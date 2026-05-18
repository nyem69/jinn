/**
 * Shared types for tool implementations consumed by the agent loop.
 *
 * Every tool exports an executor with signature
 *     (args: JsonObject, ctx: ToolExecutionContext) => Promise<ToolResult>
 *
 * The executor MUST NOT throw on user-input errors (bad arg shape, file not
 * found, jail violation, etc.). It returns `{ ok: false, content: <error
 * message>, audit: { error } }` so the agent loop can feed the error back
 * to the model as a `tool` role message and let the model recover.
 *
 * The executor MAY throw on programmer errors (bad config, missing helper).
 * The loop catches and converts these into engine errors.
 */

import type { JsonObject, JsonValue } from "../../shared/types.js";

export interface ToolExecutionContext {
  /** Absolute path that bounds filesystem access for jailed tools. */
  cwd: string;
  /** Per-tool overrides from EngineToolsConfig (truncation caps, etc.). */
  toolOpts?: Record<string, JsonObject>;
  /** Jin session id (used by the audit-log writer in Phase 6). */
  sessionId?: string;
  /** Engine name (audit log + error context). */
  engineName?: string;
}

/**
 * What every tool returns. The `content` string is what gets fed back to
 * the model verbatim as the `tool` role message body. `audit` is consumed
 * by the audit-log writer and never reaches the model.
 */
export interface ToolResult {
  ok: boolean;
  /** Plain string the model sees. May already include truncation markers. */
  content: string;
  audit: {
    truncated: boolean;
    /** Pre-truncation byte/char count if known. */
    originalBytes?: number;
    /** Set when ok=false. Short reason. */
    error?: string;
    /** Free-form per-tool extras (exit_code for bash, http_status for webfetch, etc.). */
    [key: string]: JsonValue | undefined;
  };
}
