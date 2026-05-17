/**
 * `write` tool — overwrite a text file under the cwd jail.
 *
 * Args:
 *   path:    string (relative or absolute, must resolve under ctx.cwd)
 *   content: string (the new file contents; UTF-8 written)
 *
 * Creates parent directories implicitly via fs.mkdir(..., recursive: true)
 * before writing — this matches the practical expectation when an agent
 * asks to write `subdir/new.json` under cwd. The recursive mkdir cannot
 * escape the jail because the resolved path is already jail-checked.
 *
 * No truncation policy (write is input-side; the model decides the content).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { JsonObject } from "../../shared/types.js";
import { JailViolation, resolveInJail } from "./cwdJail.js";
import type { ToolExecutionContext, ToolResult } from "./types.js";

interface WriteArgs {
  path: string;
  content: string;
}

function parseArgs(raw: JsonObject): { ok: true; args: WriteArgs } | { ok: false; reason: string } {
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    return { ok: false, reason: "write: 'path' is required and must be a non-empty string" };
  }
  if (typeof raw.content !== "string") {
    return { ok: false, reason: "write: 'content' is required and must be a string" };
  }
  return { ok: true, args: { path: raw.path, content: raw.content } };
}

export async function writeTool(raw: JsonObject, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = parseArgs(raw);
  if (!parsed.ok) {
    return { ok: false, content: parsed.reason, audit: { truncated: false, error: "bad_args" } };
  }

  let abs: string;
  try {
    abs = resolveInJail(ctx.cwd, parsed.args.path);
  } catch (err) {
    return {
      ok: false,
      content: `write: ${(err as Error).message}`,
      audit: { truncated: false, error: err instanceof JailViolation ? "jail_violation" : "bad_path" },
    };
  }

  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, parsed.args.content, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    return {
      ok: false,
      content: `write: cannot write "${parsed.args.path}" (${code})`,
      audit: { truncated: false, error: code },
    };
  }

  return {
    ok: true,
    content: `wrote ${parsed.args.content.length} chars to ${parsed.args.path}`,
    audit: {
      truncated: false,
      bytes_written: Buffer.byteLength(parsed.args.content, "utf8"),
    },
  };
}
