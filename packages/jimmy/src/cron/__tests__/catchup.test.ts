import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeMissedFires,
  readCheckpoint,
  writeCheckpoint,
  lastRunAtFromDisk,
  mostRecentRun,
} from "../catchup.js";
import type { CronJob } from "../../shared/types.js";

function job(overrides: Partial<CronJob>): CronJob {
  return {
    id: "daily",
    name: "daily-job",
    enabled: true,
    schedule: "0 9 * * *", // 09:00 daily
    timezone: "Asia/Kuala_Lumpur", // = 01:00 UTC
    engine: "claude",
    model: "sonnet",
    employee: "jin",
    prompt: "do the thing",
    ...overrides,
  } as CronJob;
}

const ms = (iso: string) => Date.parse(iso);

// 09:00 MYT == 01:00 UTC. "now" = 10:00 MYT == 02:00 UTC.
const NOW = ms("2026-06-03T02:00:00Z");
const PREV_FIRE = ms("2026-06-03T01:00:00Z"); // today's 09:00 MYT

const DEFAULTS = {
  now: NOW,
  maxLookbackMs: 72 * 3600_000,
  graceMs: 90_000,
  dedupSlopMs: 60_000,
};

describe("computeMissedFires", () => {
  it("replays a fire slept through (never ran) exactly once", () => {
    const { replay, tooOld } = computeMissedFires([job({})], {
      ...DEFAULTS,
      lastCheck: ms("2026-06-03T00:30:00Z"),
      lastRunAt: () => null,
    });
    expect(tooOld).toHaveLength(0);
    expect(replay).toHaveLength(1);
    expect(replay[0].job.id).toBe("daily");
    expect(replay[0].scheduledFor).toBe(PREV_FIRE);
    expect(replay[0].olderFiresSkipped).toBe(0);
  });

  it("does not replay a fire that already ran on time", () => {
    const { replay } = computeMissedFires([job({})], {
      ...DEFAULTS,
      lastCheck: ms("2026-06-03T00:30:00Z"),
      lastRunAt: () => ms("2026-06-03T01:00:03Z"),
    });
    expect(replay).toHaveLength(0);
  });

  it("does not replay a fire already caught up by an earlier sweep", () => {
    const { replay } = computeMissedFires([job({})], {
      ...DEFAULTS,
      lastCheck: ms("2026-06-03T00:30:00Z"),
      lastRunAt: () => ms("2026-06-03T01:40:00Z"),
    });
    expect(replay).toHaveLength(0);
  });

  it("skips when nothing fired since the last sweep", () => {
    const { replay } = computeMissedFires([job({})], {
      ...DEFAULTS,
      lastCheck: ms("2026-06-03T01:30:00Z"), // after PREV_FIRE
      lastRunAt: () => null,
    });
    expect(replay).toHaveLength(0);
  });

  it("skips a fire still inside the grace window (lets node-cron handle it)", () => {
    const { replay } = computeMissedFires([job({})], {
      ...DEFAULTS,
      now: ms("2026-06-03T01:00:30Z"), // 30s after fire, < 90s grace
      lastCheck: ms("2026-06-03T00:30:00Z"),
      lastRunAt: () => null,
    });
    expect(replay).toHaveLength(0);
  });

  it("reports a fire older than the lookback window as tooOld, not replay", () => {
    const annual = job({ id: "annual", schedule: "0 9 1 6 *" }); // 09:00 MYT Jun 1
    const { replay, tooOld } = computeMissedFires([annual], {
      ...DEFAULTS,
      now: ms("2026-06-05T02:00:00Z"), // Jun 5 — >72h after Jun 1 fire
      lastCheck: ms("2026-05-01T00:00:00Z"),
      lastRunAt: () => null,
    });
    expect(replay).toHaveLength(0);
    expect(tooOld).toHaveLength(1);
    expect(tooOld[0].job.id).toBe("annual");
    expect(tooOld[0].scheduledFor).toBe(ms("2026-06-01T01:00:00Z"));
  });

  it("collapses multiple missed occurrences to the latest, counting the rest", () => {
    // lastCheck 74h before now -> window capped at now-72h. Daily fires at
    // 06-01, 06-02 (skipped) and 06-03 (the latest, replayed).
    const { replay } = computeMissedFires([job({})], {
      ...DEFAULTS,
      lastCheck: ms("2026-05-31T00:00:00Z"),
      lastRunAt: () => null,
    });
    expect(replay).toHaveLength(1);
    expect(replay[0].scheduledFor).toBe(PREV_FIRE);
    expect(replay[0].olderFiresSkipped).toBe(2);
  });

  it("never replays a job opted out with catchUp:false", () => {
    const { replay, tooOld } = computeMissedFires(
      [job({ catchUp: false } as Partial<CronJob>)],
      {
        ...DEFAULTS,
        lastCheck: ms("2026-06-03T00:30:00Z"),
        lastRunAt: () => null,
      },
    );
    expect(replay).toHaveLength(0);
    expect(tooOld).toHaveLength(0);
  });

  it("skips disabled jobs", () => {
    const { replay } = computeMissedFires([job({ enabled: false })], {
      ...DEFAULTS,
      lastCheck: ms("2026-06-03T00:30:00Z"),
      lastRunAt: () => null,
    });
    expect(replay).toHaveLength(0);
  });

  it("skips jobs with an invalid schedule without throwing", () => {
    const { replay } = computeMissedFires([job({ schedule: "not a cron" })], {
      ...DEFAULTS,
      lastCheck: ms("2026-06-03T00:30:00Z"),
      lastRunAt: () => null,
    });
    expect(replay).toHaveLength(0);
  });

  it("returns only the missed job among a mixed set", () => {
    const missed = job({ id: "missed" });
    const onTime = job({ id: "ontime" });
    const off = job({ id: "off", enabled: false });
    const { replay } = computeMissedFires([missed, onTime, off], {
      ...DEFAULTS,
      lastCheck: ms("2026-06-03T00:30:00Z"),
      lastRunAt: (id) => (id === "ontime" ? ms("2026-06-03T01:00:02Z") : null),
    });
    expect(replay.map((r) => r.job.id)).toEqual(["missed"]);
  });
});

describe("checkpoint persistence", () => {
  it("round-trips a checkpoint timestamp", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-")), "state.json");
    writeCheckpoint(file, 1780000000000);
    expect(readCheckpoint(file)).toBe(1780000000000);
  });

  it("returns null when no checkpoint file exists", () => {
    const file = path.join(os.tmpdir(), `cc-missing-${Math.floor(NOW)}.json`);
    expect(readCheckpoint(file)).toBeNull();
  });
});

describe("mostRecentRun", () => {
  it("returns the in-memory start when the disk log is empty", () => {
    // An on-time fire still running: nothing on disk yet, but a start is tracked.
    expect(mostRecentRun(null, ms("2026-06-03T01:00:00Z"))).toBe(
      ms("2026-06-03T01:00:00Z"),
    );
  });

  it("returns the disk run when there is no in-memory start", () => {
    // Fresh process (restart): in-memory map empty, fall back to the run-log.
    expect(mostRecentRun(ms("2026-06-03T01:00:00Z"), null)).toBe(
      ms("2026-06-03T01:00:00Z"),
    );
  });

  it("returns null when both are absent", () => {
    expect(mostRecentRun(null, null)).toBeNull();
  });

  it("prefers the more recent of the two", () => {
    const older = ms("2026-06-02T01:00:00Z");
    const newer = ms("2026-06-03T01:00:00Z");
    expect(mostRecentRun(older, newer)).toBe(newer);
    expect(mostRecentRun(newer, older)).toBe(newer);
  });

  it("dedups a long on-time fire whose disk log is still yesterday's run", () => {
    // The actual production bug: yesterday's completion on disk, today's fire
    // started but not yet logged. The merged value must clear the dedup gate so
    // computeMissedFires does NOT replay today's slot.
    const yesterdayOnDisk = ms("2026-06-02T01:00:03Z");
    const startedToday = ms("2026-06-03T01:00:01Z");
    const merged = mostRecentRun(yesterdayOnDisk, startedToday);
    const { replay } = computeMissedFires([job({})], {
      ...DEFAULTS,
      lastCheck: ms("2026-06-03T00:30:00Z"),
      lastRunAt: () => merged,
    });
    expect(replay).toHaveLength(0);
  });
});

describe("lastRunAtFromDisk", () => {
  it("returns the timestamp of the last run-log entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
    fs.writeFileSync(
      path.join(dir, "j1.jsonl"),
      JSON.stringify({ timestamp: "2026-06-03T01:00:00Z", status: "success" }) +
        "\n" +
        JSON.stringify({ timestamp: "2026-06-03T01:30:00Z", status: "success" }) +
        "\n",
    );
    expect(lastRunAtFromDisk("j1", dir)).toBe(ms("2026-06-03T01:30:00Z"));
  });

  it("returns null when no run-log exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
    expect(lastRunAtFromDisk("nope", dir)).toBeNull();
  });
});
