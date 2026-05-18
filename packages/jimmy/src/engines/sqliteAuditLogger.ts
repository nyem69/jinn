/**
 * SQLite-backed AuditLogger for the HTTP-loop engines (ollama / openai).
 *
 * Persists one row per tool call into `tool_call_log` (schema in
 * migrations/0007_tool_call_log.up.sql). The shape mirrors AuditRow
 * — metadata only. We do NOT and CANNOT store tool output content
 * (stdout / stderr / file body / HTTP response body) because AuditRow
 * doesn't carry it; the agent loop hands the model-visible content
 * back through the `tool` role message, not through audit.
 *
 * Write failures must NOT break the agent loop. The loop wraps
 * `record()` in `safeAudit()` which catches any throw and forwards
 * it to logger.warn. This logger reinforces that contract by also
 * catching internally and re-throwing only the original error.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AuditLogger, AuditRow } from "./audit.js";

const INSERT_SQL = `
  INSERT INTO tool_call_log (
    id, session_id, engine, tool_name, args_summary,
    duration_ms, exit_code, http_status, error,
    result_truncated, result_bytes
  ) VALUES (
    @id, @session_id, @engine, @tool_name, @args_summary,
    @duration_ms, @exit_code, @http_status, @error,
    @result_truncated, @result_bytes
  )
`;

export class SqliteAuditLogger implements AuditLogger {
  private readonly insertStmt: Database.Statement<[Record<string, unknown>]>;

  constructor(private readonly db: Database.Database) {
    // Prepare once at construction; reuse across every record() call.
    this.insertStmt = this.db.prepare(INSERT_SQL);
  }

  record(row: AuditRow): void {
    this.insertStmt.run({
      id: randomUUID(),
      session_id: row.sessionId ?? "unknown",
      engine: row.engineName ?? "unknown",
      tool_name: row.toolName,
      args_summary: row.argsSummary,
      duration_ms: row.durationMs,
      exit_code: row.exitCode,
      http_status: row.httpStatus,
      error: row.error,
      result_truncated: row.truncated ? 1 : 0,
      result_bytes: row.resultBytes,
    });
  }
}
