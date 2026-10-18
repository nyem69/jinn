import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../ops-alert.js", () => ({ opsAlert: vi.fn().mockResolvedValue(undefined) }));

import { logger } from "../logger.js";
import { opsAlert } from "../ops-alert.js";
import {
  buildCleanEnv,
  checkT0AtBoot,
  excludeClaudeCode,
  excludeClaudeCodeAndCodex,
  globToRegExp,
  setT0NamesFileForTests,
  t0MatchingNames,
} from "../cleanEnv.js";
import { runPrecheck } from "../../cron/precheck.js";
import { runShellHook } from "../../hooks/shell.js";

// Planted fakes only — never a real name from ~/.jinn/.env.
const PLANTED: Record<string, string> = {
  FAKE_X_SSH_PASSWORD: "fake-ssh-value-111",
  FAKE_BOX_SUDO_PASSWORD: "fake-sudo-value-222",
  FAKE_KEEP_ME: "keep-333",
  FAKE_SSH_HOST: "10.0.0.1",
};
const GLOBS = "# test globs\n*_SSH_PASSWORD\n\n*SUDO*PASSWORD*\n";

let tmpDir: string;
let savedEnv: NodeJS.ProcessEnv;

function writeGlobs(text: string): string {
  const file = path.join(tmpDir, "t0-names.txt");
  fs.writeFileSync(file, text);
  setT0NamesFileForTests(file);
  return file;
}

beforeEach(() => {
  savedEnv = { ...process.env };
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t0-names-"));
  Object.assign(process.env, PLANTED);
  vi.mocked(opsAlert).mockClear();
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  setT0NamesFileForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("globToRegExp", () => {
  it("is anchored, case-sensitive, and * matches any run including empty", () => {
    const re = globToRegExp("MYSQL_153_*PASSWORD");
    expect(re.test("MYSQL_153_PASSWORD")).toBe(true);
    expect(re.test("MYSQL_153_ROOT_PASSWORD")).toBe(true);
    expect(re.test("MYSQL_153_USER")).toBe(false);
    expect(re.test("X_MYSQL_153_PASSWORD")).toBe(false);
    expect(re.test("mysql_153_password")).toBe(false);
  });

  it("treats regex metacharacters literally", () => {
    expect(globToRegExp("A.B").test("AxB")).toBe(false);
  });
});

describe("buildCleanEnv — T0 strip", () => {
  it("drops planted T0 names and keeps ordinary names", () => {
    writeGlobs(GLOBS);
    const env = buildCleanEnv();
    expect(env).not.toHaveProperty("FAKE_X_SSH_PASSWORD");
    expect(env).not.toHaveProperty("FAKE_BOX_SUDO_PASSWORD");
    expect(env.FAKE_KEEP_ME).toBe("keep-333");
    expect(env.FAKE_SSH_HOST).toBe("10.0.0.1");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("keeps the CLAUDE_CODE_* / CODEX_* exclusions exactly as before", () => {
    writeGlobs(GLOBS);
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    process.env.CODEX = "1";
    process.env.CODEX_HOME = "/tmp/x";
    process.env.CLAUDE_CONFIG_DIR = "/tmp/c"; // not CLAUDE_CODE_* → kept

    const claude = buildCleanEnv(excludeClaudeCode);
    expect(claude).not.toHaveProperty("CLAUDECODE");
    expect(claude).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(claude.CODEX).toBe("1");
    expect(claude.CODEX_HOME).toBe("/tmp/x");
    expect(claude.CLAUDE_CONFIG_DIR).toBe("/tmp/c");

    const codex = buildCleanEnv(excludeClaudeCodeAndCodex);
    expect(codex).not.toHaveProperty("CLAUDECODE");
    expect(codex).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(codex).not.toHaveProperty("CODEX");
    expect(codex).not.toHaveProperty("CODEX_HOME");

    // No caller exclusion (prechecks): only the T0 strip applies.
    const plain = buildCleanEnv();
    expect(plain.CLAUDECODE).toBe("1");
    expect(plain.CODEX_HOME).toBe("/tmp/x");
    expect(plain).not.toHaveProperty("FAKE_X_SSH_PASSWORD");
  });

  it("re-reads the globs file when it changes", () => {
    const file = writeGlobs("*_SSH_PASSWORD\n");
    expect(buildCleanEnv().FAKE_BOX_SUDO_PASSWORD).toBe("fake-sudo-value-222");
    fs.writeFileSync(file, GLOBS); // different size → new cache key
    expect(buildCleanEnv()).not.toHaveProperty("FAKE_BOX_SUDO_PASSWORD");
  });

  it("ignores malformed and all-star lines, reporting line numbers only", () => {
    writeGlobs("*_SSH_PASSWORD\nFAKE_KEEP_ME=keep-333\n*\n");
    const env = buildCleanEnv();
    expect(env).not.toHaveProperty("FAKE_X_SSH_PASSWORD");
    expect(env.FAKE_KEEP_ME).toBe("keep-333");
    expect(env.PATH).toBe(process.env.PATH);
    const warned = vi.mocked(logger.warn).mock.calls.map((c) => c[0]).join("\n");
    expect(warned).toContain("line(s) 2, 3");
    expect(warned).not.toContain("keep-333");
  });

  it("fails open when the globs file is missing: warns, does not throw, strips nothing extra", () => {
    setT0NamesFileForTests(path.join(tmpDir, "absent.txt"));
    let env: Record<string, string> = {};
    expect(() => { env = buildCleanEnv(excludeClaudeCode); }).not.toThrow();
    expect(env.FAKE_X_SSH_PASSWORD).toBe("fake-ssh-value-111");
    expect(env.FAKE_KEEP_ME).toBe("keep-333");
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining("T0 env guard OFF"));
    // One warning per state change, not per spawn.
    buildCleanEnv();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });
});

// The boot check reads a planted env: the developer's own shell env is not ours to assert on.
describe("checkT0AtBoot", () => {
  it("alerts once, naming only the matching names", async () => {
    writeGlobs(GLOBS);
    expect(t0MatchingNames({ ...PLANTED })).toEqual(["FAKE_BOX_SUDO_PASSWORD", "FAKE_X_SSH_PASSWORD"]);
    await checkT0AtBoot({ ...PLANTED });
    expect(opsAlert).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(opsAlert).mock.calls[0][0];
    expect(msg).toContain("FAKE_X_SSH_PASSWORD");
    expect(msg).toContain("FAKE_BOX_SUDO_PASSWORD");
    expect(msg).not.toContain("FAKE_KEEP_ME");
    for (const v of Object.values(PLANTED)) expect(msg).not.toContain(v);
  });

  it("stays quiet when the gateway env is clean", async () => {
    writeGlobs(GLOBS);
    await checkT0AtBoot({ FAKE_KEEP_ME: "keep-333", FAKE_SSH_HOST: "10.0.0.1" });
    expect(opsAlert).not.toHaveBeenCalled();
  });

  it("alerts once and does not throw when the globs file is missing", async () => {
    setT0NamesFileForTests(path.join(tmpDir, "absent.txt"));
    await expect(checkT0AtBoot({ ...PLANTED })).resolves.toBeUndefined();
    expect(opsAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(opsAlert).mock.calls[0][0]).toContain("T0 env guard OFF");
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining("T0 env guard OFF"));
  });

  it("treats a file with no globs as the guard being off", async () => {
    writeGlobs("# nothing here\n\n");
    await checkT0AtBoot({ ...PLANTED });
    expect(opsAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(opsAlert).mock.calls[0][0]).toContain("no globs");
  });
});

// Real child processes: the child lists its env NAMES (never values).
const NAMES_CMD = "env | cut -d= -f1";

describe("children really lack the planted T0 names", () => {
  it("cron precheck", async () => {
    writeGlobs(GLOBS);
    const r = await runPrecheck({ command: NAMES_CMD }, { cwd: process.cwd() });
    expect(r.decision).toBe("proceed");
    const names = r.stdout.split("\n");
    expect(names).toContain("FAKE_KEEP_ME");
    expect(names).not.toContain("FAKE_X_SSH_PASSWORD");
    expect(names).not.toContain("FAKE_BOX_SUDO_PASSWORD");
  });

  it("cron precheck still honours an explicit env override", async () => {
    writeGlobs(GLOBS);
    const r = await runPrecheck(
      { command: NAMES_CMD },
      { cwd: process.cwd(), env: { PATH: process.env.PATH, FAKE_EXPLICIT: "1" } },
    );
    expect(r.stdout.split("\n")).toContain("FAKE_EXPLICIT");
  });

  it("shell hook (hook-specific vars still layered on top)", async () => {
    writeGlobs(GLOBS);
    const out = await runShellHook(NAMES_CMD, {}, { HOOK_EVENT: "test" }, 10_000);
    const names = (out ?? "").split("\n");
    expect(names).toContain("FAKE_KEEP_ME");
    expect(names).toContain("HOOK_EVENT");
    expect(names).not.toContain("FAKE_X_SSH_PASSWORD");
    expect(names).not.toContain("FAKE_BOX_SUDO_PASSWORD");
  });
});
