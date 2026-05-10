import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { SESSIONS_DB } from '../shared/paths.js';
import type { JsonObject, ReplyContext, Session } from '../shared/types.js';
import { applyPendingMigrations } from './migrate-runner.js';

let db: Database.Database;

function parseJsonObject(value: unknown): JsonObject | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as JsonObject;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rowToSession(row: Record<string, unknown>): Session {
  const replyContext = parseJsonObject(row.reply_context);
  const transportMeta = parseJsonObject(row.transport_meta);
  const sessionKey = ((row.session_key as string) || (row.source_ref as string));
  const connector = (row.connector as string) ?? (row.source as string) ?? null;
  return {
    id: row.id as string,
    engine: row.engine as string,
    engineSessionId: (row.engine_session_id as string) ?? null,
    source: row.source as string,
    sourceRef: row.source_ref as string,
    connector,
    sessionKey,
    replyContext: replyContext as ReplyContext | null,
    messageId: (row.message_id as string) ?? null,
    transportMeta,
    employee: (row.employee as string) ?? null,
    model: (row.model as string) ?? null,
    title: (row.title as string) ?? null,
    parentSessionId: (row.parent_session_id as string) ?? null,
    rootSessionId: (row.root_session_id as string) ?? (row.id as string),
    effortLevel: (row.effort_level as string) ?? null,
    status: row.status as Session['status'],
    totalCost: (row.total_cost as number) ?? 0,
    totalTurns: (row.total_turns as number) ?? 0,
    createdAt: row.created_at as string,
    lastActivity: row.last_activity as string,
    lastError: (row.last_error as string) ?? null,
  };
}

export function initDb(): Database.Database {
  if (db) return db;
  mkdirSync(path.dirname(SESSIONS_DB), { recursive: true });
  db = new Database(SESSIONS_DB);
  db.pragma('journal_mode = WAL');
  applyPendingMigrations(db);
  return db;
}

/**
 * @deprecated Compat shim. Schema is owned by `applyPendingMigrations`.
 * Existing tests call this directly; new code should call applyPendingMigrations.
 */
export function migrateSessionsSchema(database: Database.Database): void {
  applyPendingMigrations(database);
}

export interface CreateSessionOpts {
  engine: string;
  source: string;
  sourceRef: string;
  connector?: string | null;
  sessionKey?: string;
  replyContext?: ReplyContext | null;
  messageId?: string;
  transportMeta?: JsonObject | null;
  employee?: string;
  model?: string;
  title?: string;
  parentSessionId?: string;
  effortLevel?: string;
  // T1A.PR5 follow-up: when set together with parentSessionId, write a
  // checkpoint on the parent session immediately after the child row is
  // inserted. Best-effort — a checkpoint write failure does NOT block
  // the spawn; a debug log is emitted instead. Caller-supplied stepSeq
  // wins; absent that, we use a per-branch monotonic counter so the
  // unique (session, branch, step_seq) index never collides on rapid
  // back-to-back spawns. (To align step_seq with session_events.seq for
  // PR5's replay slice query, the caller should pass stepSeq = max seq
  // on the parent session at write time.)
  checkpoint?: {
    state: Record<string, unknown>;
    stepSeq?: number;
    branch?: string;
  };
}

// Writes a spawn-time checkpoint on a parent session. Step_seq defaults
// to (existing checkpoint count on this branch) + 1 — a per-branch
// monotonic counter that never collides on rapid back-to-back spawns.
// Caller-supplied stepSeq always wins so PR5 replay clients that want
// session_events.seq alignment can pass it through.
//
// Exported so unit tests can drive it against an in-memory DB without
// going through initDb()/the on-disk sessions registry.
export function writeSpawnCheckpoint(
  db: Database.Database,
  parentSessionId: string,
  newChildSessionId: string,
  spec: { state: Record<string, unknown>; stepSeq?: number; branch?: string },
): void {
  const branch = spec.branch ?? 'main';
  let stepSeq = spec.stepSeq;
  if (typeof stepSeq !== 'number') {
    const row = db
      .prepare(
        'SELECT COUNT(*) AS n FROM session_checkpoints WHERE session_id = ? AND branch = ?',
      )
      .get(parentSessionId, branch) as { n: number };
    stepSeq = row.n + 1;
  }

  // Augment the caller's state with the spawn linkage so replay can
  // identify which child this checkpoint corresponds to without parsing
  // session_events. The caller's keys win on conflict.
  const augmentedState = {
    spawned_child_session_id: newChildSessionId,
    spawned_at: new Date().toISOString(),
    ...spec.state,
  };

  const stateJson = JSON.stringify(augmentedState);
  // 2 MB cap matches checkpoint.ts; duplicated here so the spawn path
  // stays self-contained and doesn't reach into the checkpoint module.
  if (Buffer.byteLength(stateJson, 'utf-8') > 2 * 1024 * 1024) {
    throw new Error('spawn checkpoint state exceeds 2 MB');
  }

  db.prepare(
    `INSERT OR IGNORE INTO session_checkpoints (session_id, step_seq, branch, state)
     VALUES (?, ?, ?, ?)`,
  ).run(parentSessionId, stepSeq, branch, stateJson);
}

function getNextSessionNumber(): number {
  const db = initDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
  return row.count + 1;
}

function generateTitle(prompt?: string): string {
  const num = getNextSessionNumber();
  if (!prompt) return `#${num}`;
  const cleaned = prompt.replace(/\n/g, ' ').replace(/@\w+/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return `#${num}`;
  const summary = cleaned.slice(0, 30).trim();
  return `#${num} - ${summary}${cleaned.length > 30 ? '...' : ''}`;
}

export function createSession(opts: CreateSessionOpts & { prompt?: string; portalName?: string }): Session {
  const db = initDb();
  const now = new Date().toISOString();
  const id = uuidv4();
  const title = opts.title ?? generateTitle(opts.prompt);
  const sessionKey = opts.sessionKey ?? opts.sourceRef;
  const connector = opts.connector ?? opts.source;
  const replyContext = opts.replyContext ? JSON.stringify(opts.replyContext) : null;
  const transportMeta = opts.transportMeta ? JSON.stringify(opts.transportMeta) : null;

  // Lineage (T1A.PR1): top-level sessions are their own root. Children
  // inherit root_session_id from the parent so subtree queries can scope
  // by root_session_id without walking parents at read time. If a parent
  // is supplied but missing from the DB (e.g. deleted), fall back to
  // self-as-root rather than crashing the spawn path.
  let rootSessionId = id;
  if (opts.parentSessionId) {
    const parentRow = db
      .prepare('SELECT root_session_id FROM sessions WHERE id = ?')
      .get(opts.parentSessionId) as { root_session_id?: string } | undefined;
    if (parentRow?.root_session_id) rootSessionId = parentRow.root_session_id;
  }

  const stmt = db.prepare(`
    INSERT INTO sessions (
      id, engine, source, source_ref, connector, session_key, reply_context, message_id, transport_meta,
      employee, model, title, parent_session_id, root_session_id, effort_level, status, created_at, last_activity
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)
  `);
  stmt.run(
    id,
    opts.engine,
    opts.source,
    opts.sourceRef,
    connector,
    sessionKey,
    replyContext,
    opts.messageId ?? null,
    transportMeta,
    opts.employee ?? null,
    opts.model ?? null,
    title,
    opts.parentSessionId ?? null,
    rootSessionId,
    opts.effortLevel ?? null,
    now,
    now,
  );

  // T1A.PR5 follow-up: spawn-time checkpoint hook. When the caller
  // supplies state and the new session has a parent, write a checkpoint
  // on the parent so replay can later resume from this delegation
  // boundary. step_seq defaults to a per-branch monotonic counter to
  // avoid colliding with rapid back-to-back spawns; callers that want
  // alignment with session_events.seq for replay's tool-slice query
  // should pass stepSeq explicitly. Best-effort: a write failure logs
  // at debug and the spawn proceeds.
  if (opts.checkpoint && opts.parentSessionId) {
    try {
      writeSpawnCheckpoint(db, opts.parentSessionId, id, opts.checkpoint);
    } catch (err) {
      // Lazy import for logger to avoid the cycle that would arise if
      // logger ever pulled registry transitively.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      import('../shared/logger.js').then(({ logger }) => {
        logger.debug(`[spawn-checkpoint] write failed: ${(err as Error).message}`);
      }).catch(() => undefined);
    }
  }

  return {
    id,
    engine: opts.engine,
    engineSessionId: null,
    source: opts.source,
    sourceRef: opts.sourceRef,
    connector,
    sessionKey,
    replyContext: opts.replyContext ?? null,
    messageId: opts.messageId ?? null,
    transportMeta: opts.transportMeta ?? null,
    employee: opts.employee ?? null,
    model: opts.model ?? null,
    title,
    parentSessionId: opts.parentSessionId ?? null,
    rootSessionId,
    effortLevel: opts.effortLevel ?? null,
    status: 'idle',
    totalCost: 0,
    totalTurns: 0,
    createdAt: now,
    lastActivity: now,
    lastError: null,
  };
}

export function getSession(id: string): Session | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export function getSessionBySourceRef(sourceRef: string): Session | undefined {
  return getSessionBySessionKey(sourceRef);
}

export function getSessionBySessionKey(sessionKey: string): Session | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM sessions WHERE session_key = ? ORDER BY last_activity DESC LIMIT 1').get(sessionKey) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export interface UpdateSessionFields {
  engine?: string;
  engineSessionId?: string | null;
  status?: Session['status'];
  model?: string | null;
  replyContext?: ReplyContext | null;
  messageId?: string | null;
  transportMeta?: JsonObject | null;
  lastActivity?: string;
  lastError?: string | null;
  title?: string;
  compactedAt?: string;
}

export function updateSession(id: string, updates: UpdateSessionFields): Session | undefined {
  const db = initDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.engine !== undefined) {
    sets.push('engine = ?');
    values.push(updates.engine);
  }
  if (updates.engineSessionId !== undefined) {
    sets.push('engine_session_id = ?');
    values.push(updates.engineSessionId);
  }
  if (updates.status !== undefined) {
    sets.push('status = ?');
    values.push(updates.status);
  }
  if (updates.model !== undefined) {
    sets.push('model = ?');
    values.push(updates.model);
  }
  if (updates.replyContext !== undefined) {
    sets.push('reply_context = ?');
    values.push(updates.replyContext ? JSON.stringify(updates.replyContext) : null);
  }
  if (updates.messageId !== undefined) {
    sets.push('message_id = ?');
    values.push(updates.messageId);
  }
  if (updates.transportMeta !== undefined) {
    sets.push('transport_meta = ?');
    values.push(updates.transportMeta ? JSON.stringify(updates.transportMeta) : null);
  }
  if (updates.lastActivity !== undefined) {
    sets.push('last_activity = ?');
    values.push(updates.lastActivity);
  }
  if (updates.lastError !== undefined) {
    sets.push('last_error = ?');
    values.push(updates.lastError);
  }
  if (updates.title !== undefined) {
    sets.push('title = ?');
    values.push(updates.title);
  }
  if (updates.compactedAt !== undefined) {
    sets.push('compacted_at = ?');
    values.push(updates.compactedAt);
  }

  if (sets.length === 0) return getSession(id);

  values.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getSession(id);
}

export interface ListSessionsFilter {
  status?: Session['status'];
  source?: string;
  engine?: string;
}

export function listSessions(filter?: ListSessionsFilter): Session[] {
  const db = initDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter?.status) {
    conditions.push('status = ?');
    values.push(filter.status);
  }
  if (filter?.source) {
    conditions.push('source = ?');
    values.push(filter.source);
  }
  if (filter?.engine) {
    conditions.push('engine = ?');
    values.push(filter.engine);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM sessions ${where} ORDER BY last_activity DESC`).all(...values) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/**
 * Mark any sessions stuck in "running" status as "interrupted".
 * Called on gateway startup — if the gateway is starting, no sessions can actually be running.
 * Sessions with an engine_session_id can be resumed via the Claude --resume flag.
 */
export function recoverStaleSessions(): number {
  const db = initDb();
  const now = new Date().toISOString();
  const result = db.prepare(
    "UPDATE sessions SET status = 'interrupted', last_activity = ?, last_error = 'Interrupted: gateway restarted while session was running' WHERE status = 'running'",
  ).run(now);
  return result.changes;
}

/**
 * Get sessions that were interrupted by a gateway restart and can be resumed.
 * A session is resumable if it has an engine_session_id (Claude's internal session ID).
 */
export function getInterruptedSessions(): Session[] {
  const db = initDb();
  const rows = db.prepare(
    "SELECT * FROM sessions WHERE status = 'interrupted' AND engine_session_id IS NOT NULL ORDER BY last_activity DESC",
  ).all() as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/**
 * Accumulate cost and turns for a session (called after each engine run).
 */
export function accumulateSessionCost(id: string, cost: number, turns: number): void {
  const db = initDb();
  db.prepare(
    'UPDATE sessions SET total_cost = total_cost + ?, total_turns = total_turns + ? WHERE id = ?',
  ).run(cost, turns, id);
}

/**
 * Insert a row into cost_log for the given session.
 *
 * As of T1A.PR2.D, the canonical writer for cost_log is the
 * `cost_log` event handler, which fires off `session_completed` and
 * carries token counts from the engine's reported usage. This legacy
 * function still runs on the post-session path in manager.ts, but
 * dedupes against the handler row: if a cost_log row already exists
 * for this session_id, we skip. That covers two cases cleanly:
 *
 *   - T1A path (parser transport != 'off'): handler writes first with
 *     tokens; this function sees the existing row and skips. The
 *     observability surface stays single-row-per-session with full
 *     token attribution.
 *
 *   - Legacy path (parser off, or non-streaming engine, or handler
 *     failed): no row exists yet; this function inserts as before
 *     with NULL tokens. cost_usd is still authoritative because
 *     Anthropic's reported total_cost_usd is the source of truth.
 *
 * Looks up source/source_ref to populate trigger_type + trigger_ref
 * accurately when we do insert.
 */
export function logSessionCost(opts: {
  sessionId: string;
  engine: string;
  model: string | null;
  employee: string | null;
  costUsd: number;
}): void {
  const db = initDb();

  // Dedup against the T1A handler. Robust to handler failures (no row
  // → fall through to legacy insert). Ordering: emit→dispatch happens
  // synchronously inside the engine adapter via queueMicrotask, so the
  // handler row lands before manager.ts gets the engine result back
  // and calls us.
  const existing = db
    .prepare('SELECT 1 FROM cost_log WHERE session_id = ? LIMIT 1')
    .get(opts.sessionId);
  if (existing) return;

  // Look up source/source_ref so we know whether this was cron, user,
  // delegation, eval, etc.
  const sessRow = db
    .prepare('SELECT source, source_ref, parent_session_id FROM sessions WHERE id = ?')
    .get(opts.sessionId) as { source?: string; source_ref?: string; parent_session_id?: string } | undefined;

  const triggerType = sessRow?.source || 'user';
  const triggerRef = sessRow?.source_ref || sessRow?.parent_session_id || null;

  // Schema has NOT NULL on engine + model — fall back to "(default)" rather
  // than crashing the post-session path when the engine config didn't carry
  // an explicit model name.
  const modelStr = opts.model ?? "(default)";

  db.prepare(
    `INSERT INTO cost_log (id, session_id, employee, engine, model, trigger_type, trigger_ref, input_tokens, output_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(
    randomUUID(),
    opts.sessionId,
    opts.employee,
    opts.engine,
    modelStr,
    triggerType,
    triggerRef,
    opts.costUsd,
  );
}

/**
 * Seed an episode_candidates row for sessions that look substantive enough
 * to potentially become curated `episodes`. Heuristic: numTurns >= 5 AND
 * costUsd >= 0.50 OR session is a parent of 2+ child sessions.
 *
 * Called from the same gateway cost sites as logSessionCost. A weekly
 * grading cron reads pending candidates and either promotes them to
 * `episodes` (with LLM-curated task_summary / quality / lesson_learned)
 * or marks them rejected.
 *
 * Heuristic rationale: solo cheap sessions (a quick haiku Q&A) aren't
 * worth grading — the corpus we want is multi-agent investigations,
 * weekly recaps, sitreps, briefs. Cost + numTurns are cheap proxies for
 * that without requiring the skill to opt-in.
 */
export function recordEpisodeCandidate(opts: {
  sessionId: string;
  employee: string | null;
  costUsd: number;
  numTurns: number;
  promptExcerpt?: string | null;
  resultExcerpt?: string | null;
}): void {
  const db = initDb();

  // Lookup session for trigger + parent context, plus child count for the
  // multi-agent override.
  const sessRow = db
    .prepare('SELECT source, source_ref, parent_session_id FROM sessions WHERE id = ?')
    .get(opts.sessionId) as {
      source?: string;
      source_ref?: string;
      parent_session_id?: string;
    } | undefined;

  const childCountRow = db
    .prepare('SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id = ?')
    .get(opts.sessionId) as { n?: number } | undefined;
  const numChildren = childCountRow?.n ?? 0;

  // Heuristic gate.
  const looksSubstantive =
    (opts.costUsd >= 0.50 && opts.numTurns >= 5) || numChildren >= 2;
  if (!looksSubstantive) return;

  // Deduplicate — don't insert twice for the same session.
  const existing = db
    .prepare('SELECT id FROM episode_candidates WHERE session_id = ?')
    .get(opts.sessionId);
  if (existing) return;

  db.prepare(
    `INSERT INTO episode_candidates (
       id, session_id, parent_session_id, employee, trigger_type, trigger_ref,
       cost_usd, num_turns, num_children, prompt_excerpt, result_excerpt
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    opts.sessionId,
    sessRow?.parent_session_id ?? null,
    opts.employee,
    sessRow?.source ?? null,
    sessRow?.source_ref ?? null,
    opts.costUsd,
    opts.numTurns,
    numChildren,
    (opts.promptExcerpt ?? '').slice(0, 500),
    (opts.resultExcerpt ?? '').slice(0, 500),
  );
}

/**
 * Duplicate a session and all its messages, returning a new session with a fresh ID.
 * Does NOT fork the engine session — the caller handles that separately.
 */
export function duplicateSession(sourceId: string, newTitle?: string): { session: Session; messageCount: number } {
  const db = initDb();
  const source = getSession(sourceId);
  if (!source) throw new Error(`Session ${sourceId} not found`);
  if (!source.engineSessionId) throw new Error(`Session ${sourceId} has no engine session ID — cannot duplicate`);

  const now = new Date().toISOString();
  const newId = uuidv4();
  const title = newTitle ?? `Copy of ${source.title || sourceId.slice(0, 8)}`;
  const newSessionKey = `web:${Date.now()}`;

  // Copy session + messages in a single transaction for consistency
  const messages = db.prepare(
    'SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC',
  ).all(sourceId) as Array<{ role: string; content: string; timestamp: number }>;

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO sessions (
        id, engine, engine_session_id, source, source_ref, connector, session_key,
        reply_context, message_id, transport_meta,
        employee, model, title, parent_session_id, root_session_id, effort_level, status,
        total_cost, total_turns, created_at, last_activity
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'idle', 0, 0, ?, ?)
    `).run(
      newId,
      source.engine,
      source.source,
      source.sourceRef,
      source.connector,
      newSessionKey,
      source.replyContext ? JSON.stringify(source.replyContext) : null,
      source.messageId,
      source.transportMeta ? JSON.stringify(source.transportMeta) : null,
      source.employee,
      source.model,
      title,
      newId,
      source.effortLevel,
      now,
      now,
    );

    const insertMsg = db.prepare(
      'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)',
    );
    for (const msg of messages) {
      insertMsg.run(uuidv4(), newId, msg.role, msg.content, msg.timestamp);
    }
  });
  txn();

  const newSession = getSession(newId)!;
  return { session: newSession, messageCount: messages.length };
}

export function deleteSession(id: string): boolean {
  const db = initDb();
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteSessions(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = initDb();
  const placeholders = ids.map(() => '?').join(',');
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...ids);
    const result = db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
    return result.changes;
  });
  return txn();
}

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
}

export function insertMessage(sessionId: string, role: string, content: string): void {
  const db = initDb();
  const id = uuidv4();
  db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)').run(id, sessionId, role, content, Date.now());
}

/**
 * Atomically replace a set of messages with a single new message.
 * Used by session compaction to swap old messages for a summary.
 */
export function replaceMessages(
  sessionId: string,
  deleteIds: string[],
  newMessage: { role: string; content: string; timestamp: number },
): void {
  if (deleteIds.length === 0) return;
  const db = initDb();
  const placeholders = deleteIds.map(() => '?').join(',');
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM messages WHERE session_id = ? AND id IN (${placeholders})`).run(sessionId, ...deleteIds);
    db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)').run(
      uuidv4(), sessionId, newMessage.role, newMessage.content, newMessage.timestamp,
    );
  });
  txn();
}

export function getMessages(sessionId: string): SessionMessage[] {
  const db = initDb();
  return db.prepare('SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as SessionMessage[];
}

export interface QueueItem {
  id: string;
  sessionId: string;
  sessionKey: string;
  prompt: string;
  status: "pending" | "running" | "cancelled" | "completed";
  position: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export function enqueueQueueItem(sessionId: string, sessionKey: string, prompt: string): string {
  const db = initDb();
  const id = randomUUID();
  const position = (db.prepare(
    "SELECT COALESCE(MAX(position), 0) + 1 as pos FROM queue_items WHERE session_key = ? AND status = 'pending'"
  ).get(sessionKey) as { pos: number }).pos;
  db.prepare(
    "INSERT INTO queue_items (id, session_id, session_key, prompt, status, position, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)"
  ).run(id, sessionId, sessionKey, prompt, position, new Date().toISOString());
  return id;
}

export function markQueueItemRunning(itemId: string): void {
  const db = initDb();
  db.prepare("UPDATE queue_items SET status = 'running', started_at = ? WHERE id = ?")
    .run(new Date().toISOString(), itemId);
}

export function markQueueItemCompleted(itemId: string): void {
  const db = initDb();
  db.prepare("UPDATE queue_items SET status = 'completed', completed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), itemId);
}

export function cancelQueueItem(itemId: string): boolean {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
  ).run(itemId);
  return result.changes > 0;
}

export function getQueueItems(sessionKey: string): QueueItem[] {
  const db = initDb();
  return db.prepare(
    "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items WHERE session_key = ? AND status IN ('pending', 'running') ORDER BY position ASC"
  ).all(sessionKey) as QueueItem[];
}

export function cancelAllPendingQueueItems(sessionKey: string): number {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE session_key = ? AND status = 'pending'"
  ).run(sessionKey);
  return result.changes;
}

export function recoverStaleQueueItems(): number {
  const db = initDb();
  // If the gateway restarts mid-run, move any "running" items back to "pending"
  // so they can be replayed. Do NOT cancel pending work.
  const result = db.prepare(
    "UPDATE queue_items SET status = 'pending', started_at = NULL WHERE status = 'running'"
  ).run();
  return result.changes;
}

export function listAllPendingQueueItems(): QueueItem[] {
  const db = initDb();
  return db.prepare(
    "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items WHERE status = 'pending' ORDER BY created_at ASC, position ASC"
  ).all() as QueueItem[];
}

// ── File management ──────────────────────────────────────────────────

export interface FileMeta {
  id: string;
  filename: string;
  size: number;
  mimetype: string | null;
  path: string | null;
  createdAt: string;
}

function rowToFileMeta(row: Record<string, unknown>): FileMeta {
  return {
    id: row.id as string,
    filename: row.filename as string,
    size: row.size as number,
    mimetype: (row.mimetype as string) ?? null,
    path: (row.path as string) ?? null,
    createdAt: row.created_at as string,
  };
}

export function insertFile(meta: { id: string; filename: string; size: number; mimetype: string | null; path: string | null }): FileMeta {
  const db = initDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO files (id, filename, size, mimetype, path, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    meta.id, meta.filename, meta.size, meta.mimetype, meta.path, now,
  );
  return { ...meta, createdAt: now };
}

export function getFile(id: string): FileMeta | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToFileMeta(row) : undefined;
}

export function listFiles(): FileMeta[] {
  const db = initDb();
  const rows = db.prepare('SELECT * FROM files ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToFileMeta);
}

export function deleteFile(id: string): boolean {
  const db = initDb();
  const result = db.prepare('DELETE FROM files WHERE id = ?').run(id);
  return result.changes > 0;
}
