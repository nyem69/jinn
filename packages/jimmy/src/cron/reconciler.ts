import { logger } from "../shared/logger.js";
import { loadJobs } from "./jobs.js";
import {
  reloadScheduler,
  getScheduledSignature,
  signatureOfJobs,
} from "./scheduler.js";

/**
 * Periodic safety net for the cron scheduler.
 *
 * The file-watcher (`gateway/watcher.ts`) is the primary mechanism that
 * picks up `cron/jobs.json` edits and calls `reloadScheduler`. But
 * chokidar's single-file watch can silently die — atomic-rename writes
 * (vim, git checkout, editor saves) unlink the watched inode and the
 * underlying fs handle becomes invalid. When that happens, jobs.json edits
 * stop being noticed and newly-enabled jobs never get scheduled.
 *
 * This reconciler ticks on a low-frequency timer and diffs the persisted
 * jobs.json signature against the live scheduler's last-loaded signature.
 * On divergence it forces a `reloadScheduler` — belt-and-suspenders.
 *
 * See nyem69/jinn#15 for the full diagnosis.
 */

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let timer: ReturnType<typeof setInterval> | null = null;

export function startCronReconciler(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return; // already running
  timer = setInterval(tickReconciler, intervalMs);
  // Don't keep the process alive just for the reconciler.
  timer.unref?.();
  logger.info(
    `Cron reconciler started (every ${Math.round(intervalMs / 1000)}s)`,
  );
}

export function stopCronReconciler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * One reconciler tick — exported for tests. Safe to call manually.
 * Returns true if a reload was forced, false otherwise.
 */
export function tickReconciler(): boolean {
  try {
    const jobs = loadJobs();
    const persisted = signatureOfJobs(jobs);
    const live = getScheduledSignature();
    if (persisted !== live) {
      logger.warn(
        `Cron reconciler: persisted jobs.json diverges from live scheduler ` +
          `(live=${live.slice(0, 8) || "<none>"} persisted=${persisted.slice(0, 8)}); forcing reloadScheduler`,
      );
      reloadScheduler(jobs);
      return true;
    }
    return false;
  } catch (err) {
    logger.warn(
      `Cron reconciler tick failed: ${(err as Error).message ?? err}`,
    );
    return false;
  }
}
