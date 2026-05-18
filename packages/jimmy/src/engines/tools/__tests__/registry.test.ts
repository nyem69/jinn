import { describe, it, expect } from "vitest";
import { buildToolRegistry, KNOWN_TOOL_NAMES } from "../index.js";

describe("buildToolRegistry", () => {
  it("returns an empty registry when toolsConfig is undefined (text-only)", () => {
    const r = buildToolRegistry(undefined);
    expect(r.executors.size).toBe(0);
    expect(r.schemas).toEqual([]);
    expect(r.unknownRequested).toEqual([]);
  });

  it("returns an empty registry when enabled is an empty array", () => {
    const r = buildToolRegistry({ enabled: [] });
    expect(r.executors.size).toBe(0);
    expect(r.schemas).toEqual([]);
  });

  it("returns only the requested tools", () => {
    const r = buildToolRegistry({ enabled: ["read", "write"] });
    expect([...r.executors.keys()].sort()).toEqual(["read", "write"]);
    expect(r.schemas.map((s) => s.name).sort()).toEqual(["read", "write"]);
  });

  it("preserves order of `enabled` in schemas array", () => {
    const r = buildToolRegistry({ enabled: ["webfetch", "read"] });
    expect(r.schemas.map((s) => s.name)).toEqual(["webfetch", "read"]);
  });

  it("ignores duplicates in enabled", () => {
    const r = buildToolRegistry({ enabled: ["read", "read", "read"] });
    expect(r.executors.size).toBe(1);
    expect(r.schemas).toHaveLength(1);
  });

  it("collects unknown tool names without throwing", () => {
    const r = buildToolRegistry({ enabled: ["read", "nonexistent_tool", "write"] });
    expect([...r.executors.keys()].sort()).toEqual(["read", "write"]);
    expect(r.unknownRequested).toEqual(["nonexistent_tool"]);
  });

  it("exposes the full known-tool set", () => {
    const r = buildToolRegistry({ enabled: [...KNOWN_TOOL_NAMES] });
    expect(r.executors.size).toBe(5);
    expect(r.schemas).toHaveLength(5);
  });

  it("each schema has required JSON-schema fields", () => {
    const r = buildToolRegistry({ enabled: [...KNOWN_TOOL_NAMES] });
    for (const s of r.schemas) {
      expect(typeof s.name).toBe("string");
      expect(typeof s.description).toBe("string");
      expect(s.parameters).toBeTruthy();
      expect((s.parameters as Record<string, unknown>).type).toBe("object");
    }
  });
});
