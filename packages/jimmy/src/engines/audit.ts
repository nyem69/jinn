/**
 * Audit-log writer for tool calls inside the HTTP-loop engines.
 *
 * KEY INVARIANT: AuditRow NEVER carries full tool output (stdout, stderr,
 * file body, HTTP response body). Audit is for forensic / cost-attribution
 * use — the model already sees the body in its conversation. Logging it
 * twice doubles storage and creates a leak surface for secrets that the
 * model saw but we shouldn't persist on disk.
 *
 * Only metadata flows through: tool name, sanitized args, duration,
 * exit code / http status, truncation flags, byte counts, error code.
 *
 * The actual sink (sqlite write, log file, telemetry pipe) is injected
 * by the engine wrapper in Phase 7. Phase 6 only defines the abstract
 * AuditLogger interface so the loop is testable.
 */

import type { JsonObject, JsonValue } from "../shared/types.js";
import type { ToolResult } from "./tools/types.js";

/** Header names + JSON keys that look like secrets and get redacted in audit. */
const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /authorization/i,
  /^auth$/i,
  /token/i,
  /secret/i,
  /password/i,
  /^bearer$/i,
  /cookie/i,
];

const MAX_AUDIT_STRING_CHARS = 200;
const MAX_AUDIT_DEPTH = 5;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

function redact(value: JsonValue, depth: number): JsonValue {
  if (depth > MAX_AUDIT_DEPTH) return "[depth-capped]";
  if (typeof value === "string") {
    if (value.length <= MAX_AUDIT_STRING_CHARS) return value;
    return value.slice(0, MAX_AUDIT_STRING_CHARS) + `…[${value.length - MAX_AUDIT_STRING_CHARS} more]`;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = redact(v as JsonValue, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/** Serialize tool arguments for the audit row — keys redacted, strings capped. */
export function sanitizeArgsForAudit(args: JsonObject): string {
  return JSON.stringify(redact(args, 0));
}

export interface AuditRow {
  /** Tool name as the model invoked it. */
  toolName: string;
  /** JSON.stringify of sanitized args (secrets redacted, long strings capped). */
  argsSummary: string;
  /** Wall-clock duration of the tool call in milliseconds. */
  durationMs: number;
  /** Short error code, or null on success. */
  error: string | null;
  /** Whether any output stream was truncated. */
  truncated: boolean;
  /** Pre-truncation byte count where the tool reports it, else null. */
  resultBytes: number | null;
  /** Process exit code for bash, else null. */
  exitCode: number | null;
  /** HTTP status for webfetch, else null. */
  httpStatus: number | null;
}

export interface AuditLogger {
  record(row: AuditRow): void | Promise<void>;
}

/** Build an AuditRow from a tool call's args + result + measured duration. */
export function buildAuditRow(
  toolName: string,
  args: JsonObject,
  result: ToolResult,
  durationMs: number,
): AuditRow {
  const audit = result.audit;
  const resultBytes = pickNumber(audit, [
    "originalBytes",
    "original_bytes",
    "file_bytes",
    "original_stdout_bytes",
  ]);
  return {
    toolName,
    argsSummary: sanitizeArgsForAudit(args),
    durationMs,
    error: audit.error == null ? null : String(audit.error),
    truncated: !!audit.truncated,
    resultBytes,
    exitCode: pickNumber(audit, ["exit_code"]),
    httpStatus: pickNumber(audit, ["http_status"]),
  };
}

function pickNumber(audit: ToolResult["audit"], keys: string[]): number | null {
  for (const k of keys) {
    const v = audit[k];
    if (typeof v === "number") return v;
  }
  return null;
}
