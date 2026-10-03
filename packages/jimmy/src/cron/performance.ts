import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { CronJob } from "../shared/types.js";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";

// Cron outcomes → performance_log.
//
// performance_log was only written by the subagent_completed handler, so cron
// runs (the bulk of the gateway's work) never reached it: the steward's
// reliability check read "26 succeeded, 0 failed" over a month that had 22
// block/fail episodes. Every run-log entry the runner writes now also lands one
// performance_log row, keyed task_type='cron', task_ref=<job name>.
//
// Gated by features.handlers.cron_performance (default on). Best-effort: a DB
// failure is logged and swallowed — it must never fail or delay a cron run.

type Outcome = "succeeded" | "failed" | "blocked";

/**
 * Map a run-log status onto performance_log's CHECK set. `null` = don't record.
 * gated-skip is a healthy no-work tick with no session; recording it would
 * flood the table from the every-few-minutes precheck jobs.
 */
export function cronStatusToOutcome(status: unknown): Outcome | null {
  switch (status) {
    case "success":
      return "succeeded";
    case "gated-skip":
      return null;
    case "session_budget_stop":
      return "blocked";
    default:
      // error, precheck_error, session_timeout, and any future failure status.
      return "failed";
  }
}

export function cronPerformanceEnabled(): boolean {
  try {
    const cfg = loadConfig() as { features?: { handlers?: Record<string, boolean> } };
    return cfg.features?.handlers?.cron_performance ?? true;
  } catch {
    return true;
  }
}

export function recordCronPerformance(
  db: Database.Database,
  jobId: string,
  job: Pick<CronJob, "name" | "employee"> | undefined,
  entry: Record<string, unknown>,
): boolean {
  const outcome = cronStatusToOutcome(entry.status);
  if (!outcome) return false;
  const notes = JSON.stringify({
    jobId,
    sessionId: entry.sessionId ?? null,
    status: entry.status ?? null,
    durationMs: entry.durationMs ?? null,
    ...(entry.catchUp ? { catchUp: true } : {}),
    ...(typeof entry.error === "string" && entry.error ? { error: entry.error.slice(0, 300) } : {}),
  });
  db.prepare(
    `INSERT INTO performance_log (id, employee, department, task_type, task_ref, outcome, quality, score, notes)
     VALUES (?, ?, 'cron', 'cron', ?, ?, NULL, NULL, ?)`,
  ).run(randomUUID(), job?.employee || "unassigned", job?.name || jobId, outcome, notes);
  return true;
}

/** Fire-and-forget wrapper used by appendRunLog. Never throws. */
export async function recordCronPerformanceSafe(
  jobId: string,
  job: Pick<CronJob, "name" | "employee"> | undefined,
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    if (!cronPerformanceEnabled()) return;
    const { initDb } = await import("../sessions/registry.js");
    recordCronPerformance(initDb(), jobId, job, entry);
  } catch (err) {
    logger.warn(
      `cron_performance: could not record run of ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
