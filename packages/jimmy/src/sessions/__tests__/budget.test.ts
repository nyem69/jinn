import { describe, it, expect } from "vitest";
import {
  isAutonomousSource,
  resolveJobBudget,
  budgetContractPrompt,
  isBudgetStop,
  DEFAULT_MAX_TURNS,
  BUDGET_STOP_SUBTYPE,
  SESSION_BUDGET_STOP_PREFIX,
} from "../budget.js";
import type { CronJob, JinnConfig } from "../../shared/types.js";

const job = (over: Partial<CronJob> = {}): CronJob => ({
  id: "j1", name: "Job 1", enabled: true, schedule: "* * * * *", prompt: "go", ...over,
});
const cfg = (maxTurns?: number): JinnConfig =>
  ({ sessions: maxTurns === undefined ? {} : { budget: { maxTurns } } } as unknown as JinnConfig);

describe("isAutonomousSource", () => {
  it("is true for cron", () => expect(isAutonomousSource("cron")).toBe(true));
  it("is false for human/web sources", () => {
    for (const s of ["web", "slack", "user", "discord", ""]) {
      expect(isAutonomousSource(s)).toBe(false);
    }
  });
});

describe("resolveJobBudget", () => {
  it("falls back to DEFAULT_MAX_TURNS when nothing is set", () => {
    expect(resolveJobBudget(job(), cfg())).toEqual({ maxTurns: DEFAULT_MAX_TURNS, sideEffects: false });
  });
  it("uses the global config default when present", () => {
    expect(resolveJobBudget(job(), cfg(200)).maxTurns).toBe(200);
  });
  it("per-job maxTurns beats the global default", () => {
    expect(resolveJobBudget(job({ maxTurns: 120 }), cfg(200)).maxTurns).toBe(120);
  });
  it("hardCap=false opts out (null) even if maxTurns is set", () => {
    expect(resolveJobBudget(job({ maxTurns: 120, sessionBudget: { hardCap: false } }), cfg(200)).maxTurns).toBeNull();
  });
  it("propagates sideEffects", () => {
    expect(resolveJobBudget(job({ sessionBudget: { sideEffects: true } }), cfg()).sideEffects).toBe(true);
  });
});

describe("budgetContractPrompt", () => {
  it("states the cap and the hard ceiling", () => {
    const p = budgetContractPrompt(250);
    expect(p).toContain("250");
    expect(p.toLowerCase()).toContain("hard ceiling");
  });
});

describe("isBudgetStop", () => {
  it("is true only for the max-turns subtype", () => {
    expect(isBudgetStop({ subtype: BUDGET_STOP_SUBTYPE })).toBe(true);
    expect(isBudgetStop({ subtype: "success" })).toBe(false);
    expect(isBudgetStop({})).toBe(false);
  });
});

describe("constants", () => {
  it("are the agreed values", () => {
    expect(DEFAULT_MAX_TURNS).toBe(300);
    expect(BUDGET_STOP_SUBTYPE).toBe("error_max_turns");
    expect(SESSION_BUDGET_STOP_PREFIX).toBe("session_budget_stop:");
  });
});
