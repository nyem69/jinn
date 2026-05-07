import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrateSessionsSchema } from "../../sessions/registry.js";
import { initEventsSchema } from "../db.js";
import { emitEventOn } from "../emit.js";
import {
  DEFAULT_HANDLERS,
  dispatchEventHandlers,
  initHandlerRegistry,
  type HandlerSpec,
} from "../handlers.js";
import { recordDlqFailure, activeDlqDepth, markDlqRetried } from "../dlq.js";

// Handler tests use an in-memory DB with all the ops tables the
// handlers write to. Each test sets up only the tables its handler
// touches; the dispatcher tests use synthetic test handlers (via
// opts.registry) so they don't depend on the default 7.

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
  `CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    employee TEXT NOT NULL,
    task_type TEXT NOT NULL,
    task_summary TEXT NOT NULL,
    input_context TEXT,
    output_summary TEXT NOT NULL,
    quality TEXT NOT NULL CHECK (quality IN ('good', 'excellent')),
    tags TEXT NOT NULL DEFAULT '[]',
    lesson_learned TEXT,
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
  `CREATE TABLE report_archive (
    id TEXT PRIMARY KEY,
    report_type TEXT NOT NULL,
    delivery_id TEXT,
    topics TEXT NOT NULL DEFAULT '[]',
    headlines TEXT NOT NULL DEFAULT '[]',
    coverage_date TEXT NOT NULL,
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

describe("dispatchEventHandlers — registry filtering + flag gating", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertSession(db, "s1", null);
  });

  it("only fires handlers whose kinds include the event kind", async () => {
    const fired: string[] = [];
    const a: HandlerSpec = {
      name: "a",
      kinds: ["assistant_message"],
      timeoutMs: 1000,
      defaultEnabled: true,
      run: async () => { fired.push("a"); },
    };
    const b: HandlerSpec = {
      name: "b",
      kinds: ["session_started"],
      timeoutMs: 1000,
      defaultEnabled: true,
      run: async () => { fired.push("b"); },
    };
    db.prepare("INSERT INTO event_handlers (kind_filter, processor) VALUES (?, ?)").run("assistant_message", "a");
    db.prepare("INSERT INTO event_handlers (kind_filter, processor) VALUES (?, ?)").run("session_started", "b");

    const r = emitEventOn(db, "s1", "assistant_message", { text: "hi", message_id: "m" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const result = await dispatchEventHandlers(db, r.event, { registry: [a, b] });
    expect(fired).toEqual(["a"]);
    expect(result.fired).toBe(1);
  });

  it("'*' kind matches every event", async () => {
    const fired: string[] = [];
    const wild: HandlerSpec = {
      name: "wild",
      kinds: ["*"],
      timeoutMs: 1000,
      defaultEnabled: true,
      run: async ({ event }) => { fired.push(event.kind); },
    };
    db.prepare("INSERT INTO event_handlers (kind_filter, processor) VALUES (?, ?)").run("assistant_message", "wild");
    db.prepare("INSERT INTO event_handlers (kind_filter, processor) VALUES (?, ?)").run("session_started", "wild");

    const r1 = emitEventOn(db, "s1", "assistant_message", { text: "hi", message_id: "m" });
    const r2 = emitEventOn(db, "s1", "session_started", { employee: "x", oversight: "VERIFY", brief: "" });
    if (!r1.ok || !r2.ok) throw new Error("emit failed");

    await dispatchEventHandlers(db, r1.event, { registry: [wild] });
    await dispatchEventHandlers(db, r2.event, { registry: [wild] });
    expect(fired).toEqual(["assistant_message", "session_started"]);
  });

  it("flag config disables a handler", async () => {
    const fired: string[] = [];
    const h: HandlerSpec = {
      name: "h",
      kinds: ["assistant_message"],
      timeoutMs: 1000,
      defaultEnabled: true,
      run: async () => { fired.push("h"); },
    };
    db.prepare("INSERT INTO event_handlers (kind_filter, processor) VALUES (?, ?)").run("assistant_message", "h");

    const r = emitEventOn(db, "s1", "assistant_message", { text: "hi", message_id: "m" });
    if (!r.ok) throw new Error("emit failed");

    const result = await dispatchEventHandlers(db, r.event, {
      registry: [h],
      flagConfig: { h: false },
    });
    expect(fired).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it("explicit flag=true overrides defaultEnabled=false", async () => {
    const fired: string[] = [];
    const h: HandlerSpec = {
      name: "off-by-default",
      kinds: ["assistant_message"],
      timeoutMs: 1000,
      defaultEnabled: false,
      run: async () => { fired.push("h"); },
    };
    db.prepare("INSERT INTO event_handlers (kind_filter, processor) VALUES (?, ?)")
      .run("assistant_message", "off-by-default");

    const r = emitEventOn(db, "s1", "assistant_message", { text: "hi", message_id: "m" });
    if (!r.ok) throw new Error("emit failed");

    await dispatchEventHandlers(db, r.event, {
      registry: [h],
      flagConfig: { "off-by-default": true },
    });
    expect(fired).toEqual(["h"]);
  });

  it("DB-level status='disabled' skips handler regardless of flag", async () => {
    const fired: string[] = [];
    const h: HandlerSpec = {
      name: "h",
      kinds: ["assistant_message"],
      timeoutMs: 1000,
      defaultEnabled: true,
      run: async () => { fired.push("h"); },
    };
    db.prepare("INSERT INTO event_handlers (kind_filter, processor, status) VALUES (?, ?, 'disabled')")
      .run("assistant_message", "h");

    const r = emitEventOn(db, "s1", "assistant_message", { text: "hi", message_id: "m" });
    if (!r.ok) throw new Error("emit failed");

    await dispatchEventHandlers(db, r.event, { registry: [h], flagConfig: { h: true } });
    expect(fired).toHaveLength(0);
  });

  it("shouldFire filter blocks dispatch even when matched", async () => {
    const fired: string[] = [];
    const h: HandlerSpec = {
      name: "picky",
      kinds: ["assistant_message"],
      timeoutMs: 1000,
      defaultEnabled: true,
      shouldFire: ({ event }) => (event.payload as { text?: string })?.text === "yes",
      run: async () => { fired.push("h"); },
    };
    db.prepare("INSERT INTO event_handlers (kind_filter, processor) VALUES (?, ?)")
      .run("assistant_message", "picky");

    const a = emitEventOn(db, "s1", "assistant_message", { text: "no", message_id: "m1" });
    const b = emitEventOn(db, "s1", "assistant_message", { text: "yes", message_id: "m2" });
    if (!a.ok || !b.ok) throw new Error("emit failed");

    await dispatchEventHandlers(db, a.event, { registry: [h] });
    await dispatchEventHandlers(db, b.event, { registry: [h] });
    expect(fired).toEqual(["h"]);
  });
});

describe("dispatchEventHandlers — failure + DLQ + auto-disable", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertSession(db, "s1", null);
  });

  it("failure inserts a DLQ row with the error message", async () => {
    const h: HandlerSpec = {
      name: "boom",
      kinds: ["assistant_message"],
      timeoutMs: 1000,
      defaultEnabled: true,
      run: async () => { throw new Error("nope"); },
    };
    db.prepare("INSERT INTO event_handlers (kind_filter, processor) VALUES (?, ?)").run("assistant_message", "boom");

    const r = emitEventOn(db, "s1", "assistant_message", { text: "hi", message_id: "m" });
    if (!r.ok) throw new Error("emit failed");

    const result = await dispatchEventHandlers(db, r.event, { registry: [h] });
    expect(result.failed).toBe(1);

    const dlq = db.prepare("SELECT * FROM event_dlq").all() as Array<{ error: string }>;
    expect(dlq).toHaveLength(1);
    expect(dlq[0].error).toBe("nope");
  });

  it("5 consecutive same-error failures auto-disable the handler", async () => {
    const h: HandlerSpec = {
      name: "always-fails",
      kinds: ["assistant_message"],
      timeoutMs: 1000,
      defaultEnabled: true,
      run: async () => { throw new Error("deterministic"); },
    };
    db.prepare("INSERT INTO event_handlers (kind_filter, processor) VALUES (?, ?)")
      .run("assistant_message", "always-fails");

    for (let i = 0; i < 5; i++) {
      const r = emitEventOn(db, "s1", "assistant_message", { text: `t${i}`, message_id: `m${i}` });
      if (!r.ok) throw new Error("emit failed");
      await dispatchEventHandlers(db, r.event, {
        registry: [h],
        // High threshold so dlq_alert recursion path doesn't fire. Tested separately.
        dlqThreshold: 1000,
      });
    }

    const row = db
      .prepare("SELECT status FROM event_handlers WHERE processor = 'always-fails'")
      .get() as { status: string };
    expect(row.status).toBe("disabled");
  });

  it("4 same-error failures keep handler active (threshold is exactly 5)", async () => {
    const h: HandlerSpec = {
      name: "fails-4",
      kinds: ["assistant_message"],
      timeoutMs: 1000,
      defaultEnabled: true,
      run: async () => { throw new Error("err"); },
    };
    db.prepare("INSERT INTO event_handlers (kind_filter, processor) VALUES (?, ?)")
      .run("assistant_message", "fails-4");

    for (let i = 0; i < 4; i++) {
      const r = emitEventOn(db, "s1", "assistant_message", { text: `t${i}`, message_id: `m${i}` });
      if (!r.ok) throw new Error("emit failed");
      await dispatchEventHandlers(db, r.event, { registry: [h], dlqThreshold: 1000 });
    }
    const row = db
      .prepare("SELECT status FROM event_handlers WHERE processor = 'fails-4'")
      .get() as { status: string };
    expect(row.status).toBe("active");
  });

  it("mixed errors do NOT auto-disable (consecutive-same-error rule)", async () => {
    let i = 0;
    const h: HandlerSpec = {
      name: "varies",
      kinds: ["assistant_message"],
      timeoutMs: 1000,
      defaultEnabled: true,
      run: async () => { throw new Error(`err-${i++}`); },
    };
    db.prepare("INSERT INTO event_handlers (kind_filter, processor) VALUES (?, ?)")
      .run("assistant_message", "varies");

    for (let j = 0; j < 5; j++) {
      const r = emitEventOn(db, "s1", "assistant_message", { text: `t${j}`, message_id: `m${j}` });
      if (!r.ok) throw new Error("emit failed");
      await dispatchEventHandlers(db, r.event, { registry: [h], dlqThreshold: 1000 });
    }
    const row = db
      .prepare("SELECT status FROM event_handlers WHERE processor = 'varies'")
      .get() as { status: string };
    expect(row.status).toBe("active");
  });

  it("timeout fails the handler and lands in DLQ", async () => {
    const h: HandlerSpec = {
      name: "slow",
      kinds: ["assistant_message"],
      timeoutMs: 50,
      defaultEnabled: true,
      run: () => new Promise((resolve) => setTimeout(resolve, 500)),
    };
    db.prepare("INSERT INTO event_handlers (kind_filter, processor) VALUES (?, ?)").run("assistant_message", "slow");

    const r = emitEventOn(db, "s1", "assistant_message", { text: "hi", message_id: "m" });
    if (!r.ok) throw new Error("emit failed");

    const result = await dispatchEventHandlers(db, r.event, { registry: [h] });
    expect(result.failed).toBe(1);

    const dlq = db.prepare("SELECT error FROM event_dlq").all() as Array<{ error: string }>;
    expect(dlq[0].error).toMatch(/timed out/);
  });
});

describe("dispatchEventHandlers — dlq_alert recursion path", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
    insertSession(db, "s1", null);
  });

  it("fires dlq_alert (synthetic event) when DLQ depth exceeds threshold", async () => {
    const failed: HandlerSpec = {
      name: "broken",
      kinds: ["assistant_message"],
      timeoutMs: 1000,
      defaultEnabled: true,
      run: async () => { throw new Error("X"); },
    };
    let alertFired = 0;
    const alert: HandlerSpec = {
      name: "dlq_alert",
      kinds: ["dlq_threshold_exceeded"],
      timeoutMs: 1000,
      defaultEnabled: true,
      run: async ({ event }) => {
        alertFired++;
        const p = event.payload as { depth: number; threshold: number };
        expect(p.depth).toBeGreaterThan(p.threshold);
      },
    };
    db.prepare("INSERT INTO event_handlers (kind_filter, processor) VALUES (?, ?)").run("assistant_message", "broken");
    // ('dlq_threshold_exceeded', 'dlq_alert') is pre-seeded by initHandlerRegistry.

    // We need a real session_events row to satisfy the FK on event_dlq.event_id.
    const seed = emitEventOn(db, "s1", "assistant_message", { text: "seed", message_id: "seed" });
    if (!seed.ok) throw new Error("seed emit failed");
    const handlerId = (db.prepare(
      "SELECT id FROM event_handlers WHERE processor = 'broken' LIMIT 1"
    ).get() as { id: number }).id;

    // Pre-load DLQ to put us right at the threshold so the very next
    // failure crosses it.
    for (let i = 0; i < 2; i++) recordDlqFailure(db, handlerId, seed.event.id, `seed-${i}`);
    expect(activeDlqDepth(db)).toBe(2);

    const r = emitEventOn(db, "s1", "assistant_message", { text: "hi", message_id: "m" });
    if (!r.ok) throw new Error("emit failed");

    await dispatchEventHandlers(db, r.event, {
      registry: [failed, alert],
      dlqThreshold: 2,
    });
    expect(alertFired).toBe(1);
  });

  it("does NOT recurse into another threshold check when alert handler itself fails", async () => {
    let alertCallCount = 0;
    const alert: HandlerSpec = {
      name: "dlq_alert",
      kinds: ["dlq_threshold_exceeded"],
      timeoutMs: 1000,
      defaultEnabled: true,
      run: async () => {
        alertCallCount++;
        throw new Error("alert broke");
      },
    };
    const failed: HandlerSpec = {
      name: "broken",
      kinds: ["assistant_message"],
      timeoutMs: 1000,
      defaultEnabled: true,
      run: async () => { throw new Error("primary"); },
    };
    db.prepare("INSERT INTO event_handlers (kind_filter, processor) VALUES (?, ?)").run("assistant_message", "broken");
    // ('dlq_threshold_exceeded', 'dlq_alert') is pre-seeded.

    const seed = emitEventOn(db, "s1", "assistant_message", { text: "seed", message_id: "seed" });
    if (!seed.ok) throw new Error("seed emit failed");
    const brokenId = (db.prepare(
      "SELECT id FROM event_handlers WHERE processor = 'broken' LIMIT 1"
    ).get() as { id: number }).id;

    for (let i = 0; i < 5; i++) recordDlqFailure(db, brokenId, seed.event.id, `s-${i}`);

    const r = emitEventOn(db, "s1", "assistant_message", { text: "hi", message_id: "m" });
    if (!r.ok) throw new Error("emit failed");

    await dispatchEventHandlers(db, r.event, {
      registry: [failed, alert],
      dlqThreshold: 2,
    });
    expect(alertCallCount).toBe(1);
  });
});

describe("default handler: performance_archive", () => {
  let db: Database.Database;
  const h = DEFAULT_HANDLERS.find((x) => x.name === "performance_archive")!;
  beforeEach(() => {
    db = freshDb();
    createOpsTables(db);
    insertSession(db, "parent", null);
    insertSession(db, "child", "parent", { employee: "chief-analyst", source: "delegation" });
  });

  it("inserts a performance_log row on subagent_completed", async () => {
    const r = emitEventOn(db, "parent", "subagent_completed", {
      child_session_id: "child",
      quality: "good",
      outcome: "success",
    });
    if (!r.ok) throw new Error("emit failed");

    await dispatchEventHandlers(db, r.event, { registry: [h], flagConfig: { performance_archive: true } });

    const rows = db.prepare("SELECT * FROM performance_log").all() as Array<{
      employee: string; outcome: string; quality: string; task_ref: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].employee).toBe("chief-analyst");
    expect(rows[0].outcome).toBe("succeeded");
    expect(rows[0].quality).toBe("good");
    expect(rows[0].task_ref).toBe("child");
  });

  it("skips when child session has no employee", async () => {
    insertSession(db, "child2", "parent", { source: "delegation" });
    const r = emitEventOn(db, "parent", "subagent_completed", {
      child_session_id: "child2",
      quality: "good",
      outcome: "success",
    });
    if (!r.ok) throw new Error("emit failed");
    await dispatchEventHandlers(db, r.event, { registry: [h], flagConfig: { performance_archive: true } });
    const count = (db.prepare("SELECT count(*) AS n FROM performance_log").get() as { n: number }).n;
    expect(count).toBe(0);
  });
});

describe("default handler: episode_capture", () => {
  let db: Database.Database;
  const h = DEFAULT_HANDLERS.find((x) => x.name === "episode_capture")!;
  beforeEach(() => {
    db = freshDb();
    createOpsTables(db);
    insertSession(db, "parent", null);
    insertSession(db, "child", "parent", { employee: "synthesizer", title: "investigation: x" });
  });

  it("inserts episode row only on quality=excellent", async () => {
    const goodEv = emitEventOn(db, "parent", "subagent_completed", {
      child_session_id: "child", quality: "good", outcome: "success",
    });
    const excellentEv = emitEventOn(db, "parent", "subagent_completed", {
      child_session_id: "child", quality: "excellent", outcome: "success",
    });
    if (!goodEv.ok || !excellentEv.ok) throw new Error("emit failed");

    await dispatchEventHandlers(db, goodEv.event, { registry: [h], flagConfig: { episode_capture: true } });
    expect((db.prepare("SELECT count(*) AS n FROM episodes").get() as { n: number }).n).toBe(0);

    await dispatchEventHandlers(db, excellentEv.event, { registry: [h], flagConfig: { episode_capture: true } });
    const rows = db.prepare("SELECT * FROM episodes").all() as Array<{
      employee: string; quality: string; task_summary: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].employee).toBe("synthesizer");
    expect(rows[0].quality).toBe("excellent");
    expect(rows[0].task_summary).toBe("investigation: x");
  });
});

describe("default handler: cost_log", () => {
  let db: Database.Database;
  const h = DEFAULT_HANDLERS.find((x) => x.name === "cost_log")!;
  beforeEach(() => {
    db = freshDb();
    createOpsTables(db);
    insertSession(db, "s1", null, { employee: "writer", engine: "claude", model: "opus" });
  });

  it("inserts cost_log row with tokens + cost from payload", async () => {
    const r = emitEventOn(db, "s1", "session_completed", {
      state: "completed",
      tokens_in: 100,
      tokens_out: 50,
      duration_ms: 1234,
      cost_usd: 0.42,
      step_count: 3,
      tool_call_count: 2,
      final_answer: "done",
      error_message: null,
    });
    if (!r.ok) throw new Error("emit failed");

    await dispatchEventHandlers(db, r.event, { registry: [h], flagConfig: { cost_log: true } });
    const rows = db.prepare("SELECT * FROM cost_log").all() as Array<{
      session_id: string; employee: string; engine: string; model: string;
      input_tokens: number; output_tokens: number; cost_usd: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("s1");
    expect(rows[0].input_tokens).toBe(100);
    expect(rows[0].output_tokens).toBe(50);
    expect(rows[0].cost_usd).toBe(0.42);
    expect(rows[0].engine).toBe("claude");
    expect(rows[0].model).toBe("opus");
  });
});

describe("default handler: report_archive", () => {
  let db: Database.Database;
  const h = DEFAULT_HANDLERS.find((x) => x.name === "report_archive")!;
  beforeEach(() => {
    db = freshDb();
    createOpsTables(db);
  });

  it("fires only when title looks like a report skill", async () => {
    insertSession(db, "non-report", null, { title: "ad-hoc chat" });
    insertSession(db, "report", null, { title: "weekly-digest run" });

    for (const id of ["non-report", "report"]) {
      const r = emitEventOn(db, id, "session_completed", {
        state: "completed", tokens_in: 0, tokens_out: 0, duration_ms: 0,
        cost_usd: null, step_count: 0, tool_call_count: 0,
        final_answer: null, error_message: null,
      });
      if (!r.ok) throw new Error("emit failed");
      await dispatchEventHandlers(db, r.event, { registry: [h], flagConfig: { report_archive: true } });
    }

    const rows = db.prepare("SELECT * FROM report_archive").all() as Array<{ report_type: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].report_type).toBe("weekly-digest");
  });
});

describe("initHandlerRegistry — idempotent seeding", () => {
  it("seeds 7 default handlers (one row per (kind, processor))", () => {
    const db = freshDb();
    const rows = db.prepare(
      "SELECT processor, kind_filter FROM event_handlers ORDER BY processor, kind_filter",
    ).all() as Array<{ processor: string; kind_filter: string }>;
    const processors = new Set(rows.map((r) => r.processor));
    expect(processors.size).toBe(7);
    expect(processors).toEqual(new Set([
      "performance_archive", "episode_capture", "cost_log",
      "report_archive", "kg_extraction", "watchpoint_extract", "dlq_alert",
    ]));
  });

  it("re-running seed does not create duplicates", () => {
    const db = freshDb();
    const before = (db.prepare("SELECT count(*) AS n FROM event_handlers").get() as { n: number }).n;
    initHandlerRegistry(db);
    initHandlerRegistry(db);
    const after = (db.prepare("SELECT count(*) AS n FROM event_handlers").get() as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe("dlq helpers", () => {
  // dlq tests need a real session + event row to satisfy the FK
  // constraints on event_dlq (event_id, handler_id).
  function dlqDb(): { db: Database.Database; eventId: number; handlerId: number } {
    const db = freshDb();
    insertSession(db, "s1", null);
    const ev = emitEventOn(db, "s1", "assistant_message", { text: "x", message_id: "m" });
    if (!ev.ok) throw new Error("emit failed");
    const handlerId = (db.prepare(
      "SELECT id FROM event_handlers WHERE processor = 'cost_log' LIMIT 1"
    ).get() as { id: number }).id;
    return { db, eventId: ev.event.id, handlerId };
  }

  it("recordDlqFailure inserts a row and exposes it via activeDlqDepth", () => {
    const { db, eventId, handlerId } = dlqDb();
    expect(activeDlqDepth(db)).toBe(0);
    const a = recordDlqFailure(db, handlerId, eventId, "x");
    expect(a.dlqId).toBeGreaterThan(0);
    expect(a.autoDisabled).toBe(false);
    expect(activeDlqDepth(db)).toBe(1);
  });

  it("markDlqRetried excludes the row from activeDlqDepth", () => {
    const { db, eventId, handlerId } = dlqDb();
    const a = recordDlqFailure(db, handlerId, eventId, "x");
    expect(activeDlqDepth(db)).toBe(1);
    markDlqRetried(db, a.dlqId);
    expect(activeDlqDepth(db)).toBe(0);
  });

  it("autoDisable flips the handler row after 5 same-error inserts", () => {
    const { db, eventId, handlerId } = dlqDb();
    for (let i = 0; i < 4; i++) {
      const r = recordDlqFailure(db, handlerId, eventId, "same");
      expect(r.autoDisabled).toBe(false);
    }
    const fifth = recordDlqFailure(db, handlerId, eventId, "same");
    expect(fifth.autoDisabled).toBe(true);
    const status = (db.prepare(
      "SELECT status FROM event_handlers WHERE id = ?"
    ).get(handlerId) as { status: string }).status;
    expect(status).toBe("disabled");
  });
});
