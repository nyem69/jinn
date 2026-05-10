import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { migrateSessionsSchema } from "../../sessions/registry.js";
import { initEventsSchema } from "../db.js";
import { emitEventOn } from "../emit.js";
import {
  startSseStream,
  formatEventFrame,
  parseLastEventId,
  resolveSingleCursorFromLastEventId,
  type SseClient,
  type SseHandle,
} from "../sse.js";

// SSE tests use an in-memory client adapter so we can drive the stream
// deterministically with fake timers. No http server needed; the gateway
// adapter wires the same SseClient interface to a ServerResponse.

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

interface ParsedFrame {
  event: string;
  id?: string;
  data: string;
}

function parseFrames(buffer: string): ParsedFrame[] {
  const out: ParsedFrame[] = [];
  for (const block of buffer.split("\n\n")) {
    if (!block.trim() || block.startsWith(":")) continue;
    const frame: ParsedFrame = { event: "message", data: "" };
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) frame.event = line.slice(7);
      else if (line.startsWith("id: ")) frame.id = line.slice(4);
      else if (line.startsWith("data: ")) frame.data = line.slice(6);
    }
    out.push(frame);
  }
  return out;
}

function eventFrames(client: MockClient): Array<{ id: number; payload: Record<string, unknown> }> {
  return parseFrames(client.buffer)
    .filter((f) => f.event === "session_event")
    .map((f) => {
      const parsed = JSON.parse(f.data) as Record<string, unknown>;
      return { id: Number(f.id), payload: parsed };
    });
}

class MockClient implements SseClient {
  buffer = "";
  ended = false;
  // When set, write() returns false to simulate backpressure. Calling
  // .drain() then dispatches the registered drain handlers.
  paused = false;
  private closeHandlers: Array<() => void> = [];
  private drainHandlers: Array<() => void> = [];

  write(chunk: string): boolean {
    this.buffer += chunk;
    return !this.paused;
  }

  end(): void {
    this.ended = true;
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  onDrain(handler: () => void): void {
    this.drainHandlers.push(handler);
  }

  // Test helpers — not part of SseClient.
  fireClose(): void {
    for (const h of this.closeHandlers) h();
  }

  fireDrain(): void {
    for (const h of this.drainHandlers) h();
  }
}

describe("startSseStream — single-session mode", () => {
  let db: Database.Database;
  let client: MockClient;
  let handle: SseHandle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    db = freshDb();
    insertSession(db, "s1", null);
    insertSession(db, "s2", null);
    client = new MockClient();
  });

  afterEach(() => {
    handle?.stop();
    handle = null;
    vi.useRealTimers();
  });

  it("emits all queued events in order on first poll", async () => {
    for (let i = 0; i < 5; i++) {
      emitEventOn(db, "s1", "assistant_message", { text: `m${i}`, message_id: `s1-${i}` });
    }
    handle = startSseStream(db, client, {
      mode: "single",
      sessionId: "s1",
      pollMs: 100,
      heartbeatMs: 60_000,
    });
    // Initial poll fires on next tick (setTimeout 0).
    await vi.advanceTimersByTimeAsync(1);

    const frames = eventFrames(client);
    expect(frames).toHaveLength(5);
    const seqs = frames.map((f) => f.payload.seq as number);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(frames.every((f) => (f.payload.session_id as string) === "s1")).toBe(true);
  });

  it("does not bleed sibling-session events", async () => {
    emitEventOn(db, "s1", "assistant_message", { text: "a", message_id: "s1-1" });
    emitEventOn(db, "s2", "assistant_message", { text: "b", message_id: "s2-1" });
    emitEventOn(db, "s1", "assistant_message", { text: "c", message_id: "s1-2" });

    handle = startSseStream(db, client, {
      mode: "single",
      sessionId: "s1",
      pollMs: 100,
      heartbeatMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(1);

    const frames = eventFrames(client);
    expect(frames).toHaveLength(2);
    expect(frames.every((f) => f.payload.session_id === "s1")).toBe(true);
  });

  it("picks up new events on subsequent polls", async () => {
    handle = startSseStream(db, client, {
      mode: "single",
      sessionId: "s1",
      pollMs: 50,
      heartbeatMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(eventFrames(client)).toHaveLength(0);

    emitEventOn(db, "s1", "assistant_message", { text: "live-1", message_id: "s1-l1" });
    emitEventOn(db, "s1", "assistant_message", { text: "live-2", message_id: "s1-l2" });

    await vi.advanceTimersByTimeAsync(60);
    const frames = eventFrames(client);
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.payload.seq)).toEqual([1, 2]);
  });

  it("respects since_seq cursor", async () => {
    for (let i = 0; i < 5; i++) {
      emitEventOn(db, "s1", "assistant_message", { text: `m${i}`, message_id: `s1-${i}` });
    }
    handle = startSseStream(db, client, {
      mode: "single",
      sessionId: "s1",
      cursorSeq: 3,
      pollMs: 100,
      heartbeatMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(1);

    const frames = eventFrames(client);
    expect(frames.map((f) => f.payload.seq)).toEqual([4, 5]);
  });

  it("frame id field carries the global id (Last-Event-ID-compatible)", async () => {
    emitEventOn(db, "s1", "assistant_message", { text: "a", message_id: "s1-1" });

    handle = startSseStream(db, client, {
      mode: "single",
      sessionId: "s1",
      pollMs: 100,
      heartbeatMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(1);

    const parsed = parseFrames(client.buffer).find((f) => f.event === "session_event");
    expect(parsed).toBeTruthy();
    // The id line is a positive integer matching session_events.id.
    expect(Number(parsed!.id)).toBeGreaterThan(0);
    const data = JSON.parse(parsed!.data) as { id: number };
    expect(data.id).toBe(Number(parsed!.id));
  });
});

describe("startSseStream — subtree mode", () => {
  let db: Database.Database;
  let client: MockClient;
  let handle: SseHandle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    db = freshDb();
    // 3-level tree:
    //   root
    //    ├── child-a
    //    │    └── grandchild
    //    └── child-b
    insertSession(db, "root", null);
    insertSession(db, "child-a", "root");
    insertSession(db, "child-b", "root");
    insertSession(db, "grandchild", "child-a");
    insertSession(db, "other-root", null);
    client = new MockClient();
  });

  afterEach(() => {
    handle?.stop();
    handle = null;
    vi.useRealTimers();
  });

  it("root reader sees all descendants in global-id order", async () => {
    // Interleave emissions across the tree so per-session seq would
    // mask events under any naive paging scheme.
    for (let i = 0; i < 3; i++) {
      emitEventOn(db, "child-a", "assistant_message", { text: `a${i}`, message_id: `a-${i}` });
      emitEventOn(db, "child-b", "assistant_message", { text: `b${i}`, message_id: `b-${i}` });
      emitEventOn(db, "grandchild", "assistant_message", { text: `g${i}`, message_id: `g-${i}` });
    }
    // Sibling root tree -- must NOT appear.
    emitEventOn(db, "other-root", "assistant_message", { text: "x", message_id: "x-1" });

    handle = startSseStream(db, client, {
      mode: "subtree",
      sessionId: "root",
      pollMs: 100,
      heartbeatMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(1);

    const frames = eventFrames(client);
    expect(frames).toHaveLength(9);
    const sessions = new Set(frames.map((f) => f.payload.session_id));
    expect(sessions).toEqual(new Set(["child-a", "child-b", "grandchild"]));
    // Strictly increasing global ids.
    const ids = frames.map((f) => f.id);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]);
  });

  it("mid-tree reader sees only its descendants", async () => {
    emitEventOn(db, "child-a", "assistant_message", { text: "a", message_id: "a" });
    emitEventOn(db, "grandchild", "assistant_message", { text: "g", message_id: "g" });
    emitEventOn(db, "child-b", "assistant_message", { text: "b", message_id: "b" });

    handle = startSseStream(db, client, {
      mode: "subtree",
      sessionId: "child-a",
      pollMs: 100,
      heartbeatMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(1);

    const frames = eventFrames(client);
    const sessions = new Set(frames.map((f) => f.payload.session_id));
    expect(sessions).toEqual(new Set(["child-a", "grandchild"]));
    expect(sessions.has("child-b")).toBe(false);
  });

  it("after_id cursor never drops events on simulated reconnect", async () => {
    // Session 1: emit 4 events, drain stream, capture last id.
    emitEventOn(db, "child-a", "assistant_message", { text: "a1", message_id: "a1" });
    emitEventOn(db, "child-b", "assistant_message", { text: "b1", message_id: "b1" });
    emitEventOn(db, "child-a", "assistant_message", { text: "a2", message_id: "a2" });
    emitEventOn(db, "child-b", "assistant_message", { text: "b2", message_id: "b2" });

    handle = startSseStream(db, client, {
      mode: "subtree",
      sessionId: "root",
      pollMs: 50,
      heartbeatMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(1);
    const firstFrames = eventFrames(client);
    expect(firstFrames).toHaveLength(4);
    const lastId = firstFrames[firstFrames.length - 1].id;
    handle.stop();

    // Network blip: more events emitted while the consumer is offline.
    emitEventOn(db, "child-a", "assistant_message", { text: "a3", message_id: "a3" });
    emitEventOn(db, "grandchild", "assistant_message", { text: "g1", message_id: "g1" });

    // Reconnect with cursor = lastId; we should get exactly the new
    // events with no overlap and no drops.
    const client2 = new MockClient();
    handle = startSseStream(db, client2, {
      mode: "subtree",
      sessionId: "root",
      cursorId: lastId,
      pollMs: 50,
      heartbeatMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(1);

    const newFrames = eventFrames(client2);
    expect(newFrames).toHaveLength(2);
    expect(newFrames.every((f) => f.id > lastId)).toBe(true);
  });

  it("returns nothing for unknown session id (no crash)", async () => {
    handle = startSseStream(db, client, {
      mode: "subtree",
      sessionId: "ghost",
      pollMs: 100,
      heartbeatMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(eventFrames(client)).toHaveLength(0);
    expect(client.ended).toBe(false);
  });
});

describe("startSseStream — heartbeat + lifecycle", () => {
  let db: Database.Database;
  let client: MockClient;
  let handle: SseHandle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    db = freshDb();
    insertSession(db, "s1", null);
    client = new MockClient();
  });

  afterEach(() => {
    handle?.stop();
    handle = null;
    vi.useRealTimers();
  });

  it("emits heartbeat after heartbeatMs idle", async () => {
    handle = startSseStream(db, client, {
      mode: "single",
      sessionId: "s1",
      pollMs: 1000,
      heartbeatMs: 100,
    });
    await vi.advanceTimersByTimeAsync(150);
    const frames = parseFrames(client.buffer).filter((f) => f.event === "heartbeat");
    expect(frames.length).toBeGreaterThanOrEqual(1);
  });

  it("client onClose tears down the stream", async () => {
    handle = startSseStream(db, client, {
      mode: "single",
      sessionId: "s1",
      pollMs: 50,
      heartbeatMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(handle.isStopped()).toBe(false);
    client.fireClose();
    expect(handle.isStopped()).toBe(true);
  });

  it("stop() ends the client immediately", async () => {
    handle = startSseStream(db, client, {
      mode: "single",
      sessionId: "s1",
      pollMs: 50,
      heartbeatMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(1);
    handle.stop();
    expect(client.ended).toBe(true);
    expect(handle.isStopped()).toBe(true);
  });
});

describe("startSseStream — slow consumer drop", () => {
  let db: Database.Database;
  let client: MockClient;
  let handle: SseHandle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    db = freshDb();
    insertSession(db, "s1", null);
    client = new MockClient();
  });

  afterEach(() => {
    handle?.stop();
    handle = null;
    vi.useRealTimers();
  });

  it("drops connection after slowConsumerDropMs without drain", async () => {
    client.paused = true; // every write returns false
    emitEventOn(db, "s1", "assistant_message", { text: "x", message_id: "x" });

    handle = startSseStream(db, client, {
      mode: "single",
      sessionId: "s1",
      pollMs: 1000,
      heartbeatMs: 60_000,
      slowConsumerDropMs: 200,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(handle.isStopped()).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    expect(handle.isStopped()).toBe(true);
    expect(client.ended).toBe(true);
  });

  it("drain cancels the slow-consumer drop", async () => {
    client.paused = true;
    emitEventOn(db, "s1", "assistant_message", { text: "x", message_id: "x" });

    handle = startSseStream(db, client, {
      mode: "single",
      sessionId: "s1",
      pollMs: 1000,
      heartbeatMs: 60_000,
      slowConsumerDropMs: 200,
    });
    await vi.advanceTimersByTimeAsync(1);
    // Drain before drop fires.
    client.fireDrain();
    await vi.advanceTimersByTimeAsync(250);
    expect(handle.isStopped()).toBe(false);
  });
});

describe("soak — 1000 events drain in order", () => {
  let db: Database.Database;
  let client: MockClient;
  let handle: SseHandle | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    db = freshDb();
    insertSession(db, "s1", null);
    client = new MockClient();
  });

  afterEach(() => {
    handle?.stop();
    handle = null;
    vi.useRealTimers();
  });

  it("reader observes 1000 events in seq order with no gaps", async () => {
    for (let i = 0; i < 1000; i++) {
      emitEventOn(db, "s1", "assistant_message", {
        text: `m${i}`,
        message_id: `s1-${i}`,
      });
    }

    handle = startSseStream(db, client, {
      mode: "single",
      sessionId: "s1",
      pollMs: 50,
      heartbeatMs: 60_000,
      pageLimit: 100,
    });
    // Drain across 10 pages of 100 + final empty: each full page
    // schedules an immediate re-poll, so a single tick advance covers
    // all of them.
    await vi.advanceTimersByTimeAsync(60);

    const frames = eventFrames(client);
    expect(frames).toHaveLength(1000);
    const seqs = frames.map((f) => f.payload.seq as number);
    for (let i = 0; i < seqs.length; i++) expect(seqs[i]).toBe(i + 1);
  });
});

describe("helpers", () => {
  it("formatEventFrame produces SSE-shaped block", () => {
    const frame = formatEventFrame({
      id: 42,
      sessionId: "s1",
      rootSessionId: "s1",
      seq: 7,
      kind: "assistant_message",
      payload: { text: "hi", message_id: "m" },
      createdAt: "2026-05-07T00:00:00.000Z",
    });
    expect(frame).toMatch(/^event: session_event\n/);
    expect(frame).toMatch(/\nid: 42\n/);
    expect(frame).toMatch(/\ndata: \{.*"id":42.*\}\n\n$/);
  });

  it("parseLastEventId handles missing/garbage values", () => {
    expect(parseLastEventId(undefined)).toBeUndefined();
    expect(parseLastEventId("")).toBeUndefined();
    expect(parseLastEventId("not-a-number")).toBeUndefined();
    expect(parseLastEventId("-5")).toBeUndefined();
    expect(parseLastEventId(["123"])).toBeUndefined();
    expect(parseLastEventId("123")).toBe(123);
    expect(parseLastEventId("  42 ")).toBe(42);
  });

  it("resolveSingleCursorFromLastEventId looks up seq by global id", () => {
    const db = freshDb();
    insertSession(db, "s1", null);
    insertSession(db, "s2", null);
    const a = emitEventOn(db, "s1", "assistant_message", { text: "1", message_id: "m1" });
    emitEventOn(db, "s2", "assistant_message", { text: "x", message_id: "x" });
    const c = emitEventOn(db, "s1", "assistant_message", { text: "2", message_id: "m2" });
    if (!a.ok || !c.ok) throw new Error("emit failed");

    expect(resolveSingleCursorFromLastEventId(db, "s1", a.event.id)).toBe(a.event.seq);
    expect(resolveSingleCursorFromLastEventId(db, "s1", c.event.id)).toBe(c.event.seq);
    // Cross-session lookup returns undefined: the global id belongs to
    // s2, not s1, so the subscriber's seq cursor must come from a
    // different source.
    expect(resolveSingleCursorFromLastEventId(db, "s1", a.event.id + 1)).toBeUndefined();
    expect(resolveSingleCursorFromLastEventId(db, "ghost", a.event.id)).toBeUndefined();
  });
});
