import fs from "node:fs";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";
import type { CronJob } from "../shared/types.js";

/**
 * Missed-fire catch-up for the cron scheduler.
 *
 * node-cron drives fires from a setInterval minute-tick. macOS sleep (notably
 * Clamshell Sleep on battery, which caffeinate cannot prevent) suspends that
 * tick, and node-cron does NOT replay a fire minute it slept through. A job
 * scheduled for a minute that passed while the host slept is silently dropped.
 *
 * This module detects such drops by comparing each job's most-recent scheduled
 * fire against its run-log, and replays the LATEST missed occurrence once,
 * shortly after wake (driven from the reconciler's setInterval, which coalesces
 * to one tick on wake). Guards: a grace window (don't race an on-time fire), a
 * lookback cap (don't replay ancient fires), run-log dedup (don't double-fire),
 * and a per-job opt-out (`catchUp: false`).
 *
 * `computeMissedFires` is pure (time + run-log lookups injected) so it is fully
 * unit-testable without live timers or the filesystem.
 */

export interface MissedFire {
  job: CronJob;
  /** ms epoch of the latest scheduled fire that was missed. */
  scheduledFor: number;
  /** In-window earlier occurrences collapsed by the latest-only policy. */
  olderFiresSkipped: number;
}

export interface TooOldSkip {
  job: CronJob;
  /** ms epoch of the most-recent fire, older than the lookback window. */
  scheduledFor: number;
}

export interface ComputeOptions {
  now: number;
  lastCheck: number;
  maxLookbackMs: number;
  graceMs: number;
  dedupSlopMs: number;
  /** Returns the ms epoch of a job's most recent run, or null if never run. */
  lastRunAt: (jobId: string) => number | null;
}

export interface MissedResult {
  replay: MissedFire[];
  tooOld: TooOldSkip[];
}

/** Most recent scheduled fire <= `now` for a job, or null if unparseable. */
function previousFire(job: CronJob, now: number): number | null {
  try {
    const it = CronExpressionParser.parse(job.schedule, {
      tz: job.timezone,
      currentDate: new Date(now),
    });
    return it.prev().toDate().getTime();
  } catch {
    return null;
  }
}

/** Count scheduled occurrences strictly inside (windowStart, before). */
function countOccurrencesBetween(
  job: CronJob,
  windowStart: number,
  before: number,
): number {
  try {
    const it = CronExpressionParser.parse(job.schedule, {
      tz: job.timezone,
      currentDate: new Date(before),
    });
    let count = 0;
    // prev() from a currentDate exactly on a fire returns the strictly-earlier
    // fire, so count each occurrence in (windowStart, before). Bound the walk.
    for (let i = 0; i < 100_000; i++) {
      const t = it.prev().toDate().getTime();
      if (t <= windowStart) break;
      if (t < before) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

export function computeMissedFires(
  jobs: CronJob[],
  opts: ComputeOptions,
): MissedResult {
  const { now, lastCheck, maxLookbackMs, graceMs, dedupSlopMs, lastRunAt } = opts;
  const replay: MissedFire[] = [];
  const tooOld: TooOldSkip[] = [];

  for (const job of jobs) {
    if (!job.enabled) continue;
    if (job.catchUp === false) continue;

    const prevFire = previousFire(job, now);
    if (prevFire === null) continue; // invalid schedule

    // Nothing fired since the last sweep.
    if (prevFire <= lastCheck) continue;

    // Too fresh — node-cron has not yet had its chance; avoid a double-fire.
    if (prevFire > now - graceMs) continue;

    // Already ran (on time, or a prior catch-up).
    const ran = lastRunAt(job.id);
    if (ran !== null && ran >= prevFire - dedupSlopMs) continue;

    // Older than the replay window: surface for logging, do not replay.
    if (prevFire < now - maxLookbackMs) {
      tooOld.push({ job, scheduledFor: prevFire });
      continue;
    }

    const windowStart = Math.max(lastCheck, now - maxLookbackMs);
    replay.push({
      job,
      scheduledFor: prevFire,
      olderFiresSkipped: countOccurrencesBetween(job, windowStart, prevFire),
    });
  }

  return { replay, tooOld };
}

/** Read the persisted last-sweep checkpoint (ms epoch), or null. */
export function readCheckpoint(file: string): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return typeof raw?.lastCheckedAt === "number" ? raw.lastCheckedAt : null;
  } catch {
    return null;
  }
}

/** Persist the last-sweep checkpoint (ms epoch). */
export function writeCheckpoint(file: string, ms: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ lastCheckedAt: ms }) + "\n",
    "utf-8",
  );
}

/** Last run timestamp (ms epoch) from a job's JSONL run-log, or null. */
export function lastRunAtFromDisk(jobId: string, runsDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(runsDir, `${jobId}.jsonl`), "utf-8");
    const lines = raw.trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      const ts = JSON.parse(line)?.timestamp;
      const ms = ts ? Date.parse(ts) : NaN;
      if (!Number.isNaN(ms)) return ms;
    }
    return null;
  } catch {
    return null;
  }
}
