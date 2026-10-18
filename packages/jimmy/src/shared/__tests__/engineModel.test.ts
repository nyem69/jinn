import { describe, it, expect } from "vitest";
import { modelFamily, resolveEngineModel } from "../engineModel.js";

describe("modelFamily", () => {
  it.each([
    ["sonnet", "claude"],
    ["opus", "claude"],
    ["opus[1m]", "claude"],
    ["haiku", "claude"],
    ["fable", "claude"],
    ["claude-opus-5-5", "claude"],
    ["claude-sonnet-5-5[1m]", "claude"],
    ["gpt-6.1-sol", "openai"],
    ["gpt-5.6-luna", "openai"],
    ["o3", "openai"],
    ["codex-mini-latest", "openai"],
    ["gemini-2.5-pro", "gemini"],
    ["opusplan", "claude"],
    ["default", "claude"],
  ])("%s → %s", (model, family) => {
    expect(modelFamily(model)).toBe(family);
  });

  it("returns null for names outside the known prefixes", () => {
    expect(modelFamily("llama3:8b")).toBeNull();
    expect(modelFamily("sonnetish-proxy")).toBeNull();
  });
});

describe("resolveEngineModel", () => {
  it("never hands a Claude alias to codex (17 Oct melaka-jejak-calon-scan 400)", () => {
    expect(resolveEngineModel("codex", "sonnet", "gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(resolveEngineModel("codex", "claude-opus-5-5", "gpt-6.1-sol")).toBe("gpt-6.1-sol");
  });

  it("returns undefined for codex when the session model is foreign and no default is set", () => {
    expect(resolveEngineModel("codex", "sonnet", undefined)).toBeUndefined();
    expect(resolveEngineModel("codex", "haiku", "")).toBeUndefined();
  });

  it("never hands an OpenAI model to claude", () => {
    expect(resolveEngineModel("claude", "gpt-6.1-sol", "opus")).toBe("opus");
  });

  it("keeps a same-family session model", () => {
    expect(resolveEngineModel("claude", "sonnet", "opus")).toBe("sonnet");
    expect(resolveEngineModel("codex", "gpt-5.6-luna", "gpt-6.1-sol")).toBe("gpt-5.6-luna");
  });

  it("passes unknown-family names and unknown engines through", () => {
    expect(resolveEngineModel("codex", "my-proxy-model", "gpt-6.1-sol")).toBe("my-proxy-model");
    expect(resolveEngineModel("mock", "sonnet", undefined)).toBe("sonnet");
  });

  it("guards the HTTP engines too", () => {
    expect(resolveEngineModel("openai", "sonnet", "gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(resolveEngineModel("openai", "gpt-4o-mini", undefined)).toBe("gpt-4o-mini");
    expect(resolveEngineModel("ollama", "sonnet", "llama3")).toBe("llama3");
    expect(resolveEngineModel("ollama", "gpt-6.1-sol", undefined)).toBeUndefined();
    expect(resolveEngineModel("ollama", "qwen3:8b", "llama3")).toBe("qwen3:8b");
  });

  it("drops a foreign engine default too (openai/ollama get the Claude config block)", () => {
    expect(resolveEngineModel("openai", "sonnet", "opus")).toBeUndefined();
    expect(resolveEngineModel("ollama", null, "opus")).toBeUndefined();
    expect(resolveEngineModel("gemini", null, "opus")).toBeUndefined();
  });

  it("falls back to the engine default when the session has no model", () => {
    expect(resolveEngineModel("claude", null, "opus")).toBe("opus");
    expect(resolveEngineModel("codex", undefined, "gpt-6.1-sol")).toBe("gpt-6.1-sol");
  });
});
