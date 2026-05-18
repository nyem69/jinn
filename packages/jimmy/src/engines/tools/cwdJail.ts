/**
 * Cwd jail — bound filesystem access for the read/write/edit tools.
 *
 * Two-stage check on every resolve:
 *
 *   1. Lexical: path.resolve(cwd, requested) must not escape cwd via ".."
 *      or absolute paths to elsewhere.
 *   2. Realpath: after walking up to the deepest existing ancestor and
 *      resolving symlinks via fs.realpath, the canonical path must still
 *      be under realpath(cwd). This catches symlink escapes both at the
 *      leaf and at any parent directory.
 *
 * Tools can additionally request `rejectSymlinkLeaf: true` (write/edit) to
 * refuse operating when the final path component exists and is itself a
 * symbolic link, even if its target lies inside the jail. This keeps
 * write/edit semantics straightforward: "you are modifying the file at
 * this exact path, no indirection."
 *
 * The lexical helper is intentionally NOT exported so future code cannot
 * accidentally pick the unsafe-on-its-own variant.
 */

import fs from "node:fs/promises";
import path from "node:path";

export type JailReason = "lexical_escape" | "realpath_escape" | "symlink_leaf";

export class JailViolation extends Error {
  constructor(
    public readonly requestedPath: string,
    public readonly cwd: string,
    public readonly reason: JailReason,
  ) {
    super(`path "${requestedPath}" violates jail "${cwd}" (${reason})`);
    this.name = "JailViolation";
  }
}

interface ResolveOpts {
  /** When true and the leaf exists as a symlink, reject (write/edit). */
  rejectSymlinkLeaf?: boolean;
}

/**
 * Resolve `requested` against `cwd` to a canonical absolute path under
 * the jail, or throw. Performs both lexical and realpath checks.
 */
export async function resolveInJail(
  cwd: string,
  requested: string,
  opts: ResolveOpts = {},
): Promise<string> {
  const lexResolved = lexicalResolve(cwd, requested);
  const realCwd = await fs.realpath(cwd);

  // Walk up the lexical path to find the deepest existing ancestor.
  // Accumulate trailing segments (those that don't yet exist on disk).
  const trailing: string[] = [];
  let ancestor = lexResolved;
  while (true) {
    let stat;
    try {
      stat = await fs.lstat(ancestor);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Doesn't exist — climb up.
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        // Walked to root without finding an existing ancestor. Shouldn't
        // happen if cwd exists; treat as a realpath escape defensively.
        throw new JailViolation(requested, cwd, "realpath_escape");
      }
      trailing.unshift(path.basename(ancestor));
      ancestor = parent;
      continue;
    }

    // Leaf-symlink check: if we're at the lexResolved leaf itself, is it
    // a symlink? Only enforced when caller asks (write/edit).
    if (opts.rejectSymlinkLeaf && ancestor === lexResolved && stat.isSymbolicLink()) {
      throw new JailViolation(requested, cwd, "symlink_leaf");
    }
    break;
  }

  // Canonicalize the existing ancestor (resolves any symlinks along the
  // path). Re-attach any trailing segments that don't yet exist.
  const realAncestor = await fs.realpath(ancestor);
  const canonical =
    trailing.length === 0 ? realAncestor : path.join(realAncestor, ...trailing);

  // Final jail check against the realpathed cwd.
  const rel = path.relative(realCwd, canonical);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new JailViolation(requested, cwd, "realpath_escape");
  }

  return canonical;
}

/** Lexical-only resolution. Private — exported helpers run realpath too. */
function lexicalResolve(cwd: string, requested: string): string {
  if (typeof requested !== "string") {
    throw new Error(`path must be a string, got ${typeof requested}`);
  }
  if (requested.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  if (requested.includes("\0")) {
    throw new Error("path must not contain NUL bytes");
  }
  const baseAbs = path.resolve(cwd);
  const resolved = path.resolve(baseAbs, requested);
  const rel = path.relative(baseAbs, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new JailViolation(requested, cwd, "lexical_escape");
  }
  return resolved;
}
