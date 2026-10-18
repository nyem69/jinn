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
  compileGlob,
  excludeClaudeCodeAndCodex,
  setT0NamesFileForTests,
  t0MatchingNames,
} from "../cleanEnv.js";
import { runPrecheck } from "../../cron/precheck.js";
import { runShellHook } from "../../hooks/shell.js";
import { probeServer } from "../../mcp/probe.js";
import { resolveMcpServers } from "../../mcp/resolver.js";

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

describe("compileGlob", () => {
  it("is anchored, case-sensitive, and * matches any run including empty", () => {
    const m = compileGlob("MYSQL_153_*PASSWORD");
    expect(m("MYSQL_153_PASSWORD")).toBe(true);
    expect(m("MYSQL_153_ROOT_PASSWORD")).toBe(true);
    expect(m("MYSQL_153_USER")).toBe(false);
    expect(m("X_MYSQL_153_PASSWORD")).toBe(false);
    expect(m("mysql_153_password")).toBe(false);
  });

  it("handles leading, trailing and repeated stars", () => {
    const m = compileGlob("*SSH*PASSWORD*");
    expect(m("SSH_10_0_0_1_PASSWORD")).toBe(true);
    expect(m("PLUS_DRIVE_SSH_PASSWORD")).toBe(true);
    expect(m("FAKE_SSH_PASSWORD_OLD")).toBe(true);
    expect(m("FAKE_SSH_HOST")).toBe(false);
    expect(m("PASSWORD_SSH")).toBe(false);
    expect(compileGlob("A**B")("AB")).toBe(true);
    expect(compileGlob("EXACT")("EXACT")).toBe(true);
    expect(compileGlob("EXACT")("EXACTX")).toBe(false);
    // Prefix and suffix may not overlap: "AB*BA" needs at least "ABBA".
    expect(compileGlob("AB*BA")("ABA")).toBe(false);
    expect(compileGlob("AB*BA")("ABBA")).toBe(true);
    // A middle segment must fit between prefix and suffix.
    expect(compileGlob("A*BC*D")("ABCD")).toBe(true);
    expect(compileGlob("A*CD*D")("ACD")).toBe(false);
  });

  it("treats regex metacharacters literally", () => {
    expect(compileGlob("A.B")("AxB")).toBe(false);
  });

  it("stays linear on a many-star glob (no backtracking)", () => {
    // 9 stars on a 40-char name: a `.*`-per-star RegExp takes ~2 s per test here.
    writeGlobs("S*S*S*S*S*S*S*S*S*X\n");
    const name = "S".repeat(40);
    const t = Date.now();
    for (let i = 0; i < 3; i++) expect(t0MatchingNames({ [name]: "" })).toEqual([]);
    expect(Date.now() - t).toBeLessThan(500);
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

  it("picks up a chmod that makes an unreadable globs file readable", () => {
    if (process.getuid?.() === 0) return; // root reads mode-000 files
    const file = writeGlobs(GLOBS);
    fs.chmodSync(file, 0o000);
    expect(buildCleanEnv().FAKE_X_SSH_PASSWORD).toBe("fake-ssh-value-111");
    // Same content, same mtime and size: only ctime moves.
    const later = Date.now() + 5;
    while (Date.now() < later) { /* make sure ctime differs */ }
    fs.chmodSync(file, 0o644);
    expect(buildCleanEnv()).not.toHaveProperty("FAKE_X_SSH_PASSWORD");
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

  it("MCP probe (the server's configured env still layered on top)", async () => {
    writeGlobs(GLOBS);
    // A stand-in MCP server: reads the probe's stdin, answers tools/list with its env NAMES.
    const script =
      "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify(" +
      "{jsonrpc:'2.0',id:2,result:{tools:Object.keys(process.env).map((name)=>({name}))}})))";
    const r = await probeServer({ command: process.execPath, args: ["-e", script], env: { FAKE_SERVER_ENV: "1" } });
    const names = (r.tools ?? []).map((t) => t.name);
    expect(names).toContain("FAKE_KEEP_ME");
    expect(names).toContain("FAKE_SERVER_ENV");
    expect(names).not.toContain("FAKE_X_SSH_PASSWORD");
    expect(names).not.toContain("FAKE_BOX_SUDO_PASSWORD");
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

describe("MCP config never interpolates a T0 name", () => {
  it("leaves ${T0_NAME} unresolved in a custom server env and resolves ordinary names", () => {
    writeGlobs(GLOBS);
    const { mcpServers } = resolveMcpServers({
      browser: { enabled: false },
      gateway: { enabled: false },
      custom: {
        planted: {
          command: "true",
          env: { A: "${FAKE_X_SSH_PASSWORD}", B: "$FAKE_BOX_SUDO_PASSWORD", C: "${FAKE_KEEP_ME}" },
        },
      },
    } as any);
    const env = (mcpServers.planted as { env: Record<string, string> }).env;
    expect(env.C).toBe("keep-333");
    expect(JSON.stringify(mcpServers)).not.toContain("fake-ssh-value-111");
    expect(JSON.stringify(mcpServers)).not.toContain("fake-sudo-value-222");
    const warned = vi.mocked(logger.warn).mock.calls.map((c) => c[0]).join("\n");
    expect(warned).toContain("FAKE_X_SSH_PASSWORD");
    expect(warned).not.toContain("fake-ssh-value-111");
  });
});
