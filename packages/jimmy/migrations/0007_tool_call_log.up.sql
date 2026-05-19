-- 0007_tool_call_log: audit-log table for HTTP-loop engine tool calls
--
-- Receives one row per tool invocation by the ollama / openai engine
-- wrappers (see packages/jimmy/src/engines/agentLoop.ts). The shape
-- mirrors the AuditRow contract from V1 (engines/audit.ts):
-- metadata only — no stdout/stderr/file body/HTTP response body.
--
-- The args_summary column is pre-sanitized JSON (secret-keyed fields
-- redacted, URLs scrubbed for query-string and userinfo credentials,
-- long strings truncated to 200 chars).
--
-- Designed for cost/forensic analysis joined to cost_log and sessions
-- on session_id.

CREATE TABLE IF NOT EXISTS tool_call_log (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  engine            TEXT NOT NULL,
  tool_name         TEXT NOT NULL,
  args_summary      TEXT,
  duration_ms       INTEGER,
  exit_code         INTEGER,
  http_status       INTEGER,
  error             TEXT,
  result_truncated  INTEGER NOT NULL DEFAULT 0,
  result_bytes      INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_call_session
  ON tool_call_log (session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_tool_call_engine_tool
  ON tool_call_log (engine, tool_name, created_at);

CREATE INDEX IF NOT EXISTS idx_tool_call_error
  ON tool_call_log (error, created_at)
  WHERE error IS NOT NULL;
