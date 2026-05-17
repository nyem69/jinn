/**
 * `read` tool — read a text file under the cwd jail.
 *
 * Args:
 *   path:   string (relative or absolute, must resolve under ctx.cwd)
 *   offset: optional 1-indexed line number to start from. Default 1.
 *   limit:  optional max line count to return. Default 2000.
 *
 * Truncation:
 *   The slice (after offset/limit) is further capped at `maxChars` chars
 *   (default 64_000). If truncated, the returned content ends with
 *   `\n[truncated: NN of MM total characters]\n`.
 *
 * Returns a ToolResult. Failures (file not found, jail violation, bad arg
 * shape) return `{ok:false, ...}` rather than throwing so the agent loop
 * can feed the error to the model.
 */

import fs from "node:fs/promises";
import type { JsonObject } from "../../shared/types.js";
import { JailViolation, resolveInJail } from "./cwdJail.js";
import type { ToolExecutionContext, ToolResult } from "./types.js";

const DEFAULT_LINE_LIMIT = 2000;
const DEFAULT_MAX_CHARS = 64_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

interface ReadArgs {
  path: string;
  offset: number;
  limit: number;
}

function parseArgs(raw: JsonObject): { ok: true; args: ReadArgs } | { ok: false; reason: string } {
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    return { ok: false, reason: "read: 'path' is required and must be a non-empty string" };
  }
  let offset = 1;
  if (raw.offset !== undefined) {
    if (typeof raw.offset !== "number" || !Number.isInteger(raw.offset) || raw.offset < 1) {
      return { ok: false, reason: "read: 'offset' must be a positive integer (1-indexed line number)" };
    }
    offset = raw.offset;
  }
  let limit = DEFAULT_LINE_LIMIT;
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit < 1) {
      return { ok: false, reason: "read: 'limit' must be a positive integer" };
    }
    limit = raw.limit;
  }
  return { ok: true, args: { path: raw.path, offset, limit } };
}

export async function readTool(raw: JsonObject, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = parseArgs(raw);
  if (!parsed.ok) {
    return { ok: false, content: parsed.reason, audit: { truncated: false, error: "bad_args" } };
  }
  const { path: requestedPath, offset, limit } = parsed.args;

  let abs: string;
  try {
    abs = await resolveInJail(ctx.cwd, requestedPath);
  } catch (err) {
    const message = (err as Error).message;
    return {
      ok: false,
      content: `read: ${message}`,
      audit: { truncated: false, error: err instanceof JailViolation ? err.reason : "bad_path" },
    };
  }

  // Size cap: stat before readFile so huge files don't blow up memory.
  try {
    const st = await fs.stat(abs);
    if (st.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        content: `read: "${requestedPath}" is ${st.size} bytes; max is ${MAX_FILE_BYTES} (${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB)`,
        audit: { truncated: false, error: "too_large", file_bytes: st.size },
      };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    return {
      ok: false,
      content: `read: cannot stat "${requestedPath}" (${code})`,
      audit: { truncated: false, error: code },
    };
  }

  let raw_content: string;
  try {
    raw_content = await fs.readFile(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    return {
      ok: false,
      content: `read: cannot read "${requestedPath}" (${code})`,
      audit: { truncated: false, error: code },
    };
  }

  // Line slicing (1-indexed offset like cat -n).
  const lines = raw_content.split("\n");
  const totalLines = lines.length;
  const startIdx = Math.min(offset - 1, totalLines);
  const endIdx = Math.min(startIdx + limit, totalLines);
  const sliced = lines.slice(startIdx, endIdx).join("\n");

  const maxChars = readMaxChars(ctx);
  let content = sliced;
  let truncated = false;
  if (content.length > maxChars) {
    truncated = true;
    content = content.slice(0, maxChars) + `\n[truncated: ${maxChars} of ${sliced.length} characters]\n`;
  }

  return {
    ok: true,
    content,
    audit: {
      truncated,
      originalBytes: sliced.length,
      total_lines: totalLines,
      returned_lines: endIdx - startIdx,
    },
  };
}

function readMaxChars(ctx: ToolExecutionContext): number {
  const override = ctx.toolOpts?.read;
  if (override && typeof override.maxChars === "number" && override.maxChars > 0) {
    return override.maxChars;
  }
  return DEFAULT_MAX_CHARS;
}
