import { describe, it, expect } from "vitest";
import { signatureOfJobs } from "../scheduler.js";
import type { CronJob } from "../../shared/types.js";

function job(overrides: Partial<CronJob>): CronJob {
  return {
    id: "j1",
    name: "test-job",
    enabled: true,
    schedule: "* * * * *",
    timezone: "Asia/Kuala_Lumpur",
    engine: "claude",
    model: "sonnet",
    employee: "jin",
    prompt: "do the thing",
    ...overrides,
  } as CronJob;
}

describe("signatureOfJobs", () => {
  it("is stable for the same input", () => {
    const a = [job({ id: "a" }), job({ id: "b" })];
    const b = [job({ id: "a" }), job({ id: "b" })];
    expect(signatureOfJobs(a)).toBe(signatureOfJobs(b));
  });

  it("is order-independent", () => {
    const a = [job({ id: "a" }), job({ id: "b" })];
    const b = [job({ id: "b" }), job({ id: "a" })];
    expect(signatureOfJobs(a)).toBe(signatureOfJobs(b));
  });

  it("excludes disabled jobs", () => {
    const baseline = [job({ id: "a" })];
    const withDisabled = [job({ id: "a" }), job({ id: "b", enabled: false })];
    expect(signatureOfJobs(baseline)).toBe(signatureOfJobs(withDisabled));
  });

  it("changes when an enabled job's schedule changes", () => {
    const before = [job({ id: "a", schedule: "0 * * * *" })];
    const after = [job({ id: "a", schedule: "*/15 * * * *" })];
    expect(signatureOfJobs(before)).not.toBe(signatureOfJobs(after));
  });

  it("changes when an enabled job's prompt changes (closure captures it)", () => {
    // Critical: runCronJob captures the prompt in its closure at schedule
    // time, so prompt edits must trigger a rescheduling pass. The
    // reconciler relies on this signature to detect that case.
    const before = [job({ prompt: "old" })];
    const after = [job({ prompt: "new" })];
    expect(signatureOfJobs(before)).not.toBe(signatureOfJobs(after));
  });

  it("changes when a disabled job is enabled", () => {
    const before = [job({ id: "a", enabled: false })];
    const after = [job({ id: "a", enabled: true })];
    expect(signatureOfJobs(before)).not.toBe(signatureOfJobs(after));
  });

  it("does not change when a disabled job's fields are edited", () => {
    const before = [job({ id: "x", enabled: true }), job({ id: "y", enabled: false, prompt: "p1" })];
    const after = [job({ id: "x", enabled: true }), job({ id: "y", enabled: false, prompt: "p2" })];
    expect(signatureOfJobs(before)).toBe(signatureOfJobs(after));
  });
});
