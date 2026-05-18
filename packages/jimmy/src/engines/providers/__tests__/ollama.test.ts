import { describe, it, expect, vi } from "vitest";
import { createOllamaProvider } from "../ollama.js";
import type { ProviderCallOpts } from "../types.js";

function mockJsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
  const status = init.status ?? 200;
  const fn: typeof fetch = async (_input, _init) => {
    return new Response(JSON.stringify(body), {
      status,
      statusText: init.statusText ?? "",
      headers: { "Content-Type": "application/json" },
    });
  };
  return vi.fn(fn);
}

function baseOpts(overrides: Partial<ProviderCallOpts> = {}): ProviderCallOpts {
  return {
    messages: [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ],
    tools: [],
    model: "qwen2.5:7b-instruct",
    ...overrides,
  };
}

describe("providers/ollama — construction", () => {
  it("throws if baseUrl is empty at construction", () => {
    expect(() => createOllamaProvider({ baseUrl: "" })).toThrow(/missing baseUrl/);
  });
});

describe("providers/ollama — happy path text only", () => {
  it("returns assistant content and stop finish reason", async () => {
    const fetchFn = mockJsonResponse({
      model: "qwen2.5:7b-instruct",
      message: { role: "assistant", content: "hello from ollama" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 20,
      eval_count: 5,
    });
    const call = createOllamaProvider({ baseUrl: "https://ollama.example.com" });
    const r = await call(baseOpts({ fetchFn }));
    expect(r.message.content).toBe("hello from ollama");
    expect(r.message.toolCalls).toBeUndefined();
    expect(r.finishReason).toBe("stop");
    expect(r.usage).toEqual({ promptTokens: 20, completionTokens: 5 });
    expect(r.billedModel).toBe("qwen2.5:7b-instruct");
  });

  it("model that ignores tools and returns plain text is treated as a normal text response", async () => {
    const fetchFn = mockJsonResponse({
      model: "qwen2.5:7b-instruct",
      // No tool_calls field at all — model ignored the tools schema.
      message: { role: "assistant", content: "I would call search('x') but I'll just describe it instead." },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 40,
      eval_count: 12,
    });
    const call = createOllamaProvider({ baseUrl: "https://o" });
    const r = await call(baseOpts({
      fetchFn,
      tools: [{ name: "search", description: "x", parameters: { type: "object" } }],
    }));
    expect(r.finishReason).toBe("stop");
    expect(r.message.toolCalls).toBeUndefined();
    expect(r.message.content).toContain("search");
  });
});

describe("providers/ollama — tool_calls normalization", () => {
  it("accepts arguments as an OBJECT on the wire (typical Ollama)", async () => {
    const fetchFn = mockJsonResponse({
      model: "qwen2.5:7b-instruct",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "search", arguments: { q: "hello", limit: 3 } } },
        ],
      },
      done: true,
      prompt_eval_count: 8,
      eval_count: 4,
    });
    const call = createOllamaProvider({ baseUrl: "https://o" });
    const r = await call(baseOpts({ fetchFn }));
    expect(r.finishReason).toBe("tool_calls");
    expect(r.message.toolCalls).toHaveLength(1);
    expect(r.message.toolCalls![0].name).toBe("search");
    expect(r.message.toolCalls![0].arguments).toEqual({ q: "hello", limit: 3 });
  });

  it("accepts arguments as a JSON STRING (some clients/models)", async () => {
    const fetchFn = mockJsonResponse({
      model: "qwen2.5:7b-instruct",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "search", arguments: '{"q":"hello"}' } },
        ],
      },
      done: true,
      prompt_eval_count: 1,
      eval_count: 1,
    });
    const call = createOllamaProvider({ baseUrl: "https://o" });
    const r = await call(baseOpts({ fetchFn }));
    expect(r.message.toolCalls![0].arguments).toEqual({ q: "hello" });
  });

  it("synthesizes stable call_<uuid> id when id is missing", async () => {
    const fetchFn = mockJsonResponse({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "noop", arguments: {} } }],
      },
      done: true,
      prompt_eval_count: 1,
      eval_count: 1,
    });
    const call = createOllamaProvider({ baseUrl: "https://o" });
    const r = await call(baseOpts({ fetchFn }));
    expect(r.message.toolCalls![0].id).toMatch(/^call_[0-9a-f-]{36}$/);
  });

  it("treats empty / null / undefined arguments as {}", async () => {
    for (const args of [null, undefined, "", {}]) {
      const fetchFn = mockJsonResponse({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "noop", arguments: args } }],
        },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1,
      });
      const call = createOllamaProvider({ baseUrl: "https://o" });
      const r = await call(baseOpts({ fetchFn }));
      expect(r.message.toolCalls![0].arguments).toEqual({});
    }
  });

  it("throws when arguments parses to an array (non-object)", async () => {
    const fetchFn = mockJsonResponse({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "x", arguments: "[1,2,3]" } }],
      },
      done: true,
      prompt_eval_count: 1,
      eval_count: 1,
    });
    const call = createOllamaProvider({ baseUrl: "https://o" });
    await expect(call(baseOpts({ fetchFn }))).rejects.toThrow(/must parse to an object, got array/);
  });

  it("throws when arguments is an unparseable JSON string", async () => {
    const fetchFn = mockJsonResponse({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "x", arguments: "{not json" } }],
      },
      done: true,
      prompt_eval_count: 1,
      eval_count: 1,
    });
    const call = createOllamaProvider({ baseUrl: "https://o" });
    await expect(call(baseOpts({ fetchFn }))).rejects.toThrow(/arguments JSON parse failed/);
  });

  it("throws when tool_call is missing function.name", async () => {
    const fetchFn = mockJsonResponse({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { arguments: {} } }],
      },
      done: true,
      prompt_eval_count: 1,
      eval_count: 1,
    });
    const call = createOllamaProvider({ baseUrl: "https://o" });
    await expect(call(baseOpts({ fetchFn }))).rejects.toThrow(/missing function.name/);
  });
});

describe("providers/ollama — auth", () => {
  it("sends Authorization: Bearer header when token is provided", async () => {
    const fetchFn = mockJsonResponse({
      message: { role: "assistant", content: "ok" },
      done: true,
      prompt_eval_count: 1,
      eval_count: 1,
    });
    const call = createOllamaProvider({ baseUrl: "https://o", token: "secret-token-xyz" });
    await call(baseOpts({ fetchFn }));
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-token-xyz");
  });

  it("omits Authorization header when no token is provided", async () => {
    const fetchFn = mockJsonResponse({
      message: { role: "assistant", content: "ok" },
      done: true,
      prompt_eval_count: 1,
      eval_count: 1,
    });
    const call = createOllamaProvider({ baseUrl: "https://o" });
    await call(baseOpts({ fetchFn }));
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });
});

describe("providers/ollama — HTTP errors", () => {
  it("throws with status on non-2xx", async () => {
    const fetchFn = vi.fn(async () =>
      new Response("model not found", { status: 404, statusText: "Not Found" })
    );
    const call = createOllamaProvider({ baseUrl: "https://o" });
    await expect(call(baseOpts({ fetchFn }))).rejects.toThrow(/HTTP 404.*model not found/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws with transport error message when fetch rejects", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("DNS resolution failed");
    });
    const call = createOllamaProvider({ baseUrl: "https://o" });
    await expect(call(baseOpts({ fetchFn }))).rejects.toThrow(/transport error.*DNS resolution failed/);
  });
});

describe("providers/ollama — request shape", () => {
  it("hits /api/chat with model + messages + stream:false", async () => {
    const fetchFn = mockJsonResponse({
      message: { role: "assistant", content: "ok" },
      done: true,
      prompt_eval_count: 1,
      eval_count: 1,
    });
    const call = createOllamaProvider({ baseUrl: "https://ollama.example.com/" }); // trailing slash
    await call(baseOpts({ fetchFn }));
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://ollama.example.com/api/chat");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("qwen2.5:7b-instruct");
    expect(body.stream).toBe(false);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it("round-trips assistant toolCalls with arguments as objects (Ollama wire format)", async () => {
    const fetchFn = mockJsonResponse({
      message: { role: "assistant", content: "done" },
      done: true,
      prompt_eval_count: 1,
      eval_count: 1,
    });
    const call = createOllamaProvider({ baseUrl: "https://o" });
    await call({
      ...baseOpts({ fetchFn }),
      messages: [
        { role: "user", content: "do thing" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "search", arguments: { q: "x" } }],
        },
        { role: "tool", content: '{"results":[]}', toolCallId: "c1", name: "search" },
      ],
    });
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    const asstMsg = body.messages[1];
    // Ollama: arguments object on the wire, not stringified
    expect(asstMsg.tool_calls[0].function.arguments).toEqual({ q: "x" });
    const toolMsg = body.messages[2];
    expect(toolMsg).toEqual({
      role: "tool",
      content: '{"results":[]}',
      tool_call_id: "c1",
      name: "search",
    });
  });
});
