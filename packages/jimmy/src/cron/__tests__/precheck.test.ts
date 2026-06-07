import { describe, it, expect } from "vitest";
import { runPrecheck, DEFAULT_PRECHECK_TIMEOUT_MS } from "../precheck.js";

// Pin cwd to a real dir: vitest sets JINN_HOME to an uncreated tmp path, and the
// default cwd would otherwise spawn-fail. Production cwd is the real ~/.jinn.
const run = (pc: Parameters<typeof runPrecheck>[0]) => runPrecheck(pc, { cwd: process.cwd() });

describe("runPrecheck — exit-code contract", () => {
  it("decision=proceed when the command exits 0", async () => {
    const r = await run({ command: "exit 0", skipExitCodes: [10] });
    expect(r.decision).toBe("proceed");
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("decision=skip when the exit code is in skipExitCodes", async () => {
    const r = await run({ command: "exit 10", skipExitCodes: [10, 20] });
    expect(r.decision).toBe("skip");
    expect(r.exitCode).toBe(10);
  });

  it("treats a second listed skip code (e.g. lock contention) as skip", async () => {
    const r = await run({ command: "exit 20", skipExitCodes: [10, 20] });
    expect(r.decision).toBe("skip");
    expect(r.exitCode).toBe(20);
  });

  it("decision=error for a non-zero exit NOT in skipExitCodes (real failure not swallowed)", async () => {
    // e.g. the jinn-watcher prefilter's 21 = wacli outage — must surface, not skip.
    const r = await run({ command: "exit 21", skipExitCodes: [10, 20] });
    expect(r.decision).toBe("error");
    expect(r.exitCode).toBe(21);
  });

  it("with no skipExitCodes, ANY non-zero exit is an error (never skips blind)", async () => {
    const r = await run({ command: "exit 1" });
    expect(r.decision).toBe("error");
    expect(r.exitCode).toBe(1);
  });

  it("decision=error and timedOut=true when the command exceeds timeoutMs", async () => {
    const r = await run({ command: "sleep 5", skipExitCodes: [10], timeoutMs: 150 });
    expect(r.decision).toBe("error");
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it("decision=error on invalid config (missing/empty command)", async () => {
    const r = await run({ command: "" });
    expect(r.decision).toBe("error");
    expect(r.exitCode).toBeNull();
    expect(r.stderr).toMatch(/missing or empty command/);
  });

  it("captures stdout from the gate", async () => {
    const r = await run({ command: "echo hello; exit 0" });
    expect(r.decision).toBe("proceed");
    expect(r.stdout).toMatch(/hello/);
  });

  it("default timeout constant is exported and sane", () => {
    expect(DEFAULT_PRECHECK_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
