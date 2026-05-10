import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrateSessionsSchema, writeSpawnCheckpoint } from "../registry.js";
import { initEventsSchema } from "../../events/db.js";
import { initHandlerRegistry } from "../../events/handlers.js";
import {
  initCheckpointsSchema,
  listCheckpointsOn,
} from "../checkpoint.js";

// writeSpawnCheckpoint is the spawn-time hook called from createSession
// when opts.checkpoint + opts.parentSessionId are both set. The unit
// tests exercise it directly against an in-memory DB so we don't have
// to drive the global initDb() path.

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  // Schema is owned by the migration runner; migrateSessionsSchema (compat
  // shim) applies every baseline migration. The trailing init* calls are
  // no-ops kept for documentation parity.
  migrateSessionsSchema(db);
  initEventsSchema(db);
  initHandlerRegistry(db);
  initCheckpointsSchema(db);
  return db;
}

function insertSession(db: Database.Database, id: string, parent: string | null = null): void {
  let root = id;
  if (parent) {
    const r = db
      .prepare("SELECT root_session_id FROM sessions WHERE id = ?")
      .get(parent) as { root_session_id?: string } | undefined;
    root = r?.root_session_id ?? parent;
  }
  db.prepare(`
    INSERT INTO sessions (id, engine, source, source_ref, parent_session_id, root_session_id, created_at, last_activity)
    VALUES (?, 'claude', 'test', ?, ?, ?, '2026-05-07T00:00:00.000Z', '2026-05-07T00:00:00.000Z')
  `).run(id, `test:${id}`, parent, root);
}

describe("writeSpawnCheckpoint — defaults", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertSession(db, "parent");
  });

  it("writes a checkpoint on the parent at step_seq=1 when none exist", () => {
    writeSpawnCheckpoint(db, "parent", "child-a", {
      state: { persona: "writer", prompt: "compose a haiku" },
    });

    const rows = listCheckpointsOn(db, "parent");
    expect(rows).toHaveLength(1);
    expect(rows[0].stepSeq).toBe(1);
    expect(rows[0].branch).toBe("main");
    expect(rows[0].state).toMatchObject({
      persona: "writer",
      prompt: "compose a haiku",
      spawned_child_session_id: "child-a",
    });
    expect(typeof rows[0].state.spawned_at).toBe("string");
  });

  it("monotonic step_seq for back-to-back spawns on same branch", () => {
    writeSpawnCheckpoint(db, "parent", "c1", { state: { persona: "a" } });
    writeSpawnCheckpoint(db, "parent", "c2", { state: { persona: "b" } });
    writeSpawnCheckpoint(db, "parent", "c3", { state: { persona: "c" } });

    const rows = listCheckpointsOn(db, "parent");
    expect(rows.map((r) => r.stepSeq)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.state.persona as string)).toEqual(["a", "b", "c"]);
  });

  it("caller-supplied stepSeq wins (so callers can align with session_events.seq)", () => {
    writeSpawnCheckpoint(db, "parent", "c1", {
      state: { persona: "x" },
      stepSeq: 42,
    });
    const row = listCheckpointsOn(db, "parent")[0];
    expect(row.stepSeq).toBe(42);
  });

  it("custom branch lands as a separate row from main", () => {
    writeSpawnCheckpoint(db, "parent", "c1", { state: { persona: "main-1" } });
    writeSpawnCheckpoint(db, "parent", "c2", {
      state: { persona: "fork-1" },
      branch: "fork-a",
    });

    const all = listCheckpointsOn(db, "parent");
    expect(all).toHaveLength(2);
    const fork = listCheckpointsOn(db, "parent", { branch: "fork-a" });
    expect(fork).toHaveLength(1);
    expect(fork[0].state.persona).toBe("fork-1");
  });

  it("caller state overrides spawn linkage augmentation on key conflict", () => {
    writeSpawnCheckpoint(db, "parent", "c1", {
      state: {
        persona: "x",
        spawned_child_session_id: "explicit-override",
      },
    });
    const row = listCheckpointsOn(db, "parent")[0];
    expect(row.state.spawned_child_session_id).toBe("explicit-override");
  });

  it("rejects state JSON > 2 MB", () => {
    const huge = "x".repeat(3 * 1024 * 1024);
    expect(() =>
      writeSpawnCheckpoint(db, "parent", "c1", { state: { huge } }),
    ).toThrow(/exceeds 2 MB/);
  });

  it("INSERT OR IGNORE — duplicate (session, branch, stepSeq) is a silent no-op", () => {
    writeSpawnCheckpoint(db, "parent", "c1", {
      state: { persona: "first" },
      stepSeq: 5,
    });
    writeSpawnCheckpoint(db, "parent", "c2", {
      state: { persona: "second" },
      stepSeq: 5,
    });
    const rows = listCheckpointsOn(db, "parent");
    expect(rows).toHaveLength(1);
    expect(rows[0].state.persona).toBe("first");
  });
});
