-- 0003_lineage: T1A.PR1 — parent/root lineage + indexes + recursive CTE backfill.
-- Down migration drops these columns; row-level lineage data is lost on rollback.
--
-- WARNING: This migration is NOT safe to apply against a database that was
-- previously populated by the in-code DDL path (legacy initDb pre-migration-runner).
-- Such a database already has these 12 columns — running this file raw would fail
-- with "duplicate column name". The runner's bootstrap detector
-- (isLegacyInCodeBootstrap in migrate-runner.ts) catches this case and marks the
-- baseline migrations as applied without re-running them. Fresh databases hit
-- this file normally.

ALTER TABLE sessions ADD COLUMN title TEXT;
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
ALTER TABLE sessions ADD COLUMN root_session_id TEXT;
ALTER TABLE sessions ADD COLUMN connector TEXT;
ALTER TABLE sessions ADD COLUMN session_key TEXT;
ALTER TABLE sessions ADD COLUMN reply_context TEXT;
ALTER TABLE sessions ADD COLUMN message_id TEXT;
ALTER TABLE sessions ADD COLUMN transport_meta TEXT;
ALTER TABLE sessions ADD COLUMN total_cost REAL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN total_turns INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN effort_level TEXT;
ALTER TABLE sessions ADD COLUMN compacted_at TEXT;

UPDATE sessions SET session_key = COALESCE(session_key, source_ref) WHERE session_key IS NULL OR session_key = '';
UPDATE sessions SET connector   = COALESCE(connector,   source)     WHERE connector   IS NULL OR connector   = '';

WITH RECURSIVE roots(id, root_id) AS (
  SELECT id, id FROM sessions WHERE parent_session_id IS NULL
  UNION ALL
  SELECT s.id, r.root_id FROM sessions s JOIN roots r ON s.parent_session_id = r.id
)
UPDATE sessions
  SET root_session_id = (SELECT root_id FROM roots WHERE roots.id = sessions.id)
  WHERE root_session_id IS NULL
    AND id IN (SELECT id FROM roots);

UPDATE sessions SET root_session_id = id WHERE root_session_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_session_key ON sessions (session_key, last_activity);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_root ON sessions(root_session_id);
