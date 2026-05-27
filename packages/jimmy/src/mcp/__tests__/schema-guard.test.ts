import { describe, it, expect } from "vitest";
import { topLevelCombinator } from "../schema-guard.js";

describe("topLevelCombinator", () => {
  it("flags top-level anyOf (the find_cheapest shape)", () => {
    expect(topLevelCombinator({ type: "object", properties: {}, anyOf: [{ required: ["a"] }] })).toBe("anyOf");
  });
  it("flags oneOf / allOf / not at the top level", () => {
    expect(topLevelCombinator({ oneOf: [] })).toBe("oneOf");
    expect(topLevelCombinator({ allOf: [] })).toBe("allOf");
    expect(topLevelCombinator({ not: {} })).toBe("not");
  });
  it("allows clean object schemas", () => {
    expect(topLevelCombinator({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })).toBeNull();
  });
  it("ignores NESTED combinators (only top level 400s)", () => {
    expect(topLevelCombinator({ type: "object", properties: { a: { anyOf: [{ type: "string" }] } } })).toBeNull();
  });
  it("handles non-object / missing schema", () => {
    expect(topLevelCombinator(undefined)).toBeNull();
    expect(topLevelCombinator(null)).toBeNull();
  });
});
