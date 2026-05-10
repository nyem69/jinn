import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrateSessionsSchema } from "../../sessions/registry.js";
import { initEventsSchema } from "../db.js";
import { emitEventOn } from "../emit.js";

// emit() tests use an in-memory DB so they don't touch ~/.jinn/sessions.db.
// freshDb() bootstraps the same shape initDb() builds, then runs the
// PR1 migrator + the PR2 events schema initializer. Lean — only the
// sessions table is created with the columns emit() reads from.

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  // Schema is owned by the migration runner; migrateSessionsSchema (compat
  // shim) applies every baseline migration. The trailing initEventsSchema
  // call is a no-op kept for documentation parity.
  migrateSessionsSchema(db);
  initEventsSchema(db);
  return db;
}

function insertSession(db: Database.Database, id: string, parent: string | null): void {
  // Mirror createSession()'s lineage logic so multi-level fixtures get
  // the right root: walk up to parent's row and copy its root.
  let root = id;
  if (parent) {
    const parentRow = db
      .prepare("SELECT root_session_id FROM sessions WHERE id = ?")
      .get(parent) as { root_session_id?: string } | undefined;
    root = parentRow?.root_session_id ?? parent;
  }
  db.prepare(`
    INSERT INTO sessions (id, engine, source, source_ref, parent_session_id, root_session_id, created_at, last_activity)
    VALUES (?, 'claude', 'test', ?, ?, ?, '2026-05-07T00:00:00.000Z', '2026-05-07T00:00:00.000Z')
  `).run(id, `test:${id}`, parent, root);
}

describe("emitEventOn — happy path", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
    insertSession(db, "s1", null);
  });

  it("writes a valid event and returns the row", () => {
    const r = emitEventOn(db, "s1", "session_started", {
      employee: "chief-analyst",
      oversight: "VERIFY",
      brief: "test",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.sessionId).toBe("s1");
      expect(r.event.kind).toBe("session_started");
      expect(r.event.seq).toBe(1);
      expect(r.event.rootSessionId).toBe("s1");
      expect(r.event.payload).toEqual({
        employee: "chief-analyst",
        oversight: "VERIFY",
        brief: "test",
      });
      expect(r.event.id).toBeGreaterThan(0);
      expect(typeof r.event.createdAt).toBe("string");
    }
  });

  it("auto-assigns monotonic seq per session", () => {
    insertSession(db, "s2", null);
    const a = emitEventOn(db, "s1", "assistant_message", { text: "hi", message_id: "m1" });
    const b = emitEventOn(db, "s1", "assistant_message", { text: "hi", message_id: "m2" });
    const c = emitEventOn(db, "s2", "assistant_message", { text: "hi", message_id: "m3" });
    const d = emitEventOn(db, "s1", "assistant_message", { text: "hi", message_id: "m4" });
    if (a.ok && b.ok && c.ok && d.ok) {
      expect(a.event.seq).toBe(1);
      expect(b.event.seq).toBe(2);
      expect(c.event.seq).toBe(1); // s2's first event
      expect(d.event.seq).toBe(3); // s1's third event
    } else {
      expect.fail("expected all four emits to succeed");
    }
  });

  it("populates root_session_id from the parent's row", () => {
    insertSession(db, "child", "s1");
    insertSession(db, "grandchild", "child");
    const r = emitEventOn(db, "grandchild", "assistant_message", {
      text: "hi",
      message_id: "m1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.rootSessionId).toBe("s1");
  });

  it("global id is monotonically increasing across sessions", () => {
    insertSession(db, "s2", null);
    const a = emitEventOn(db, "s1", "assistant_message", { text: "1", message_id: "m1" });
    const b = emitEventOn(db, "s2", "assistant_message", { text: "2", message_id: "m2" });
    const c = emitEventOn(db, "s1", "assistant_message", { text: "3", message_id: "m3" });
    if (a.ok && b.ok && c.ok) {
      expect(b.event.id).toBeGreaterThan(a.event.id);
      expect(c.event.id).toBeGreaterThan(b.event.id);
    } else {
      expect.fail("emits failed");
    }
  });

  it("accepts caller-supplied seq for replay/import workflows", () => {
    const r = emitEventOn(
      db,
      "s1",
      "assistant_message",
      { text: "hi", message_id: "m1" },
      { seq: 42 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.seq).toBe(42);
  });
});

describe("emitEventOn — rejection paths", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
    insertSession(db, "s1", null);
  });

  it("rejects unknown session id with reason='unknown_session'", () => {
    const r = emitEventOn(db, "ghost", "assistant_message", {
      text: "hi",
      message_id: "m1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown_session");
  });

  it("rejects malformed payload with reason='invalid_payload' and field errors", () => {
    const r = emitEventOn(db, "s1", "session_started", {
      employee: "x",
      oversight: "INVALID",
      // brief missing
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid_payload");
      expect(r.errors).toBeTruthy();
    }
  });

  it("rejects unknown kinds before touching the DB", () => {
    const before = (db.prepare("SELECT count(*) AS n FROM session_events").get() as { n: number }).n;
    const r = emitEventOn(db, "s1", "totally_made_up_kind", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_payload");
    const after = (db.prepare("SELECT count(*) AS n FROM session_events").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it("does not write a row on validation failure", () => {
    const r = emitEventOn(db, "s1", "session_completed", {
      // tokens_in negative -> rejected
      state: "completed",
      tokens_in: -1,
      tokens_out: 0,
      duration_ms: 0,
      cost_usd: null,
      step_count: 0,
      tool_call_count: 0,
      final_answer: null,
      error_message: null,
    });
    expect(r.ok).toBe(false);
    const count = (db.prepare("SELECT count(*) AS n FROM session_events").get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it("rejects caller-supplied seq collision with reason='collision'", () => {
    const a = emitEventOn(
      db,
      "s1",
      "assistant_message",
      { text: "hi", message_id: "m1" },
      { seq: 5 },
    );
    expect(a.ok).toBe(true);
    const b = emitEventOn(
      db,
      "s1",
      "assistant_message",
      { text: "hi", message_id: "m2" },
      { seq: 5 },
    );
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("collision");
  });
});

describe("session_events indexes", () => {
  it("idx_session_events_session covers (session_id, seq) lookups", () => {
    const db = freshDb();
    const idx = db.prepare("PRAGMA index_list(session_events)").all() as Array<{ name: string }>;
    const names = new Set(idx.map((i) => i.name));
    expect(names.has("idx_session_events_session")).toBe(true);
    expect(names.has("idx_session_events_root_id")).toBe(true);
    expect(names.has("idx_session_events_kind")).toBe(true);
  });
});
