/**
 * `runCommand` tool — argv-only command execution under the cwd jail.
 *
 * Hardening posture (V1):
 *   - Spawns via node:child_process spawn() with shell:false, so the OS
 *     never sees a shell expansion of the model's input.
 *   - The model's argv is rejected upfront if any element contains a
 *     shell-metacharacter or NUL byte (belt-and-suspenders even though
 *     shell:false doesn't expand them).
 *   - An allowlist of argv[0] basenames must be configured on the engine.
 *     Missing or empty allowlist → tool is disabled with a clear error.
 *   - A hardcoded NEVER-LIST overrides the allowlist: shell executables
 *     (sh/bash/zsh/fish/...) and shell-like bypasses (env/xargs/eval/exec)
 *     are refused even if the user adds them to bashAllowlist by mistake.
 *   - python3 has extra restrictions: no -c / -m / stdin / interactive,
 *     and the first positional arg must be an existing file under cwd.
 *
 * Truncation:
 *   - stdout capped at 32 KB by default, stderr at 16 KB. Independently
 *     tracked; audit row has `truncated_stdout`, `truncated_stderr`,
 *     `original_stdout_bytes`, `original_stderr_bytes`.
 *   - Top-level `audit.truncated` is the OR of the two.
 *
 * Timeout / kill:
 *   - Per-call wall-clock timeout (default 60s, configurable). On hit:
 *     SIGTERM, wait `killGraceMs` (default 3s), then SIGKILL.
 *   - `audit.timeout: true` indicates the process was killed by us.
 *   - `audit.signal: "SIGTERM" | "SIGKILL" | null` carries the signal
 *     the OS reported back.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { JsonObject, JsonValue } from "../../shared/types.js";
import { JailViolation, resolveInJail } from "./cwdJail.js";
import type { ToolExecutionContext, ToolResult } from "./types.js";

const DEFAULT_MAX_STDOUT = 32_000;
const DEFAULT_MAX_STDERR = 16_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 3_000;

/**
 * Characters that have meaning in a shell context. argv-only execution
 * doesn't expand them, but we reject upfront so a misconfigured downstream
 * (re-shelling, copy/paste of an argv into a shell command line, future
 * code change) can't turn a benign-looking command into a code execution
 * surface.
 */
const METACHARS_RE = /[;|&`$<>\n\r\t*?~(){}\\\[\]!]/;

/** argv[0] basenames refused regardless of allowlist. Lowercase. */
const NEVER_LIST = new Set([
  "sh", "bash", "zsh", "fish", "ksh", "csh", "tcsh", "dash", "ash",
  "env", "xargs", "eval", "exec", "source",
]);

/**
 * Python flags that bypass the "must run a script file under cwd" intent.
 * Reject if present in args.
 */
const PYTHON_BANNED_FLAGS = new Set([
  "-c", "--command", "-m", "--module", "-i", "--interactive", "-",
]);

interface RunCommandArgs {
  command: string;
  args: string[];
}

interface BashOpts {
  allowlist: string[];
  maxStdout: number;
  maxStderr: number;
  perCallTimeoutMs: number;
  killGraceMs: number;
}

function readBashOpts(ctx: ToolExecutionContext): BashOpts {
  const raw = (ctx.toolOpts?.bash ?? {}) as Record<string, JsonValue | undefined>;
  const rawAllowlist = raw.allowlist;
  const allowlist =
    Array.isArray(rawAllowlist) && rawAllowlist.every((x) => typeof x === "string")
      ? (rawAllowlist as string[])
      : [];
  return {
    allowlist,
    maxStdout: typeof raw.maxStdout === "number" ? raw.maxStdout : DEFAULT_MAX_STDOUT,
    maxStderr: typeof raw.maxStderr === "number" ? raw.maxStderr : DEFAULT_MAX_STDERR,
    perCallTimeoutMs:
      typeof raw.perCallTimeoutMs === "number" ? raw.perCallTimeoutMs : DEFAULT_TIMEOUT_MS,
    killGraceMs: typeof raw.killGraceMs === "number" ? raw.killGraceMs : DEFAULT_KILL_GRACE_MS,
  };
}

function parseArgs(raw: JsonObject): { ok: true; args: RunCommandArgs } | { ok: false; reason: string } {
  if (typeof raw.command !== "string" || raw.command.length === 0) {
    return { ok: false, reason: "bash: 'command' is required and must be a non-empty string" };
  }
  if (raw.args === undefined) {
    return { ok: true, args: { command: raw.command, args: [] } };
  }
  if (!Array.isArray(raw.args)) {
    return { ok: false, reason: "bash: 'args' must be an array of strings" };
  }
  for (let i = 0; i < raw.args.length; i++) {
    if (typeof raw.args[i] !== "string") {
      return { ok: false, reason: `bash: args[${i}] must be a string` };
    }
  }
  return { ok: true, args: { command: raw.command, args: raw.args as string[] } };
}

function metacharCheck(value: string, label: string): string | null {
  if (value.includes("\0")) return `${label} contains NUL byte`;
  const m = METACHARS_RE.exec(value);
  if (m) return `${label} contains shell metacharacter ${JSON.stringify(m[0])}`;
  return null;
}

/** Truncate a single arg to keep the audit row bounded. */
function summarizeArg(s: string): string {
  if (s.length <= 200) return s;
  return s.slice(0, 200) + `…[${s.length - 200} more chars]`;
}

async function validatePython(args: string[], ctx: ToolExecutionContext): Promise<{ ok: true } | { ok: false; reason: string; code: string }> {
  for (const a of args) {
    if (PYTHON_BANNED_FLAGS.has(a)) {
      return {
        ok: false,
        reason: `bash: python3 invocation must not use ${a} (no inline code or stdin execution)`,
        code: "python3_unsafe_args",
      };
    }
  }
  const positional = args.find((a) => !a.startsWith("-"));
  if (!positional) {
    return {
      ok: false,
      reason: "bash: python3 invocation must include a script path as a positional argument",
      code: "python3_no_script",
    };
  }
  try {
    const abs = await resolveInJail(ctx.cwd, positional);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      return { ok: false, reason: `bash: python3 script "${positional}" is not a regular file`, code: "python3_script_not_file" };
    }
  } catch (err) {
    if (err instanceof JailViolation) {
      return {
        ok: false,
        reason: `bash: python3 script "${positional}" ${err.reason}`,
        code: err.reason,
      };
    }
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    return {
      ok: false,
      reason: `bash: python3 script "${positional}" not accessible (${code})`,
      code: code === "ENOENT" ? "python3_script_missing" : code,
    };
  }
  return { ok: true };
}

interface CollectorState {
  parts: string[];
  byteCount: number;
  truncated: boolean;
}

function appendBounded(state: CollectorState, chunk: Buffer | string, maxBytes: number): void {
  const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
  const before = state.byteCount;
  state.byteCount = before + buf.length;
  if (before >= maxBytes) {
    state.truncated = true;
    return;
  }
  if (before + buf.length <= maxBytes) {
    state.parts.push(buf.toString("utf8"));
  } else {
    state.parts.push(buf.subarray(0, maxBytes - before).toString("utf8"));
    state.truncated = true;
  }
}

function finalizeCollector(state: CollectorState, maxBytes: number, label: string): string {
  const joined = state.parts.join("");
  if (!state.truncated) return joined;
  return joined + `\n[truncated: ${label} capped at ${maxBytes} of ${state.byteCount} bytes]`;
}

export async function runCommandTool(raw: JsonObject, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = parseArgs(raw);
  if (!parsed.ok) {
    return { ok: false, content: parsed.reason, audit: { truncated: false, error: "bad_args" } };
  }
  const { command, args } = parsed.args;

  const cmdMetaErr = metacharCheck(command, "command");
  if (cmdMetaErr) {
    return {
      ok: false,
      content: `bash: ${cmdMetaErr}`,
      audit: { truncated: false, error: "metacharacter", command: summarizeArg(command) },
    };
  }
  for (let i = 0; i < args.length; i++) {
    const argMetaErr = metacharCheck(args[i]!, `args[${i}]`);
    if (argMetaErr) {
      return {
        ok: false,
        content: `bash: ${argMetaErr}`,
        audit: {
          truncated: false,
          error: "metacharacter",
          command: summarizeArg(command),
          args: args.map(summarizeArg),
        },
      };
    }
  }

  const basename = path.basename(command).toLowerCase();
  if (NEVER_LIST.has(basename)) {
    return {
      ok: false,
      content: `bash: "${basename}" is a shell or shell-like bypass and is never permitted`,
      audit: {
        truncated: false,
        error: "shell_blocked",
        command: summarizeArg(command),
        args: args.map(summarizeArg),
      },
    };
  }

  const opts = readBashOpts(ctx);
  if (opts.allowlist.length === 0) {
    return {
      ok: false,
      content: `bash: tool is disabled (no allowlist configured for this engine)`,
      audit: {
        truncated: false,
        error: "disabled",
        command: summarizeArg(command),
      },
    };
  }
  if (!opts.allowlist.includes(basename)) {
    return {
      ok: false,
      content: `bash: "${basename}" is not in the configured allowlist (${opts.allowlist.join(", ")})`,
      audit: {
        truncated: false,
        error: "not_in_allowlist",
        command: summarizeArg(command),
        args: args.map(summarizeArg),
      },
    };
  }

  if (basename === "python3" || basename === "python") {
    const py = await validatePython(args, ctx);
    if (!py.ok) {
      return {
        ok: false,
        content: py.reason,
        audit: {
          truncated: false,
          error: py.code,
          command: summarizeArg(command),
          args: args.map(summarizeArg),
        },
      };
    }
  }

  const start = Date.now();
  const stdoutState: CollectorState = { parts: [], byteCount: 0, truncated: false };
  const stderrState: CollectorState = { parts: [], byteCount: 0, truncated: false };

  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let timedOut = false;
  let spawnError: NodeJS.ErrnoException | null = null;

  await new Promise<void>((resolve) => {
    const proc = spawn(command, args, {
      cwd: ctx.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    proc.on("error", (err) => {
      spawnError = err as NodeJS.ErrnoException;
      settle();
    });

    proc.stdout?.on("data", (d: Buffer) => appendBounded(stdoutState, d, opts.maxStdout));
    proc.stderr?.on("data", (d: Buffer) => appendBounded(stderrState, d, opts.maxStderr));

    let killer: NodeJS.Timeout | null = null;
    const termTimer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // proc already exited
      }
      killer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, opts.killGraceMs);
    }, opts.perCallTimeoutMs);

    proc.on("close", (code, sig) => {
      exitCode = code;
      signal = sig;
      clearTimeout(termTimer);
      if (killer) clearTimeout(killer);
      settle();
    });
  });

  const durationMs = Date.now() - start;

  // Cast through `as` because TS narrows the let-binding through the
  // closure to `never` in the truthy branch even though we assign in the
  // spawn 'error' handler.
  const errorMaybe = spawnError as NodeJS.ErrnoException | null;
  if (errorMaybe !== null) {
    return {
      ok: false,
      content: `bash: spawn failed (${errorMaybe.code ?? "unknown"}): ${errorMaybe.message}`,
      audit: {
        truncated: false,
        error: errorMaybe.code ?? "spawn_failed",
        command: summarizeArg(command),
        args: args.map(summarizeArg),
        duration_ms: durationMs,
      },
    };
  }

  const stdout = finalizeCollector(stdoutState, opts.maxStdout, "stdout");
  const stderr = finalizeCollector(stderrState, opts.maxStderr, "stderr");

  const lines: string[] = [];
  if (timedOut) {
    lines.push(`[timed out after ${opts.perCallTimeoutMs}ms — killed]`);
  } else {
    lines.push(`[exit ${exitCode}${signal ? ` signal=${signal}` : ""}]`);
  }
  if (stdout.length > 0) {
    lines.push("--- stdout ---");
    lines.push(stdout);
  }
  if (stderr.length > 0) {
    lines.push("--- stderr ---");
    lines.push(stderr);
  }
  const content = lines.join("\n");

  const truncatedAny = stdoutState.truncated || stderrState.truncated;
  const ok = !timedOut && exitCode === 0;
  return {
    ok,
    content,
    audit: {
      truncated: truncatedAny,
      truncated_stdout: stdoutState.truncated,
      truncated_stderr: stderrState.truncated,
      original_stdout_bytes: stdoutState.byteCount,
      original_stderr_bytes: stderrState.byteCount,
      exit_code: exitCode,
      signal,
      timeout: timedOut,
      duration_ms: durationMs,
      command: summarizeArg(command),
      args: args.map(summarizeArg),
      error: timedOut ? "timeout" : ok ? undefined : "nonzero_exit",
    },
  };
}
