import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrateSessionsSchema } from "../registry.js";

// PR1 covers the schema/backfill side of lineage. createSession() goes through
// initDb() and the global SESSIONS_DB path, so we exercise the migrator
// directly here against an in-memory DB rather than reaching into the real
// sessions DB on disk.

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.prepare(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      engine TEXT NOT NULL,
      engine_session_id TEXT,
      source TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      connector TEXT,
      session_key TEXT,
      reply_context TEXT,
      message_id TEXT,
      transport_meta TEXT,
      employee TEXT,
      model TEXT,
      title TEXT,
      parent_session_id TEXT,
      status TEXT DEFAULT 'idle',
      created_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      last_error TEXT
    )
  `).run();
  return db;
}

function insertRaw(db: Database.Database, id: string, parent: string | null): void {
  db.prepare(`
    INSERT INTO sessions (id, engine, source, source_ref, parent_session_id, created_at, last_activity)
    VALUES (?, 'claude', 'test', ?, ?, '2026-05-07T00:00:00.000Z', '2026-05-07T00:00:00.000Z')
  `).run(id, `test:${id}`, parent);
}

describe("lineage backfill", () => {
  it("adds root_session_id column and backfills top-level rows to id", () => {
    const db = freshDb();
    insertRaw(db, "a", null);
    insertRaw(db, "b", null);

    migrateSessionsSchema(db);

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

    migrateSessionsSchema(db);

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

    migrateSessionsSchema(db);

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

    migrateSessionsSchema(db);

    const nullCount = db
      .prepare("SELECT count(*) AS n FROM sessions WHERE root_session_id IS NULL")
      .get() as { n: number };
    expect(nullCount.n).toBe(0);
  });

  it("creates idx_sessions_parent and idx_sessions_root", () => {
    const db = freshDb();
    migrateSessionsSchema(db);

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

    migrateSessionsSchema(db);

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

    migrateSessionsSchema(db);
    const after1 = db.prepare("SELECT id, root_session_id FROM sessions ORDER BY id").all();

    migrateSessionsSchema(db);
    const after2 = db.prepare("SELECT id, root_session_id FROM sessions ORDER BY id").all();

    expect(after2).toEqual(after1);
  });
});
