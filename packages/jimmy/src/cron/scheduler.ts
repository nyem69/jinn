import crypto from "node:crypto";
import cron from "node-cron";
import type {
  CronJob,
  JinnConfig,
  Connector,
} from "../shared/types.js";
import { runCronJob } from "./runner.js";
import { logger } from "../shared/logger.js";
import type { SessionManager } from "../sessions/manager.js";
import { loadJobs, saveJobs } from "./jobs.js";
import {
  computeMissedFires,
  readCheckpoint,
  writeCheckpoint,
  lastRunAtFromDisk,
} from "./catchup.js";
import { CRON_CATCHUP_STATE, CRON_RUNS } from "../shared/paths.js";

const CATCHUP_MAX_LOOKBACK_MS = 72 * 60 * 60 * 1000; // 72h
const CATCHUP_GRACE_MS = 90 * 1000;
const CATCHUP_DEDUP_SLOP_MS = 60 * 1000;
let catchUpInFlight = false;

let tasks: cron.ScheduledTask[] = [];
let currentSessionManager: SessionManager;
let currentConfig: JinnConfig;
let currentConnectors: Map<string, Connector>;

// Signature of the last set of jobs successfully passed to scheduleJobs().
// The reconciler (cron/reconciler.ts) diffs this against the persisted
// jobs.json signature on a timer to catch silent file-watcher drops —
// see nyem69/jinn#15.
let lastScheduledSig = "";

/**
 * Canonical hash of the *enabled* jobs' scheduling-relevant fields.
 * Includes prompt/engine/model/employee because runCronJob captures these
 * at schedule time — editing any of them in jobs.json must trigger a
 * rescheduling pass for the live closure to pick up the change.
 */
export function signatureOfJobs(jobs: CronJob[]): string {
  const slim = jobs
    .filter((j) => j.enabled)
    .map((j) => ({
      id: j.id,
      schedule: j.schedule,
      timezone: j.timezone ?? null,
      engine: j.engine ?? null,
      model: j.model ?? null,
      employee: j.employee ?? null,
      prompt: j.prompt ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return crypto.createHash("sha1").update(JSON.stringify(slim)).digest("hex");
}

export function getScheduledSignature(): string {
  return lastScheduledSig;
}

export function startScheduler(
  jobs: CronJob[],
  sessionManager: SessionManager,
  config: JinnConfig,
  connectors: Map<string, Connector>,
): void {
  currentSessionManager = sessionManager;
  currentConfig = config;
  currentConnectors = connectors;
  scheduleJobs(jobs);
  // Replay any fire the host slept (or was down) through since the last sweep.
  void catchUpMissed();
}

/**
 * Replay scheduled fires missed while the host slept (node-cron's minute-tick
 * is suspended during macOS sleep and never replays a passed minute). Driven
 * fire-and-forget from startScheduler and each reconciler tick (the first
 * post-wake tick runs this). Replays only the latest missed occurrence per
 * eligible job; run-log dedup + a grace window prevent double-firing on-time
 * runs. See cron/catchup.ts for the pure decision logic.
 */
export async function catchUpMissed(now: number = Date.now()): Promise<void> {
  if (!currentSessionManager) return; // scheduler not started yet
  if (catchUpInFlight) return; // don't overlap sweeps
  catchUpInFlight = true;
  const lastCheck = readCheckpoint(CRON_CATCHUP_STATE) ?? now;
  try {
    const { replay, tooOld } = computeMissedFires(loadJobs(), {
      now,
      lastCheck,
      maxLookbackMs: CATCHUP_MAX_LOOKBACK_MS,
      graceMs: CATCHUP_GRACE_MS,
      dedupSlopMs: CATCHUP_DEDUP_SLOP_MS,
      lastRunAt: (id) => lastRunAtFromDisk(id, CRON_RUNS),
    });
    const lookbackH = Math.round(CATCHUP_MAX_LOOKBACK_MS / 3_600_000);
    for (const t of tooOld) {
      logger.warn(
        `Cron catch-up: "${t.job.name}" (${t.job.id}) missed fire at ` +
          `${new Date(t.scheduledFor).toISOString()} is older than the ${lookbackH}h ` +
          `lookback — not replaying.`,
      );
    }
    for (const m of replay) {
      const scheduledFor = new Date(m.scheduledFor).toISOString();
      const extra = m.olderFiresSkipped
        ? ` (+${m.olderFiresSkipped} older occurrence(s) skipped)`
        : "";
      logger.info(
        `Cron catch-up: replaying "${m.job.name}" (${m.job.id}) — missed fire ` +
          `${scheduledFor}${extra}`,
      );
      await runCronJob(
        m.job,
        currentSessionManager,
        currentConfig,
        currentConnectors,
        { catchUp: true, scheduledFor, olderFiresSkipped: m.olderFiresSkipped },
      );
    }
  } catch (err) {
    logger.warn(
      `Cron catch-up sweep failed: ${(err as Error).message ?? err}`,
    );
  } finally {
    try {
      writeCheckpoint(CRON_CATCHUP_STATE, now);
    } catch {
      /* best-effort checkpoint */
    }
    catchUpInFlight = false;
  }
}

export function reloadScheduler(jobs: CronJob[]): void {
  stopScheduler();
  scheduleJobs(jobs);
}

export function stopScheduler(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks = [];
}

function scheduleJobs(jobs: CronJob[]): void {
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (!cron.validate(job.schedule)) {
      logger.warn(
        `Invalid cron schedule for job "${job.name}": ${job.schedule}`,
      );
      continue;
    }
    const task = cron.schedule(
      job.schedule,
      () => {
        runCronJob(job, currentSessionManager, currentConfig, currentConnectors);
      },
      { timezone: job.timezone },
    );
    tasks.push(task);
    logger.info(`Scheduled cron job "${job.name}" (${job.schedule})`);
  }
  lastScheduledSig = signatureOfJobs(jobs);
}

export async function triggerCronJob(idOrName: string): Promise<CronJob | undefined> {
  const job = findJob(idOrName);
  if (!job) return undefined;
  await runCronJob(job, currentSessionManager, currentConfig, currentConnectors);
  return job;
}

export function setCronJobEnabled(idOrName: string, enabled: boolean): CronJob | undefined {
  const jobs = loadJobs();
  const index = jobs.findIndex((job) => matchesJob(job, idOrName));
  if (index === -1) return undefined;
  jobs[index] = { ...jobs[index], enabled };
  saveJobs(jobs);
  reloadScheduler(jobs);
  return jobs[index];
}

function findJob(idOrName: string): CronJob | undefined {
  return loadJobs().find((job) => matchesJob(job, idOrName));
}

function matchesJob(job: CronJob, idOrName: string): boolean {
  const needle = idOrName.trim().toLowerCase();
  return job.id.toLowerCase() === needle || job.name.toLowerCase() === needle;
}
