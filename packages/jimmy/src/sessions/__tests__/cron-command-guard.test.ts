import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Connector, IncomingMessage, JinnConfig } from "../../shared/types.js";

// R9 #2: `/cron enable|disable` on an invalid cron/jobs.json replies with the
// reason (no file content) and leaves the file byte-identical. Driven through
// SessionManager.handleCommand with a temp JINN_HOME.

const { opsAlert } = vi.hoisted(() => ({ opsAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../shared/ops-alert.js", () => ({ opsAlert }));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SECRET = "FAKE_PROMPT_SECRET_VALUE";
const BROKEN = `[\n  {"id": "a", "name": "a", "prompt": "${SECRET}"},\n  oops\n]\n`;

let tmpHome: string;
let originalHome: string | undefined;
let jobsPath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jin-cron-command-guard-"));
  fs.mkdirSync(path.join(tmpHome, "cron"), { recursive: true });
  jobsPath = path.join(tmpHome, "cron", "jobs.json");
  originalHome = process.env.JINN_HOME;
  process.env.JINN_HOME = tmpHome;
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("/cron disable on an invalid jobs.json", () => {
  it("replies with the reason, leaks no content and does not touch the file", async () => {
    fs.writeFileSync(jobsPath, JSON.stringify([{ id: "a", name: "a", enabled: true, schedule: "0 3 * * *" }]));
    const { loadJobsResult } = await import("../../cron/jobs.js");
    loadJobsResult(); // the gateway had a good load
    fs.writeFileSync(jobsPath, BROKEN);

    const { SessionManager } = await import("../manager.js");
    const manager = new SessionManager({ engines: { default: "claude" } } as JinnConfig, new Map(), []);
    const replyMessage = vi.fn(async () => {});
    const connector = {
      reconstructTarget: () => ({ channel: "test" }),
      replyMessage,
    } as unknown as Connector;
    const msg = { text: "/cron disable a", replyContext: {}, sessionKey: "k" } as unknown as IncomingMessage;

    expect(await manager.handleCommand(msg, connector)).toBe(true);
    expect(replyMessage).toHaveBeenCalledTimes(1);
    const reply = String((replyMessage.mock.calls[0] as unknown[])[1]);
    expect(reply).toMatch(/^Not changed: cron\/jobs\.json is invalid \(parse: .*line 3 column 3\)/);
    expect(reply).not.toContain(SECRET);
    expect(fs.readFileSync(jobsPath, "utf-8")).toBe(BROKEN);
  });
});
