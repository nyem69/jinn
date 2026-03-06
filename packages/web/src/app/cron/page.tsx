"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  engine?: string;
  employee?: string;
  enabled: boolean;
  nextRun?: string;
  [key: string]: unknown;
}

interface CronRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  [key: string]: unknown;
}

function humanCron(expr: string): string {
  const parts = expr.split(" ");
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  if (min === "0" && hour === "*" && dom === "*" && mon === "*" && dow === "*")
    return "Every hour";
  if (min === "*/5" && hour === "*" && dom === "*" && mon === "*" && dow === "*")
    return "Every 5 minutes";
  if (min === "*/15" && hour === "*" && dom === "*" && mon === "*" && dow === "*")
    return "Every 15 minutes";
  if (min === "*/30" && hour === "*" && dom === "*" && mon === "*" && dow === "*")
    return "Every 30 minutes";
  if (dom === "*" && mon === "*" && dow === "*" && hour !== "*" && min !== "*")
    return `Daily at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  if (dom === "*" && mon === "*" && dow === "1" && hour !== "*")
    return `Weekly on Mon at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  return expr;
}

export default function CronPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  useEffect(() => {
    api
      .getCronJobs()
      .then((data) => setJobs(data as CronJob[]))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function toggleExpand(job: CronJob) {
    if (expandedId === job.id) {
      setExpandedId(null);
      setRuns([]);
      return;
    }
    setExpandedId(job.id);
    setRunsLoading(true);
    api
      .getCronRuns(job.id)
      .then((data) => setRuns(data as CronRun[]))
      .catch(() => setRuns([]))
      .finally(() => setRunsLoading(false));
  }

  function toggleEnabled(job: CronJob) {
    const updated = { ...job, enabled: !job.enabled };
    api
      .updateCronJob(job.id, { enabled: updated.enabled })
      .then(() => {
        setJobs((prev) =>
          prev.map((j) => (j.id === job.id ? { ...j, enabled: updated.enabled } : j))
        );
      })
      .catch(() => {});
  }

  if (loading) {
    return (
      <div>
        <div className="mb-8">
          <h2 className="text-2xl font-semibold tracking-tight">Cron Jobs</h2>
          <p className="text-sm text-neutral-500 mt-1">Scheduled tasks and run history</p>
        </div>
        <p className="text-sm text-neutral-400">Loading...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-2xl font-semibold tracking-tight">Cron Jobs</h2>
        <p className="text-sm text-neutral-500 mt-1">Scheduled tasks and run history</p>
      </div>

      {error && (
        <div className="mb-6 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Failed to load cron jobs: {error}
        </div>
      )}

      {jobs.length === 0 && !error ? (
        <div className="rounded-xl border border-neutral-200 bg-white px-6 py-12 text-center">
          <p className="text-sm text-neutral-400">No cron jobs configured</p>
          <p className="text-xs text-neutral-300 mt-1">
            Add jobs to your Jimmy config to schedule automated tasks
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="rounded-xl border border-neutral-200 bg-white overflow-hidden"
            >
              <div
                className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-neutral-50 transition-colors"
                onClick={() => toggleExpand(job)}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-neutral-800 truncate">
                    {job.name}
                  </p>
                  <p className="text-xs text-neutral-400 mt-0.5">
                    {humanCron(job.schedule)}
                    <span className="mx-1.5 text-neutral-300">|</span>
                    <span className="font-mono">{job.schedule}</span>
                  </p>
                </div>

                {job.engine && (
                  <span className="text-xs bg-neutral-100 text-neutral-500 px-2 py-0.5 rounded-full">
                    {job.engine}
                  </span>
                )}
                {job.employee && (
                  <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full">
                    {job.employee}
                  </span>
                )}

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleEnabled(job);
                  }}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    job.enabled ? "bg-blue-600" : "bg-neutral-300"
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                      job.enabled ? "translate-x-4" : "translate-x-1"
                    }`}
                  />
                </button>

                <span
                  className={`text-xs transition-transform ${
                    expandedId === job.id ? "rotate-180" : ""
                  }`}
                >
                  v
                </span>
              </div>

              {expandedId === job.id && (
                <div className="border-t border-neutral-100 px-5 py-4 bg-neutral-50">
                  {job.nextRun && (
                    <p className="text-xs text-neutral-500 mb-3">
                      Next run: <span className="font-mono">{job.nextRun}</span>
                    </p>
                  )}

                  <h4 className="text-xs font-medium uppercase tracking-wide text-neutral-400 mb-2">
                    Run History
                  </h4>
                  {runsLoading ? (
                    <p className="text-xs text-neutral-400">Loading runs...</p>
                  ) : runs.length === 0 ? (
                    <p className="text-xs text-neutral-400">No runs yet</p>
                  ) : (
                    <div className="space-y-1">
                      {runs.slice(0, 10).map((run) => (
                        <div
                          key={run.id}
                          className="flex items-center gap-3 text-xs py-1"
                        >
                          <span
                            className={`inline-block w-1.5 h-1.5 rounded-full ${
                              run.status === "success"
                                ? "bg-green-500"
                                : run.status === "error" || run.status === "failed"
                                  ? "bg-red-500"
                                  : run.status === "running"
                                    ? "bg-blue-500"
                                    : "bg-neutral-300"
                            }`}
                          />
                          <span className="font-mono text-neutral-500">
                            {run.startedAt}
                          </span>
                          <span className="text-neutral-400">{run.status}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
