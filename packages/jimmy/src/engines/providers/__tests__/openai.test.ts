import { describe, it, expect, vi } from "vitest";
import { createOpenAIProvider } from "../openai.js";
import type { ProviderCallOpts } from "../types.js";

/** Build a fetch-shaped mock from a single canned response object. */
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
    model: "gpt-4o-mini",
    ...overrides,
  };
}

describe("providers/openai — construction", () => {
  it("throws if apiKey is empty at construction", () => {
    expect(() => createOpenAIProvider({ apiKey: "" })).toThrow(/missing apiKey/);
  });
});

describe("providers/openai — happy path (text only)", () => {
  it("returns assistant message with no toolCalls and finishReason=stop", async () => {
    const fetchFn = mockJsonResponse({
      id: "resp_1",
      model: "gpt-4o-mini-2024-07-18",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello back" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    });

    const call = createOpenAIProvider({ apiKey: "sk-test" });
    const r = await call(baseOpts({ fetchFn }));

    expect(r.message.role).toBe("assistant");
    expect(r.message.content).toBe("hello back");
    expect(r.message.toolCalls).toBeUndefined();
    expect(r.finishReason).toBe("stop");
    expect(r.usage).toEqual({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });
    expect(r.billedModel).toBe("gpt-4o-mini-2024-07-18");
  });

  it("falls back to requested model when response.model is missing", async () => {
    const fetchFn = mockJsonResponse({
      choices: [{ message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const call = createOpenAIProvider({ apiKey: "sk-test" });
    const r = await call(baseOpts({ fetchFn, model: "gpt-4o-mini" }));
    expect(r.billedModel).toBe("gpt-4o-mini");
  });
});

describe("providers/openai — tool_calls normalization", () => {
  it("parses JSON-string arguments into a JS object", async () => {
    const fetchFn = mockJsonResponse({
      model: "gpt-4o-mini",
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "search",
                  arguments: '{"q":"hello","limit":3}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 12 },
    });
    const call = createOpenAIProvider({ apiKey: "sk-test" });
    const r = await call(baseOpts({ fetchFn }));

    expect(r.finishReason).toBe("tool_calls");
    expect(r.message.toolCalls).toHaveLength(1);
    expect(r.message.toolCalls![0]).toEqual({
      id: "call_abc",
      name: "search",
      arguments: { q: "hello", limit: 3 },
    });
  });

  it("synthesizes a stable id when the response omits one", async () => {
    const fetchFn = mockJsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { type: "function", function: { name: "noop", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const call = createOpenAIProvider({ apiKey: "sk-test" });
    const r = await call(baseOpts({ fetchFn }));
    expect(r.message.toolCalls![0].id).toMatch(/^call_[0-9a-f-]{36}$/);
  });

  it("returns finishReason=tool_calls when tool_calls present even if wire says 'stop'", async () => {
    const fetchFn = mockJsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "x", arguments: "{}" } },
            ],
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const call = createOpenAIProvider({ apiKey: "sk-test" });
    const r = await call(baseOpts({ fetchFn }));
    expect(r.finishReason).toBe("tool_calls");
  });

  it("throws on malformed JSON in tool_calls arguments", async () => {
    const fetchFn = mockJsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "x", arguments: "{not valid json" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const call = createOpenAIProvider({ apiKey: "sk-test" });
    await expect(call(baseOpts({ fetchFn }))).rejects.toThrow(/arguments JSON parse failed/);
  });

  it("throws when tool_call arguments parses to a non-object (array, primitive)", async () => {
    const fetchFn = mockJsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "x", arguments: "[1,2,3]" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const call = createOpenAIProvider({ apiKey: "sk-test" });
    await expect(call(baseOpts({ fetchFn }))).rejects.toThrow(/must parse to an object/);
  });

  it("throws when tool_call is missing function.name", async () => {
    const fetchFn = mockJsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "c1", type: "function", function: { arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const call = createOpenAIProvider({ apiKey: "sk-test" });
    await expect(call(baseOpts({ fetchFn }))).rejects.toThrow(/missing function.name/);
  });
});

describe("providers/openai — HTTP errors and no-retry policy", () => {
  it("throws with status + body excerpt on non-2xx response", async () => {
    const fetchFn = vi.fn(async () =>
      new Response("rate limit exceeded", { status: 429, statusText: "Too Many Requests" })
    );
    const call = createOpenAIProvider({ apiKey: "sk-test" });
    await expect(call(baseOpts({ fetchFn }))).rejects.toThrow(/HTTP 429.*rate limit exceeded/);
    expect(fetchFn).toHaveBeenCalledTimes(1); // V1: no retries
  });

  it("throws with transport error message when fetch rejects", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const call = createOpenAIProvider({ apiKey: "sk-test" });
    await expect(call(baseOpts({ fetchFn }))).rejects.toThrow(/transport error.*ECONNRESET/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws when response body is not valid JSON", async () => {
    const fetchFn = vi.fn(async () =>
      new Response("not json at all", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const call = createOpenAIProvider({ apiKey: "sk-test" });
    await expect(call(baseOpts({ fetchFn }))).rejects.toThrow(/response JSON parse failed/);
  });
});

describe("providers/openai — request shape", () => {
  it("sends Authorization: Bearer header and JSON body with tools when provided", async () => {
    const fetchFn = mockJsonResponse({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const call = createOpenAIProvider({ apiKey: "sk-test-123", baseUrl: "https://example.com/v1/" });
    await call(baseOpts({
      fetchFn,
      tools: [
        { name: "search", description: "search the web", parameters: { type: "object", properties: { q: { type: "string" } } } },
      ],
    }));

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://example.com/v1/chat/completions"); // trailing slash on baseUrl is normalized
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test-123");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.stream).toBe(false);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "search",
        description: "search the web",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    });
  });

  it("omits tools field when no tools are provided", async () => {
    const fetchFn = mockJsonResponse({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const call = createOpenAIProvider({ apiKey: "sk-test" });
    await call(baseOpts({ fetchFn }));
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.tools).toBeUndefined();
  });

  it("serializes assistant→tool round-trip with arguments as JSON string", async () => {
    const fetchFn = mockJsonResponse({
      choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const call = createOpenAIProvider({ apiKey: "sk-test" });
    await call({
      ...baseOpts({ fetchFn }),
      messages: [
        { role: "user", content: "do thing" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "search", arguments: { q: "x" } }],
        },
        { role: "tool", content: "{\"results\":[]}", toolCallId: "c1" },
      ],
    });
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    const asstMsg = body.messages[1];
    expect(asstMsg.tool_calls[0].function.arguments).toBe('{"q":"x"}'); // serialized to string on the wire
    const toolMsg = body.messages[2];
    expect(toolMsg).toEqual({ role: "tool", tool_call_id: "c1", content: '{"results":[]}' });
  });
});
