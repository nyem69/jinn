import { describe, it, expect, vi } from "vitest";
import { runAgentLoop, type AgentLoopOpts } from "../agentLoop.js";
import type {
  NormalizedToolCall,
  ProviderCall,
  ProviderCallResult,
  ProviderMessage,
} from "../providers/types.js";
import type { ToolExecutor } from "../tools/index.js";
import type { AuditLogger, AuditRow } from "../audit.js";
import type { JsonObject } from "../../shared/types.js";

// ─── Mock provider ───────────────────────────────────────────────────

/**
 * Scriptable provider. Each call consumes the next script entry.
 * If `scripts[i]` is a function, it's invoked with the request opts so
 * the test can assert on the message history. If it's an Error, the
 * provider throws (simulating parse/transport failure).
 */
type ProviderScript = ProviderCallResult | Error | ((opts: { messages: ProviderMessage[] }) => ProviderCallResult | Error);

function mockProvider(scripts: ProviderScript[]): ProviderCall {
  let i = 0;
  return async (opts) => {
    if (i >= scripts.length) throw new Error(`provider script exhausted at call ${i + 1}`);
    let entry = scripts[i++]!;
    if (typeof entry === "function") {
      entry = entry({ messages: opts.messages });
    }
    if (entry instanceof Error) throw entry;
    return entry;
  };
}

function assistantText(content: string, usage = { promptTokens: 10, completionTokens: 5 }): ProviderCallResult {
  return {
    message: { role: "assistant", content },
    finishReason: "stop",
    usage,
    billedModel: "gpt-4o-mini",
  };
}

function assistantToolCall(
  toolCalls: NormalizedToolCall[],
  usage = { promptTokens: 10, completionTokens: 5 },
): ProviderCallResult {
  return {
    message: { role: "assistant", content: "", toolCalls },
    finishReason: "tool_calls",
    usage,
    billedModel: "gpt-4o-mini",
  };
}

function tc(name: string, args: JsonObject, id = `call_${Math.random().toString(36).slice(2, 10)}`): NormalizedToolCall {
  return { id, name, arguments: args };
}

function fakeExec(content: string, ok = true): ToolExecutor {
  return async () => ({
    ok,
    content,
    audit: { truncated: false, originalBytes: content.length },
  });
}

function baseOpts(overrides: Partial<AgentLoopOpts>): AgentLoopOpts {
  return {
    provider: mockProvider([assistantText("default")]),
    toolExecutors: new Map(),
    toolSchemas: [],
    model: "gpt-4o-mini",
    userPrompt: "hi",
    maxTurns: 5,
    timeoutMs: 5000,
    toolContext: { cwd: process.cwd() },
    ...overrides,
  };
}

// ─── Text-only mode ──────────────────────────────────────────────────

describe("agentLoop: text-only mode (no tools)", () => {
  it("returns the assistant message after one turn with no tools exposed", async () => {
    const provider = mockProvider([assistantText("hello back", { promptTokens: 12, completionTokens: 4 })]);
    const result = await runAgentLoop(baseOpts({ provider }));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.finalContent).toBe("hello back");
    expect(result.turns).toBe(1);
    expect(result.promptTokens).toBe(12);
    expect(result.completionTokens).toBe(4);
    expect(result.billedModels).toEqual(["gpt-4o-mini"]);
    expect(result.toolMessages).toEqual([]);
  });

  it("passes an empty tools array to the provider when none are registered", async () => {
    const seen: number[] = [];
    const provider: ProviderCall = async (opts) => {
      seen.push(opts.tools.length);
      return assistantText("ok");
    };
    await runAgentLoop(baseOpts({ provider }));
    expect(seen).toEqual([0]);
  });
});

// ─── Single tool call ────────────────────────────────────────────────

describe("agentLoop: single tool turn", () => {
  it("executes one tool call and then returns the terminal assistant message", async () => {
    const provider = mockProvider([
      assistantToolCall([tc("read", { path: "x.txt" }, "c1")]),
      assistantText("file said: hello"),
    ]);
    const toolExecutors = new Map<string, ToolExecutor>();
    toolExecutors.set("read", fakeExec("hello"));
    const result = await runAgentLoop(baseOpts({ provider, toolExecutors }));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.finalContent).toBe("file said: hello");
    expect(result.turns).toBe(2);
    expect(result.toolMessages).toHaveLength(1);
    expect(result.toolMessages[0].toolCallId).toBe("c1");
    expect(result.toolMessages[0].content).toBe("hello");
  });
});

// ─── Multi-tool turn (parallel calls in one assistant turn) ──────────

describe("agentLoop: multi-tool turn", () => {
  it("executes both tool calls in a single assistant turn", async () => {
    const provider = mockProvider([
      assistantToolCall([
        tc("read", { path: "a.txt" }, "c-a"),
        tc("read", { path: "b.txt" }, "c-b"),
      ]),
      assistantText("done both"),
    ]);
    const toolExecutors = new Map<string, ToolExecutor>();
    const exec = vi.fn(async (args: JsonObject) => ({
      ok: true,
      content: `read ${(args as { path: string }).path}`,
      audit: { truncated: false },
    }));
    toolExecutors.set("read", exec as unknown as ToolExecutor);
    const result = await runAgentLoop(baseOpts({ provider, toolExecutors }));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(exec).toHaveBeenCalledTimes(2);
    expect(result.toolMessages).toHaveLength(2);
    expect(result.toolMessages.map((m) => m.content)).toEqual(["read a.txt", "read b.txt"]);
  });
});

// ─── Max-turn exhaustion ────────────────────────────────────────────

describe("agentLoop: max_turns exhaustion", () => {
  it("returns kind=max_turns when the model never stops calling tools", async () => {
    const looping: ProviderScript[] = [];
    for (let i = 0; i < 10; i++) {
      looping.push(assistantToolCall([tc("read", { path: `${i}.txt` }, `c${i}`)]));
    }
    const provider = mockProvider(looping);
    const toolExecutors = new Map<string, ToolExecutor>();
    toolExecutors.set("read", fakeExec("..."));
    const result = await runAgentLoop(baseOpts({ provider, toolExecutors, maxTurns: 3 }));
    expect(result.kind).toBe("max_turns");
    if (result.kind !== "max_turns") return;
    expect(result.turns).toBe(3);
  });
});

// ─── Wall-clock timeout: before provider call ────────────────────────

describe("agentLoop: timeout before provider call", () => {
  it("returns kind=timeout when the deadline expires between turns", async () => {
    // Turn 1: provider returns tool call instantly, tool burns 200ms.
    // Budget = 100ms — so by the time the loop comes back for turn 2,
    // the deadline has long passed and the gate-before-provider-call
    // trips.
    let providerCalls = 0;
    const provider: ProviderCall = async () => {
      providerCalls++;
      if (providerCalls === 1) {
        return assistantToolCall([tc("read", { path: "x" }, "c1")]);
      }
      return assistantText("never reached — should be gated out");
    };
    const slowTool: ToolExecutor = async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { ok: true, content: "done", audit: { truncated: false } };
    };
    const toolExecutors = new Map<string, ToolExecutor>();
    toolExecutors.set("read", slowTool);
    const result = await runAgentLoop(
      baseOpts({ provider, toolExecutors, timeoutMs: 100 }),
    );
    expect(result.kind).toBe("timeout");
    if (result.kind !== "timeout") return;
    expect(result.message).toMatch(/before provider call/);
    expect(providerCalls).toBe(1);
  });
});

// ─── Wall-clock timeout: before tool call ────────────────────────────

describe("agentLoop: timeout before tool call", () => {
  it("returns kind=timeout if the deadline expires between provider and tool", async () => {
    // Provider returns instantly with two tool calls. The first tool takes
    // 100ms. Budget = 80ms so deadline passes mid-stream.
    const provider = mockProvider([
      assistantToolCall([
        tc("read", { path: "a" }, "c1"),
        tc("read", { path: "b" }, "c2"),
      ]),
      assistantText("never"),
    ]);
    const slowExec: ToolExecutor = async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { ok: true, content: "slow", audit: { truncated: false } };
    };
    const toolExecutors = new Map<string, ToolExecutor>();
    toolExecutors.set("read", slowExec);
    const result = await runAgentLoop(baseOpts({ provider, toolExecutors, timeoutMs: 80 }));
    expect(result.kind).toBe("timeout");
    if (result.kind !== "timeout") return;
    expect(result.message).toMatch(/before tool call/);
  });
});

// ─── Unknown tool ────────────────────────────────────────────────────

describe("agentLoop: unknown tool", () => {
  it("feeds an unknown_tool error back to the model and continues", async () => {
    const provider = mockProvider([
      assistantToolCall([tc("fictional_tool", { x: 1 }, "c1")]),
      // After receiving the error, the model gives up and answers.
      assistantText("I tried; that tool doesn't exist."),
    ]);
    const toolExecutors = new Map<string, ToolExecutor>();
    toolExecutors.set("read", fakeExec("..."));
    const result = await runAgentLoop(baseOpts({ provider, toolExecutors }));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.turns).toBe(2);
    expect(result.toolMessages).toHaveLength(1);
    const parsed = JSON.parse(result.toolMessages[0].content);
    expect(parsed.error).toBe("unknown_tool");
    expect(parsed.requested).toBe("fictional_tool");
    expect(parsed.available).toEqual(["read"]);
  });
});

// ─── Tool that throws ────────────────────────────────────────────────

describe("agentLoop: tool executor exception", () => {
  it("catches and surfaces tool exceptions as structured tool messages", async () => {
    const throwingExec: ToolExecutor = async () => {
      throw new Error("kaboom");
    };
    const provider = mockProvider([
      assistantToolCall([tc("read", { path: "x" }, "c1")]),
      assistantText("understood, moving on"),
    ]);
    const toolExecutors = new Map<string, ToolExecutor>();
    toolExecutors.set("read", throwingExec);
    const result = await runAgentLoop(baseOpts({ provider, toolExecutors }));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const parsed = JSON.parse(result.toolMessages[0].content);
    expect(parsed.error).toBe("tool_exception");
    expect(parsed.message).toBe("kaboom");
  });
});

// ─── Provider parse/transport errors ─────────────────────────────────

describe("agentLoop: provider parse / transport errors", () => {
  it("aborts the loop with kind=provider_error when the adapter throws", async () => {
    const provider = mockProvider([new Error("malformed tool_calls JSON")]);
    const result = await runAgentLoop(baseOpts({ provider }));
    expect(result.kind).toBe("provider_error");
    if (result.kind !== "provider_error") return;
    expect(result.message).toMatch(/malformed/);
    expect(result.turns).toBe(0);
  });

  it("aborts on provider error mid-loop", async () => {
    const provider = mockProvider([
      assistantToolCall([tc("read", { path: "x" }, "c1")]),
      new Error("transport ECONNRESET"),
    ]);
    const toolExecutors = new Map<string, ToolExecutor>();
    toolExecutors.set("read", fakeExec("ok"));
    const result = await runAgentLoop(baseOpts({ provider, toolExecutors }));
    expect(result.kind).toBe("provider_error");
    if (result.kind !== "provider_error") return;
    expect(result.message).toMatch(/ECONNRESET/);
    expect(result.turns).toBe(1); // we did one full turn before the second provider call failed
  });
});

// ─── Audit logger integration ────────────────────────────────────────

describe("agentLoop: audit integration", () => {
  it("records one AuditRow per tool call (including unknown / exception cases)", async () => {
    const rows: AuditRow[] = [];
    const audit: AuditLogger = { record: (r) => { rows.push(r); } };
    const provider = mockProvider([
      assistantToolCall([
        tc("read", { path: "x" }, "c1"),
        tc("fictional", { y: 1 }, "c2"),
      ]),
      assistantText("done"),
    ]);
    const toolExecutors = new Map<string, ToolExecutor>();
    toolExecutors.set("read", fakeExec("ok"));
    const result = await runAgentLoop(baseOpts({ provider, toolExecutors, audit }));
    expect(result.kind).toBe("ok");
    expect(rows).toHaveLength(2);
    expect(rows[0].toolName).toBe("read");
    expect(rows[0].error).toBeNull();
    expect(rows[1].toolName).toBe("fictional");
    expect(rows[1].error).toBe("unknown_tool");
  });

  it("audit failures do not break the loop", async () => {
    const audit: AuditLogger = {
      record: () => {
        throw new Error("sqlite locked");
      },
    };
    const provider = mockProvider([
      assistantToolCall([tc("read", { path: "x" }, "c1")]),
      assistantText("done"),
    ]);
    const toolExecutors = new Map<string, ToolExecutor>();
    toolExecutors.set("read", fakeExec("ok"));
    const result = await runAgentLoop(baseOpts({ provider, toolExecutors, audit }));
    expect(result.kind).toBe("ok");
  });
});

// ─── Token accounting and model attribution ──────────────────────────

describe("agentLoop: token + model accounting", () => {
  it("accumulates prompt / completion tokens across turns", async () => {
    const provider = mockProvider([
      assistantToolCall([tc("read", { path: "x" }, "c1")], { promptTokens: 10, completionTokens: 3 }),
      assistantText("done", { promptTokens: 25, completionTokens: 7 }),
    ]);
    const toolExecutors = new Map<string, ToolExecutor>();
    toolExecutors.set("read", fakeExec("ok"));
    const result = await runAgentLoop(baseOpts({ provider, toolExecutors }));
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.promptTokens).toBe(35);
    expect(result.completionTokens).toBe(10);
  });

  it("dedupes billed model identifiers when the provider routes consistently", async () => {
    const provider = mockProvider([
      assistantToolCall([tc("read", { path: "x" }, "c1")]),
      assistantText("done"),
    ]);
    const toolExecutors = new Map<string, ToolExecutor>();
    toolExecutors.set("read", fakeExec("ok"));
    const result = await runAgentLoop(baseOpts({ provider, toolExecutors }));
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.billedModels).toEqual(["gpt-4o-mini"]);
  });
});
