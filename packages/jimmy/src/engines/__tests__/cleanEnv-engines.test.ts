import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Capture the env each engine hands its CLI child; nothing is really spawned.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
vi.mock("../../shared/ops-alert.js", () => ({ opsAlert: vi.fn().mockResolvedValue(undefined) }));

import { spawn } from "node:child_process";
import { ClaudeEngine } from "../claude.js";
import { CodexEngine } from "../codex.js";
import { GeminiEngine } from "../gemini.js";
import { setT0NamesFileForTests } from "../../shared/cleanEnv.js";

const mockSpawn = vi.mocked(spawn);

function failingProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.pid = 4242;
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn();
  setImmediate(() => proc.emit("error", new Error("planted spawn failure")));
  return proc;
}

async function childEnvOf(run: () => Promise<unknown>): Promise<Record<string, string>> {
  await expect(run()).rejects.toThrow(/planted spawn failure/);
  expect(mockSpawn).toHaveBeenCalledTimes(1);
  return (mockSpawn.mock.calls[0][2] as { env: Record<string, string> }).env;
}

let tmpDir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t0-engines-"));
  const file = path.join(tmpDir, "t0-names.txt");
  fs.writeFileSync(file, "*_SSH_PASSWORD\n*SUDO*PASSWORD*\n");
  setT0NamesFileForTests(file);
  Object.assign(process.env, {
    FAKE_X_SSH_PASSWORD: "fake-ssh-value-111",
    FAKE_BOX_SUDO_PASSWORD: "fake-sudo-value-222",
    FAKE_KEEP_ME: "keep-333",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CODEX_HOME: "/tmp/fake-codex",
  });
  mockSpawn.mockReset().mockImplementation((() => failingProcess()) as any);
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  setT0NamesFileForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const opts = { prompt: "hi", cwd: os.tmpdir() };

describe("engine child env — T0 strip + per-engine exclusions", () => {
  it("claude", async () => {
    const env = await childEnvOf(() => new ClaudeEngine().run({ ...opts }));
    expect(env).not.toHaveProperty("FAKE_X_SSH_PASSWORD");
    expect(env).not.toHaveProperty("FAKE_BOX_SUDO_PASSWORD");
    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(env.FAKE_KEEP_ME).toBe("keep-333");
    expect(env.CODEX_HOME).toBe("/tmp/fake-codex");
  });

  it("codex", async () => {
    const env = await childEnvOf(() => new CodexEngine().run({ ...opts }));
    expect(env).not.toHaveProperty("FAKE_X_SSH_PASSWORD");
    expect(env).not.toHaveProperty("FAKE_BOX_SUDO_PASSWORD");
    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(env).not.toHaveProperty("CODEX_HOME");
    expect(env.FAKE_KEEP_ME).toBe("keep-333");
  });

  it("gemini", async () => {
    const env = await childEnvOf(() => new GeminiEngine().run({ ...opts }));
    expect(env).not.toHaveProperty("FAKE_X_SSH_PASSWORD");
    expect(env).not.toHaveProperty("FAKE_BOX_SUDO_PASSWORD");
    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(env.FAKE_KEEP_ME).toBe("keep-333");
    expect(env.CODEX_HOME).toBe("/tmp/fake-codex");
  });
});
