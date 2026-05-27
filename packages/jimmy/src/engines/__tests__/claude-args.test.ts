import { describe, it, expect } from "vitest";
import { buildClaudeArgs } from "../claude.js";

const base = { prompt: "hi", cwd: "/tmp", model: "haiku" } as const;

describe("buildClaudeArgs", () => {
  it("omits --strict-mcp-config by default", () => {
    const args = buildClaudeArgs({ ...base, mcpConfigPath: "/tmp/m.json" }, false);
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).toContain("--mcp-config");
  });

  it("adds --strict-mcp-config when strictMcp is set", () => {
    const args = buildClaudeArgs({ ...base, mcpConfigPath: "/tmp/m.json", strictMcp: true }, false);
    expect(args).toContain("--strict-mcp-config");
  });

  it("keeps the prompt before --mcp-config (variadic flag ordering)", () => {
    const args = buildClaudeArgs({ ...base, mcpConfigPath: "/tmp/m.json", strictMcp: true }, false);
    expect(args.indexOf("hi")).toBeLessThan(args.indexOf("--mcp-config"));
  });
});
