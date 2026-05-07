import { describe, it, expect } from "vitest";
import { validateEvent, isKnownKind, EventSchemas } from "../schema.js";

describe("validateEvent — happy path per kind", () => {
  it("accepts well-formed session_started", () => {
    const r = validateEvent("session_started", {
      employee: "chief-analyst",
      oversight: "VERIFY",
      brief: "Run weekly recap.",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts well-formed session_completed", () => {
    const r = validateEvent("session_completed", {
      state: "completed",
      tokens_in: 1234,
      tokens_out: 567,
      duration_ms: 12000,
      cost_usd: 0.42,
      step_count: 8,
      tool_call_count: 3,
      final_answer: "...",
      error_message: null,
    });
    expect(r.ok).toBe(true);
  });

  it("accepts subagent_completed with all enum values", () => {
    for (const quality of ["excellent", "good", "fair", "poor"] as const) {
      for (const outcome of ["success", "partial", "failed", "blocked"] as const) {
        const r = validateEvent("subagent_completed", {
          child_session_id: "child-1",
          quality,
          outcome,
        });
        expect(r.ok).toBe(true);
      }
    }
  });

  it("accepts tool_invoked with arbitrary args shape (z.unknown)", () => {
    const r = validateEvent("tool_invoked", {
      tool: "Bash",
      call_id: "c-1",
      args: { command: "ls", flags: ["-la"], nested: { ok: true } },
    });
    expect(r.ok).toBe(true);
  });
});

describe("validateEvent — rejection", () => {
  it("rejects unknown kinds with field path 'kind'", () => {
    const r = validateEvent("not_a_kind", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].path).toBe("kind");
      expect(r.errors[0].message).toContain("not_a_kind");
    }
  });

  it("rejects missing required fields with field-level error", () => {
    const r = validateEvent("session_started", { employee: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const paths = r.errors.map((e) => e.path);
      expect(paths).toContain("oversight");
      expect(paths).toContain("brief");
    }
  });

  it("rejects empty employee on session_started (min(1))", () => {
    const r = validateEvent("session_started", {
      employee: "",
      oversight: "TRUST",
      brief: "ok",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects negative tokens on session_completed", () => {
    const r = validateEvent("session_completed", {
      state: "completed",
      tokens_in: -1,
      tokens_out: 0,
      duration_ms: 0,
      cost_usd: null,
      step_count: 0,
      tool_call_count: 0,
      final_answer: null,
      error_message: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path === "tokens_in")).toBe(true);
    }
  });

  it("rejects oversight values outside the enum", () => {
    const r = validateEvent("session_started", {
      employee: "x",
      oversight: "WHATEVER",
      brief: "y",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects skill_invoked args_summary > 500 chars", () => {
    const r = validateEvent("skill_invoked", {
      skill: "test",
      args_summary: "x".repeat(501),
    });
    expect(r.ok).toBe(false);
  });

  it("rejects validator_hard_fail iterations <= 0", () => {
    const r = validateEvent("validator_hard_fail", {
      skill: "test",
      iterations: 0,
    });
    expect(r.ok).toBe(false);
  });
});

describe("isKnownKind", () => {
  it("returns true for every key in EventSchemas", () => {
    for (const key of Object.keys(EventSchemas)) {
      expect(isKnownKind(key)).toBe(true);
    }
  });

  it("returns false for unknown strings", () => {
    expect(isKnownKind("nope")).toBe(false);
    expect(isKnownKind("")).toBe(false);
  });
});
