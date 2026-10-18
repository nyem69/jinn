import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

// R9 #2: POST/PUT/DELETE /api/cron refuse with 409 while cron/jobs.json is
// invalid and leave the file byte-identical. Before the fix, POST loaded []
// and wrote [newJob] over every live job. Driven through handleApiRequest
// with a temp JINN_HOME (fresh modules per test so paths.ts picks it up).

const { opsAlert, reloadScheduler } = vi.hoisted(() => ({
  opsAlert: vi.fn().mockResolvedValue(undefined),
  reloadScheduler: vi.fn(),
}));
vi.mock("../../shared/ops-alert.js", () => ({ opsAlert }));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../cron/scheduler.js", () => ({ reloadScheduler }));
vi.mock("../../sessions/registry.js", async (orig) => ({
  ...(await orig<typeof import("../../sessions/registry.js")>()),
  listSessions: () => [],
}));

const SECRET = "FAKE_PROMPT_SECRET_VALUE";
const BROKEN = `[\n  {"id": "a", "name": "a", "prompt": "${SECRET}"},\n  oops\n]\n`;

let tmpHome: string;
let originalHome: string | undefined;
let jobsPath: string;

function fakeReq(method: string, url: string, body?: unknown, onRead?: () => void): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(
    (function* () {
      onRead?.();
      yield* chunks;
    })(),
  ) as unknown as IncomingMessage;
  Object.assign(req, { method, url, headers: { host: "localhost" } });
  return req;
}

function fakeRes(): ServerResponse & { status: number; body: unknown } {
  const res = {
    status: 0,
    body: undefined as unknown,
    writeHead(status: number) {
      res.status = status;
      return res;
    },
    setHeader() {},
    end(data?: string) {
      res.body = data ? JSON.parse(data) : undefined;
    },
  };
  return res as unknown as ServerResponse & { status: number; body: unknown };
}

async function call(method: string, url: string, body?: unknown, onRead?: () => void) {
  const { handleApiRequest } = await import("../api.js");
  const res = fakeRes();
  const context = {
    config: {},
    getConfig: () => ({ gateway: { port: 7777 }, engines: { default: "claude" } }),
    connectors: new Map(),
    engines: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
  };
  await handleApiRequest(fakeReq(method, url, body, onRead), res, context as never);
  return res;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jin-cron-api-guard-"));
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

describe("/api/cron writes on an invalid jobs.json", () => {
  it("(b) POST, PUT and DELETE answer 409 and leave the file byte-identical", async () => {
    fs.writeFileSync(jobsPath, JSON.stringify([{ id: "a", name: "a", enabled: true, schedule: "0 3 * * *" }]));
    expect((await call("GET", "/api/cron")).status).toBe(200); // gateway had a good load
    fs.writeFileSync(jobsPath, BROKEN);

    for (const [method, url, body] of [
      ["POST", "/api/cron", { name: "new-job", schedule: "0 * * * *", prompt: "x" }],
      ["PUT", "/api/cron/a", { enabled: false }],
      ["DELETE", "/api/cron/a", undefined],
    ] as const) {
      const res = await call(method, url, body);
      expect(res.status, `${method} ${url}`).toBe(409);
      expect(res.body).toMatchObject({ reason: "parse" });
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
      expect(fs.readFileSync(jobsPath, "utf-8")).toBe(BROKEN);
    }
    expect(reloadScheduler).not.toHaveBeenCalled();

    // Read-only GET still serves the last-good set rather than [].
    const list = await call("GET", "/api/cron");
    expect((list.body as Array<{ id: string }>).map((j) => j.id)).toEqual(["a"]);
  });

  it("PUT reads the file after the body: a file broken mid-request is refused, not overwritten", async () => {
    fs.writeFileSync(jobsPath, JSON.stringify([{ id: "a", name: "a", enabled: true, schedule: "0 3 * * *" }]));
    const res = await call("PUT", "/api/cron/a", { enabled: false }, () => fs.writeFileSync(jobsPath, BROKEN));
    expect(res.status).toBe(409);
    expect(fs.readFileSync(jobsPath, "utf-8")).toBe(BROKEN);
    expect(reloadScheduler).not.toHaveBeenCalled();
  });

  it("POST still appends on a valid file, atomically", async () => {
    fs.writeFileSync(jobsPath, JSON.stringify([{ id: "a", name: "a", enabled: true, schedule: "0 3 * * *" }]));
    const res = await call("POST", "/api/cron", { id: "b", name: "b", schedule: "0 * * * *" });
    expect(res.status).toBe(201);
    const saved = JSON.parse(fs.readFileSync(jobsPath, "utf-8")) as Array<{ id: string }>;
    expect(saved.map((j) => j.id)).toEqual(["a", "b"]);
    expect(fs.readdirSync(path.dirname(jobsPath)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("GET /api/status reports jobsFile", async () => {
    fs.writeFileSync(jobsPath, "[]");
    expect((await call("GET", "/api/status")).body).toMatchObject({ jobsFile: { ok: true, invalidSince: null } });
    fs.writeFileSync(jobsPath, BROKEN);
    const body = (await call("GET", "/api/status")).body as { jobsFile: Record<string, unknown> };
    expect(body.jobsFile).toMatchObject({ ok: false, reason: "parse" });
    expect(typeof body.jobsFile.invalidSince).toBe("string");
    expect(JSON.stringify(body.jobsFile)).not.toContain(SECRET);
  });
});
