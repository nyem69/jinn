-- Down: drop T1A.PR1 lineage columns + indexes.
-- DESTRUCTIVE: row-level lineage and connector/session_key data is lost.
DROP INDEX IF EXISTS idx_sessions_root;
DROP INDEX IF EXISTS idx_sessions_parent;
DROP INDEX IF EXISTS idx_sessions_session_key;

ALTER TABLE sessions DROP COLUMN compacted_at;
ALTER TABLE sessions DROP COLUMN effort_level;
ALTER TABLE sessions DROP COLUMN total_turns;
ALTER TABLE sessions DROP COLUMN total_cost;
ALTER TABLE sessions DROP COLUMN transport_meta;
ALTER TABLE sessions DROP COLUMN message_id;
ALTER TABLE sessions DROP COLUMN reply_context;
ALTER TABLE sessions DROP COLUMN session_key;
ALTER TABLE sessions DROP COLUMN connector;
ALTER TABLE sessions DROP COLUMN root_session_id;
ALTER TABLE sessions DROP COLUMN parent_session_id;
ALTER TABLE sessions DROP COLUMN title;
