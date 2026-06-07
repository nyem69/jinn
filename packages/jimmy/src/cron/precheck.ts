import { execFile } from "node:child_process";
import type { CronJob } from "../shared/types.js";
import { JINN_HOME } from "../shared/paths.js";

export type PrecheckDecision = "proceed" | "skip" | "error";

export interface PrecheckResult {
  decision: PrecheckDecision;
  /** Numeric exit code, or null if the process never exited cleanly (timeout / spawn error). */
  exitCode: number | null;
  /** Signal that terminated the process, if any (e.g. "SIGTERM" on timeout). */
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export const DEFAULT_PRECHECK_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Run a cron job's `precheck` gate and classify the outcome. NEVER rejects —
 * every failure mode resolves to a result with decision "error" so the caller
 * can branch deterministically.
 *
 * Contract (see CronJob.precheck): exit 0 → proceed; exit ∈ skipExitCodes →
 * skip; any other non-zero (or timeout / spawn error / missing command) → error.
 */
export function runPrecheck(
  precheck: NonNullable<CronJob["precheck"]>,
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<PrecheckResult> {
  const start = Date.now();
  return new Promise<PrecheckResult>((resolve) => {
    const command = precheck?.command;
    if (typeof command !== "string" || command.trim() === "") {
      resolve({
        decision: "error",
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "precheck: missing or empty command",
        durationMs: Date.now() - start,
      });
      return;
    }
    const timeoutMs = precheck.timeoutMs ?? DEFAULT_PRECHECK_TIMEOUT_MS;
    const skipExitCodes = precheck.skipExitCodes ?? [];

    execFile(
      "/bin/bash",
      ["-c", command],
      {
        cwd: opts?.cwd ?? JINN_HOME,
        env: opts?.env ?? process.env,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - start;
        const out = (stdout ?? "").toString();
        const errOut = (stderr ?? "").toString();

        if (!err) {
          resolve({ decision: "proceed", exitCode: 0, signal: null, timedOut: false, stdout: out, stderr: errOut, durationMs });
          return;
        }

        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
        const signal = e.signal ?? null;
        // execFile sets killed=true and a termination signal when the timeout fires.
        const timedOut = e.killed === true && (signal === "SIGTERM" || signal === "SIGKILL");
        const exitCode = typeof e.code === "number" ? e.code : null;

        if (timedOut) {
          resolve({ decision: "error", exitCode: null, signal, timedOut: true, stdout: out, stderr: errOut, durationMs });
          return;
        }
        if (exitCode !== null && skipExitCodes.includes(exitCode)) {
          resolve({ decision: "skip", exitCode, signal: null, timedOut: false, stdout: out, stderr: errOut, durationMs });
          return;
        }
        // Non-zero exit not on the skip list, or a spawn error (ENOENT etc.) → fail loud.
        resolve({ decision: "error", exitCode, signal, timedOut: false, stdout: out, stderr: errOut, durationMs });
      },
    );
  });
}
