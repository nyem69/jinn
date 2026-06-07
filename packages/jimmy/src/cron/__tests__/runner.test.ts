import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCronJob } from "../runner.js";
import type { CronJob, Connector, JinnConfig } from "../../shared/types.js";

// Stub appendRunLog so we don't touch the filesystem
vi.mock("../jobs.js", () => ({
  appendRunLog: vi.fn(),
}));

// Stub org scanning
vi.mock("../../gateway/org.js", () => ({
  scanOrg: vi.fn(() => []),
  findEmployee: vi.fn(),
}));

// Stub logger
vi.mock("../../shared/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// Stub the precheck gate (its own exit-code logic is unit-tested in precheck.test.ts);
// here we control its decision to assert how runCronJob branches.
vi.mock("../precheck.js", () => ({ runPrecheck: vi.fn() }));

// Stub ops alert so a precheck_error doesn't try to reach Telegram.
vi.mock("../../shared/ops-alert.js", () => ({ opsAlert: vi.fn().mockResolvedValue(undefined) }));

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "test-job",
    name: "Test Job",
    enabled: true,
    schedule: "0 * * * *",
    prompt: "do something",
    ...overrides,
  };
}

function makeConfig(overrides: Partial<JinnConfig["cron"]> = {}): JinnConfig {
  return {
    engines: { default: "claude", claude: { model: "opus" } },
    logging: { file: false, stdout: false, level: "info" },
    cron: {
      alertConnector: "slack",
      alertChannel: "#cron-alerts",
      ...overrides,
    },
  } as JinnConfig;
}

function makeMockConnector(): Connector {
  return {
    name: "slack",
    sendMessage: vi.fn().mockResolvedValue(undefined),
    replyMessage: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as Connector;
}

function makeMockSessionManager(delayMs = 0) {
  return {
    route: vi.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ sessionId: "sess-123" }), delayMs),
        ),
    ),
  } as any;
}

describe("runCronJob — latency alerting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a Slack alert when job duration exceeds alertThresholdMs", async () => {
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    // Session takes 200ms, threshold is 100ms → should alert
    const sessionManager = makeMockSessionManager(200);
    const config = makeConfig({ alertThresholdMs: 100 });

    await runCronJob(makeJob(), sessionManager, config, connectors);

    expect(connector.sendMessage).toHaveBeenCalledWith(
      { channel: "#cron-alerts" },
      expect.stringContaining("Test Job"),
    );
    // Alert message should mention the duration
    const alertCall = (connector.sendMessage as any).mock.calls[0];
    expect(alertCall[1]).toMatch(/slow|latency|exceeded/i);
  });

  it("does NOT alert when job completes within alertThresholdMs", async () => {
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    // Session takes ~0ms, threshold is 5000ms → no alert
    const sessionManager = makeMockSessionManager(0);
    const config = makeConfig({ alertThresholdMs: 5000 });

    await runCronJob(makeJob(), sessionManager, config, connectors);

    expect(connector.sendMessage).not.toHaveBeenCalled();
  });

  it("does NOT alert when alertThresholdMs is not configured", async () => {
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    const sessionManager = makeMockSessionManager(0);
    const config = makeConfig(); // no alertThresholdMs

    await runCronJob(makeJob(), sessionManager, config, connectors);

    expect(connector.sendMessage).not.toHaveBeenCalled();
  });

  it("still logs success even when latency alert fires", async () => {
    const { appendRunLog } = await import("../jobs.js");
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    const sessionManager = makeMockSessionManager(200);
    const config = makeConfig({ alertThresholdMs: 100 });

    await runCronJob(makeJob(), sessionManager, config, connectors);

    expect(appendRunLog).toHaveBeenCalledWith(
      "test-job",
      expect.objectContaining({ status: "success" }),
    );
  });

  it("records catch-up metadata in the run-log when replayed", async () => {
    const { appendRunLog } = await import("../jobs.js");
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);
    const config = makeConfig();

    await runCronJob(makeJob(), sessionManager, config, connectors, {
      catchUp: true,
      scheduledFor: "2026-06-01T06:00:00.000Z",
      olderFiresSkipped: 2,
    });

    expect(appendRunLog).toHaveBeenCalledWith(
      "test-job",
      expect.objectContaining({
        status: "success",
        catchUp: true,
        scheduledFor: "2026-06-01T06:00:00.000Z",
        olderFiresSkipped: 2,
      }),
    );
  });

  it("omits catch-up fields on a normal (non-replayed) run", async () => {
    const { appendRunLog } = await import("../jobs.js");
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);
    const sessionManager = makeMockSessionManager(0);
    const config = makeConfig();

    await runCronJob(makeJob(), sessionManager, config, connectors);

    const entry = (appendRunLog as any).mock.calls.at(-1)[1];
    expect(entry.catchUp).toBeUndefined();
    expect(entry.scheduledFor).toBeUndefined();
  });

  it("does not double-alert on failure (only failure alert, not latency)", async () => {
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);
    const sessionManager = {
      route: vi.fn().mockRejectedValue(new Error("API exploded")),
    } as any;
    const config = makeConfig({ alertThresholdMs: 1 });

    await runCronJob(makeJob(), sessionManager, config, connectors);

    // Should only get the failure alert, not a latency alert
    expect(connector.sendMessage).toHaveBeenCalledTimes(1);
    const alertMsg = (connector.sendMessage as any).mock.calls[0][1];
    expect(alertMsg).toContain("failed");
  });
});

describe("runCronJob — precheck gate", () => {
  beforeEach(async () => {
    // Clear accumulated call history on the module-mocked fns and re-arm async ones.
    const { runPrecheck } = await import("../precheck.js");
    const { opsAlert } = await import("../../shared/ops-alert.js");
    const { appendRunLog } = await import("../jobs.js");
    (runPrecheck as any).mockReset();
    (opsAlert as any).mockReset().mockResolvedValue(undefined);
    (appendRunLog as any).mockClear();
  });

  const withPrecheck = (overrides = {}) =>
    makeJob({ precheck: { command: "x", skipExitCodes: [10] }, ...overrides });

  it("spawns the session when precheck decides proceed", async () => {
    const { runPrecheck } = await import("../precheck.js");
    (runPrecheck as any).mockResolvedValue({ decision: "proceed", exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", durationMs: 5 });
    const sessionManager = makeMockSessionManager(0);
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);

    await runCronJob(withPrecheck(), sessionManager, makeConfig(), connectors);

    expect(sessionManager.route).toHaveBeenCalledTimes(1);
  });

  it("does NOT spawn a session on skip, and logs gated-skip (no alert)", async () => {
    const { appendRunLog } = await import("../jobs.js");
    const { runPrecheck } = await import("../precheck.js");
    const { opsAlert } = await import("../../shared/ops-alert.js");
    (runPrecheck as any).mockResolvedValue({ decision: "skip", exitCode: 10, signal: null, timedOut: false, stdout: "", stderr: "", durationMs: 5 });
    const sessionManager = makeMockSessionManager(0);
    const connector = makeMockConnector();
    const connectors = new Map<string, Connector>([["slack", connector]]);

    await runCronJob(withPrecheck(), sessionManager, makeConfig(), connectors);

    expect(sessionManager.route).not.toHaveBeenCalled();
    expect(opsAlert).not.toHaveBeenCalled();
    expect(connector.sendMessage).not.toHaveBeenCalled();
    expect(appendRunLog).toHaveBeenCalledWith(
      "test-job",
      expect.objectContaining({ status: "gated-skip" }),
    );
  });

  it("does NOT spawn a session on precheck error, logs precheck_error AND ops-alerts", async () => {
    const { appendRunLog } = await import("../jobs.js");
    const { runPrecheck } = await import("../precheck.js");
    const { opsAlert } = await import("../../shared/ops-alert.js");
    (runPrecheck as any).mockResolvedValue({ decision: "error", exitCode: 21, signal: null, timedOut: false, stdout: "", stderr: "wacli down", durationMs: 5 });
    const sessionManager = makeMockSessionManager(0);
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);

    await runCronJob(withPrecheck(), sessionManager, makeConfig(), connectors);

    expect(sessionManager.route).not.toHaveBeenCalled();
    expect(opsAlert).toHaveBeenCalledTimes(1);
    expect(appendRunLog).toHaveBeenCalledWith(
      "test-job",
      expect.objectContaining({ status: "precheck_error" }),
    );
  });

  it("treats a precheck timeout as an error (no session)", async () => {
    const { runPrecheck } = await import("../precheck.js");
    const { opsAlert } = await import("../../shared/ops-alert.js");
    (runPrecheck as any).mockResolvedValue({ decision: "error", exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "", stderr: "", durationMs: 60000 });
    const sessionManager = makeMockSessionManager(0);
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);

    await runCronJob(withPrecheck(), sessionManager, makeConfig(), connectors);

    expect(sessionManager.route).not.toHaveBeenCalled();
    expect(opsAlert).toHaveBeenCalledTimes(1);
  });

  it("ignores precheck entirely for jobs without a precheck field (backward compat)", async () => {
    const { runPrecheck } = await import("../precheck.js");
    const sessionManager = makeMockSessionManager(0);
    const connectors = new Map<string, Connector>([["slack", makeMockConnector()]]);

    await runCronJob(makeJob(), sessionManager, makeConfig(), connectors);

    expect(runPrecheck).not.toHaveBeenCalled();
    expect(sessionManager.route).toHaveBeenCalledTimes(1);
  });
});
