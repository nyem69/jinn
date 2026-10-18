import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type {
  Connector,
  Engine,
  EngineResult,
  EngineRunOpts,
  IncomingMessage,
  JinnConfig,
} from "../../shared/types.js";

// End-to-end coverage of SessionManager's Claude usage-limit branch (the
// `if (rateLimit.limited)` block after engine.run), driven through the public
// route() entry point the cron runner uses. Per-test temp JINN_HOME +
// vi.resetModules() so the registry DB lands in the temp dir.

// Fire-and-forget HTTP calls to the local gateway — never hit the network.
vi.mock("../callbacks.js", () => ({
  notifyParentSession: vi.fn(),
  notifyRateLimited: vi.fn(),
  notifyRateLimitResumed: vi.fn(),
  notifyDiscordChannel: vi.fn(),
}));

// buildContext scans org/skills/projects dirs (some outside JINN_HOME); the
// system prompt is irrelevant here.
vi.mock("../context.js", () => ({
  buildContext: vi.fn(() => "test system prompt"),
}));

// validateServers spawns MCP servers to probe tools/list.
vi.mock("../../mcp/validate.js", () => ({
  validateServers: vi.fn(async () => ({ servers: {}, quarantined: [] })),
}));

const LIMIT_TEXT = "You've hit your session limit · resets 9:50pm";

// What ClaudeEngine returns when the CLI emits a rejected rate_limit_event
// (engines/claude.ts buildEngineResultFromResultEvent + formatClaudeError).
// Case (d) covers the bare CLI text with no rate_limit_event.
const LIMITED = {
  error: `Claude usage limit reached: ${LIMIT_TEXT}`,
  rateLimit: { status: "rejected" },
} as const;

let tmpHome: string;
let originalHome: string | undefined;

async function freshHome(): Promise<void> {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jin-manager-limit-"));
  fs.mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });
  originalHome = process.env.JINN_HOME;
  process.env.JINN_HOME = tmpHome;

  vi.resetModules();
  const { initDb, migrateSessionsSchema } = await import("../registry.js");
  const { initEventsSchema } = await import("../../events/db.js");
  const { initHandlerRegistry } = await import("../../events/handlers.js");
  const { initCheckpointsSchema } = await import("../checkpoint.js");
  const db = initDb();
  migrateSessionsSchema(db);
  initEventsSchema(db);
  initHandlerRegistry(db);
  initCheckpointsSchema(db);
}

function cleanupHome(): void {
  if (originalHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = originalHome;
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
}

function makeConfig(): JinnConfig {
  return {
    gateway: { port: 0, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-6.1-sol" },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "error" },
    sessions: { rateLimitStrategy: "fallback" },
  } as JinnConfig;
}

function makeConnector(): Connector {
  return {
    name: "cron",
    start: async () => {},
    stop: async () => {},
    getCapabilities: () => ({ reactions: false }) as ReturnType<Connector["getCapabilities"]>,
    getHealth: () => ({ status: "running" }) as ReturnType<Connector["getHealth"]>,
    reconstructTarget: (ctx) => ({ channel: String((ctx as Record<string, unknown> | null)?.channel ?? "test") }),
    sendMessage: async () => {},
    replyMessage: async () => {},
    addReaction: async () => {},
    removeReaction: async () => {},
    editMessage: async () => {},
    onMessage: () => {},
  };
}

function makeMessage(source: string, sessionKey: string): IncomingMessage {
  return {
    connector: "cron",
    source,
    sessionKey,
    replyContext: { channel: "job-1", messageTs: null },
    messageId: undefined,
    channel: "job-1",
    thread: undefined,
    user: "system",
    userId: "system",
    text: "do the job",
    attachments: [],
    raw: {},
    transportMeta: source === "cron" ? { cronJobId: "job-1", sessionBudget: { maxTurns: 300, sideEffects: false } } : {},
  } as IncomingMessage;
}

async function setup(claudeResult: Partial<EngineResult>) {
  const { SessionManager } = await import("../manager.js");
  const { getSession } = await import("../registry.js");

  const claudeRun = vi.fn(async (_opts: EngineRunOpts): Promise<EngineResult> => ({
    sessionId: "cl1",
    result: "",
    ...claudeResult,
  }));
  const codexRun = vi.fn(async (_opts: EngineRunOpts): Promise<EngineResult> => ({
    sessionId: "cx1",
    result: "ok",
  }));
  const engines = new Map<string, Engine>([
    ["claude", { name: "claude", run: claudeRun }],
    ["codex", { name: "codex", run: codexRun }],
  ]);
  const manager = new SessionManager(makeConfig(), engines, []);
  const connector = makeConnector();
  manager.setConnectorProvider(() => new Map([["cron", connector]]));
  return { manager, connector, claudeRun, codexRun, getSession };
}

describe("SessionManager — Claude usage-limit branch", () => {
  beforeEach(async () => {
    await freshHome();
  });

  afterEach(() => {
    cleanupHome();
  });

  it("(a) cron run that already did work stops: no codex fallback, error + LIMIT_AFTER_WORK_PREFIX, cost kept", async () => {
    const { LIMIT_AFTER_WORK_PREFIX } = await import("../budget.js");
    const { manager, connector, claudeRun, codexRun, getSession } = await setup({
      ...LIMITED,
      cost: 0.5,
      numTurns: 3,
    });

    const res = await manager.route(makeMessage("cron", "cron:job-1:1"), connector, {
      engine: "claude",
      model: "sonnet",
      title: "job-1",
    });

    expect(res?.sessionId).toBeTruthy();
    expect(claudeRun).toHaveBeenCalledTimes(1);
    expect(codexRun).not.toHaveBeenCalled();

    const row = getSession(res!.sessionId)!;
    expect(row.status).toBe("error");
    expect(row.lastError?.startsWith(LIMIT_AFTER_WORK_PREFIX)).toBe(true);
    expect(row.lastError).toContain("usage limit");
    expect(row.totalCost).toBeCloseTo(0.5, 6);
    expect(row.engine).toBe("claude");
  });

  it("(b) cron run rejected before any work falls back to codex with the codex model, not 'sonnet'", async () => {
    const { manager, connector, claudeRun, codexRun, getSession } = await setup({
      ...LIMITED,
      cost: 0,
      numTurns: 1,
    });

    const res = await manager.route(makeMessage("cron", "cron:job-1:2"), connector, {
      engine: "claude",
      model: "sonnet",
      title: "job-1",
    });

    expect(claudeRun).toHaveBeenCalledTimes(1);
    expect(claudeRun.mock.calls[0][0].model).toBe("sonnet");
    expect(codexRun).toHaveBeenCalledTimes(1);
    expect(codexRun.mock.calls[0][0].model).toBe("gpt-6.1-sol");

    const row = getSession(res!.sessionId)!;
    expect(row.engine).toBe("codex");
    expect(row.status).toBe("idle");
    expect(row.model).toBe("sonnet");
  });

  it("(c) interactive session that did work still falls back to codex with the codex model", async () => {
    const { manager, connector, codexRun, getSession } = await setup({
      ...LIMITED,
      cost: 0.5,
      numTurns: 3,
    });

    const res = await manager.route(makeMessage("web", "web:abc"), connector, {
      engine: "claude",
      model: "sonnet",
    });

    expect(codexRun).toHaveBeenCalledTimes(1);
    expect(codexRun.mock.calls[0][0].model).toBe("gpt-6.1-sol");

    const row = getSession(res!.sessionId)!;
    expect(row.engine).toBe("codex");
    expect(row.status).toBe("idle");
    // The limited Claude run's own usage is still counted.
    expect(row.totalCost).toBeCloseTo(0.5, 6);
  });
  it("(d) the bare CLI quota text with no rate_limit_event still reaches the limit branch", async () => {
    const { LIMIT_AFTER_WORK_PREFIX } = await import("../budget.js");
    const { manager, connector, codexRun, getSession } = await setup({ error: LIMIT_TEXT, cost: 0.5, numTurns: 3 });

    const res = await manager.route(makeMessage("cron", "cron:job-4:4"), connector, {
      engine: "claude",
      model: "sonnet",
      title: "job-4",
    });

    expect(codexRun).not.toHaveBeenCalled();
    const row = getSession(res!.sessionId)!;
    expect(row.lastError?.startsWith(LIMIT_AFTER_WORK_PREFIX)).toBe(true);
    expect(row.lastError).toContain("usage limit");
  });
});
