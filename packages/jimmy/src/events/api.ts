import type Database from 'better-sqlite3';
import { initDb } from '../sessions/registry.js';
import { rowToSessionEvent, type SessionEventRow } from './db.js';

// T1A.PR2.B: read paths.
//
// Two cursor models — and they are NOT interchangeable:
//
// - Single-session reads page on per-session `seq`. Stable for that
//   session even when sibling sessions emit; the cursor a subscriber
//   resumes with after a network blip.
//
// - Subtree reads page on the GLOBAL auto-increment `id`. Per-session
//   seq would silently drop events from sibling descendants because
//   each child has its own seq=1, seq=2, ... -- the subtree consumer
//   needs a single timeline across all descendants, which is what `id`
//   provides.
//
// Mixing these is a silent-data-loss bug, not a stylistic choice.

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export interface ReadSingleOpts {
  sinceSeq?: number;
  limit?: number;
}

export interface ReadSingleResult {
  events: SessionEventRow[];
  next_seq: number | null;
}

export function readEventsSingle(
  sessionId: string,
  opts: ReadSingleOpts = {},
): ReadSingleResult {
  return readEventsSingleOn(initDb(), sessionId, opts);
}

export function readEventsSingleOn(
  db: Database.Database,
  sessionId: string,
  opts: ReadSingleOpts = {},
): ReadSingleResult {
  const sinceSeq = clampNonNegative(opts.sinceSeq, 0);
  const limit = clampLimit(opts.limit);

  const rows = db
    .prepare(
      `SELECT * FROM session_events
        WHERE session_id = ?
          AND seq > ?
        ORDER BY seq ASC
        LIMIT ?`,
    )
    .all(sessionId, sinceSeq, limit) as Array<Record<string, unknown>>;
  const events = rows.map(rowToSessionEvent);

  // next_seq is the highest seq we returned, or null when there's
  // nothing more. Callers re-call with sinceSeq=next_seq to continue.
  const next_seq = events.length === limit ? events[events.length - 1].seq : null;
  return { events, next_seq };
}

export interface ReadSubtreeOpts {
  afterId?: number;
  limit?: number;
}

export interface ReadSubtreeResult {
  events: SessionEventRow[];
  next_id: number | null;
}

export function readEventsSubtree(
  sessionId: string,
  opts: ReadSubtreeOpts = {},
): ReadSubtreeResult {
  return readEventsSubtreeOn(initDb(), sessionId, opts);
}

export function readEventsSubtreeOn(
  db: Database.Database,
  sessionId: string,
  opts: ReadSubtreeOpts = {},
): ReadSubtreeResult {
  const afterId = clampNonNegative(opts.afterId, 0);
  const limit = clampLimit(opts.limit);

  // Path selection: when the caller is itself a root, scan by
  // root_session_id (single index seek). When mid-tree, walk
  // descendants via a recursive CTE on parent_session_id.
  const sess = db
    .prepare('SELECT id, root_session_id FROM sessions WHERE id = ?')
    .get(sessionId) as { id?: string; root_session_id?: string } | undefined;
  if (!sess) return { events: [], next_id: null };

  const isRoot = sess.id === sess.root_session_id;

  let rows: Array<Record<string, unknown>>;
  if (isRoot) {
    rows = db
      .prepare(
        `SELECT * FROM session_events
          WHERE root_session_id = ?
            AND id > ?
          ORDER BY id ASC
          LIMIT ?`,
      )
      .all(sessionId, afterId, limit) as Array<Record<string, unknown>>;
  } else {
    rows = db
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
            SELECT id FROM sessions WHERE id = ?
            UNION ALL
            SELECT s.id FROM sessions s JOIN descendants d ON s.parent_session_id = d.id
          )
          SELECT e.* FROM session_events e
            WHERE e.session_id IN (SELECT id FROM descendants)
              AND e.id > ?
            ORDER BY e.id ASC
            LIMIT ?`,
      )
      .all(sessionId, afterId, limit) as Array<Record<string, unknown>>;
  }

  const events = rows.map(rowToSessionEvent);
  const next_id = events.length === limit ? events[events.length - 1].id : null;
  return { events, next_id };
}

function clampNonNegative(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(value), MAX_LIMIT);
}
