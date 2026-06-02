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

  it("adds --max-turns with the value when maxTurns is a positive number", () => {
    const args = buildClaudeArgs({ ...base, maxTurns: 300 }, false);
    const i = args.indexOf("--max-turns");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("300");
  });

  it("omits --max-turns when maxTurns is unset", () => {
    expect(buildClaudeArgs({ ...base }, false)).not.toContain("--max-turns");
  });

  it("omits --max-turns when maxTurns is zero or negative", () => {
    expect(buildClaudeArgs({ ...base, maxTurns: 0 }, false)).not.toContain("--max-turns");
    expect(buildClaudeArgs({ ...base, maxTurns: -5 }, false)).not.toContain("--max-turns");
  });
});
