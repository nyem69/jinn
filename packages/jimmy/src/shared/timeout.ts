import type { Engine } from "./types.js";
import { isInterruptibleEngine } from "./types.js";
import { logger } from "./logger.js";

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
    engine.kill(sessionId, `Interrupted: session timeout (${capped}m)`);
    if (!wasAlive) {
      logger.warn(`Session ${label} has no live engine process — marking interrupted`);
      opts?.onForceInterrupt?.();
    }
  }, capped * 60_000);
}
