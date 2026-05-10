import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrateSessionsSchema } from "../registry.js";
import { initEventsSchema } from "../../events/db.js";
import { initHandlerRegistry, dispatchEventHandlers, DEFAULT_HANDLERS } from "../../events/handlers.js";
import { emitEventOn } from "../../events/emit.js";
import {
  buildSessionResult,
  finalizeSessionOn,
  getExistingResult,
} from "../result.js";

// PR3 tests use an in-memory DB. finalizeSessionOn writes via
// emitEventOn (no auto-dispatch) and returns the emitted events so the
// integration test can run dispatch explicitly on the same DB. The
// production finalizeSession path uses initDb() + emitAndDispatch, which
// is exercised at the gateway level — not here.

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  // Schema is owned by the migration runner; migrateSessionsSchema (compat
  // shim) applies every baseline migration. The trailing init* calls are
  // no-ops kept for documentation parity.
  migrateSessionsSchema(db);
  initEventsSchema(db);
  initHandlerRegistry(db);
  return db;
}

const OPS_DDL: string[] = [
  `CREATE TABLE performance_log (
    id TEXT PRIMARY KEY,
    employee TEXT NOT NULL,
    department TEXT NOT NULL,
    task_type TEXT NOT NULL,
    task_ref TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'blocked')),
    quality TEXT CHECK (quality IN ('poor', 'fair', 'good', 'excellent')),
    score REAL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE cost_log (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    employee TEXT,
    engine TEXT NOT NULL,
    model TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    trigger_ref TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

function createOpsTables(db: Database.Database): void {
  for (const stmt of OPS_DDL) db.prepare(stmt).run();
}

function insertSession(
  db: Database.Database,
  id: string,
  parent: string | null,
  extra: Partial<{ employee: string; engine: string; model: string; title: string; source: string }> = {},
): void {
  let root = id;
  if (parent) {
    const parentRow = db
      .prepare("SELECT root_session_id FROM sessions WHERE id = ?")
      .get(parent) as { root_session_id?: string } | undefined;
    root = parentRow?.root_session_id ?? parent;
  }
  db.prepare(`
    INSERT INTO sessions (id, engine, source, source_ref, parent_session_id, root_session_id, employee, model, title, created_at, last_activity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-05-07T00:00:00.000Z', '2026-05-07T00:00:00.000Z')
  `).run(
    id,
    extra.engine ?? "claude",
    extra.source ?? "test",
    `test:${id}`,
    parent,
    root,
    extra.employee ?? null,
    extra.model ?? null,
    extra.title ?? null,
  );
}

describe("buildSessionResult — counter derivation", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertSession(db, "s1", null);
  });

  it("counts tool_invoked and skill_invoked into step_count, tool_invoked alone into tool_call_count", () => {
    emitEventOn(db, "s1", "tool_invoked", { tool: "Read", call_id: "c1", args: {} });
    emitEventOn(db, "s1", "tool_invoked", { tool: "Bash", call_id: "c2", args: {} });
    emitEventOn(db, "s1", "skill_invoked", { skill: "investigate", args_summary: "x" });
    // Non-step events shouldn't be counted.
    emitEventOn(db, "s1", "assistant_message", { text: "hi", message_id: "m1" });

    const r = buildSessionResult(db, "s1", { state: "completed" });
    expect(r.stepCount).toBe(3);
    expect(r.toolCallCount).toBe(2);
  });

  it("zero-event session yields zero counters", () => {
    const r = buildSessionResult(db, "s1", { state: "completed" });
    expect(r.stepCount).toBe(0);
    expect(r.toolCallCount).toBe(0);
  });

  it("counters are scoped per-session — sibling activity doesn't bleed in", () => {
    insertSession(db, "s2", null);
    emitEventOn(db, "s2", "tool_invoked", { tool: "Read", call_id: "c1", args: {} });
    emitEventOn(db, "s1", "tool_invoked", { tool: "Bash", call_id: "c2", args: {} });

    const r = buildSessionResult(db, "s1", { state: "completed" });
    expect(r.toolCallCount).toBe(1);
  });

  it("propagates engine-supplied tokens / duration / cost / messages onto the result", () => {
    const r = buildSessionResult(db, "s1", {
      state: "completed",
      tokensIn: 1234,
      tokensOut: 567,
      durationMs: 8910,
      costUsd: 0.42,
      finalAnswer: "done",
      errorMessage: null,
    });
    expect(r).toMatchObject({
      sessionId: "s1",
      state: "completed",
      tokensIn: 1234,
      tokensOut: 567,
      durationMs: 8910,
      costUsd: 0.42,
      finalAnswer: "done",
      errorMessage: null,
    });
  });

  it("missing engine numbers default to safe zeros / nulls", () => {
    const r = buildSessionResult(db, "s1", { state: "error" });
    expect(r.tokensIn).toBe(0);
    expect(r.tokensOut).toBe(0);
    expect(r.durationMs).toBe(0);
    expect(r.costUsd).toBe(null);
    expect(r.finalAnswer).toBe(null);
    expect(r.errorMessage).toBe(null);
  });
});

describe("finalizeSessionOn — primary emit + payload shape", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertSession(db, "s1", null);
  });

  it("emits a session_completed event with the SessionResult payload", () => {
    const { result, primaryEvent } = finalizeSessionOn(db, "s1", {
      state: "completed",
      tokensIn: 100,
      tokensOut: 50,
      durationMs: 1234,
      costUsd: 0.21,
      finalAnswer: "ok",
    });
    expect(primaryEvent).not.toBeNull();
    expect(primaryEvent!.kind).toBe("session_completed");
    expect(primaryEvent!.payload).toMatchObject({
      state: "completed",
      tokens_in: 100,
      tokens_out: 50,
      duration_ms: 1234,
      cost_usd: 0.21,
      step_count: 0,
      tool_call_count: 0,
      final_answer: "ok",
      error_message: null,
    });
    expect(result.sessionId).toBe("s1");
  });

  it("emits an error-state result without an answer", () => {
    const { primaryEvent } = finalizeSessionOn(db, "s1", {
      state: "error",
      errorMessage: "boom",
    });
    expect(primaryEvent!.payload).toMatchObject({
      state: "error",
      error_message: "boom",
      final_answer: null,
    });
  });
});

describe("finalizeSessionOn — idempotency", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertSession(db, "s1", null);
  });

  it("second finalize returns the cached result without re-emitting", () => {
    const first = finalizeSessionOn(db, "s1", {
      state: "completed",
      tokensIn: 10,
      tokensOut: 20,
      finalAnswer: "first",
    });
    expect(first.alreadyFinalized).toBe(false);
    expect(first.primaryEvent).not.toBeNull();

    const second = finalizeSessionOn(db, "s1", {
      state: "error",  // would be different if not idempotent
      tokensIn: 999,
      finalAnswer: "second",
    });
    expect(second.alreadyFinalized).toBe(true);
    expect(second.primaryEvent).toBeNull();
    // Cached result reflects the FIRST finalize, not the second's args.
    expect(second.result.state).toBe("completed");
    expect(second.result.tokensIn).toBe(10);
    expect(second.result.finalAnswer).toBe("first");

    const eventCount = (db.prepare(
      "SELECT count(*) AS n FROM session_events WHERE session_id = 's1' AND kind = 'session_completed'"
    ).get() as { n: number }).n;
    expect(eventCount).toBe(1);
  });

  it("getExistingResult returns the cached SessionResult after finalize", () => {
    expect(getExistingResult(db, "s1")).toBeNull();
    finalizeSessionOn(db, "s1", { state: "completed", tokensIn: 5 });
    const cached = getExistingResult(db, "s1");
    expect(cached).not.toBeNull();
    expect(cached!.state).toBe("completed");
    expect(cached!.tokensIn).toBe(5);
  });
});

describe("finalizeSessionOn — parent subagent_completed", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertSession(db, "parent", null);
    insertSession(db, "child", "parent", { employee: "synthesizer" });
  });

  it("emits subagent_completed on the parent when quality+outcome supplied", () => {
    const { subagentEvent } = finalizeSessionOn(db, "child", {
      state: "completed",
      quality: "excellent",
      outcome: "success",
    });
    expect(subagentEvent).not.toBeNull();
    expect(subagentEvent!.sessionId).toBe("parent");
    expect(subagentEvent!.kind).toBe("subagent_completed");
    expect(subagentEvent!.payload).toMatchObject({
      child_session_id: "child",
      quality: "excellent",
      outcome: "success",
    });
  });

  it("does NOT emit subagent_completed when only quality is supplied", () => {
    const { subagentEvent } = finalizeSessionOn(db, "child", {
      state: "completed",
      quality: "good",
    });
    expect(subagentEvent).toBeNull();
  });

  it("does NOT emit subagent_completed for a top-level (parent-less) session", () => {
    insertSession(db, "lone", null);
    const { subagentEvent } = finalizeSessionOn(db, "lone", {
      state: "completed",
      quality: "good",
      outcome: "success",
    });
    expect(subagentEvent).toBeNull();
  });
});

describe("PR3 + PR2.D integration — handler chain autofills cost_log + performance_log", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    createOpsTables(db);
    insertSession(db, "parent", null);
    insertSession(db, "child", "parent", {
      employee: "writer",
      engine: "claude",
      model: "opus",
    });
  });

  it("finalize → cost_log row populated from session_completed", async () => {
    const { primaryEvent } = finalizeSessionOn(db, "child", {
      state: "completed",
      tokensIn: 1000,
      tokensOut: 500,
      costUsd: 0.55,
    });
    // Drive PR2.D dispatch on the in-memory DB explicitly.
    await dispatchEventHandlers(db, primaryEvent!, {
      registry: DEFAULT_HANDLERS,
      flagConfig: { cost_log: true },
    });

    const rows = db.prepare("SELECT * FROM cost_log").all() as Array<{
      session_id: string; input_tokens: number; output_tokens: number; cost_usd: number;
      engine: string; model: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("child");
    expect(rows[0].input_tokens).toBe(1000);
    expect(rows[0].output_tokens).toBe(500);
    expect(rows[0].cost_usd).toBe(0.55);
    expect(rows[0].engine).toBe("claude");
    expect(rows[0].model).toBe("opus");
  });

  it("finalize with quality+outcome → performance_log row populated on parent's subagent_completed", async () => {
    const { subagentEvent } = finalizeSessionOn(db, "child", {
      state: "completed",
      quality: "excellent",
      outcome: "success",
    });
    await dispatchEventHandlers(db, subagentEvent!, {
      registry: DEFAULT_HANDLERS,
      flagConfig: { performance_archive: true },
    });

    const rows = db.prepare("SELECT * FROM performance_log").all() as Array<{
      employee: string; outcome: string; quality: string; task_ref: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].employee).toBe("writer");
    expect(rows[0].quality).toBe("excellent");
    expect(rows[0].outcome).toBe("succeeded");
    expect(rows[0].task_ref).toBe("child");
  });

  it("double-finalize does NOT duplicate cost_log rows", async () => {
    const first = finalizeSessionOn(db, "child", {
      state: "completed", tokensIn: 100, tokensOut: 50, costUsd: 0.1,
    });
    await dispatchEventHandlers(db, first.primaryEvent!, {
      registry: DEFAULT_HANDLERS, flagConfig: { cost_log: true },
    });

    const second = finalizeSessionOn(db, "child", {
      state: "error", tokensIn: 999, tokensOut: 999, costUsd: 9.99,
    });
    expect(second.alreadyFinalized).toBe(true);
    expect(second.primaryEvent).toBeNull();
    // Nothing to dispatch on the second call — primaryEvent is null,
    // so no fresh cost_log insert happens.

    const count = (db.prepare("SELECT count(*) AS n FROM cost_log").get() as { n: number }).n;
    expect(count).toBe(1);
  });
});
