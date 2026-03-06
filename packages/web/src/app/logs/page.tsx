"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "@/lib/api";

interface LogLine {
  level: string;
  message: string;
  timestamp?: string;
  [key: string]: unknown;
}

const LEVEL_COLORS: Record<string, string> = {
  debug: "text-neutral-400",
  info: "text-neutral-300",
  warn: "text-yellow-400",
  error: "text-red-400",
};

const LEVEL_BADGE: Record<string, string> = {
  debug: "text-neutral-500",
  info: "text-blue-400",
  warn: "text-yellow-400",
  error: "text-red-400",
};

function parseLine(raw: unknown): LogLine {
  if (typeof raw === "string") {
    const lower = raw.toLowerCase();
    let level = "info";
    if (lower.includes("[error]") || lower.includes('"level":"error"')) level = "error";
    else if (lower.includes("[warn]") || lower.includes('"level":"warn"')) level = "warn";
    else if (lower.includes("[debug]") || lower.includes('"level":"debug"'))
      level = "debug";
    return { level, message: raw };
  }
  const obj = raw as Record<string, unknown>;
  return {
    level: (obj.level as string) || "info",
    message: (obj.message as string) || (obj.msg as string) || JSON.stringify(raw),
    timestamp: (obj.timestamp as string) || (obj.time as string) || undefined,
  };
}

export default function LogsPage() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  const fetchLogs = useCallback(() => {
    api
      .getLogs(100)
      .then((data) => {
        const d = data as Record<string, unknown>;
        const raw = (d.lines as unknown[]) || (d.logs as unknown[]) || [];
        setLines(raw.map(parseLine));
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  useEffect(() => {
    if (autoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  function handleScroll() {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    autoScroll.current = scrollHeight - scrollTop - clientHeight < 40;
  }

  const filtered =
    filter === "all" ? lines : lines.filter((l) => l.level === filter);

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Logs</h2>
          <p className="text-sm text-neutral-500 mt-1">Gateway log output</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="text-sm border border-neutral-200 rounded-lg px-3 py-1.5 bg-white text-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Levels</option>
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <button
            onClick={() => {
              setLoading(true);
              fetchLogs();
            }}
            className="px-3 py-1.5 text-sm font-medium text-neutral-600 bg-neutral-100 rounded-lg hover:bg-neutral-200 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Failed to load logs: {error}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 rounded-xl bg-neutral-900 border border-neutral-700 overflow-y-auto font-mono text-xs leading-5"
      >
        {loading ? (
          <p className="px-4 py-6 text-neutral-500">Loading logs...</p>
        ) : filtered.length === 0 ? (
          <p className="px-4 py-6 text-neutral-500 text-center">
            {filter === "all" ? "No log entries" : `No ${filter} entries`}
          </p>
        ) : (
          <div className="px-4 py-3">
            {filtered.map((line, i) => (
              <div key={i} className="flex gap-2 py-0.5 hover:bg-neutral-800/50">
                {line.timestamp && (
                  <span className="text-neutral-600 shrink-0">
                    {line.timestamp}
                  </span>
                )}
                <span
                  className={`uppercase w-12 shrink-0 text-right ${
                    LEVEL_BADGE[line.level] || "text-neutral-500"
                  }`}
                >
                  {line.level}
                </span>
                <span className={LEVEL_COLORS[line.level] || "text-neutral-300"}>
                  {line.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
