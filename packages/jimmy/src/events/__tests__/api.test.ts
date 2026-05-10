import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrateSessionsSchema } from "../../sessions/registry.js";
import { initEventsSchema } from "../db.js";
import { emitEventOn } from "../emit.js";
import { readEventsSingleOn, readEventsSubtreeOn } from "../api.js";

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

function emitN(db: Database.Database, sessionId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    emitEventOn(db, sessionId, "assistant_message", {
      text: `msg-${i}`,
      message_id: `${sessionId}-m${i}`,
    });
  }
}

describe("readEventsSingle — single-session paging on seq", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertSession(db, "s1", null);
    insertSession(db, "s2", null);
    emitN(db, "s1", 5);
    emitN(db, "s2", 3);
  });

  it("returns all of session's events with default since_seq=0", () => {
    const r = readEventsSingleOn(db, "s1");
    expect(r.events).toHaveLength(5);
    expect(r.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(r.events.every((e) => e.sessionId === "s1")).toBe(true);
    // No more events to read; next_seq is null.
    expect(r.next_seq).toBe(null);
  });

  it("does not bleed events from other sessions", () => {
    const r = readEventsSingleOn(db, "s1");
    expect(r.events.every((e) => e.sessionId === "s1")).toBe(true);
  });

  it("paginates correctly with since_seq + limit", () => {
    const page1 = readEventsSingleOn(db, "s1", { sinceSeq: 0, limit: 2 });
    expect(page1.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(page1.next_seq).toBe(2);

    const page2 = readEventsSingleOn(db, "s1", { sinceSeq: page1.next_seq!, limit: 2 });
    expect(page2.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(page2.next_seq).toBe(4);

    const page3 = readEventsSingleOn(db, "s1", { sinceSeq: page2.next_seq!, limit: 2 });
    // Last partial page: only 1 event left, so next_seq is null.
    expect(page3.events.map((e) => e.seq)).toEqual([5]);
    expect(page3.next_seq).toBe(null);
  });

  it("clamps limit to MAX_LIMIT (1000) silently", () => {
    const r = readEventsSingleOn(db, "s1", { limit: 999999 });
    // Just verify it doesn't blow up; we have 5 events so all are returned.
    expect(r.events).toHaveLength(5);
  });

  it("treats negative since_seq as 0", () => {
    const r = readEventsSingleOn(db, "s1", { sinceSeq: -10 });
    expect(r.events).toHaveLength(5);
  });
});

describe("readEventsSubtree — root fast path", () => {
  let db: Database.Database;
  beforeEach(() => {
    // 3-level tree:
    //   root
    //    ├── child-a (1 event)
    //    │    └── grandchild (2 events)
    //    └── child-b (1 event)
    db = freshDb();
    insertSession(db, "root", null);
    insertSession(db, "child-a", "root");
    insertSession(db, "child-b", "root");
    insertSession(db, "grandchild", "child-a");
    emitN(db, "child-a", 1);
    emitN(db, "child-b", 1);
    emitN(db, "grandchild", 2);
    // Sibling root tree -- must NOT appear in our subtree query.
    insertSession(db, "other-root", null);
    emitN(db, "other-root", 5);
  });

  it("returns all descendant events when caller is the root", () => {
    const r = readEventsSubtreeOn(db, "root");
    // 1 + 1 + 2 = 4 events from our tree
    expect(r.events).toHaveLength(4);
    const sessions = new Set(r.events.map((e) => e.sessionId));
    expect(sessions).toEqual(new Set(["child-a", "child-b", "grandchild"]));
  });

  it("does not include events from sibling roots", () => {
    const r = readEventsSubtreeOn(db, "root");
    expect(r.events.every((e) => e.sessionId !== "other-root")).toBe(true);
  });

  it("paginates by global id; cursor moves forward across descendants", () => {
    const page1 = readEventsSubtreeOn(db, "root", { limit: 2 });
    expect(page1.events).toHaveLength(2);
    expect(page1.next_id).toBe(page1.events[1].id);

    const page2 = readEventsSubtreeOn(db, "root", { afterId: page1.next_id!, limit: 2 });
    expect(page2.events).toHaveLength(2);

    // Page 2's first id strictly greater than page 1's last.
    expect(page2.events[0].id).toBeGreaterThan(page1.events[1].id);
    // No overlap.
    const page1Ids = new Set(page1.events.map((e) => e.id));
    expect(page2.events.every((e) => !page1Ids.has(e.id))).toBe(true);
  });
});

describe("readEventsSubtree — mid-tree recursive CTE", () => {
  let db: Database.Database;
  beforeEach(() => {
    // Same shape:
    //   root
    //    ├── child-a (1 event)
    //    │    └── grandchild (2 events)
    //    └── child-b (1 event, NOT a descendant of child-a)
    db = freshDb();
    insertSession(db, "root", null);
    insertSession(db, "child-a", "root");
    insertSession(db, "child-b", "root");
    insertSession(db, "grandchild", "child-a");
    emitN(db, "child-a", 1);
    emitN(db, "child-b", 1);
    emitN(db, "grandchild", 2);
  });

  it("returns only descendants of mid-tree node, not siblings", () => {
    const r = readEventsSubtreeOn(db, "child-a");
    // child-a (1) + grandchild (2) = 3; child-b's event must be excluded.
    expect(r.events).toHaveLength(3);
    const sessions = new Set(r.events.map((e) => e.sessionId));
    expect(sessions).toEqual(new Set(["child-a", "grandchild"]));
    expect(sessions.has("child-b")).toBe(false);
  });

  it("returns only its own events for a leaf node", () => {
    const r = readEventsSubtreeOn(db, "grandchild");
    expect(r.events).toHaveLength(2);
    expect(r.events.every((e) => e.sessionId === "grandchild")).toBe(true);
  });
});

describe("readEventsSubtree — empty / unknown", () => {
  it("returns empty events for unknown session id", () => {
    const db = freshDb();
    const r = readEventsSubtreeOn(db, "ghost");
    expect(r.events).toEqual([]);
    expect(r.next_id).toBe(null);
  });

  it("returns empty events for a session with no emits yet", () => {
    const db = freshDb();
    insertSession(db, "quiet", null);
    const r = readEventsSubtreeOn(db, "quiet");
    expect(r.events).toEqual([]);
    expect(r.next_id).toBe(null);
  });
});

describe("cursor model integrity (regression test for plan §T1A.3)", () => {
  it("subtree pagination on after_id never drops events that single-session seq would mask", () => {
    // Two children of same root, interleaved emissions. If the subtree
    // reader paged on per-session seq, it would consume child-a.seq=1
    // and child-b.seq=1 before either's seq=2 -- but page boundaries
    // could drop one. With global id cursor, every event is reachable.
    const db = freshDb();
    insertSession(db, "root", null);
    insertSession(db, "child-a", "root");
    insertSession(db, "child-b", "root");
    // Interleave: a, b, a, b, a, b
    for (let i = 0; i < 3; i++) {
      emitEventOn(db, "child-a", "assistant_message", {
        text: `a-${i}`,
        message_id: `a-${i}`,
      });
      emitEventOn(db, "child-b", "assistant_message", {
        text: `b-${i}`,
        message_id: `b-${i}`,
      });
    }

    // Page through with limit=2 and verify we get exactly 6 events, no
    // duplicates, no gaps.
    const seenIds: number[] = [];
    let afterId = 0;
    for (let safety = 0; safety < 100; safety++) {
      const r = readEventsSubtreeOn(db, "root", { afterId, limit: 2 });
      if (r.events.length === 0) break;
      for (const e of r.events) seenIds.push(e.id);
      if (r.next_id === null) break;
      afterId = r.next_id;
    }
    expect(seenIds).toHaveLength(6);
    // Strictly increasing.
    for (let i = 1; i < seenIds.length; i++) {
      expect(seenIds[i]).toBeGreaterThan(seenIds[i - 1]);
    }
    // Unique.
    expect(new Set(seenIds).size).toBe(6);
  });
});
