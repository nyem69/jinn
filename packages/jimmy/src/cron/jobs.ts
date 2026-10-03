import fs from "node:fs";
import path from "node:path";
import type { CronJob } from "../shared/types.js";
import { CRON_JOBS, CRON_RUNS } from "../shared/paths.js";
import { recordCronPerformanceSafe } from "./performance.js";

export function loadJobs(): CronJob[] {
  try {
    const raw = fs.readFileSync(CRON_JOBS, "utf-8");
    return JSON.parse(raw) as CronJob[];
  } catch {
    return [];
  }
}

export function saveJobs(jobs: CronJob[]): void {
  const dir = path.dirname(CRON_JOBS);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CRON_JOBS, JSON.stringify(jobs, null, 2) + "\n", "utf-8");
}

export function appendRunLog(jobId: string, entry: object): void {
  fs.mkdirSync(CRON_RUNS, { recursive: true });
  const logPath = path.join(CRON_RUNS, `${jobId}.jsonl`);
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  // Every run-log entry also lands a performance_log row (see performance.ts).
  // Hooked here rather than in the runner so all three run-log writers are
  // covered by one call. Fire-and-forget; it never throws.
  const job = loadJobs().find((j) => j.id === jobId);
  void recordCronPerformanceSafe(jobId, job, entry as Record<string, unknown>);
}
