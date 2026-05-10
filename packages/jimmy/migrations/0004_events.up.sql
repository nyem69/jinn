-- 0004_events: T1A.PR2 — append-only event log + handler registry + DLQ.
-- Mirrors src/events/db.ts initEventsSchema() exactly.

CREATE TABLE IF NOT EXISTS session_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_session_events_root_id ON session_events(root_session_id, id);
CREATE INDEX IF NOT EXISTS idx_session_events_kind    ON session_events(kind, created_at);

CREATE TABLE IF NOT EXISTS event_handlers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind_filter    TEXT NOT NULL,
  session_filter TEXT,
  processor      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_dlq (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES session_events(id),
  handler_id  INTEGER NOT NULL REFERENCES event_handlers(id),
  error       TEXT NOT NULL,
  retried_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_dlq_unretried ON event_dlq(id) WHERE retried_at IS NULL;
