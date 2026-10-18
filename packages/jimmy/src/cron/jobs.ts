import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CronJob } from "../shared/types.js";
import { CRON_JOBS, CRON_RUNS } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { opsAlert } from "../shared/ops-alert.js";
import { recordCronPerformanceSafe } from "./performance.js";

/**
 * jobs.json guard (R9 #2).
 *
 * jobs.json is edited read-modify-write by the API, by `/cron enable`, and by
 * self-editing cron prompts and other sessions, so a half-written or
 * hand-broken file is a real event. The old loader returned [] on any error,
 * which unscheduled every job and let the next POST /api/cron write
 * `[newJob]` over the whole set.
 *
 * Rules:
 * - `loadJobsResult()` is the typed read. Writers MUST use it and refuse on
 *   `ok: false` — they base their write on that fresh read, never on the
 *   last-good copy, which would overwrite another session's in-flight edit.
 * - `loadJobs()` is for read-only callers: on an invalid file it returns the
 *   last-known-good set instead of [].
 * - Last-known-good is this process's set from its last good load (not git:
 *   jobs.json carries other sessions' uncommitted edits). Each good load whose
 *   bytes changed is mirrored to `cron/jobs.lastgood.json`, which boot falls
 *   back to.
 * - A valid file containing [] is a deliberate state and is honoured. But a
 *   big shrink (to [] or below half) first copies the mirror it replaces to
 *   `cron/jobs.lastgood.prev.json`, so a session that "starts fresh with []"
 *   cannot destroy the only restore copy. That file is a manual restore source
 *   only; nothing loads it.
 * - A MISSING file is an error while the last-good set is non-empty (a deleted
 *   file must not silently empty the schedule), or while a jobs.lastgood.json
 *   exists that cannot be read; with no last-good anywhere it reads as [], so
 *   a fresh install still works.
 * - Failure details carry the parse position (line/column) and a fixed
 *   message only, never file content (V8's "Unexpected token" message embeds a
 *   source snippet, and prompts can hold anything).
 */

export type JobsLoadFailureReason = "missing" | "unreadable" | "parse" | "not-array";

export type JobsLoadFailure = {
  ok: false;
  reason: JobsLoadFailureReason;
  /** sha1 prefix of the bad bytes; null when there are no bytes to hash. */
  hash: string | null;
  detail: string;
};

export type JobsLoadResult = { ok: true; jobs: CronJob[]; hash: string } | JobsLoadFailure;

export interface JobsFileStatus {
  ok: boolean;
  invalidSince: string | null;
  reason?: JobsLoadFailureReason;
  detail?: string;
}

/** Thrown by write paths outside HTTP (e.g. `/cron enable`) on an invalid file. */
export class JobsFileInvalidError extends Error {
  constructor(public readonly failure: JobsLoadFailure) {
    super(`cron/jobs.json is invalid (${failure.reason}: ${failure.detail}); refusing to write`);
    this.name = "JobsFileInvalidError";
  }
}

// A bad file must stay byte-identical for this long before it pages anyone.
// Writers that use a plain writeFileSync (editors, sessions, scripts) leave a
// truncated file on disk for milliseconds; the watcher's next event or the
// next read then sees the finished, valid file. A file that is still the SAME
// bad bytes a minute later is not mid-write — nobody is coming to finish it.
// No extra timer is needed: the cron reconciler re-reads every 5 min, so the
// confirming observation arrives within one tick.
const ALERT_CONFIRM_MS = 60 * 1000;

let lastGood: { jobs: CronJob[]; hash: string } | null = null;
let lastGoodDiskChecked = false;
// jobs.lastgood.json exists but could not be read or parsed.
let lastGoodDiskBad = false;
let invalid: {
  since: string;
  reason: JobsLoadFailureReason;
  detail: string;
  key: string;
  keyFirstSeenMs: number;
} | null = null;
// Per invalid episode; cleared on recovery so a later recurrence pages again.
const alertedKeys = new Set<string>();

function lastGoodPath(): string {
  return path.join(path.dirname(CRON_JOBS), "jobs.lastgood.json");
}

function lastGoodPrevPath(): string {
  return path.join(path.dirname(CRON_JOBS), "jobs.lastgood.prev.json");
}

function hashOf(raw: string): string {
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12);
}

/** 1-based line and column of a string offset, as V8 counts them. */
function lineCol(raw: string, offset: number): string {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (raw.charCodeAt(i) === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  return `line ${line} column ${offset - lineStart + 1}`;
}

/**
 * Offset of the first character that cannot continue a JSON document
 * (raw.length when the input simply ends), or null if none is found. Used
 * because V8 gives no position for its commonest errors — a trailing comma,
 * a stray or unquoted word, a BOM, a truncated file — and the operator has to
 * find the fault in a ~2000-line file without the gateway echoing content.
 */
function syntaxErrorOffset(s: string): number | null {
  let i = 0;
  const stop = { at: 0 };
  const fail = (at = i): never => {
    stop.at = at;
    throw stop;
  };
  const ws = () => {
    while (i < s.length && " \t\n\r".includes(s[i])) i++;
  };
  const word = (w: string) => {
    for (const c of w) {
      if (s[i] !== c) fail();
      i++;
    }
  };
  const str = () => {
    i++;
    for (;;) {
      if (i >= s.length) fail();
      const c = s.charCodeAt(i);
      if (c === 0x22) return void i++;
      if (c < 0x20) fail();
      if (c !== 0x5c) {
        i++;
        continue;
      }
      i++;
      if (s[i] === "u") {
        for (let k = 1; k <= 4; k++) if (!/[0-9a-fA-F]/.test(s[i + k] ?? "")) fail(Math.min(i + k, s.length));
        i += 5;
      } else if (i < s.length && '"\\/bfnrt'.includes(s[i])) i++;
      else fail();
    }
  };
  const num = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = (): void => {
    ws();
    if (i >= s.length) fail();
    const c = s[i];
    if (c === "{") {
      i++;
      ws();
      if (s[i] === "}") return void i++;
      for (;;) {
        ws();
        if (s[i] !== '"') fail();
        str();
        ws();
        if (s[i] !== ":") fail();
        i++;
        value();
        ws();
        if (s[i] === ",") i++;
        else if (s[i] === "}") return void i++;
        else fail();
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (s[i] === "]") return void i++;
      for (;;) {
        value();
        ws();
        if (s[i] === ",") i++;
        else if (s[i] === "]") return void i++;
        else fail();
      }
    }
    if (c === '"') return str();
    if (c === "t") return word("true");
    if (c === "f") return word("false");
    if (c === "n") return word("null");
    num.lastIndex = i;
    const m = num.exec(s);
    if (!m) fail();
    i += m![0].length;
  };
  try {
    value();
    ws();
    if (i < s.length) fail();
    return null;
  } catch (err) {
    if (err === stop) return stop.at;
    return null; // e.g. nesting too deep for this recursion
  }
}

/** Map a JSON.parse error to line/column + fixed text, dropping any source snippet. */
function describeParseError(err: unknown, raw: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Positioned V8 messages are fixed text ("Expected ',' or ']' after array
  // element", "Bad control character in string literal", ...), except the
  // pre-Node-20 form "Unexpected token x", whose token is dropped.
  const pos = msg.match(/^(.*?) (?:in|after) JSON at position (\d+)/);
  if (pos) {
    const text = pos[1].replace(/^Unexpected token\b.*/, "Unexpected token");
    return `${text} at ${lineCol(raw, Number(pos[2]))}`;
  }
  const at = syntaxErrorOffset(raw);
  if (at === null) return "Invalid JSON (parser gave no position)";
  if (at >= raw.length) return `Unexpected end of JSON input at ${lineCol(raw, raw.length)} (file truncated?)`;
  // Name the character only when it is JSON punctuation or a BOM: neither leaks content.
  const ch = raw[at];
  const what = "[]{}:,".includes(ch)
    ? `Unexpected token '${ch}'`
    : ch === "\uFEFF"
      ? "Unexpected byte-order mark"
      : "Unexpected token";
  return `${what} at ${lineCol(raw, at)}`;
}

function parseJobs(raw: string): { ok: true; jobs: CronJob[] } | { ok: false; reason: "parse" | "not-array"; detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: "parse", detail: describeParseError(err, raw) };
  }
  if (!Array.isArray(parsed)) {
    const kind = parsed === null ? "null" : typeof parsed;
    return { ok: false, reason: "not-array", detail: `top-level value is ${kind}, expected an array` };
  }
  return { ok: true, jobs: parsed as CronJob[] };
}

/** In-memory last-good, seeded once from jobs.lastgood.json when this process has none. */
function getLastGood(): { jobs: CronJob[]; hash: string } | null {
  if (lastGood || lastGoodDiskChecked) return lastGood;
  lastGoodDiskChecked = true;
  try {
    const raw = fs.readFileSync(lastGoodPath(), "utf-8");
    const parsed = parseJobs(raw);
    if (parsed.ok) lastGood = { jobs: parsed.jobs, hash: hashOf(raw) };
    else {
      lastGoodDiskBad = true;
      logger.warn(`cron/jobs.lastgood.json is invalid too (${parsed.reason}: ${parsed.detail}); ignoring it`);
    }
  } catch (err) {
    // ENOENT: no last-good on disk yet. Anything else: it exists but is unreadable.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") lastGoodDiskBad = true;
  }
  return lastGood;
}

/** Job count of jobs.lastgood.prev.json, or -1 when it is absent or invalid. */
function prevJobCount(): number {
  try {
    const parsed = parseJobs(fs.readFileSync(lastGoodPrevPath(), "utf-8"));
    return parsed.ok ? parsed.jobs.length : -1;
  } catch {
    return -1;
  }
}

function recordGood(raw: string, jobs: CronJob[], hash: string): void {
  if (invalid) {
    logger.info(
      `cron/jobs.json is valid again (${jobs.length} job(s)); it was invalid since ${invalid.since} (${invalid.reason})`,
    );
    invalid = null;
    alertedKeys.clear();
  }
  const old = getLastGood();
  if (old?.hash === hash) return;
  // A private copy: writers mutate the array loadJobsResult hands them before
  // saveJobs, and a save that then throws must not leave that edit here.
  lastGood = { jobs: structuredClone(jobs), hash };
  try {
    // The live schedule honours a big shrink, but keep the set it replaced as
    // a restore copy — unless prev already holds a bigger set (a later small
    // shrink, e.g. 1 -> 0, must not evict the 106-job copy).
    if (old && jobs.length < old.jobs.length / 2 && prevJobCount() <= old.jobs.length) {
      writeFileAtomic(lastGoodPrevPath(), JSON.stringify(old.jobs, null, 2) + "\n", CRON_JOBS);
      logger.warn(
        `cron/jobs.json shrank from ${old.jobs.length} to ${jobs.length} job(s); ` +
          `the previous set is kept in cron/jobs.lastgood.prev.json`,
      );
    }
    writeFileAtomic(lastGoodPath(), raw, CRON_JOBS);
    lastGoodDiskBad = false;
  } catch (err) {
    logger.warn(`Could not write cron/jobs.lastgood.json: ${err instanceof Error ? err.message : err}`);
  }
}

function alertText(f: JobsLoadFailure): string {
  const kept = getLastGood()?.jobs.length ?? 0;
  return (
    `cron jobs file invalid: ${CRON_JOBS} — ${f.reason}: ${f.detail}` +
    (f.hash ? ` (sha1 ${f.hash})` : "") +
    `. Gateway keeps the last-good schedule (${kept} job(s)); cron writes refused until fixed.`
  );
}

function recordFailure(f: JobsLoadFailure): void {
  const now = Date.now();
  const key = f.hash ?? f.reason;
  if (!invalid || invalid.key !== key) {
    // First sighting of these bytes: log loudly, but don't page yet (see ALERT_CONFIRM_MS).
    invalid = {
      since: invalid?.since ?? new Date(now).toISOString(),
      reason: f.reason,
      detail: f.detail,
      key,
      keyFirstSeenMs: now,
    };
    logger.error(`cron/jobs.json is invalid (${f.reason}: ${f.detail}); serving the last-good set, refusing writes`);
    return;
  }
  if (!alertedKeys.has(key) && now - invalid.keyFirstSeenMs >= ALERT_CONFIRM_MS) {
    alertedKeys.add(key);
    void opsAlert(alertText(f));
  }
}

/**
 * Typed read of cron/jobs.json. Every write path must use this and refuse on
 * `ok: false`. Side effects: updates the last-good copy on success and the
 * invalid-file state (log, alert) on failure.
 */
export function loadJobsResult(): JobsLoadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(CRON_JOBS, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const known = getLastGood()?.jobs.length ?? 0;
      if (known === 0 && !lastGoodDiskBad) {
        // Nothing live to protect (fresh install, or a deliberately empty set).
        return { ok: true, jobs: [], hash: hashOf("") };
      }
      const f: JobsLoadFailure = {
        ok: false,
        reason: "missing",
        hash: null,
        detail:
          known > 0
            ? "file does not exist but the last-good set is non-empty"
            : "file does not exist and cron/jobs.lastgood.json is unreadable",
      };
      recordFailure(f);
      return f;
    }
    const f: JobsLoadFailure = { ok: false, reason: "unreadable", hash: null, detail: code ?? "read failed" };
    recordFailure(f);
    return f;
  }
  const hash = hashOf(raw);
  const parsed = parseJobs(raw);
  if (!parsed.ok) {
    const f: JobsLoadFailure = { ok: false, reason: parsed.reason, hash, detail: parsed.detail };
    recordFailure(f);
    return f;
  }
  recordGood(raw, parsed.jobs, hash);
  return { ok: true, jobs: parsed.jobs, hash };
}

/**
 * Read-only view: the file's jobs, or the last-good set while the file is
 * invalid. Never use this as the base of a write — use `loadJobsResult()`.
 */
export function loadJobs(): CronJob[] {
  const r = loadJobsResult();
  return r.ok ? r.jobs : (getLastGood()?.jobs ?? []);
}

/**
 * Boot read. An invalid file falls back to cron/jobs.lastgood.json and pages
 * at once (no transient grace: the gateway is starting on a fallback). Never
 * boots into an empty schedule silently.
 */
export function loadJobsForBoot(): { jobs: CronJob[]; source: "file" | "lastgood" | "none"; failure?: JobsLoadFailure } {
  const r = loadJobsResult();
  if (r.ok) return { jobs: r.jobs, source: "file" };
  const lg = getLastGood();
  alertedKeys.add(r.hash ?? r.reason);
  if (lg) {
    logger.error(`Booting cron from cron/jobs.lastgood.json (${lg.jobs.length} job(s)): jobs.json is ${r.reason}: ${r.detail}`);
    void opsAlert(`Gateway booted cron from jobs.lastgood.json — ${alertText(r)}`);
    return { jobs: lg.jobs, source: "lastgood", failure: r };
  }
  logger.error(`Booting with NO cron jobs: jobs.json is ${r.reason}: ${r.detail} and there is no valid jobs.lastgood.json`);
  void opsAlert(`Gateway booted with ZERO cron jobs — ${CRON_JOBS} is ${r.reason}: ${r.detail}, and no valid jobs.lastgood.json exists.`);
  return { jobs: [], source: "none", failure: r };
}

/** For /api/status. Re-reads the file so the answer is current. */
export function jobsFileStatus(): JobsFileStatus {
  const r = loadJobsResult();
  if (r.ok || !invalid) return { ok: true, invalidSince: null };
  return { ok: false, invalidSince: invalid.since, reason: invalid.reason, detail: invalid.detail };
}

/**
 * Write via a temp file in the same directory + fsync + rename, so a reader
 * (or a crash) never sees a truncated file. Takes the mode of `modeFrom`
 * (default: the existing target), so copies of jobs.json are never looser
 * than jobs.json itself. The directory itself is not fsynced: a power cut may
 * lose the rename, which leaves the previous complete file — acceptable here.
 */
function writeFileAtomic(target: string, data: string, modeFrom: string = target): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  let mode = 0o644;
  try {
    mode = fs.statSync(modeFrom).mode & 0o777;
  } catch {
    /* new file */
  }
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    const fd = fs.openSync(tmp, "wx", mode);
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, mode); // openSync's mode is filtered by the umask
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Atomic save. Callers must have based `jobs` on a successful `loadJobsResult()`. */
export function saveJobs(jobs: CronJob[]): void {
  const raw = JSON.stringify(jobs, null, 2) + "\n";
  writeFileAtomic(CRON_JOBS, raw);
  recordGood(raw, jobs, hashOf(raw));
}

export function appendRunLog(jobId: string, entry: object): void {
  fs.mkdirSync(CRON_RUNS, { recursive: true });
  const logPath = path.join(CRON_RUNS, `${jobId}.jsonl`);
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  // Every run-log entry also lands a performance_log row (see performance.ts).
  // Hooked here rather than in the runner so all three run-log writers are
  // covered by one call. Fire-and-forget; it never throws.
  const job = loadJobs().find((j) => j.id === jobId);
  void recordCronPerformanceSafe(jobId, job, entry as Record<string, unknown>);
}
