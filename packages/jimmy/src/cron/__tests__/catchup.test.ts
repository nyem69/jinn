import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeMissedFires,
  checkpointFloor,
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

  it("defers (does not replay) a fire still inside the grace window", () => {
    const { replay, deferred } = computeMissedFires([job({})], {
      ...DEFAULTS,
      now: ms("2026-06-03T01:00:30Z"), // 30s after fire, < 90s grace
      lastCheck: ms("2026-06-03T00:30:00Z"),
      lastRunAt: () => null,
    });
    expect(replay).toHaveLength(0);
    // Reported, not dropped — the checkpoint must be held back behind it.
    expect(deferred).toHaveLength(1);
    expect(deferred[0].scheduledFor).toBe(PREV_FIRE);
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

/**
 * The grace window defers a decision; the checkpoint must not bury it. These
 * drive two consecutive sweeps and assert both failure modes stay closed:
 * a fire the sleeping host never ran IS replayed, and one node-cron ran on time
 * is NOT (the 2026-06-07 sitrep double-fire).
 */
describe("a fire deferred by the grace window, across two sweeps", () => {
  // Host wakes 30s after the 01:00 fire — inside the 90s grace.
  const WAKE = ms("2026-06-03T01:00:30Z");
  const NEXT_SWEEP = ms("2026-06-03T01:05:30Z"); // reconciler tick, 5 min later

  function firstSweep() {
    const r = computeMissedFires([job({})], {
      ...DEFAULTS,
      now: WAKE,
      lastCheck: ms("2026-06-03T00:30:00Z"),
      lastRunAt: () => null, // node-cron slept through it
    });
    return { ...r, checkpoint: checkpointFloor(WAKE, r.deferred) };
  }

  it("holds the checkpoint behind the deferred fire instead of advancing to now", () => {
    const { checkpoint } = firstSweep();
    expect(checkpoint).toBe(PREV_FIRE - 1);
    // The bug: advancing to `now` would make prevFire <= lastCheck next sweep.
    expect(checkpoint).toBeLessThan(PREV_FIRE);
  });

  it("replays the fire on the next sweep when the host slept through it", () => {
    const { checkpoint } = firstSweep();
    const { replay } = computeMissedFires([job({})], {
      ...DEFAULTS,
      now: NEXT_SWEEP, // grace has now passed
      lastCheck: checkpoint,
      lastRunAt: () => null, // still never ran
    });
    expect(replay).toHaveLength(1);
    expect(replay[0].scheduledFor).toBe(PREV_FIRE);
  });

  it("does NOT replay when node-cron fired it on time (no double-fire)", () => {
    const { checkpoint } = firstSweep();
    const { replay } = computeMissedFires([job({})], {
      ...DEFAULTS,
      now: NEXT_SWEEP,
      lastCheck: checkpoint, // reconsidered — but the run-log now vetoes it
      lastRunAt: () => ms("2026-06-03T01:00:02Z"),
    });
    expect(replay).toHaveLength(0);
  });
});

describe("checkpointFloor", () => {
  it("returns now when nothing was deferred", () => {
    expect(checkpointFloor(NOW, [])).toBe(NOW);
  });

  it("clamps to just before the EARLIEST deferred fire", () => {
    const early = ms("2026-06-03T01:00:00Z");
    const late = ms("2026-06-03T01:30:00Z");
    const floor = checkpointFloor(NOW, [
      { job: job({ id: "late" }), scheduledFor: late },
      { job: job({ id: "early" }), scheduledFor: early },
    ]);
    expect(floor).toBe(early - 1);
  });

  it("never advances the checkpoint past now", () => {
    const future = NOW + 60_000;
    expect(
      checkpointFloor(NOW, [{ job: job({}), scheduledFor: future }]),
    ).toBe(NOW);
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
