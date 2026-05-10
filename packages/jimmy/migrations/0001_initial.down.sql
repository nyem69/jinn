-- Down: drop pre-T1A baseline
DROP INDEX IF EXISTS idx_messages_session;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS sessions;
