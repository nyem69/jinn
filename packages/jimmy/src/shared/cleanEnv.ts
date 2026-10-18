import fs from "node:fs";
import { logger } from "./logger.js";
import { opsAlert } from "./ops-alert.js";
import { T0_NAMES_FILE } from "./paths.js";

/**
 * One env builder for every child the gateway starts on a session's behalf:
 * the engine CLIs (claude / codex / gemini), cron prechecks, session forks,
 * shell hooks, the HTTP engines' runCommand tool and the MCP tools/list
 * probe (the same server code a session then runs). mcp/resolver.ts also
 * refuses to interpolate a T0 name into a session's MCP config (isT0Name).
 *
 * Two layers:
 *   1. The caller's own exclusions (CLAUDECODE / CLAUDE_CODE_* so a nested CLI
 *      does not think it runs inside Claude Code; CODEX* for codex). These are
 *      exactly the per-engine copies this helper replaced.
 *   2. Root-class (T0) names: any name matching a glob in
 *      ${JINN_HOME}/config/t0-names.txt is dropped (R9 #4, register K7 / K20).
 *
 * Fail-open by design: a missing, unreadable or empty globs file strips nothing
 * beyond layer 1, because a broken guard must not stop crons. It is made
 * visible instead: one warning per state change here, and one opsAlert at boot
 * (checkT0AtBoot).
 *
 * The file is re-read when its mtime/ctime/size changes (one statSync per
 * spawn, microseconds against a CLI start-up of seconds), so widening the
 * globs does not need a gateway restart; restarts are operator-timed. ctime is
 * in the key so a chmod that makes an unreadable file readable is picked up.
 *
 * Matching is a linear segment scan, not a RegExp: `.*` per star backtracks
 * polynomially in the number of stars, and every env name is tested against
 * every glob on every spawn, synchronously, so one many-star line could stall
 * the event loop.
 *
 * Known ceiling: jobs and prechecks that source secrets/root.env by design
 * (replica-136-lag, fama-stall-watch) put T0 into a child of the session after
 * this strip has run. This only keeps T0 out of the env we hand over; the file
 * fence (R9 #5, after 25 Nov) is what keeps root.env itself out of reach.
 */

type NameMatcher = (name: string) => boolean;

type T0State =
  | { ok: true; globs: string[]; matchers: NameMatcher[] }
  | { ok: false; reason: string };

/** A glob line may hold only env-name characters and `*` — never a value. */
const GLOB_LINE_RE = /^[A-Za-z0-9_*]+$/;

let t0File = T0_NAMES_FILE;
let cache: { key: string; state: T0State } | null = null;
let lastReported: string | null = null;

/**
 * Anchored, case-sensitive matcher where `*` is the only wildcard (any run,
 * incl. empty). Prefix and suffix must match exactly; each middle segment is
 * placed at its leftmost occurrence after the previous one, which is optimal
 * for `*`-only globs, so a name is scanned once per glob with no backtracking.
 */
export function compileGlob(glob: string): NameMatcher {
  const parts = glob.split("*");
  if (parts.length === 1) return (name) => name === glob;
  const head = parts[0];
  const tail = parts[parts.length - 1];
  const mids = parts.slice(1, -1).filter((p) => p !== "");
  return (name) => {
    if (name.length < head.length + tail.length) return false;
    if (!name.startsWith(head) || !name.endsWith(tail)) return false;
    const end = name.length - tail.length;
    let pos = head.length;
    for (const mid of mids) {
      const i = name.indexOf(mid, pos);
      if (i === -1 || i + mid.length > end) return false;
      pos = i + mid.length;
    }
    return true;
  };
}

function parseGlobs(text: string): { globs: string[]; badLines: number[] } {
  const globs: string[] = [];
  const badLines: number[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    // An all-star line would strip PATH/HOME from every session; refuse it too.
    if (!GLOB_LINE_RE.test(line) || /^\*+$/.test(line)) {
      badLines.push(i + 1);
      return;
    }
    globs.push(line);
  });
  return { globs, badLines };
}

function loadState(): T0State {
  let key: string;
  try {
    const st = fs.statSync(t0File);
    key = `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "stat failed";
    key = `missing:${code}`;
  }
  if (cache && cache.key === key) return cache.state;

  let state: T0State;
  if (key.startsWith("missing:")) {
    state = { ok: false, reason: `${t0File} unreadable (${key.slice(8)})` };
  } else {
    try {
      const { globs, badLines } = parseGlobs(fs.readFileSync(t0File, "utf-8"));
      if (badLines.length > 0) {
        // Line numbers only: a malformed line might be a pasted value.
        logger.warn(`T0 env guard: ignored malformed line(s) ${badLines.join(", ")} in ${t0File} (globs only: A-Z 0-9 _ *)`);
      }
      state = globs.length > 0
        ? { ok: true, globs, matchers: globs.map(compileGlob) }
        : { ok: false, reason: `${t0File} holds no globs` };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
      state = { ok: false, reason: `${t0File} unreadable (${code})` };
    }
  }
  cache = { key, state };

  const report = state.ok ? "ok" : state.reason;
  if (report !== lastReported) {
    if (state.ok) logger.info(`T0 env guard: ${state.globs.length} glob(s) loaded from ${t0File}`);
    else logger.warn(`T0 env guard OFF: ${state.reason} — session envs are not stripped of root-class names`);
    lastReported = report;
  }
  return state;
}

/** Sorted NAMES (never values) in `env` that match the T0 globs; [] when the guard is off. */
export function t0MatchingNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const state = loadState();
  if (!state.ok) return [];
  return Object.keys(env)
    .filter((k) => state.matchers.some((m) => m(k)))
    .sort();
}

/** True when `name` matches a T0 glob; false when it does not or the guard is off. */
export function isT0Name(name: string): boolean {
  const state = loadState();
  return state.ok && state.matchers.some((m) => m(name));
}

/** Claude Code's own session markers. */
export const excludeClaudeCode = (k: string): boolean =>
  k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_");

/** Codex additionally drops its own CODEX* markers. */
export const excludeClaudeCodeAndCodex = (k: string): boolean =>
  excludeClaudeCode(k) || k === "CODEX" || k.startsWith("CODEX_");

/**
 * Copy of `base` (default process.env) minus the caller's `exclude` names and
 * minus every T0-matching name. Undefined values are dropped, as before.
 */
export function buildCleanEnv(
  exclude?: (name: string) => boolean,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const state = loadState();
  const matchers = state.ok ? state.matchers : [];
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (exclude?.(k)) continue;
    if (matchers.some((m) => m(k))) continue;
    if (v !== undefined) cleanEnv[k] = v;
  }
  return cleanEnv;
}

/**
 * Boot check: the guard being off, or T0 names in the gateway's own env, each
 * log and send ONE opsAlert. Names only, never values. Never throws.
 */
export async function checkT0AtBoot(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const state = loadState();
  if (!state.ok) {
    await opsAlert(`T0 env guard OFF at gateway boot: ${state.reason}. Sessions and prechecks get the gateway env without the root-class strip.`);
    return;
  }
  const names = t0MatchingNames(env);
  if (names.length === 0) {
    logger.info(`T0 env guard: 0 root-class names in the gateway env (${state.globs.length} glob(s))`);
    return;
  }
  await opsAlert(
    `Gateway env holds ${names.length} root-class (T0) name(s): ${names.join(", ")}. ` +
      `They are stripped from every session/precheck env; move them to secrets/root.env and restart.`,
  );
}

/** Test seam: point the guard at another globs file (null = the real one) and drop the cache. */
export function setT0NamesFileForTests(file: string | null): void {
  t0File = file ?? T0_NAMES_FILE;
  cache = null;
  lastReported = null;
}
