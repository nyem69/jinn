import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { JINN_HOME } from '../shared/paths.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import type { SessionEventRow } from './db.js';
import { recordDlqFailure, activeDlqDepth } from './dlq.js';

// T1A.PR2.D: default event handlers.
//
// Seven handlers shipped with jin (per PLAN-T1A § "Default event
// handlers"). Each runs async, fire-and-forget, with a per-handler
// timeout. Failures land in event_dlq; 5 consecutive same-error DLQ
// entries auto-disable the handler (handled in dlq.ts).
//
// Per-handler flag gating in config.yaml under features.handlers.<name>:
//   - true / false override the spec's defaultEnabled
//   - missing falls through to defaultEnabled
//
// CLAUDE.md § "Auto-Housekeeping After Multi-Agent Tasks" is the
// canonical behavioural spec for these handlers. Don't delete that
// prose until all seven are flag-on in production for a week (per the
// plan's done-criteria).

export interface HandlerCtx {
  db: Database.Database;
  event: SessionEventRow;
  // sessions row of event.sessionId; empty object if the row vanished.
  session: Record<string, unknown>;
}

export interface HandlerSpec {
  name: string;
  // Event kinds that fire this handler. '*' matches all kinds.
  // 'dlq_threshold_exceeded' is a synthetic kind for dlq_alert.
  kinds: string[];
  timeoutMs: number;
  defaultEnabled: boolean;
  shouldFire?: (ctx: HandlerCtx) => boolean;
  run: (ctx: HandlerCtx) => Promise<void>;
}

// ── 1. performance_archive ──────────────────────────────────────────
const performanceArchive: HandlerSpec = {
  name: 'performance_archive',
  kinds: ['subagent_completed'],
  timeoutMs: 5000,
  defaultEnabled: true,
  run: async ({ db, event }) => {
    const payload = event.payload as {
      child_session_id: string;
      quality: string;
      outcome: string;
    };
    const child = db
      .prepare('SELECT employee, source FROM sessions WHERE id = ?')
      .get(payload.child_session_id) as
      | { employee?: string; source?: string }
      | undefined;
    if (!child?.employee) return;

    // performance_log uses CHECK(outcome IN ('succeeded','failed','blocked'))
    // — map the event-schema's broader vocabulary into that set.
    const mappedOutcome =
      payload.outcome === 'success' || payload.outcome === 'partial'
        ? 'succeeded'
        : payload.outcome === 'failed' || payload.outcome === 'blocked'
          ? payload.outcome
          : 'succeeded';

    db.prepare(
      `INSERT INTO performance_log (id, employee, department, task_type, task_ref, outcome, quality, score, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      randomUUID(),
      child.employee,
      'unknown',
      child.source || 'delegation',
      payload.child_session_id,
      mappedOutcome,
      payload.quality,
    );
  },
};

// ── 2. episode_capture ──────────────────────────────────────────────
const episodeCapture: HandlerSpec = {
  name: 'episode_capture',
  kinds: ['subagent_completed'],
  timeoutMs: 5000,
  defaultEnabled: true,
  shouldFire: ({ event }) => {
    const p = event.payload as { quality?: string };
    return p?.quality === 'excellent';
  },
  run: async ({ db, event }) => {
    const payload = event.payload as {
      child_session_id: string;
      quality: string;
    };
    const child = db
      .prepare('SELECT employee, title FROM sessions WHERE id = ?')
      .get(payload.child_session_id) as
      | { employee?: string; title?: string }
      | undefined;
    if (!child?.employee) return;

    const id = randomUUID();
    db.prepare(
      `INSERT INTO episodes (id, employee, task_type, task_summary, input_context, output_summary, quality, tags, lesson_learned)
       VALUES (?, ?, ?, ?, NULL, ?, ?, '[]', NULL)`,
    ).run(
      id,
      child.employee,
      'delegation',
      child.title || 'unknown',
      'auto-captured by episode_capture handler',
      payload.quality,
    );

    // Mirror to JSON for the file-based knowledge index. FS write is
    // best-effort: the DB row is the source of truth.
    try {
      const dir = path.join(JINN_HOME, 'knowledge', 'episodes');
      fs.mkdirSync(dir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const fname = `${child.employee}-${date}-${id.slice(0, 8)}.json`;
      fs.writeFileSync(
        path.join(dir, fname),
        JSON.stringify(
          {
            id,
            employee: child.employee,
            task_type: 'delegation',
            quality: payload.quality,
            child_session_id: payload.child_session_id,
            captured_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch (e) {
      logger.warn(
        `episode_capture: FS mirror failed for ${id}: ${(e as Error).message}`,
      );
    }
  },
};

// ── 3. cost_log ─────────────────────────────────────────────────────
const costLog: HandlerSpec = {
  name: 'cost_log',
  kinds: ['session_completed'],
  timeoutMs: 5000,
  defaultEnabled: true,
  run: async ({ db, event }) => {
    const payload = event.payload as {
      tokens_in: number;
      tokens_out: number;
      cost_usd: number | null;
    };
    const sess = db
      .prepare(
        'SELECT engine, model, employee, source, source_ref, parent_session_id FROM sessions WHERE id = ?',
      )
      .get(event.sessionId) as
      | {
          engine?: string;
          model?: string;
          employee?: string;
          source?: string;
          source_ref?: string;
          parent_session_id?: string;
        }
      | undefined;
    if (!sess) return;

    const triggerType = sess.source || 'user';
    const triggerRef = sess.source_ref || sess.parent_session_id || null;

    db.prepare(
      `INSERT INTO cost_log (id, session_id, employee, engine, model, trigger_type, trigger_ref, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      event.sessionId,
      sess.employee ?? null,
      sess.engine ?? '(default)',
      sess.model ?? '(default)',
      triggerType,
      triggerRef,
      payload.tokens_in,
      payload.tokens_out,
      payload.cost_usd,
    );
  },
};

// ── 4. report_archive ───────────────────────────────────────────────
// Stub-ish: triggers when the session's title/source matches a known
// report skill, archives a row with empty topics/headlines. Skills can
// post richer payloads via /api/sessions/:id/events — handler will
// pick those up once the skills are wired (out of PR2 scope).
const REPORT_TITLE_HINTS = [
  'sitrep',
  'weekly-digest',
  'weekly-recap',
  'brief',
  'monthly-review',
  'investigation',
  'pemantau',
];

const reportArchive: HandlerSpec = {
  name: 'report_archive',
  kinds: ['session_completed'],
  timeoutMs: 5000,
  defaultEnabled: true,
  shouldFire: ({ db, event }) => {
    const sess = db
      .prepare('SELECT title, source_ref FROM sessions WHERE id = ?')
      .get(event.sessionId) as { title?: string; source_ref?: string } | undefined;
    const haystack = `${sess?.title ?? ''} ${sess?.source_ref ?? ''}`.toLowerCase();
    return REPORT_TITLE_HINTS.some((t) => haystack.includes(t));
  },
  run: async ({ db, event }) => {
    const sess = db
      .prepare('SELECT title, source_ref FROM sessions WHERE id = ?')
      .get(event.sessionId) as { title?: string; source_ref?: string } | undefined;
    if (!sess) return;
    const reportType = REPORT_TITLE_HINTS.find((t) =>
      `${sess.title ?? ''} ${sess.source_ref ?? ''}`.toLowerCase().includes(t),
    ) || sess.title || 'unknown';
    db.prepare(
      `INSERT INTO report_archive (id, report_type, delivery_id, topics, headlines, coverage_date)
       VALUES (?, ?, NULL, '[]', '[]', ?)`,
    ).run(
      randomUUID(),
      reportType,
      new Date().toISOString().slice(0, 10),
    );
  },
};

// ── 5. kg_extraction ────────────────────────────────────────────────
// Stub. Queues a marker into ~/.jinn/knowledge/graph-pending.json so
// the existing graph/extract skills can pick up later. Defaults off
// per plan ("AuraDB load; gate during initial soak").
const kgExtraction: HandlerSpec = {
  name: 'kg_extraction',
  kinds: ['subagent_completed'],
  timeoutMs: 5000,
  defaultEnabled: false,
  run: async ({ event }) => {
    const queueFile = path.join(JINN_HOME, 'knowledge', 'graph-pending.json');
    let queue: unknown[] = [];
    try {
      if (fs.existsSync(queueFile)) {
        queue = JSON.parse(fs.readFileSync(queueFile, 'utf-8')) as unknown[];
      }
    } catch {
      queue = [];
    }
    const payload = event.payload as { child_session_id?: string };
    queue.push({
      session_id: event.sessionId,
      child_session_id: payload?.child_session_id,
      queued_at: new Date().toISOString(),
      source: 'event_handler:kg_extraction',
    });
    fs.mkdirSync(path.dirname(queueFile), { recursive: true });
    fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));
  },
};

// ── 6. watchpoint_extract ───────────────────────────────────────────
// Stub. Defaults off per plan ("noisy; gate while tuning").
const watchpointExtract: HandlerSpec = {
  name: 'watchpoint_extract',
  kinds: ['subagent_completed'],
  timeoutMs: 5000,
  defaultEnabled: false,
  run: async ({ event }) => {
    logger.info(
      `watchpoint_extract: scanning session ${event.sessionId} for dated triggers (stub)`,
    );
  },
};

// ── 7. dlq_alert ────────────────────────────────────────────────────
// Synthetic — fires only on 'dlq_threshold_exceeded' events emitted
// internally by the dispatcher when DLQ depth crosses the configured
// threshold. Real Telegram delivery is a follow-up; for now we log so
// the mechanism is observable in the gateway log without hardcoding a
// secret here.
const dlqAlert: HandlerSpec = {
  name: 'dlq_alert',
  kinds: ['dlq_threshold_exceeded'],
  timeoutMs: 5000,
  defaultEnabled: true,
  run: async ({ event }) => {
    const p = event.payload as { depth?: number; threshold?: number };
    logger.warn(
      `dlq_alert: event_dlq depth ${p?.depth ?? '?'} > threshold ${p?.threshold ?? '?'}; manual investigation required`,
    );
  },
};

export const DEFAULT_HANDLERS: HandlerSpec[] = [
  performanceArchive,
  episodeCapture,
  costLog,
  reportArchive,
  kgExtraction,
  watchpointExtract,
  dlqAlert,
];

export type HandlersFlagConfig = Record<string, boolean>;

export function loadHandlersFlagConfig(): HandlersFlagConfig {
  try {
    const cfg = loadConfig() as {
      features?: { handlers?: Record<string, boolean> };
    };
    return cfg.features?.handlers ?? {};
  } catch {
    return {};
  }
}

// Idempotent seed of (kind, processor) rows in event_handlers. Call
// from initDb() after initEventsSchema(). Adds a unique index lazily so
// the seed inserts don't duplicate on every boot.
export function initHandlerRegistry(db: Database.Database): void {
  db.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS uniq_event_handlers_kind_processor ON event_handlers (kind_filter, processor)',
  ).run();
  for (const spec of DEFAULT_HANDLERS) {
    for (const kind of spec.kinds) {
      db.prepare(
        'INSERT OR IGNORE INTO event_handlers (kind_filter, processor) VALUES (?, ?)',
      ).run(kind, spec.name);
    }
  }
}

export interface DispatchResult {
  fired: number;
  skipped: number;
  failed: number;
}

export interface DispatchOpts {
  flagConfig?: HandlersFlagConfig;
  registry?: HandlerSpec[];
  dlqThreshold?: number;
  // Internal: when true, suppress the dlq_alert recursion path. Set
  // when dispatching a synthetic 'dlq_threshold_exceeded' event so an
  // alert failure doesn't loop back into another threshold check.
  _suppressDlqAlert?: boolean;
}

const DEFAULT_DLQ_THRESHOLD = 10;

// Run a handler with a per-handler timeout. Resolves on success;
// rejects with a "timed out" error if the handler exceeds the budget.
function runWithTimeout<T>(
  p: Promise<T>,
  ms: number,
  name: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`handler ${name} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function dispatchEventHandlers(
  db: Database.Database,
  event: SessionEventRow,
  opts: DispatchOpts = {},
): Promise<DispatchResult> {
  const flagConfig = opts.flagConfig ?? loadHandlersFlagConfig();
  const registry = opts.registry ?? DEFAULT_HANDLERS;
  const result: DispatchResult = { fired: 0, skipped: 0, failed: 0 };

  // sessions row lookup once; passed to each handler via ctx so they
  // don't re-query for the same data.
  const session = db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(event.sessionId) as Record<string, unknown> | undefined;

  for (const spec of registry) {
    const matches =
      spec.kinds.includes('*') || spec.kinds.includes(event.kind);
    if (!matches) continue;

    // Flag-gating: explicit config beats spec default.
    const enabled = Object.prototype.hasOwnProperty.call(flagConfig, spec.name)
      ? flagConfig[spec.name]
      : spec.defaultEnabled;
    if (!enabled) {
      result.skipped++;
      continue;
    }

    // DB row gives us the persistent status (auto-disabled by DLQ rule)
    // and the handler_id we need for the DLQ row on failure.
    const handlerRow = db
      .prepare(
        'SELECT id, status FROM event_handlers WHERE kind_filter = ? AND processor = ?',
      )
      .get(event.kind, spec.name) as
      | { id?: number; status?: string }
      | undefined;
    if (!handlerRow || handlerRow.status !== 'active') {
      result.skipped++;
      continue;
    }

    const ctx: HandlerCtx = { db, event, session: session ?? {} };
    if (spec.shouldFire && !spec.shouldFire(ctx)) {
      result.skipped++;
      continue;
    }

    try {
      await runWithTimeout(spec.run(ctx), spec.timeoutMs, spec.name);
      result.fired++;
    } catch (e) {
      const errMsg = ((e as Error).message || String(e)).slice(0, 1000);
      result.failed++;

      // Synthetic events (id < 0) aren't persisted to session_events,
      // so a DLQ insert would violate the FK. Log and move on — the
      // alert/meta path is debug surface, not a workqueue.
      if (event.id < 0) {
        logger.error(
          `[handler ${spec.name}] failed on synthetic event (${event.kind}): ${errMsg}`,
        );
        continue;
      }

      const dlqResult = recordDlqFailure(
        db,
        handlerRow.id!,
        event.id,
        errMsg,
      );
      logger.error(
        `[handler ${spec.name}] failed for event ${event.id} (${event.kind}): ${errMsg}` +
          (dlqResult.autoDisabled
            ? ' — handler auto-disabled after 5 same-error DLQ entries'
            : ''),
      );

      // Trigger dlq_alert if depth threshold crossed. Avoid recursion
      // via _suppressDlqAlert.
      if (!opts._suppressDlqAlert && spec.name !== 'dlq_alert') {
        const threshold = opts.dlqThreshold ?? DEFAULT_DLQ_THRESHOLD;
        const depth = activeDlqDepth(db);
        if (depth > threshold) {
          const synthetic: SessionEventRow = {
            id: -1,
            sessionId: event.sessionId,
            rootSessionId: event.rootSessionId,
            seq: -1,
            kind: 'dlq_threshold_exceeded',
            payload: { depth, threshold },
            createdAt: new Date().toISOString(),
          };
          await dispatchEventHandlers(db, synthetic, {
            ...opts,
            _suppressDlqAlert: true,
          });
        }
      }
    }
  }

  return result;
}
