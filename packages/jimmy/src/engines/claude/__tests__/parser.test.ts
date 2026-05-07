import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClaudeStreamParser,
  parseTranscript,
  type ParserOutput,
} from "../parser.js";

// Test fixtures live next to this file in __fixtures__/. We snapshot
// the parsed event stream against expectations defined inline so a
// drift in the parser surface is loud and locatable.

const __filename = fileURLToPath(import.meta.url);
const FIXTURES_DIR = path.join(path.dirname(__filename), "..", "__fixtures__");

function loadFixture(name: string): string[] {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
  return raw.split("\n").filter((l) => l.trim().length > 0);
}

// Deterministic clock for tests that care about durations: t=1000ms at
// parser construction, increments by 100ms per parse() call.
function makeClock(start = 1000, step = 100): () => number {
  let t = start;
  return () => {
    const cur = t;
    t += step;
    return cur;
  };
}

function eventsOnly(out: ParserOutput[]): Array<{ kind: string; payload: Record<string, unknown> }> {
  return out
    .filter((o): o is Extract<ParserOutput, { type: "event" }> => o.type === "event")
    .map((o) => ({ kind: o.kind, payload: o.payload }));
}

function finalizeOnly(out: ParserOutput[]): Extract<ParserOutput, { type: "finalize" }> | undefined {
  return out.find((o): o is Extract<ParserOutput, { type: "finalize" }> => o.type === "finalize");
}

describe("simple-text fixture", () => {
  it("emits one assistant_message and one finalize with completed state", () => {
    const lines = loadFixture("simple-text.jsonl");
    const { outputs } = parseTranscript(lines, { now: makeClock() });

    const events = eventsOnly(outputs);
    expect(events).toEqual([
      {
        kind: "assistant_message",
        payload: { text: "Hello world.", message_id: "msg_01" },
      },
    ]);

    const fin = finalizeOnly(outputs);
    expect(fin).toBeDefined();
    expect(fin!.state).toBe("completed");
    expect(fin!.tokensIn).toBe(10);
    expect(fin!.tokensOut).toBe(3);
    expect(fin!.durationMs).toBe(420);
    expect(fin!.costUsd).toBe(0.0008);
    expect(fin!.finalAnswer).toBe("Hello world.");
    expect(fin!.errorMessage).toBeNull();
  });
});

describe("multi-tool-success fixture", () => {
  const lines = loadFixture("multi-tool-success.jsonl");

  it("pairs three tool_invoked / tool_completed by call_id with no orphans", () => {
    const { outputs, parser } = parseTranscript(lines, { now: makeClock() });
    const events = eventsOnly(outputs);

    const invoked = events.filter((e) => e.kind === "tool_invoked");
    const completed = events.filter((e) => e.kind === "tool_completed");
    expect(invoked).toHaveLength(3);
    expect(completed).toHaveLength(3);

    const invokedIds = invoked.map((e) => (e.payload as { call_id: string }).call_id);
    const completedIds = completed.map((e) => (e.payload as { call_id: string }).call_id);
    expect(new Set(invokedIds)).toEqual(new Set(completedIds));
    expect(parser.hasOrphanToolInvocations()).toBe(false);
  });

  it("preserves tool name + args on tool_invoked; tool_completed carries duration_ms", () => {
    const { outputs } = parseTranscript(lines, { now: makeClock() });
    const events = eventsOnly(outputs);
    const tools = events.filter((e) => e.kind === "tool_invoked").map((e) => e.payload);
    expect(tools).toEqual([
      { tool: "Read", call_id: "toolu_01", args: { file_path: "/tmp/a" } },
      { tool: "Bash", call_id: "toolu_02", args: { command: "ls /tmp" } },
      { tool: "Edit", call_id: "toolu_03", args: { file_path: "/tmp/a", old_string: "x", new_string: "y" } },
    ]);
    const completedDurations = events
      .filter((e) => e.kind === "tool_completed")
      .map((e) => (e.payload as { duration_ms: number }).duration_ms);
    // Each tool result line lands one parser tick after its tool_use,
    // so duration is one step (100ms) under the deterministic clock.
    for (const d of completedDurations) expect(d).toBe(100);
  });

  it("emits two assistant_message events (intro + final 'Done.')", () => {
    const { outputs } = parseTranscript(lines, { now: makeClock() });
    const texts = eventsOnly(outputs)
      .filter((e) => e.kind === "assistant_message")
      .map((e) => (e.payload as { text: string }).text);
    expect(texts).toEqual(["Let me check the file.", "Done."]);
  });

  it("finalize tokens match Claude's reported max-so-far across the run", () => {
    const { outputs } = parseTranscript(lines, { now: makeClock() });
    const fin = finalizeOnly(outputs)!;
    expect(fin.tokensIn).toBe(75);
    expect(fin.tokensOut).toBe(26);
    expect(fin.state).toBe("completed");
    expect(fin.finalAnswer).toBe("Done.");
  });
});

describe("tool-error fixture", () => {
  it("tool_completed.error populated, run still completes", () => {
    const lines = loadFixture("tool-error.jsonl");
    const { outputs } = parseTranscript(lines, { now: makeClock() });
    const events = eventsOnly(outputs);

    const completed = events.find((e) => e.kind === "tool_completed");
    expect(completed).toBeDefined();
    expect(completed!.payload.error).toBe("ENOENT: no such file or directory");
    expect(completed!.payload.result).toBeNull();

    const fin = finalizeOnly(outputs)!;
    expect(fin.state).toBe("completed");
    expect(fin.errorMessage).toBeNull();
  });
});

describe("max-tokens-exit fixture", () => {
  it("finalize state = max_iterations with no final_answer", () => {
    const lines = loadFixture("max-tokens-exit.jsonl");
    const { outputs } = parseTranscript(lines, { now: makeClock() });
    const fin = finalizeOnly(outputs)!;
    expect(fin.state).toBe("max_iterations");
    expect(fin.tokensIn).toBe(50);
    expect(fin.tokensOut).toBe(4096);
    expect(fin.finalAnswer).toBeNull();
    expect(fin.errorMessage).not.toBeNull();
  });
});

describe("cancelled fixture", () => {
  it("orphan tool_invoked, no tool_completed, parser.finalize cancellation", () => {
    const lines = loadFixture("cancelled.jsonl");
    const { outputs, parser } = parseTranscript(lines, { now: makeClock() });
    const events = eventsOnly(outputs);

    const invoked = events.filter((e) => e.kind === "tool_invoked");
    const completed = events.filter((e) => e.kind === "tool_completed");
    expect(invoked).toHaveLength(1);
    expect(completed).toHaveLength(0);

    expect(parser.hasOrphanToolInvocations()).toBe(true);
    expect(parser.orphanToolCallIds()).toEqual(["toolu_01"]);

    // No result line — caller invokes finalize() with state=cancelled.
    const fin = parser.finalize("cancelled");
    expect(fin.type).toBe("finalize");
    if (fin.type === "finalize") {
      expect(fin.state).toBe("cancelled");
      expect(fin.tokensIn).toBe(20);
      expect(fin.tokensOut).toBe(12);
      expect(fin.finalAnswer).toBeNull();
    }
  });
});

describe("subagent-spawn fixture", () => {
  it("Task tool emits subagent_spawned + tool_invoked, then subagent_completed + tool_completed", () => {
    const lines = loadFixture("subagent-spawn.jsonl");
    const { outputs } = parseTranscript(lines, { now: makeClock() });
    const events = eventsOnly(outputs);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "assistant_message",       // "I'll delegate to the writer."
      "subagent_spawned",        // before tool_invoked for Task
      "tool_invoked",
      "tool_completed",
      "subagent_completed",      // paired by call_id with tool_completed
      "assistant_message",       // "Summary delivered."
    ]);

    const spawned = events.find((e) => e.kind === "subagent_spawned")!;
    expect(spawned.payload).toMatchObject({
      child_session_id: "general-purpose",
      kind: "Task",
      brief: "Compose a one-line summary",
    });

    const subagentDone = events.find((e) => e.kind === "subagent_completed")!;
    expect(subagentDone.payload).toMatchObject({
      child_session_id: "toolu_01",
      outcome: "success",
    });
  });
});

describe("parser robustness", () => {
  it("ignores system, stream_event, and rate_limit_event lines", () => {
    const parser = new ClaudeStreamParser({ now: makeClock() });
    expect(parser.parse({ type: "system", subtype: "init" })).toEqual([]);
    expect(parser.parse({ type: "stream_event", event: { type: "content_block_delta" } })).toEqual([]);
    expect(parser.parse({ type: "rate_limit_event" })).toEqual([]);
    expect(parser.stats.unknownEventCount).toBe(0);
  });

  it("counts unknown event kinds", () => {
    const parser = new ClaudeStreamParser({ now: makeClock() });
    parser.parse({ type: "future_kind_anthropic_just_added" });
    parser.parse({ type: "another_one" });
    expect(parser.stats.unknownEventCount).toBe(2);
  });

  it("returns a single 'unknown' on unparseable input", () => {
    const parser = new ClaudeStreamParser({ now: makeClock() });
    const r = parser.parse("{not valid json}");
    expect(r).toHaveLength(1);
    expect(r[0].type).toBe("unknown");
  });

  it("ignores empty/whitespace lines", () => {
    const parser = new ClaudeStreamParser({ now: makeClock() });
    expect(parser.parse("")).toEqual([]);
    expect(parser.parse("   \t  ")).toEqual([]);
  });

  it("skips text content blocks with empty text (no event)", () => {
    const parser = new ClaudeStreamParser({ now: makeClock() });
    const out = parser.parse({
      type: "assistant",
      message: {
        id: "msg_x",
        content: [{ type: "text", text: "" }],
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    });
    expect(out).toEqual([]);
  });

  it("error event yields a state=error finalize", () => {
    const parser = new ClaudeStreamParser({ now: makeClock() });
    const out = parser.parse({ type: "error", error: "engine crashed" });
    expect(out).toHaveLength(1);
    if (out[0].type === "finalize") {
      expect(out[0].state).toBe("error");
      expect(out[0].errorMessage).toBe("engine crashed");
    } else {
      expect.fail("expected finalize output");
    }
  });
});
