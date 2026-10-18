import { describe, it, expect } from "vitest";
import type { EngineResult } from "../types.js";
import { isDeadSessionError, detectRateLimit, engineDidWork, rateLimitKind } from "../rateLimit.js";

function makeResult(overrides: Partial<EngineResult> = {}): EngineResult {
  return {
    sessionId: "test-session",
    result: "",
    ...overrides,
  };
}

describe("isDeadSessionError", () => {
  it("returns true for error with zero cost and no rate limit", () => {
    const result = makeResult({
      error: "Claude exited with code 1 (no stderr output)",
      cost: 0,
      numTurns: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns true for error with undefined cost/turns (no work done)", () => {
    const result = makeResult({
      error: "Claude exited with code 1",
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns false when rate limit status is present", () => {
    const result = makeResult({
      error: "Claude usage limit reached",
      cost: 0,
      rateLimit: { status: "rejected" },
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns false when cost > 0 (work was done)", () => {
    const result = makeResult({
      error: "Some error after work",
      cost: 0.05,
      numTurns: 3,
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns false when numTurns > 0 (work was done)", () => {
    const result = makeResult({
      error: "Some error after work",
      cost: 0,
      numTurns: 1,
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns false when there is no error", () => {
    const result = makeResult({ result: "success" });
    expect(isDeadSessionError(result)).toBe(false);
  });

  // Secondary pattern matching — requires zero cost as conjunction
  it("returns true for 'error_during_execution' with zero cost", () => {
    const result = makeResult({
      error: "error_during_execution",
      cost: 0,
      numTurns: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns false for 'error_during_execution' when cost > 0 (real work done)", () => {
    const result = makeResult({
      error: "error_during_execution",
      cost: 0.05,
      numTurns: 1,
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns true for 'session not found' in error text", () => {
    const result = makeResult({
      error: "Session not found or expired",
      cost: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns true for 'invalid session' in error text", () => {
    const result = makeResult({
      error: "Invalid session ID provided",
      cost: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns true for 'session expired' in error text", () => {
    const result = makeResult({
      error: "The session has expired",
      cost: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("does not false-positive on rate limit errors with no cost", () => {
    const result = makeResult({
      error: "rate limit exceeded",
      cost: 0,
      rateLimit: { status: "rejected", resetsAt: 1234567890 },
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("does not interfere with detectRateLimit", () => {
    const rateLimited = makeResult({
      error: "Claude usage limit reached",
      rateLimit: { status: "rejected", resetsAt: 9999999999 },
    });
    expect(detectRateLimit(rateLimited).limited).toBe(true);
    expect(isDeadSessionError(rateLimited)).toBe(false);
  });
});

describe("engineDidWork", () => {
  it("is false for a first-request usage-limit rejection", () => {
    expect(engineDidWork(makeResult({ error: "You've hit your session limit", cost: 0, numTurns: 1 }))).toBe(false);
    expect(engineDidWork(makeResult({ error: "Claude exited with code 1" }))).toBe(false);
  });

  it("is true once the run spent money or took a second turn", () => {
    expect(engineDidWork(makeResult({ cost: 0.42, numTurns: 1 }))).toBe(true);
    expect(engineDidWork(makeResult({ cost: 0, numTurns: 3 }))).toBe(true);
  });
});

describe("rateLimitKind", () => {
  it("separates a real usage limit from a transient 429/overload", () => {
    expect(rateLimitKind(makeResult({ error: "You've hit your session limit · resets 9:50pm" }))).toBe("usage limit");
    expect(rateLimitKind(makeResult({ error: "x", rateLimit: { status: "rejected" } }))).toBe("usage limit");
    expect(rateLimitKind(makeResult({ error: "API Error: 529 overloaded_error" }))).toBe("rate limit/overload");
    expect(rateLimitKind(makeResult({ error: "429 Too Many Requests" }))).toBe("rate limit/overload");
  });
});

describe("detectRateLimit — Claude CLI 5-hour session limit text", () => {
  it("treats the bare quota-exit text as a usage limit", () => {
    expect(detectRateLimit(makeResult({ error: "You've hit your session limit · resets 9:50pm" })).limited).toBe(true);
    expect(detectRateLimit(makeResult({ error: "session not found" })).limited).toBe(false);
  });
});
