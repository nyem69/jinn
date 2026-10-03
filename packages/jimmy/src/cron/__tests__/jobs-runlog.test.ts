import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-runlog-"));
vi.mock("../../shared/paths.js", () => ({
  CRON_JOBS: path.join(tmp, "jobs.json"),
  CRON_RUNS: path.join(tmp, "runs"),
}));
const recordSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../performance.js", () => ({ recordCronPerformanceSafe: recordSpy }));

describe("appendRunLog → performance_log hook", () => {
  it("appends the jsonl line and hands the entry + looked-up job to the recorder", async () => {
    fs.writeFileSync(path.join(tmp, "jobs.json"), JSON.stringify([{ id: "j1", name: "nightly", employee: "jin" }]));
    const { appendRunLog } = await import("../jobs.js");
    const entry = { status: "success", sessionId: "s1" };
    appendRunLog("j1", entry);
    expect(fs.readFileSync(path.join(tmp, "runs", "j1.jsonl"), "utf-8").trim()).toBe(JSON.stringify(entry));
    expect(recordSpy).toHaveBeenCalledWith("j1", expect.objectContaining({ name: "nightly", employee: "jin" }), entry);
  });
});
