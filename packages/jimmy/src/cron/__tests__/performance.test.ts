import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { cronStatusToOutcome, recordCronPerformance } from "../performance.js";

// Same shape as the live registry.db table (CHECKs included).
function makeDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE performance_log (
    id TEXT PRIMARY KEY,
    employee TEXT NOT NULL,
    department TEXT NOT NULL,
    task_type TEXT NOT NULL,
    task_ref TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'blocked')),
    quality TEXT CHECK (quality IN ('poor', 'fair', 'good', 'excellent')),
    score REAL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  return db;
}

describe("cronStatusToOutcome", () => {
  it("maps run-log statuses onto the CHECK set", () => {
    expect(cronStatusToOutcome("success")).toBe("succeeded");
    expect(cronStatusToOutcome("session_budget_stop")).toBe("blocked");
    expect(cronStatusToOutcome("error")).toBe("failed");
    expect(cronStatusToOutcome("precheck_error")).toBe("failed");
    expect(cronStatusToOutcome("session_timeout")).toBe("failed");
  });
  it("does not record a healthy precheck skip", () => {
    expect(cronStatusToOutcome("gated-skip")).toBeNull();
  });
  it("treats an unknown status as a failure, not a success", () => {
    expect(cronStatusToOutcome("something-new")).toBe("failed");
    expect(cronStatusToOutcome(undefined)).toBe("failed");
  });
});

describe("recordCronPerformance", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("writes one cron row with job name, employee and notes", () => {
    const wrote = recordCronPerformance(db, "j1", { name: "daily-sitrep", employee: "jin" }, {
      status: "success",
      sessionId: "s-1",
      durationMs: 1234,
    });
    expect(wrote).toBe(true);
    const row = db.prepare("SELECT * FROM performance_log").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      employee: "jin",
      department: "cron",
      task_type: "cron",
      task_ref: "daily-sitrep",
      outcome: "succeeded",
      quality: null,
    });
    expect(JSON.parse(row.notes as string)).toEqual({ jobId: "j1", sessionId: "s-1", status: "success", durationMs: 1234 });
  });

  it("records failures with a truncated error", () => {
    recordCronPerformance(db, "j2", { name: "x", employee: "jin" }, {
      status: "session_timeout",
      error: "e".repeat(1000),
    });
    const row = db.prepare("SELECT outcome, notes FROM performance_log").get() as { outcome: string; notes: string };
    expect(row.outcome).toBe("failed");
    expect(JSON.parse(row.notes).error).toHaveLength(300);
  });

  it("records a budget stop as blocked", () => {
    recordCronPerformance(db, "j3", { name: "x", employee: "jin" }, { status: "session_budget_stop" });
    expect((db.prepare("SELECT outcome FROM performance_log").get() as { outcome: string }).outcome).toBe("blocked");
  });

  it("skips gated-skip entirely", () => {
    expect(recordCronPerformance(db, "j4", { name: "x", employee: "jin" }, { status: "gated-skip" })).toBe(false);
    expect((db.prepare("SELECT COUNT(*) n FROM performance_log").get() as { n: number }).n).toBe(0);
  });

  it("falls back when the job is gone from jobs.json", () => {
    recordCronPerformance(db, "orphan-id", undefined, { status: "error" });
    const row = db.prepare("SELECT employee, task_ref FROM performance_log").get();
    expect(row).toEqual({ employee: "unassigned", task_ref: "orphan-id" });
  });
});
