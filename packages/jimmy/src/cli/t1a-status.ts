import { initDb } from '../sessions/registry.js';
import { DEFAULT_HANDLERS } from '../events/handlers.js';
import { getClaudeTransport } from '../engines/claude/emitter.js';

// `jinn t1a-status [--since <iso>] [--json]`
//
// One-shot snapshot of the T1A soak surfaces: event log volume,
// DLQ depth + recent failures, handler statuses, cost_log autofill
// ratio. Designed for the 7-day soak window — run anytime to see how
// the gateway is tracking against PLAN-T1A § "Done criteria for T1A
// as a whole".

export interface RunT1aStatusOpts {
  since?: string;
  json?: boolean;
}

interface EventCount { kind: string; n: number }
interface HandlerRow { id: number; processor: string; kind_filter: string; status: string }
interface DlqError { error: string; n: number }

export interface StatusReport {
  generatedAt: string;
  since: string;
  gateway: {
    transport: string;
    listening: boolean;
    uptimeSeconds: number | null;
  };
  events: { byKind: EventCount[]; total: number };
  dlq: { depth: number; topErrors: DlqError[] };
  handlers: Array<{
    processor: string;
    kindFilter: string;
    status: string;
    defaultEnabled: boolean;
  }>;
  costLog: {
    total: number;
    withTokens: number;
    legacy: number;
    autofillRatio: number;
    claudeCompletions: number;
  };
  doneCriteria: {
    dlqClean: boolean;
    costAutofillPct: number;
    replayInvocations: number;
  };
}

export async function runT1aStatus(opts: RunT1aStatusOpts = {}): Promise<void> {
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const report = await buildReport(since);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printHuman(report);
}

export async function buildReport(since: string): Promise<StatusReport> {
  const db = initDb();
  const generatedAt = new Date().toISOString();

  const eventRows = db
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM session_events
        WHERE created_at >= ?
        GROUP BY kind ORDER BY kind`,
    )
    .all(since) as EventCount[];
  const eventTotal = eventRows.reduce((sum, r) => sum + r.n, 0);

  const dlqDepth = (
    db
      .prepare("SELECT COUNT(*) AS n FROM event_dlq WHERE retried_at IS NULL")
      .get() as { n: number }
  ).n;
  const topErrors = db
    .prepare(
      `SELECT substr(error, 1, 100) AS error, COUNT(*) AS n FROM event_dlq
        WHERE retried_at IS NULL
        GROUP BY error
        ORDER BY n DESC LIMIT 5`,
    )
    .all() as DlqError[];

  const handlerRows = db
    .prepare("SELECT id, processor, kind_filter, status FROM event_handlers ORDER BY processor")
    .all() as HandlerRow[];
  const defaultEnabledMap = new Map(DEFAULT_HANDLERS.map((h) => [h.name, h.defaultEnabled]));
  const handlers = handlerRows.map((h) => ({
    processor: h.processor,
    kindFilter: h.kind_filter,
    status: h.status,
    defaultEnabled: defaultEnabledMap.get(h.processor) ?? false,
  }));

  const costRows = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS with_tokens,
         SUM(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) AS legacy
       FROM cost_log WHERE created_at >= ?`,
    )
    .get(since) as { total: number; with_tokens: number | null; legacy: number | null };

  const claudeCompletions = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM session_events e
          JOIN sessions s ON s.id = e.session_id
          WHERE e.kind = 'session_completed'
            AND s.engine = 'claude'
            AND e.created_at >= ?`,
      )
      .get(since) as { n: number }
  ).n;

  const withTokens = costRows.with_tokens ?? 0;
  const autofillRatio = claudeCompletions > 0 ? withTokens / claudeCompletions : 1;

  // Replay invocations: a checkpoint on a non-'main' branch is the
  // signature of a forked replay. Counts unique (session, branch) pairs.
  const replayInvocations = (
    db
      .prepare(
        "SELECT COUNT(DISTINCT session_id || '|' || branch) AS n FROM session_checkpoints WHERE branch != 'main'",
      )
      .get() as { n: number }
  ).n;

  // Live gateway probe — loopback only, short timeout. If unreachable
  // the report still produces; the `listening` flag tells the operator.
  // We read the gateway's transport from /api/status because the CLI's
  // own process.env doesn't reflect the gateway's launchd-managed env.
  let listening = false;
  let uptimeSeconds: number | null = null;
  let liveTransport: string | null = null;
  try {
    const res = await fetch("http://127.0.0.1:7777/api/status", {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        uptime?: number;
        features?: { claude_event_transport?: string };
      };
      listening = true;
      uptimeSeconds = typeof json.uptime === "number" ? json.uptime : null;
      liveTransport = json.features?.claude_event_transport ?? null;
    }
  } catch {
    // not reachable — leave listening=false
  }

  return {
    generatedAt,
    since,
    gateway: {
      // Prefer the live gateway's reported transport; fall back to the
      // CLI's own env if the gateway is unreachable.
      transport: liveTransport ?? getClaudeTransport(),
      listening,
      uptimeSeconds,
    },
    events: { byKind: eventRows, total: eventTotal },
    dlq: { depth: dlqDepth, topErrors },
    handlers,
    costLog: {
      total: costRows.total ?? 0,
      withTokens,
      legacy: costRows.legacy ?? 0,
      autofillRatio,
      claudeCompletions,
    },
    doneCriteria: {
      dlqClean: dlqDepth === 0,
      costAutofillPct: Math.round(autofillRatio * 100),
      replayInvocations,
    },
  };
}

function printHuman(report: StatusReport): void {
  const fmt = (n: number): string => n.toLocaleString();

  console.log(`=== T1A soak state — ${report.generatedAt} ===`);
  console.log("");

  console.log("Gateway");
  if (report.gateway.listening) {
    console.log(`  Status:        listening on 127.0.0.1:7777`);
    if (report.gateway.uptimeSeconds !== null) {
      console.log(`  Uptime:        ${formatDuration(report.gateway.uptimeSeconds)}`);
    }
  } else {
    console.log("  Status:        not reachable on 127.0.0.1:7777");
  }
  console.log(`  Transport:     JIN_CLAUDE_EVENT_TRANSPORT=${report.gateway.transport}`);
  console.log("");

  console.log(`Event log (since ${report.since})`);
  if (report.events.byKind.length === 0) {
    console.log("  (no events)");
  } else {
    for (const row of report.events.byKind) {
      console.log(`  ${row.kind.padEnd(24)} ${fmt(row.n).padStart(8)}`);
    }
    console.log(`  ${"Total".padEnd(24)} ${fmt(report.events.total).padStart(8)}`);
  }
  console.log("");

  console.log("DLQ");
  const dlqMark = report.dlq.depth === 0 ? "✓" : "✗";
  console.log(`  Depth (unretried):  ${fmt(report.dlq.depth)}  ${dlqMark}`);
  if (report.dlq.topErrors.length > 0) {
    console.log("  Top errors:");
    for (const e of report.dlq.topErrors) {
      console.log(`    ${e.n.toString().padStart(4)} × ${e.error}`);
    }
  }
  console.log("");

  console.log("Handlers");
  for (const h of report.handlers) {
    const mark = h.status === "active" ? " " : "✗";
    const note = h.defaultEnabled ? "" : "  (gated off by default)";
    console.log(`  ${mark} ${h.processor.padEnd(22)} ${h.status.padEnd(10)}${note}`);
  }
  console.log("");

  console.log("cost_log autofill (Claude streaming sessions)");
  console.log(`  T1A handler rows:    ${fmt(report.costLog.withTokens)}`);
  console.log(`  Legacy rows:         ${fmt(report.costLog.legacy)}`);
  const ratioPct = `${(report.costLog.autofillRatio * 100).toFixed(0)}%`;
  console.log(
    `  Autofill ratio:      ${ratioPct} (${report.costLog.withTokens}/${report.costLog.claudeCompletions} Claude completions)`,
  );
  console.log("");

  console.log("Done-criteria (PLAN-T1A § 'Done criteria for T1A as a whole')");
  console.log(`  DLQ clean:                       ${report.doneCriteria.dlqClean ? 'YES' : 'NO'}`);
  console.log(`  cost_log autofill rate:          ${report.doneCriteria.costAutofillPct}%`);
  console.log(`  jinn replay invocations:         ${report.doneCriteria.replayInvocations}  (target: ≥1)`);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return `${h}h ${mm}m`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return `${d}d ${hh}h`;
}
