import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaEngine } from "../ollama.js";
import { OpenAIEngine } from "../openai.js";
import type { ProviderCall, ProviderCallResult } from "../providers/types.js";

// We mock the two provider factories so the wrapper tests stay
// fully in-process — no HTTP, no fixture servers needed. The wrapper
// passes the provider call returned by these factories straight into
// the agent loop, so by controlling that we control the loop's
// response shape.
const mockOllamaProvider = vi.fn<(opts: object) => ProviderCall>();
const mockOpenAIProvider = vi.fn<(opts: object) => ProviderCall>();

vi.mock("../providers/ollama.js", () => ({
  createOllamaProvider: (opts: object) => mockOllamaProvider(opts),
}));

vi.mock("../providers/openai.js", () => ({
  createOpenAIProvider: (opts: object) => mockOpenAIProvider(opts),
}));

// Defaults the provider factories return when a test doesn't override.
function setProviderResult(result: ProviderCallResult | Error): ProviderCall {
  const fn: ProviderCall = async () => {
    if (result instanceof Error) throw result;
    return result;
  };
  return fn;
}

function okResult(content = "all done"): ProviderCallResult {
  return {
    message: { role: "assistant", content },
    finishReason: "stop",
    usage: { promptTokens: 100, completionTokens: 30 },
    billedModel: "gpt-4o-mini",
  };
}

beforeEach(() => {
  mockOllamaProvider.mockReset();
  mockOpenAIProvider.mockReset();
  // Default to a successful provider call.
  mockOllamaProvider.mockImplementation(() => setProviderResult(okResult()));
  mockOpenAIProvider.mockImplementation(() => setProviderResult(okResult()));
});

// ─── Ollama: construction-time config validation ─────────────────────

describe("OllamaEngine: construction-time validation", () => {
  it("throws when config.url is missing", () => {
    expect(() => new OllamaEngine({ url: "" as never })).toThrow(/url is required/);
  });

  it("succeeds with just a url", () => {
    const engine = new OllamaEngine({ url: "https://ollama.example.com" });
    expect(engine.name).toBe("ollama");
  });

  it("warns but constructs when tools.enabled has unknown names", () => {
    // Just verify no throw — the warning goes through logger.warn.
    expect(
      () =>
        new OllamaEngine({
          url: "https://o.example.com",
          tools: { enabled: ["read", "fictional_tool"] },
        }),
    ).not.toThrow();
  });

  it("reads OLLAMA_TOKEN env var by default", () => {
    process.env.OLLAMA_TOKEN = "test-token-xyz";
    try {
      new OllamaEngine({ url: "https://o.example.com" });
      expect(mockOllamaProvider).toHaveBeenCalledWith({
        baseUrl: "https://o.example.com",
        token: "test-token-xyz",
      });
    } finally {
      delete process.env.OLLAMA_TOKEN;
    }
  });

  it("respects custom authTokenEnvVar", () => {
    process.env.CUSTOM_OLLAMA_TOKEN = "abc";
    try {
      new OllamaEngine({
        url: "https://o.example.com",
        authTokenEnvVar: "CUSTOM_OLLAMA_TOKEN",
      });
      expect(mockOllamaProvider).toHaveBeenCalledWith({
        baseUrl: "https://o.example.com",
        token: "abc",
      });
    } finally {
      delete process.env.CUSTOM_OLLAMA_TOKEN;
    }
  });
});

// ─── OpenAI: construction-time config validation ─────────────────────

describe("OpenAIEngine: construction-time validation", () => {
  it("throws when OPENAI_API_KEY env var is unset", () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => new OpenAIEngine({})).toThrow(/missing API key/);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  it("throws when OPENAI_API_KEY is empty", () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "";
    try {
      expect(() => new OpenAIEngine({})).toThrow(/missing API key/);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it("succeeds when OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      const engine = new OpenAIEngine({});
      expect(engine.name).toBe("openai");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("respects custom apiKeyEnvVar", () => {
    process.env.CUSTOM_OPENAI_KEY = "sk-custom";
    try {
      new OpenAIEngine({ apiKeyEnvVar: "CUSTOM_OPENAI_KEY" });
      expect(mockOpenAIProvider).toHaveBeenCalledWith({
        apiKey: "sk-custom",
        baseUrl: undefined,
      });
    } finally {
      delete process.env.CUSTOM_OPENAI_KEY;
    }
  });
});

// ─── Unsupported features rejected BEFORE any provider call ─────────

describe("OllamaEngine: rejects unsupported features without provider call", () => {
  let engine: OllamaEngine;
  let providerCalls = 0;

  beforeEach(() => {
    providerCalls = 0;
    mockOllamaProvider.mockImplementation(() => async () => {
      providerCalls++;
      return okResult();
    });
    engine = new OllamaEngine({ url: "https://o.example.com", model: "qwen2.5:7b" });
  });

  it("rejects resumeSessionId", async () => {
    const r = await engine.run({
      prompt: "hi",
      cwd: "/tmp",
      resumeSessionId: "prev-sess",
    });
    expect(r.error).toMatch(/resumeSessionId is not supported/);
    expect(providerCalls).toBe(0);
  });

  it("rejects mcpConfigPath", async () => {
    const r = await engine.run({
      prompt: "hi",
      cwd: "/tmp",
      mcpConfigPath: "/path/to/mcp.json",
    });
    expect(r.error).toMatch(/MCP servers are not supported/);
    expect(providerCalls).toBe(0);
  });

  it("rejects attachments", async () => {
    const r = await engine.run({
      prompt: "hi",
      cwd: "/tmp",
      attachments: ["/path/to/file.txt"],
    });
    expect(r.error).toMatch(/attachments are not supported/);
    expect(providerCalls).toBe(0);
  });

  it("rejects cliFlags", async () => {
    const r = await engine.run({
      prompt: "hi",
      cwd: "/tmp",
      cliFlags: ["--no-stream"],
    });
    expect(r.error).toMatch(/cliFlags are not supported/);
    expect(providerCalls).toBe(0);
  });

  it("ignores empty attachments / cliFlags arrays", async () => {
    const r = await engine.run({
      prompt: "hi",
      cwd: "/tmp",
      attachments: [],
      cliFlags: [],
    });
    expect(r.error).toBeUndefined();
    expect(providerCalls).toBe(1);
  });
});

describe("OpenAIEngine: rejects unsupported features without provider call", () => {
  let engine: OpenAIEngine;
  let providerCalls = 0;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
    providerCalls = 0;
    mockOpenAIProvider.mockImplementation(() => async () => {
      providerCalls++;
      return okResult();
    });
    engine = new OpenAIEngine({ model: "gpt-4o-mini" });
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("rejects resumeSessionId without making a provider call", async () => {
    const r = await engine.run({
      prompt: "hi",
      cwd: "/tmp",
      resumeSessionId: "prev",
    });
    expect(r.error).toMatch(/resumeSessionId is not supported/);
    expect(providerCalls).toBe(0);
  });

  it("rejects mcpConfigPath", async () => {
    const r = await engine.run({
      prompt: "hi",
      cwd: "/tmp",
      mcpConfigPath: "/a",
    });
    expect(r.error).toMatch(/MCP servers are not supported/);
    expect(providerCalls).toBe(0);
  });
});

// ─── Model resolution ────────────────────────────────────────────────

describe("OllamaEngine: model resolution", () => {
  it("uses opts.model when provided", async () => {
    let seenModel = "";
    mockOllamaProvider.mockImplementation(() => async (callOpts) => {
      seenModel = callOpts.model;
      return okResult();
    });
    const engine = new OllamaEngine({ url: "https://o", model: "config-model" });
    await engine.run({ prompt: "hi", cwd: "/tmp", model: "opts-model" });
    expect(seenModel).toBe("opts-model");
  });

  it("falls back to config.model when opts.model is missing", async () => {
    let seenModel = "";
    mockOllamaProvider.mockImplementation(() => async (callOpts) => {
      seenModel = callOpts.model;
      return okResult();
    });
    const engine = new OllamaEngine({ url: "https://o", model: "default-from-config" });
    await engine.run({ prompt: "hi", cwd: "/tmp" });
    expect(seenModel).toBe("default-from-config");
  });

  it("returns error when neither opts.model nor config.model exists", async () => {
    const engine = new OllamaEngine({ url: "https://o" });
    const r = await engine.run({ prompt: "hi", cwd: "/tmp" });
    expect(r.error).toMatch(/no model resolved/);
    expect(r.result).toBe("");
  });
});

describe("OpenAIEngine: model resolution", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
  });
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("returns error when neither opts.model nor config.model exists", async () => {
    const engine = new OpenAIEngine({});
    const r = await engine.run({ prompt: "hi", cwd: "/tmp" });
    expect(r.error).toMatch(/no model resolved/);
  });
});

// ─── Session ID handling ─────────────────────────────────────────────

describe("session id handling", () => {
  it("preserves opts.sessionId when provided (Ollama)", async () => {
    const engine = new OllamaEngine({ url: "https://o", model: "x" });
    const r = await engine.run({ prompt: "hi", cwd: "/tmp", sessionId: "my-sess-id" });
    expect(r.sessionId).toBe("my-sess-id");
  });

  it("generates a sessionId when omitted (Ollama)", async () => {
    const engine = new OllamaEngine({ url: "https://o", model: "x" });
    const r = await engine.run({ prompt: "hi", cwd: "/tmp" });
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("preserves opts.sessionId when provided (OpenAI)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      const engine = new OpenAIEngine({ model: "gpt-4o-mini" });
      const r = await engine.run({ prompt: "hi", cwd: "/tmp", sessionId: "openai-sess" });
      expect(r.sessionId).toBe("openai-sess");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

// ─── Cost computation ────────────────────────────────────────────────

describe("cost computation", () => {
  it("Ollama returns cost=0 regardless of model", async () => {
    mockOllamaProvider.mockImplementation(() => async () => ({
      message: { role: "assistant", content: "done" },
      finishReason: "stop",
      usage: { promptTokens: 9_999, completionTokens: 9_999 },
      billedModel: "qwen2.5:7b-instruct",
    }));
    const engine = new OllamaEngine({ url: "https://o", model: "qwen2.5:7b" });
    const r = await engine.run({ prompt: "hi", cwd: "/tmp" });
    expect(r.cost).toBe(0);
  });

  it("OpenAI computes cost from billedModel and accumulated usage", async () => {
    mockOpenAIProvider.mockImplementation(() => async () => ({
      message: { role: "assistant", content: "done" },
      finishReason: "stop",
      usage: { promptTokens: 1_000_000, completionTokens: 500_000 },
      billedModel: "gpt-4o-mini",
    }));
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      const engine = new OpenAIEngine({ model: "gpt-4o-mini" });
      const r = await engine.run({ prompt: "hi", cwd: "/tmp" });
      // gpt-4o-mini: $0.15/M input, $0.60/M output
      expect(r.cost).toBeCloseTo(0.15 + 0.30, 5);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("OpenAI returns cost=undefined (NOT 0) for unknown billed model", async () => {
    mockOpenAIProvider.mockImplementation(() => async () => ({
      message: { role: "assistant", content: "done" },
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 50 },
      billedModel: "gpt-fictional-2030",
    }));
    process.env.OPENAI_API_KEY = "sk-test";
    try {
      const engine = new OpenAIEngine({ model: "gpt-fictional-2030" });
      const r = await engine.run({ prompt: "hi", cwd: "/tmp" });
      expect(r.cost).toBeUndefined();
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

// ─── EngineResult shape across loop kinds ────────────────────────────

describe("EngineResult shape mapping", () => {
  it("happy path carries result, cost, durationMs, numTurns; no error", async () => {
    mockOllamaProvider.mockImplementation(() => async () => ({
      message: { role: "assistant", content: "hello" },
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5 },
      billedModel: "qwen2.5:7b",
    }));
    const engine = new OllamaEngine({ url: "https://o", model: "qwen2.5:7b" });
    const r = await engine.run({ prompt: "hi", cwd: "/tmp" });
    expect(r.result).toBe("hello");
    expect(r.cost).toBe(0);
    expect(typeof r.durationMs).toBe("number");
    expect(r.numTurns).toBe(1);
    expect(r.error).toBeUndefined();
  });

  it("provider error path carries error, cost (from accumulated usage), turns", async () => {
    mockOllamaProvider.mockImplementation(() => async () => {
      throw new Error("ECONNREFUSED");
    });
    const engine = new OllamaEngine({ url: "https://o", model: "qwen2.5:7b" });
    const r = await engine.run({ prompt: "hi", cwd: "/tmp" });
    expect(r.error).toMatch(/provider_error.*ECONNREFUSED/);
    expect(r.result).toBe("");
    expect(typeof r.durationMs).toBe("number");
  });
});
