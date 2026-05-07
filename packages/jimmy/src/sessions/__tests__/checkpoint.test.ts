import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrateSessionsSchema } from "../registry.js";
import { initEventsSchema } from "../../events/db.js";
import { initHandlerRegistry } from "../../events/handlers.js";
import { emitEventOn } from "../../events/emit.js";
import {
  initCheckpointsSchema,
  writeCheckpointOn,
  listCheckpointsOn,
  readCheckpointOn,
  deleteCheckpointsOlderThanOn,
  buildReplayContextOn,
  type CheckpointRow,
} from "../checkpoint.js";

// PR5 tests use the same in-memory DB pattern as PR1-PR4: build the
// minimal sessions table, migrate, then init the events + checkpoints
// schemas. Each test sets up only what it needs.

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
  migrateSessionsSchema(db);
  initEventsSchema(db);
  initHandlerRegistry(db);
  initCheckpointsSchema(db);
  return db;
}

function insertSession(
  db: Database.Database,
  id: string,
  parent: string | null = null,
  extra: Partial<{ employee: string; engine: string; model: string }> = {},
): void {
  let root = id;
  if (parent) {
    const parentRow = db
      .prepare("SELECT root_session_id FROM sessions WHERE id = ?")
      .get(parent) as { root_session_id?: string } | undefined;
    root = parentRow?.root_session_id ?? parent;
  }
  db.prepare(`
    INSERT INTO sessions (id, engine, source, source_ref, parent_session_id, root_session_id, employee, model, created_at, last_activity)
    VALUES (?, ?, 'test', ?, ?, ?, ?, ?, '2026-05-07T00:00:00.000Z', '2026-05-07T00:00:00.000Z')
  `).run(
    id,
    extra.engine ?? "claude",
    `test:${id}`,
    parent,
    root,
    extra.employee ?? null,
    extra.model ?? null,
  );
}

describe("writeCheckpoint + readCheckpoint roundtrip", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertSession(db, "s1");
  });

  it("writes a checkpoint and reads it back with state JSON intact", () => {
    const state = {
      persona: "writer.yaml",
      prompt: "compose a haiku about migrations",
      active_plan: { todos: ["draft", "polish"], current: 0 },
      prior_results: [],
    };
    const r = writeCheckpointOn(db, { sessionId: "s1", stepSeq: 1, state });
    expect(r.dedup).toBe(false);
    expect(r.id).toBeGreaterThan(0);

    const cp = readCheckpointOn(db, "s1", { stepSeq: 1 });
    expect(cp).not.toBeNull();
    expect(cp!.sessionId).toBe("s1");
    expect(cp!.stepSeq).toBe(1);
    expect(cp!.branch).toBe("main");
    expect(cp!.state).toEqual(state);
  });

  it("dedup on identical (session, branch, step) — second write is a no-op", () => {
    const first = writeCheckpointOn(db, { sessionId: "s1", stepSeq: 5, state: { persona: "a" } });
    const second = writeCheckpointOn(db, { sessionId: "s1", stepSeq: 5, state: { persona: "b" } });
    expect(first.dedup).toBe(false);
    expect(second.dedup).toBe(true);
    expect(second.id).toBe(first.id);

    // Original state preserved (the second write's persona='b' is dropped).
    const cp = readCheckpointOn(db, "s1", { stepSeq: 5 });
    expect(cp!.state.persona).toBe("a");
  });

  it("different branches at the same step are independent rows", () => {
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 1, branch: "main", state: { persona: "main-cp" } });
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 1, branch: "fork-a", state: { persona: "fork-cp" } });
    expect(readCheckpointOn(db, "s1", { stepSeq: 1, branch: "main" })?.state.persona).toBe("main-cp");
    expect(readCheckpointOn(db, "s1", { stepSeq: 1, branch: "fork-a" })?.state.persona).toBe("fork-cp");
  });

  it("rejects state JSON that exceeds the 2 MB cap", () => {
    const huge = "x".repeat(3 * 1024 * 1024);
    expect(() =>
      writeCheckpointOn(db, { sessionId: "s1", stepSeq: 1, state: { persona: huge } }),
    ).toThrow(/exceeds.*bytes/);
  });
});

describe("listCheckpoints", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertSession(db, "s1");
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 3, state: { persona: "third" } });
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 1, state: { persona: "first" } });
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 2, branch: "fork", state: { persona: "fork-second" } });
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 2, state: { persona: "second" } });
  });

  it("returns all checkpoints across branches by default, ordered by branch then step_seq", () => {
    const all = listCheckpointsOn(db, "s1");
    expect(all.map((c: CheckpointRow) => `${c.branch}:${c.stepSeq}`)).toEqual([
      "fork:2",
      "main:1",
      "main:2",
      "main:3",
    ]);
  });

  it("filters by branch and orders by step_seq when branch is supplied", () => {
    const main = listCheckpointsOn(db, "s1", { branch: "main" });
    expect(main.map((c) => c.stepSeq)).toEqual([1, 2, 3]);
  });
});

describe("readCheckpoint — latest helper", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertSession(db, "s1");
  });

  it("returns null when nothing has been written yet", () => {
    expect(readCheckpointOn(db, "s1")).toBeNull();
  });

  it("returns the highest step_seq on the branch when no stepSeq is supplied", () => {
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 1, state: { persona: "a" } });
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 5, state: { persona: "b" } });
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 3, state: { persona: "c" } });
    expect(readCheckpointOn(db, "s1")!.stepSeq).toBe(5);
    expect(readCheckpointOn(db, "s1")!.state.persona).toBe("b");
  });
});

describe("deleteCheckpointsOlderThan — retention", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertSession(db, "s1");
  });

  it("prunes checkpoints created before the cutoff", () => {
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 1, state: {} });
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 2, state: {} });
    // Backdate row 1 by 60 days.
    db.prepare(
      "UPDATE session_checkpoints SET created_at = datetime('now', '-60 days') WHERE step_seq = 1",
    ).run();

    const removed = deleteCheckpointsOlderThanOn(db, 30);
    expect(removed).toBe(1);
    const remaining = listCheckpointsOn(db, "s1");
    expect(remaining.map((c) => c.stepSeq)).toEqual([2]);
  });

  it("days <= 0 is a no-op", () => {
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 1, state: {} });
    expect(deleteCheckpointsOlderThanOn(db, 0)).toBe(0);
    expect(deleteCheckpointsOlderThanOn(db, -10)).toBe(0);
    expect(listCheckpointsOn(db, "s1")).toHaveLength(1);
  });
});

describe("buildReplayContext — tool sequence reconstruction", () => {
  let db: Database.Database;

  function emitToolPair(
    sessionId: string,
    callId: string,
    tool: string,
    args: unknown,
    result: unknown,
  ): void {
    emitEventOn(db, sessionId, "tool_invoked", { tool, call_id: callId, args });
    emitEventOn(db, sessionId, "tool_completed", {
      tool, call_id: callId, result, error: null, duration_ms: 100,
    });
  }

  beforeEach(() => {
    db = freshDb();
    insertSession(db, "s1", null, { engine: "claude", model: "opus", employee: "writer" });
  });

  it("returns unknown_session for a session that doesn't exist", () => {
    const r = buildReplayContextOn(db, "ghost");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown_session");
  });

  it("returns no_checkpoints when the session has none on the branch", () => {
    const r = buildReplayContextOn(db, "s1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_checkpoints");
  });

  it("step_out_of_bounds when --from-step is not in the available list", () => {
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 1, state: {} });
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 5, state: {} });
    const r = buildReplayContextOn(db, "s1", { fromStep: 99 });
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "step_out_of_bounds") {
      expect(r.available).toEqual([1, 5]);
    } else {
      expect.fail("expected step_out_of_bounds");
    }
  });

  it("default selects the latest checkpoint on 'main'", () => {
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 1, state: { persona: "early" } });
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 4, state: { persona: "latest" } });
    const r = buildReplayContextOn(db, "s1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.checkpoint.stepSeq).toBe(4);
      expect(r.checkpoint.state.persona).toBe("latest");
    }
  });

  it("--from-step picks an exact checkpoint and the tool slice is bounded by the next checkpoint", () => {
    // step_seq aligns with session_events.seq per plan: checkpoints
    // are taken at the event boundary they cover, and replay reads
    // events with seq in (fromStep, nextStep].
    //
    // Layout:
    //   checkpoint @ step_seq=0    (before any events)
    //   tool A pair                seq 1, 2 (Read)
    //   tool B pair                seq 3, 4 (Bash)
    //   checkpoint @ step_seq=4    (after B's completed)
    //   tool C pair                seq 5, 6 (Edit) — excluded for fromStep=0
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 0, state: { persona: "step0" } });
    emitToolPair("s1", "c1", "Read", { f: "a" }, "ok-a");
    emitToolPair("s1", "c2", "Bash", { cmd: "ls" }, "ok-b");
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 4, state: { persona: "step4" } });
    emitToolPair("s1", "c3", "Edit", { f: "a" }, "ok-c");

    const r = buildReplayContextOn(db, "s1", { fromStep: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tools = r.toolSequence.map((t) => t.tool);
    expect(tools).toEqual(["Read", "Bash"]);
    expect(r.toolSequence[0].args).toEqual({ f: "a" });
    expect(r.toolSequence[1].result).toBe("ok-b");
  });

  it("when starting from the latest checkpoint, slice extends to end-of-log", () => {
    // checkpoint @ 0; A (seq 1,2); checkpoint @ 2; B (seq 3,4); C (seq 5,6).
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 0, state: {} });
    emitToolPair("s1", "c1", "A", null, null);
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 2, state: {} });
    emitToolPair("s1", "c2", "B", null, null);
    emitToolPair("s1", "c3", "C", null, null);

    const r = buildReplayContextOn(db, "s1", { fromStep: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.toolSequence.map((t) => t.tool)).toEqual(["B", "C"]);
    }
  });

  it("auto-generates a fork branch name when --to-branch is omitted", () => {
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 1, state: {} });
    const r = buildReplayContextOn(db, "s1");
    if (r.ok) {
      expect(r.fromBranch).toBe("main");
      expect(r.toBranch).toMatch(/^replay-/);
      expect(r.nextStepSeq).toBe(2);
    }
  });

  it("respects --to-branch and computes nextStepSeq from existing rows on that branch", () => {
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 1, state: {} });
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 7, branch: "fork-x", state: {} });
    const r = buildReplayContextOn(db, "s1", { toBranch: "fork-x" });
    if (r.ok) {
      expect(r.toBranch).toBe("fork-x");
      // Existing fork-x has step_seq=7, so the next is 8.
      expect(r.nextStepSeq).toBe(8);
    }
  });

  it("session metadata is populated from the sessions row", () => {
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 1, state: {} });
    const r = buildReplayContextOn(db, "s1");
    if (r.ok) {
      expect(r.session.engine).toBe("claude");
      expect(r.session.model).toBe("opus");
      expect(r.session.employee).toBe("writer");
      expect(r.session.parentSessionId).toBeNull();
      expect(r.session.rootSessionId).toBe("s1");
    }
  });
});

describe("buildReplayContext — leaves original session untouched", () => {
  it("listing checkpoints on 'main' is unaffected after a replay context build", () => {
    const db = freshDb();
    insertSession(db, "s1");
    writeCheckpointOn(db, { sessionId: "s1", stepSeq: 1, state: { persona: "p" } });
    const before = listCheckpointsOn(db, "s1", { branch: "main" });
    const ctx = buildReplayContextOn(db, "s1", { toBranch: "fork-y" });
    expect(ctx.ok).toBe(true);
    const after = listCheckpointsOn(db, "s1", { branch: "main" });
    expect(after.map((c) => `${c.stepSeq}:${c.state.persona as string}`)).toEqual(
      before.map((c) => `${c.stepSeq}:${c.state.persona as string}`),
    );
    // No fork-y rows written either — context build is a read-only operation.
    expect(listCheckpointsOn(db, "s1", { branch: "fork-y" })).toHaveLength(0);
  });
});
