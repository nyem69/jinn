import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateSessionsSchema } from "../../../sessions/registry.js";
import { initEventsSchema } from "../../../events/db.js";
import { initHandlerRegistry } from "../../../events/handlers.js";
import { getExistingResult } from "../../../sessions/result.js";
import {
  ClaudeStreamParser,
  parseTranscript,
  type ParserOpts,
} from "../parser.js";
import {
  dispatchParserOutputOn,
  getClaudeTransport,
} from "../emitter.js";

// Round-trip: parse fixture → dispatch every parser output onto an
// in-memory DB → assert that getExistingResult returns a SessionResult
// matching the fixture's terminal state. The session_events row count +
// kinds also have to match the parsed event stream exactly.

const __filename = fileURLToPath(import.meta.url);
const FIXTURES_DIR = path.join(path.dirname(__filename), "..", "__fixtures__");

function loadFixture(name: string): string[] {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
  return raw.split("\n").filter((l) => l.trim().length > 0);
}

function makeClock(start = 1000, step = 100): () => number {
  let t = start;
  return () => {
    const cur = t;
    t += step;
    return cur;
  };
}

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

function insertSession(db: Database.Database, id: string): void {
  db.prepare(`
    INSERT INTO sessions (id, engine, source, source_ref, root_session_id, created_at, last_activity)
    VALUES (?, 'claude', 'test', ?, ?, '2026-05-07T00:00:00.000Z', '2026-05-07T00:00:00.000Z')
  `).run(id, `test:${id}`, id);
}

function runFixture(
  db: Database.Database,
  sessionId: string,
  fixture: string,
  parserOpts: ParserOpts = { now: makeClock() },
): {
  eventKinds: string[];
} {
  const lines = loadFixture(fixture);
  const { outputs } = parseTranscript(lines, parserOpts);
  const eventKinds: string[] = [];
  for (const out of outputs) {
    dispatchParserOutputOn(db, sessionId, out);
    if (out.type === "event") eventKinds.push(out.kind);
  }
  return { eventKinds };
}

describe("round-trip: parse fixture → emit → SessionResult", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("simple-text — completed, tokens + final answer match fixture", () => {
    insertSession(db, "sim-simple");
    runFixture(db, "sim-simple", "simple-text.jsonl");

    const r = getExistingResult(db, "sim-simple");
    expect(r).not.toBeNull();
    expect(r!.state).toBe("completed");
    expect(r!.tokensIn).toBe(10);
    expect(r!.tokensOut).toBe(3);
    expect(r!.durationMs).toBe(420);
    expect(r!.costUsd).toBe(0.0008);
    expect(r!.finalAnswer).toBe("Hello world.");
    expect(r!.toolCallCount).toBe(0);
    expect(r!.stepCount).toBe(0);
  });

  it("multi-tool-success — derived counters match emitted tool_invoked count", () => {
    insertSession(db, "sim-multi");
    runFixture(db, "sim-multi", "multi-tool-success.jsonl");

    const r = getExistingResult(db, "sim-multi");
    expect(r!.state).toBe("completed");
    expect(r!.tokensIn).toBe(75);
    expect(r!.tokensOut).toBe(26);
    // 3 tool_invoked → tool_call_count = 3, step_count = 3 + 0 (no skill_invoked)
    expect(r!.toolCallCount).toBe(3);
    expect(r!.stepCount).toBe(3);
    expect(r!.finalAnswer).toBe("Done.");
  });

  it("tool-error — completed result, error preserved on the tool_completed event", () => {
    insertSession(db, "sim-tool-err");
    runFixture(db, "sim-tool-err", "tool-error.jsonl");

    const r = getExistingResult(db, "sim-tool-err");
    expect(r!.state).toBe("completed");

    // The tool_completed payload should carry the error string verbatim.
    const ev = db.prepare(
      "SELECT payload FROM session_events WHERE session_id = ? AND kind = 'tool_completed' LIMIT 1",
    ).get("sim-tool-err") as { payload: string };
    const parsed = JSON.parse(ev.payload) as { error: string | null; result: unknown };
    expect(parsed.error).toBe("ENOENT: no such file or directory");
    expect(parsed.result).toBeNull();
  });

  it("max-tokens-exit — state=max_iterations with no final answer", () => {
    insertSession(db, "sim-max");
    runFixture(db, "sim-max", "max-tokens-exit.jsonl");

    const r = getExistingResult(db, "sim-max");
    expect(r!.state).toBe("max_iterations");
    expect(r!.tokensIn).toBe(50);
    expect(r!.tokensOut).toBe(4096);
    expect(r!.finalAnswer).toBeNull();
    expect(r!.errorMessage).not.toBeNull();
  });

  it("cancelled — orphan tool_invoked, parser.finalize emits state=cancelled", () => {
    insertSession(db, "sim-cancel");
    const lines = loadFixture("cancelled.jsonl");
    const parser = new ClaudeStreamParser({ now: makeClock() });

    let toolInvokedCount = 0;
    let toolCompletedCount = 0;
    for (const line of lines) {
      for (const out of parser.parse(line)) {
        dispatchParserOutputOn(db, "sim-cancel", out);
        if (out.type === "event" && out.kind === "tool_invoked") toolInvokedCount++;
        if (out.type === "event" && out.kind === "tool_completed") toolCompletedCount++;
      }
    }
    expect(toolInvokedCount).toBe(1);
    expect(toolCompletedCount).toBe(0);
    expect(parser.hasOrphanToolInvocations()).toBe(true);

    // Stream ended without result — caller (engine adapter) finalizes.
    const fin = parser.finalize("cancelled", "user interrupted");
    dispatchParserOutputOn(db, "sim-cancel", fin);

    const r = getExistingResult(db, "sim-cancel");
    expect(r!.state).toBe("cancelled");
    expect(r!.errorMessage).toBe("user interrupted");
    expect(r!.toolCallCount).toBe(1);
  });

  it("subagent-spawn — both subagent_spawned and subagent_completed land in the log", () => {
    insertSession(db, "sim-subagent");
    const { eventKinds } = runFixture(db, "sim-subagent", "subagent-spawn.jsonl");
    expect(eventKinds).toEqual([
      "assistant_message",
      "subagent_spawned",
      "tool_invoked",
      "tool_completed",
      "subagent_completed",
      "assistant_message",
    ]);

    // Persisted log = parser-emitted events + the session_completed
    // row that finalizeSessionOn writes when the result line arrives.
    const persistedKinds = db.prepare(
      "SELECT kind FROM session_events WHERE session_id = ? ORDER BY id ASC",
    ).all("sim-subagent") as Array<{ kind: string }>;
    expect(persistedKinds.map((r) => r.kind)).toEqual([...eventKinds, "session_completed"]);

    const r = getExistingResult(db, "sim-subagent");
    expect(r!.state).toBe("completed");
    expect(r!.toolCallCount).toBe(1);
  });

  it("double finalize is a no-op (PR3 idempotency holds through the parser path)", () => {
    insertSession(db, "sim-simple-2");
    runFixture(db, "sim-simple-2", "simple-text.jsonl");
    const first = getExistingResult(db, "sim-simple-2");

    // Re-run the same fixture; the result line yields a second finalize
    // output. dispatchParserOutputOn → finalizeSessionOn returns the
    // cached result with primaryEvent=null and no new session_completed
    // row gets written.
    runFixture(db, "sim-simple-2", "simple-text.jsonl", { now: makeClock(2000) });

    const completedRows = db.prepare(
      "SELECT count(*) AS n FROM session_events WHERE session_id = ? AND kind = 'session_completed'",
    ).get("sim-simple-2") as { n: number };
    expect(completedRows.n).toBe(1);

    const second = getExistingResult(db, "sim-simple-2");
    expect(second!.tokensIn).toBe(first!.tokensIn);
  });
});

describe("getClaudeTransport", () => {
  it("defaults to 'off' when env is unset", () => {
    expect(getClaudeTransport({})).toBe("off");
  });
  it("recognises 'sideband', 'stdout', 'off' (case-insensitive)", () => {
    expect(getClaudeTransport({ JIN_CLAUDE_EVENT_TRANSPORT: "sideband" })).toBe("sideband");
    expect(getClaudeTransport({ JIN_CLAUDE_EVENT_TRANSPORT: "STDOUT" })).toBe("stdout");
    expect(getClaudeTransport({ JIN_CLAUDE_EVENT_TRANSPORT: "Off" })).toBe("off");
  });
  it("falls back to 'off' on unrecognised values", () => {
    expect(getClaudeTransport({ JIN_CLAUDE_EVENT_TRANSPORT: "yolo" })).toBe("off");
  });
});
