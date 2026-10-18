import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Capture the env the Claude fork hands its CLI child; nothing is really run.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => '{"session_id":"forked-1"}\n'),
}));
vi.mock("../../shared/ops-alert.js", () => ({ opsAlert: vi.fn().mockResolvedValue(undefined) }));

import { execFileSync } from "node:child_process";
import { forkClaudeSession } from "../fork.js";
import { setT0NamesFileForTests } from "../../shared/cleanEnv.js";

let tmpDir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-env-"));
  const globs = path.join(tmpDir, "t0-names.txt");
  fs.writeFileSync(globs, "*_SSH_PASSWORD\n*SUDO*PASSWORD*\n");
  setT0NamesFileForTests(globs);
  // Planted fakes only.
  process.env.FAKE_X_SSH_PASSWORD = "fake-ssh-value-111";
  process.env.FAKE_BOX_SUDO_PASSWORD = "fake-sudo-value-222";
  process.env.FAKE_KEEP_ME = "keep-333";
  vi.mocked(execFileSync).mockClear();
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  setT0NamesFileForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("forkClaudeSession child env", () => {
  it("drops planted T0 names and keeps ordinary ones", () => {
    expect(forkClaudeSession("orig-1", tmpDir)).toEqual({ engineSessionId: "forked-1" });
    expect(execFileSync).toHaveBeenCalledTimes(1);
    const env = (vi.mocked(execFileSync).mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(env.FAKE_KEEP_ME).toBe("keep-333");
    expect(Object.keys(env)).not.toContain("FAKE_X_SSH_PASSWORD");
    expect(Object.keys(env)).not.toContain("FAKE_BOX_SUDO_PASSWORD");
  });
});
