-- Down: drop T1A.PR2 event surfaces
DROP INDEX IF EXISTS idx_event_dlq_unretried;
DROP TABLE IF EXISTS event_dlq;
DROP TABLE IF EXISTS event_handlers;
DROP INDEX IF EXISTS idx_session_events_kind;
DROP INDEX IF EXISTS idx_session_events_root_id;
DROP INDEX IF EXISTS idx_session_events_session;
DROP TABLE IF EXISTS session_events;
