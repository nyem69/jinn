import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CronJob } from "../../shared/types.js";

// R9 #2: an invalid cron/jobs.json must never empty the live schedule, never
// be overwritten by a write path, and pages once per bad file. Per-test temp
// JINN_HOME + vi.resetModules() so paths.ts and the jobs.ts module state are
// fresh (a reset also stands in for a gateway restart).

const { opsAlert } = vi.hoisted(() => ({ opsAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../shared/ops-alert.js", () => ({ opsAlert }));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Scheduled closures never fire in these tests; keep the runner's imports out.
vi.mock("../runner.js", () => ({ runCronJob: vi.fn(), lastStartedAtMs: vi.fn() }));

const SECRET = "FAKE_PROMPT_SECRET_VALUE";

let tmpHome: string;
let originalHome: string | undefined;
let jobsPath: string;
let lastGoodPath: string;

function job(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return { id, name: id, enabled: true, schedule: "0 3 * * *", prompt: `do ${id}`, ...overrides } as CronJob;
}

function writeJobs(jobs: CronJob[]): string {
  const raw = JSON.stringify(jobs, null, 2) + "\n";
  fs.writeFileSync(jobsPath, raw);
  return raw;
}

// The "Unexpected token" form whose V8 message embeds a source snippet.
const BROKEN = `[\n  {"id": "a", "prompt": "${SECRET}"},\n  oops\n]\n`;
const BROKEN_2 = `[\n  {"id": "a", "prompt": "${SECRET}"},\n`; // truncated mid-write

async function load() {
  vi.resetModules();
  return import("../jobs.js");
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jin-jobs-guard-"));
  fs.mkdirSync(path.join(tmpHome, "cron"), { recursive: true });
  jobsPath = path.join(tmpHome, "cron", "jobs.json");
  lastGoodPath = path.join(tmpHome, "cron", "jobs.lastgood.json");
  originalHome = process.env.JINN_HOME;
  process.env.JINN_HOME = tmpHome;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("loadJobsResult", () => {
  // V8 gives no position for most of these; the guard must still locate them.
  it.each([
    ["a stray word", BROKEN, "Unexpected token at line 3 column 3"],
    ["a trailing comma", `[\n  {"id": "a", "prompt": "${SECRET}"},\n]\n`, "Unexpected token ']' at line 3 column 1"],
    [
      "an unquoted value",
      `[\n  {\n    "id": "a",\n    "name": job 25,\n    "prompt": "${SECRET}"\n  }\n]\n`,
      "Unexpected token at line 4 column 13",
    ],
    ["a truncated file", BROKEN_2, "Unexpected end of JSON input at line 3 column 1 (file truncated?)"],
    ["a BOM", `\uFEFF[{"prompt": "${SECRET}"}]`, "Unexpected byte-order mark at line 1 column 1"],
    ["a missing comma (V8 positioned)", `[\n  {"prompt": "${SECRET}"}\n  {}\n]`, "Expected ',' or ']' after array element at line 3 column 3"],
  ])("reports %s by line and column, never file content", async (_label, raw, detail) => {
    fs.writeFileSync(jobsPath, raw);
    const { loadJobsResult } = await load();
    const r = loadJobsResult();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("parse");
    expect(r.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(r.detail).toBe(detail);
    expect(r.detail).not.toContain(SECRET);
  });

  it("treats a non-array as an error and a valid [] as a deliberate empty set", async () => {
    fs.writeFileSync(jobsPath, JSON.stringify({ jobs: [] }));
    const { loadJobsResult } = await load();
    const r = loadJobsResult();
    expect(r).toMatchObject({ ok: false, reason: "not-array" });

    writeJobs([]);
    expect(loadJobsResult()).toMatchObject({ ok: true, jobs: [] });
  });

  it("a missing file is an error once a non-empty set is known, [] on a fresh install", async () => {
    const { loadJobsResult } = await load();
    expect(loadJobsResult()).toMatchObject({ ok: true, jobs: [] }); // fresh: no file, no last-good

    writeJobs([job("a")]);
    expect(loadJobsResult().ok).toBe(true);
    fs.rmSync(jobsPath);
    expect(loadJobsResult()).toMatchObject({ ok: false, reason: "missing" });
  });

  it("a missing file with a corrupt jobs.lastgood.json is an error, and boot pages ZERO jobs", async () => {
    fs.writeFileSync(lastGoodPath, BROKEN);
    const { loadJobsResult, loadJobsForBoot } = await load();
    expect(loadJobsResult()).toMatchObject({ ok: false, reason: "missing" });
    const boot = loadJobsForBoot();
    expect(boot).toMatchObject({ source: "none", jobs: [] });
    expect(opsAlert).toHaveBeenCalledTimes(1);
    expect(opsAlert.mock.calls[0][0]).toMatch(/ZERO cron jobs/);
  });
});

describe("last-known-good", () => {
  it("(e) mirrors each changed good load to jobs.lastgood.json", async () => {
    const raw1 = writeJobs([job("a"), job("b")]);
    const { loadJobsResult, loadJobs } = await load();
    expect(loadJobsResult().ok).toBe(true);
    expect(fs.readFileSync(lastGoodPath, "utf-8")).toBe(raw1);

    const raw2 = writeJobs([job("a")]);
    loadJobsResult();
    expect(fs.readFileSync(lastGoodPath, "utf-8")).toBe(raw2);

    // A bad file never touches the mirror, and read-only callers get last-good.
    fs.writeFileSync(jobsPath, BROKEN);
    expect(loadJobs().map((j) => j.id)).toEqual(["a"]);
    expect(fs.readFileSync(lastGoodPath, "utf-8")).toBe(raw2);
  });

  it("a big shrink is honoured but keeps the replaced set in jobs.lastgood.prev.json", async () => {
    const prevPath = path.join(tmpHome, "cron", "jobs.lastgood.prev.json");
    const many = [job("a"), job("b"), job("c"), job("d")];
    writeJobs(many);
    const { loadJobsResult, loadJobs } = await load();
    loadJobsResult();

    writeJobs([job("a"), job("b"), job("c")]); // small shrink: no rotation
    loadJobsResult();
    expect(fs.existsSync(prevPath)).toBe(false);

    const empty = writeJobs([]); // a session "starts fresh with []"
    expect(loadJobs()).toEqual([]); // honoured live
    expect(fs.readFileSync(lastGoodPath, "utf-8")).toBe(empty);
    const prev = JSON.parse(fs.readFileSync(prevPath, "utf-8")) as CronJob[];
    expect(prev.map((j) => j.id)).toEqual(["a", "b", "c"]);

    // A later 1 -> 0 shrink must not evict the bigger restore copy.
    writeJobs([job("x")]);
    loadJobsResult();
    writeJobs([]);
    loadJobsResult();
    expect((JSON.parse(fs.readFileSync(prevPath, "utf-8")) as CronJob[]).map((j) => j.id)).toEqual(["a", "b", "c"]);
  });

  it("a writer's failed save does not leak its edit into the last-good set", async () => {
    writeJobs([job("a"), job("b")]);
    const { loadJobsResult, loadJobs, saveJobs } = await load();
    const r = loadJobsResult();
    if (!r.ok) throw new Error("expected a good load");
    r.jobs.push(job("phantom")); // what POST does before saveJobs
    const spy = vi.spyOn(fs, "writeSync").mockImplementation(() => {
      throw new Error("ENOSPC: simulated disk full");
    });
    expect(() => saveJobs(r.jobs)).toThrow(/ENOSPC/);
    spy.mockRestore();

    loadJobsResult(); // same bytes: early return on equal hash
    fs.writeFileSync(jobsPath, BROKEN);
    expect(loadJobs().map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("(d) short writes are completed, and a zero-byte write fails without replacing the file", async () => {
    const { saveJobs } = await load();
    const realWrite = fs.writeSync.bind(fs) as (fd: number, b: Buffer, o: number, l: number) => number;
    // Chunked: each call writes at most 7 bytes, as a partial write would.
    const chunk = vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, b: Buffer, o: number, l: number) =>
      realWrite(fd, b, o, Math.min(l, 7))) as typeof fs.writeSync);
    saveJobs([job("a"), job("b")]);
    chunk.mockRestore();
    expect((JSON.parse(fs.readFileSync(jobsPath, "utf-8")) as CronJob[]).map((j) => j.id)).toEqual(["a", "b"]);

    const before = fs.readFileSync(jobsPath);
    let calls = 0;
    const stall = vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, b: Buffer, o: number, l: number) =>
      calls++ === 0 ? realWrite(fd, b, o, Math.min(l, 5)) : 0) as typeof fs.writeSync);
    expect(() => saveJobs([job("a"), job("b"), job("c")])).toThrow(/short write/);
    stall.mockRestore();
    expect(fs.readFileSync(jobsPath).equals(before)).toBe(true);
    expect(fs.readdirSync(path.dirname(jobsPath)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("(f) boot falls back to jobs.lastgood.json and pages at once", async () => {
    writeJobs([job("a"), job("b"), job("c")]);
    (await load()).loadJobsResult(); // previous gateway run wrote the mirror

    fs.writeFileSync(jobsPath, BROKEN);
    const { loadJobsForBoot, loadJobs, loadJobsResult } = await load(); // "restart"
    const boot = loadJobsForBoot();
    expect(boot.source).toBe("lastgood");
    expect(boot.jobs.map((j) => j.id)).toEqual(["a", "b", "c"]);
    expect(opsAlert).toHaveBeenCalledTimes(1);
    expect(opsAlert.mock.calls[0][0]).toContain(jobsPath);
    expect(opsAlert.mock.calls[0][0]).not.toContain(SECRET);
    expect(loadJobs()).toHaveLength(3);
    // Writers still see the invalid file, not the fallback.
    expect(loadJobsResult().ok).toBe(false);
    // Boot already paged for these bytes; later ticks don't page again.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    loadJobsResult();
    loadJobsResult();
    expect(opsAlert).toHaveBeenCalledTimes(1);
  });

  it("(f) boot with an invalid file and no mirror pages that the schedule is empty", async () => {
    fs.writeFileSync(jobsPath, BROKEN);
    const { loadJobsForBoot } = await load();
    const boot = loadJobsForBoot();
    expect(boot).toMatchObject({ source: "none", jobs: [] });
    expect(opsAlert).toHaveBeenCalledTimes(1);
    expect(opsAlert.mock.calls[0][0]).toMatch(/ZERO cron jobs/);
  });
});

describe("ops alert", () => {
  it("(c) fires once per distinct bad hash, only after the bad bytes persist", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    writeJobs([job("a")]);
    const { loadJobsResult } = await load();
    loadJobsResult();

    fs.writeFileSync(jobsPath, BROKEN);
    loadJobsResult();
    expect(opsAlert).not.toHaveBeenCalled(); // first sighting: could be mid-write

    vi.advanceTimersByTime(61_000);
    for (let i = 0; i < 5; i++) loadJobsResult(); // reconciler ticks, watcher, readers
    expect(opsAlert).toHaveBeenCalledTimes(1);
    expect(opsAlert.mock.calls[0][0]).not.toContain(SECRET);

    vi.advanceTimersByTime(10 * 60_000);
    loadJobsResult();
    expect(opsAlert).toHaveBeenCalledTimes(1);

    // Different bad bytes: a new hash, paged again once it persists.
    fs.writeFileSync(jobsPath, BROKEN_2);
    loadJobsResult();
    expect(opsAlert).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    loadJobsResult();
    loadJobsResult();
    expect(opsAlert).toHaveBeenCalledTimes(2);
  });

  it("(c) a transient half-written file that recovers never pages", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    writeJobs([job("a"), job("b")]);
    const { loadJobsResult, jobsFileStatus } = await load();
    const { logger } = await import("../../shared/logger.js");
    loadJobsResult();

    fs.writeFileSync(jobsPath, BROKEN_2); // mid-write
    expect(jobsFileStatus()).toMatchObject({ ok: false, invalidSince: "2026-10-20T00:00:00.000Z", reason: "parse" });
    vi.advanceTimersByTime(800);
    writeJobs([job("a"), job("b"), job("c")]); // write finished
    loadJobsResult();
    vi.advanceTimersByTime(10 * 60_000);
    loadJobsResult();
    loadJobsResult();
    expect(opsAlert).not.toHaveBeenCalled();
    expect(jobsFileStatus()).toEqual({ ok: true, invalidSince: null });
    const recoveries = vi.mocked(logger.info).mock.calls.filter(([m]) => /valid again/.test(String(m)));
    expect(recoveries).toHaveLength(1);
  });

  it("(c) the same bad bytes after a recovery page again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    writeJobs([job("a")]);
    const { loadJobsResult } = await load();
    loadJobsResult();

    fs.writeFileSync(jobsPath, BROKEN);
    loadJobsResult();
    vi.advanceTimersByTime(61_000);
    loadJobsResult();
    expect(opsAlert).toHaveBeenCalledTimes(1);

    writeJobs([job("a")]); // operator fixes it
    loadJobsResult();

    fs.writeFileSync(jobsPath, BROKEN); // a session re-applies the same broken edit
    loadJobsResult();
    vi.advanceTimersByTime(61_000);
    loadJobsResult();
    expect(opsAlert).toHaveBeenCalledTimes(2);
  });
});

describe("saveJobs", () => {
  it("(d) writes atomically: no temp file left, mode kept, content complete", async () => {
    writeJobs([job("a")]);
    fs.chmodSync(jobsPath, 0o600);
    const { saveJobs, loadJobsResult } = await load();
    saveJobs([job("a"), job("b")]);
    const left = fs.readdirSync(path.dirname(jobsPath)).sort();
    expect(left).toEqual(["jobs.json", "jobs.lastgood.json"]);
    expect(fs.statSync(jobsPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(lastGoodPath).mode & 0o777).toBe(0o600); // the mirror is never looser
    const r = loadJobsResult();
    expect(r.ok && r.jobs.map((j) => j.id)).toEqual(["a", "b"]);
  });

  it("(d) a failed write leaves the old file intact and no temp file", async () => {
    const before = writeJobs([job("a"), job("b")]);
    const { saveJobs } = await load();
    vi.spyOn(fs, "writeSync").mockImplementation(() => {
      throw new Error("ENOSPC: simulated disk full");
    });
    expect(() => saveJobs([job("x")])).toThrow(/ENOSPC/);
    expect(fs.readFileSync(jobsPath, "utf-8")).toBe(before);
    expect(fs.readdirSync(path.dirname(jobsPath)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("scheduler + reconciler on an invalid file", () => {
  it("(a) keep the live schedule across a watcher reload and a reconciler tick", async () => {
    writeJobs([job("a"), job("b")]);
    vi.resetModules();
    const sched = await import("../scheduler.js");
    const { tickReconciler } = await import("../reconciler.js");
    try {
      expect(sched.reloadSchedulerFromFile()).toEqual({ ok: true, count: 2 });
      const live = sched.getScheduledSignature();
      expect(live).not.toBe("");

      fs.writeFileSync(jobsPath, BROKEN);
      expect(sched.reloadSchedulerFromFile()).toEqual({ ok: false });
      expect(sched.getScheduledSignature()).toBe(live);
      expect(tickReconciler()).toBe(false);
      expect(sched.getScheduledSignature()).toBe(live);

      // Recovery: a good edit is picked up by the next tick.
      writeJobs([job("a"), job("b"), job("c")]);
      expect(tickReconciler()).toBe(true);
      expect(sched.getScheduledSignature()).not.toBe(live);
    } finally {
      sched.stopScheduler();
    }
  });

  it("setCronJobEnabled refuses and leaves the file byte-identical", async () => {
    writeJobs([job("a")]);
    vi.resetModules();
    const sched = await import("../scheduler.js");
    const { JobsFileInvalidError } = await import("../jobs.js");
    try {
      sched.reloadSchedulerFromFile();
      fs.writeFileSync(jobsPath, BROKEN);
      expect(() => sched.setCronJobEnabled("a", false)).toThrow(JobsFileInvalidError);
      expect(fs.readFileSync(jobsPath, "utf-8")).toBe(BROKEN);
    } finally {
      sched.stopScheduler();
    }
  });
});
