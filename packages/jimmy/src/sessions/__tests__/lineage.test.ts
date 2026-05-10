import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrateSessionsSchema } from "../registry.js";

// PR1 covers the schema/backfill side of lineage. createSession() goes through
// initDb() and the global SESSIONS_DB path, so we exercise the lineage
// backfill SQL directly here against an in-memory DB rather than reaching
// into the real sessions DB on disk.
//
// Schema is now owned by the SQL-file migration runner. Each test calls
// migrateSessionsSchema(db) (a compat shim that runs all baseline migrations)
// to create the full schema, then inserts rows with root_session_id=NULL to
// simulate legacy data, and finally re-runs the backfill SQL to verify the
// CTE walk lands the right roots. The backfill SQL is duplicated here from
// 0003_lineage.up.sql — that's intentional, since the test asserts on the
// behaviour of THAT SQL, not on the migration framework that ships it.

const LINEAGE_BACKFILL_SQL = `
  WITH RECURSIVE roots(id, root_id) AS (
    SELECT id, id FROM sessions WHERE parent_session_id IS NULL
    UNION ALL
    SELECT s.id, r.root_id FROM sessions s JOIN roots r ON s.parent_session_id = r.id
  )
  UPDATE sessions
    SET root_session_id = (SELECT root_id FROM roots WHERE roots.id = sessions.id)
    WHERE root_session_id IS NULL
      AND id IN (SELECT id FROM roots);
`;

const ORPHAN_FALLBACK_SQL = `
  UPDATE sessions SET root_session_id = id WHERE root_session_id IS NULL;
`;

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrateSessionsSchema(db);
  return db;
}

function insertRaw(db: Database.Database, id: string, parent: string | null): void {
  // Insert as a "legacy" row: parent_session_id filled but root_session_id NULL,
  // mirroring the on-disk state a database in production would be in just
  // before 0003 fired.
  db.prepare(`
    INSERT INTO sessions (id, engine, source, source_ref, parent_session_id, root_session_id, created_at, last_activity)
    VALUES (?, 'claude', 'test', ?, ?, NULL, '2026-05-07T00:00:00.000Z', '2026-05-07T00:00:00.000Z')
  `).run(id, `test:${id}`, parent);
}

function runBackfill(db: Database.Database): void {
  db.prepare(LINEAGE_BACKFILL_SQL).run();
  db.prepare(ORPHAN_FALLBACK_SQL).run();
}

describe("lineage backfill", () => {
  it("adds root_session_id column and backfills top-level rows to id", () => {
    const db = freshDb();
    insertRaw(db, "a", null);
    insertRaw(db, "b", null);

    runBackfill(db);

    const rows = db.prepare("SELECT id, root_session_id FROM sessions ORDER BY id").all() as Array<{
      id: string;
      root_session_id: string;
    }>;
    expect(rows).toEqual([
      { id: "a", root_session_id: "a" },
      { id: "b", root_session_id: "b" },
    ]);
  });

  it("walks parent pointers up to the root for arbitrary depth", () => {
    const db = freshDb();
    insertRaw(db, "root", null);
    insertRaw(db, "child", "root");
    insertRaw(db, "grandchild", "child");
    insertRaw(db, "great-grandchild", "grandchild");

    runBackfill(db);

    const rows = db.prepare("SELECT id, root_session_id FROM sessions ORDER BY id").all() as Array<{
      id: string;
      root_session_id: string;
    }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.root_session_id]));
    expect(byId.root).toBe("root");
    expect(byId.child).toBe("root");
    expect(byId.grandchild).toBe("root");
    expect(byId["great-grandchild"]).toBe("root");
  });

  it("treats orphans (parent points to deleted row) as their own root", () => {
    const db = freshDb();
    // No row with id="ghost" — child is an orphan.
    insertRaw(db, "orphan", "ghost");

    runBackfill(db);

    const row = db.prepare("SELECT root_session_id FROM sessions WHERE id = ?").get("orphan") as
      | { root_session_id: string }
      | undefined;
    // Invariant: every row must have non-null root_session_id after the
    // migration, even if its parent is missing.
    expect(row?.root_session_id).toBe("orphan");
  });

  it("leaves no NULL root_session_id values after migrate", () => {
    const db = freshDb();
    insertRaw(db, "r1", null);
    insertRaw(db, "c1", "r1");
    insertRaw(db, "c2", "r1");
    insertRaw(db, "lonely", null);

    runBackfill(db);

    const nullCount = db
      .prepare("SELECT count(*) AS n FROM sessions WHERE root_session_id IS NULL")
      .get() as { n: number };
    expect(nullCount.n).toBe(0);
  });

  it("creates idx_sessions_parent and idx_sessions_root", () => {
    const db = freshDb();

    const idx = db.prepare("PRAGMA index_list(sessions)").all() as Array<{ name: string }>;
    const names = new Set(idx.map((i) => i.name));
    expect(names.has("idx_sessions_parent")).toBe(true);
    expect(names.has("idx_sessions_root")).toBe(true);
  });

  it("recursive CTE descent from a mid-tree node uses idx_sessions_parent", () => {
    const db = freshDb();
    insertRaw(db, "r", null);
    insertRaw(db, "a", "r");
    insertRaw(db, "b", "a");
    insertRaw(db, "c", "b");
    insertRaw(db, "d", "c");

    runBackfill(db);

    // Query plan for a 5-level descent starting mid-tree at 'a'. We don't
    // mandate index usage at exactly one place in the plan -- SQLite's
    // recursive CTE plan output varies between versions -- but the
    // descent SHOULD reach idx_sessions_parent, not a full sessions scan.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         WITH RECURSIVE descendants(id) AS (
           SELECT id FROM sessions WHERE id = ?
           UNION ALL
           SELECT s.id FROM sessions s JOIN descendants d ON s.parent_session_id = d.id
         )
         SELECT id FROM descendants`,
      )
      .all("a") as Array<{ detail: string }>;

    const planText = plan.map((p) => p.detail).join("\n");
    expect(planText).toMatch(/idx_sessions_parent/);
    expect(planText).not.toMatch(/SCAN sessions(?!\w)/);
  });
});

describe("lineage backfill — idempotency", () => {
  it("running migrate twice is a no-op and preserves backfilled values", () => {
    const db = freshDb();
    insertRaw(db, "r", null);
    insertRaw(db, "c", "r");

    runBackfill(db);
    const after1 = db.prepare("SELECT id, root_session_id FROM sessions ORDER BY id").all();

    runBackfill(db);
    const after2 = db.prepare("SELECT id, root_session_id FROM sessions ORDER BY id").all();

    expect(after2).toEqual(after1);
  });
});
