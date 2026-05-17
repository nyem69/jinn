/**
 * `edit` tool — exact string replacement in a file under the cwd jail.
 *
 * Args:
 *   path:        string (must resolve under ctx.cwd)
 *   old_string:  string (must already exist in the file)
 *   new_string:  string (replacement; may be empty to delete)
 *   replace_all: optional boolean. Default false.
 *
 * Behavior:
 *   - If `old_string` is not found → error
 *   - If `old_string === new_string` → error (no-op)
 *   - If multiple matches and `replace_all=false` → error (refuses to
 *     guess which match the model meant)
 *   - If `replace_all=true` → replaces every occurrence
 *   - Otherwise replaces the single match
 *
 * Mirrors the semantics of Claude Code's Edit tool so prompts written for
 * Claude can be reused.
 */

import fs from "node:fs/promises";
import type { JsonObject } from "../../shared/types.js";
import { JailViolation, resolveInJail } from "./cwdJail.js";
import type { ToolExecutionContext, ToolResult } from "./types.js";

interface EditArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

function parseArgs(raw: JsonObject): { ok: true; args: EditArgs } | { ok: false; reason: string } {
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    return { ok: false, reason: "edit: 'path' is required and must be a non-empty string" };
  }
  if (typeof raw.old_string !== "string") {
    return { ok: false, reason: "edit: 'old_string' is required and must be a string" };
  }
  if (raw.old_string.length === 0) {
    return { ok: false, reason: "edit: 'old_string' must be non-empty" };
  }
  if (typeof raw.new_string !== "string") {
    return { ok: false, reason: "edit: 'new_string' is required and must be a string" };
  }
  let replace_all = false;
  if (raw.replace_all !== undefined) {
    if (typeof raw.replace_all !== "boolean") {
      return { ok: false, reason: "edit: 'replace_all' must be a boolean" };
    }
    replace_all = raw.replace_all;
  }
  return { ok: true, args: { path: raw.path, old_string: raw.old_string, new_string: raw.new_string, replace_all } };
}

export async function editTool(raw: JsonObject, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = parseArgs(raw);
  if (!parsed.ok) {
    return { ok: false, content: parsed.reason, audit: { truncated: false, error: "bad_args" } };
  }
  const { path: requestedPath, old_string, new_string, replace_all } = parsed.args;

  if (old_string === new_string) {
    return {
      ok: false,
      content: "edit: 'old_string' and 'new_string' are identical — no-op refused",
      audit: { truncated: false, error: "noop" },
    };
  }

  let abs: string;
  try {
    abs = resolveInJail(ctx.cwd, requestedPath);
  } catch (err) {
    return {
      ok: false,
      content: `edit: ${(err as Error).message}`,
      audit: { truncated: false, error: err instanceof JailViolation ? "jail_violation" : "bad_path" },
    };
  }

  let content: string;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    return {
      ok: false,
      content: `edit: cannot read "${requestedPath}" (${code})`,
      audit: { truncated: false, error: code },
    };
  }

  const occurrences = countOccurrences(content, old_string);
  if (occurrences === 0) {
    return {
      ok: false,
      content: `edit: 'old_string' not found in "${requestedPath}"`,
      audit: { truncated: false, error: "not_found" },
    };
  }
  if (occurrences > 1 && !replace_all) {
    return {
      ok: false,
      content:
        `edit: 'old_string' matches ${occurrences} locations in "${requestedPath}"; ` +
        `provide more context to make it unique, or set replace_all=true`,
      audit: { truncated: false, error: "ambiguous", matches: occurrences },
    };
  }

  const updated = replace_all
    ? content.split(old_string).join(new_string)
    : content.replace(old_string, new_string);

  try {
    await fs.writeFile(abs, updated, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    return {
      ok: false,
      content: `edit: cannot write "${requestedPath}" (${code})`,
      audit: { truncated: false, error: code },
    };
  }

  return {
    ok: true,
    content: replace_all
      ? `edited ${requestedPath} (replaced all ${occurrences} occurrences)`
      : `edited ${requestedPath} (1 replacement)`,
    audit: {
      truncated: false,
      replacements: replace_all ? occurrences : 1,
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
