import type { Engine } from "./types.js";
import { isInterruptibleEngine } from "./types.js";
import { logger } from "./logger.js";

/** Sentinel prefix for the kill reason written when the wall-clock cap fires.
 *  Still begins with "Interrupted" so the engines' retry-skip and the session
 *  manager's `startsWith("Interrupted")` idiom keep working, but is specific
 *  enough that both the manager and the cron runner can tell a TIMEOUT kill
 *  apart from a benign user interrupt ("Interrupted by user", "Interrupted:
 *  new message received"). Mirrors SESSION_BUDGET_STOP_PREFIX. */
export const SESSION_TIMEOUT_PREFIX = "Interrupted: session timeout";

/** The exact kill reason for a wall-clock timeout at `minutes`. */
export function sessionTimeoutReason(minutes: number): string {
  return `${SESSION_TIMEOUT_PREFIX} (${minutes}m)`;
}

/**
 * Start a session timeout that kills the engine after `timeoutMinutes`.
 * Returns the timer handle (for clearTimeout in finally), or undefined if no timeout was set.
 */
export function startSessionTimeout(
  engine: Engine,
  sessionId: string,
  timeoutMinutes: unknown,
  opts?: {
    employeeName?: string;
    source?: string;
    onForceInterrupt?: () => void;
  },
): ReturnType<typeof setTimeout> | undefined {
  if (
    typeof timeoutMinutes !== "number" ||
    !Number.isFinite(timeoutMinutes) ||
    timeoutMinutes <= 0 ||
    !isInterruptibleEngine(engine)
  ) {
    return undefined;
  }

  const capped = Math.min(timeoutMinutes, 1440); // cap at 24h
  const label = [sessionId, opts?.employeeName, opts?.source].filter(Boolean).join(", ");

  return setTimeout(() => {
    const wasAlive = engine.isAlive(sessionId);
    logger.info(`Session ${label} exceeded ${capped}m timeout — killing engine`);
    engine.kill(sessionId, sessionTimeoutReason(capped));
    if (!wasAlive) {
      logger.warn(`Session ${label} has no live engine process — marking interrupted`);
      opts?.onForceInterrupt?.();
    }
  }, capped * 60_000);
}
