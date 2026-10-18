import type { CronJob, JinnConfig } from "../shared/types.js";

/** Default autonomous (cron) turn ceiling when nothing overrides it. */
export const DEFAULT_MAX_TURNS = 300;

/** Claude CLI result subtype emitted when --max-turns is hit. */
export const BUDGET_STOP_SUBTYPE = "error_max_turns";

/** Sentinel prefix written to Session.lastError on a budget stop, so the cron
 *  runner can classify the run without re-reading the engine result. Mirrors
 *  the existing `result.error.startsWith("Interrupted")` idiom. */
export const SESSION_BUDGET_STOP_PREFIX = "session_budget_stop:";

/** Sources that run unattended through SessionManager.runSession and so get the
 *  turn cap. v1 = cron only. (Web/API sessions use dispatchWebSessionRun, a
 *  separate path; "sdk" does not exist yet — extend here when it does.) */
export function isAutonomousSource(source: string): boolean {
  return source === "cron";
}

/** lastError prefix when a cron run hits a Claude usage/rate limit after it
 *  already did work. It stops instead of falling back (a fresh Codex run would
 *  repeat the sends/writes it already made) or waiting (the wait loop holds the
 *  job for hours, past later fires, with the wall-clock timer still armed). Its
 *  status is "error", so the cron runner's sessionErrored check fires the ops
 *  alert with this message. Ceiling: only the cron root's own turn in
 *  SessionManager.runSession stops; cron-spawned children and later callback
 *  turns (web dispatch path) keep the old fallback, because stopping them drops
 *  or re-wakes their parent (round-2 review, 2026-10-18). See isStoppedAfterWork. */
export const LIMIT_AFTER_WORK_PREFIX = "Claude limit after partial work";

/** A session stopped by the limit-after-work guard. Notifications to it (child
 *  completions, rate-limit resumes) are recorded but never dispatched: a turn
 *  would resume it on Codex and repeat the work the stop protects. An
 *  operator's own message still runs. */
export function isStoppedAfterWork(s: { status: string; lastError?: string | null }): boolean {
  return s.status === "error" && !!s.lastError?.startsWith(LIMIT_AFTER_WORK_PREFIX);
}

export function limitAfterWorkMessage(kind: string, numTurns?: number, cost?: number): string {
  return `${LIMIT_AFTER_WORK_PREFIX}: ${kind} (turns=${numTurns ?? 0}, cost=$${(cost ?? 0).toFixed(2)}) — stopped instead of falling back or waiting; check for partial side effects before re-running`;
}

/** Resolve a job's effective turn budget. Precedence:
 *  1. sessionBudget.hardCap === false  -> uncapped (null)
 *  2. job.maxTurns                     -> per-job override
 *  3. config.sessions.budget.maxTurns  -> global default
 *  4. DEFAULT_MAX_TURNS                -> hard default */
export function resolveJobBudget(
  job: CronJob,
  config: JinnConfig,
): { maxTurns: number | null; sideEffects: boolean } {
  const sideEffects = job.sessionBudget?.sideEffects === true;
  if (job.sessionBudget?.hardCap === false) {
    return { maxTurns: null, sideEffects };
  }
  const maxTurns = job.maxTurns ?? config.sessions?.budget?.maxTurns ?? DEFAULT_MAX_TURNS;
  return { maxTurns, sideEffects };
}

/** Short advisory contract appended to the system prompt of a capped run. */
export function budgetContractPrompt(cap: number): string {
  return [
    "## Turn Budget Contract",
    `This is an autonomous run with a hard ceiling of ${cap} agent turns. At the`,
    "ceiling the process is force-stopped with no output saved.",
    "- Work efficiently; avoid unnecessary tool calls and re-reading.",
    "- By ~80% of the budget, stop expanding scope — finish and deliver what you have.",
    "- If the task cannot complete within budget, STOP CLEANLY before the ceiling and",
    "  write a short continuation note (done / remaining / next step) into your normal",
    "  output so the next run can resume.",
  ].join("\n");
}

/** True when an engine result indicates a turn-budget (max-turns) stop. */
export function isBudgetStop(result: { subtype?: string }): boolean {
  return result.subtype === BUDGET_STOP_SUBTYPE;
}
