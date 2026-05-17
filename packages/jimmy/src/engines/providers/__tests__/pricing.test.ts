import { describe, it, expect } from "vitest";
import { openaiRate, openaiCostFor, ollamaCostFor } from "../pricing.js";

describe("providers/pricing — openaiRate", () => {
  it("returns rate for known model", () => {
    const r = openaiRate("gpt-4o-mini");
    expect(r).toBeDefined();
    expect(r!.in).toBeGreaterThan(0);
    expect(r!.out).toBeGreaterThan(r!.in);
  });

  it("returns undefined for unknown model — never falls back to 0", () => {
    expect(openaiRate("gpt-fictional-2026")).toBeUndefined();
  });

  it("returns undefined for empty model id", () => {
    expect(openaiRate("")).toBeUndefined();
  });
});

describe("providers/pricing — openaiCostFor", () => {
  it("computes USD cost for a known model from token counts", () => {
    // gpt-4o-mini: $0.15/M input, $0.60/M output
    const cost = openaiCostFor("gpt-4o-mini", 1_000_000, 500_000);
    expect(cost).toBeCloseTo(0.15 + 0.30, 5);
  });

  it("returns undefined for unknown model (not 0)", () => {
    expect(openaiCostFor("gpt-fictional-2026", 1000, 1000)).toBeUndefined();
  });

  it("returns 0 for known model with zero tokens", () => {
    expect(openaiCostFor("gpt-4o-mini", 0, 0)).toBe(0);
  });
});

describe("providers/pricing — ollamaCostFor", () => {
  it("always returns 0 regardless of model and tokens", () => {
    expect(ollamaCostFor("qwen2.5:7b", 0, 0)).toBe(0);
    expect(ollamaCostFor("qwen2.5:7b", 1_000_000, 500_000)).toBe(0);
    expect(ollamaCostFor("any-fictional-model", 999_999_999, 999_999_999)).toBe(0);
  });
});
