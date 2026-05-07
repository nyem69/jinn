import type Database from 'better-sqlite3';

// T1A.PR2: append-only event log + handler registry + DLQ.
//
// session_events
//   The event log. id is the GLOBAL cursor -- subtree consumers page on
//   id so events from any descendant session interleave correctly. seq
//   is per-session monotonic, used by single-session consumers as a
//   stable cursor that doesn't fluctuate when sibling sessions emit.
//
// event_handlers
//   Per-(kind, session_filter) processor pointers. status='active' rows
//   fire on matching events; 'disabled' rows are skipped (e.g. after
//   the auto-disable threshold of 5 consecutive same-error DLQ entries).
//
// event_dlq
//   Failed handler invocations. retried_at IS NULL means "still pending
//   retry"; that's the indexed path the retry worker reads.

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS session_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    root_session_id TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    kind            TEXT NOT NULL,
    payload         TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_root_id ON session_events(root_session_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_kind    ON session_events(kind, created_at)`,
  `CREATE TABLE IF NOT EXISTS event_handlers (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind_filter    TEXT NOT NULL,
    session_filter TEXT,
    processor      TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS event_dlq (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL REFERENCES session_events(id),
    handler_id  INTEGER NOT NULL REFERENCES event_handlers(id),
    error       TEXT NOT NULL,
    retried_at  TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_event_dlq_unretried ON event_dlq(id) WHERE retried_at IS NULL`,
];

export function initEventsSchema(database: Database.Database): void {
  for (const stmt of DDL) {
    database.prepare(stmt).run();
  }
}

export interface SessionEventRow {
  id: number;
  sessionId: string;
  rootSessionId: string;
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}

export function rowToSessionEvent(row: Record<string, unknown>): SessionEventRow {
  return {
    id: row.id as number,
    sessionId: row.session_id as string,
    rootSessionId: row.root_session_id as string,
    seq: row.seq as number,
    kind: row.kind as string,
    payload: row.payload ? JSON.parse(row.payload as string) : null,
    createdAt: row.created_at as string,
  };
}
