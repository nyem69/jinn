-- Roll back 0007_tool_call_log.
DROP INDEX IF EXISTS idx_tool_call_error;
DROP INDEX IF EXISTS idx_tool_call_engine_tool;
DROP INDEX IF EXISTS idx_tool_call_session;
DROP TABLE IF EXISTS tool_call_log;
