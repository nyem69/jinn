-- Down: drop T1A.PR5 checkpoints
DROP INDEX IF EXISTS idx_session_checkpoints_branch;
DROP INDEX IF EXISTS idx_session_checkpoints_session;
DROP TABLE IF EXISTS session_checkpoints;
