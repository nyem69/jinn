/**
 * Cwd jail — bound filesystem access for the read/write/edit tools.
 *
 * Lexical-only check (V1). We resolve the requested path against the cwd
 * then verify the relative path doesn't begin with `..` and isn't itself
 * absolute. This catches the common attack surface: `..` escapes, absolute
 * paths to /etc/, paths containing normalized escapes (`foo/../../etc`).
 *
 * Known limitation: a symlink inside the cwd that points to a target
 * outside the cwd will pass this check. fs.realpath() would catch that
 * but adds an I/O round-trip on every tool call and breaks operations on
 * paths that don't yet exist (e.g. `write` creating a new file). V1
 * accepts this and the caller (engine config) must ensure the cwd does
 * not contain escape-symlinks pointing into sensitive locations. The
 * existing claude/codex/gemini engines have the same limitation.
 */

import path from "node:path";

export class JailViolation extends Error {
  constructor(public readonly requestedPath: string, public readonly cwd: string) {
    super(`path "${requestedPath}" resolves outside of cwd jail "${cwd}"`);
    this.name = "JailViolation";
  }
}

/**
 * Resolve `requested` against `cwd` and return the absolute path on
 * success. Throws JailViolation if the path escapes the cwd. Throws a
 * plain Error for malformed input (non-string, empty).
 */
export function resolveInJail(cwd: string, requested: string): string {
  if (typeof requested !== "string") {
    throw new Error(`path must be a string, got ${typeof requested}`);
  }
  if (requested.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  // Reject NUL bytes — fs APIs will throw later but the error is clearer here.
  if (requested.includes("\0")) {
    throw new Error("path must not contain NUL bytes");
  }

  const baseAbs = path.resolve(cwd);
  const resolved = path.resolve(baseAbs, requested);
  const rel = path.relative(baseAbs, resolved);

  // path.relative returns "" when resolved === baseAbs (cwd itself); allow.
  // Returns ".." or "../foo" when escaping; reject.
  // Returns an absolute path (Windows: starts with C:\) when on a different
  // drive; reject defensively even though we target macOS/Linux.
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new JailViolation(requested, cwd);
  }
  return resolved;
}
