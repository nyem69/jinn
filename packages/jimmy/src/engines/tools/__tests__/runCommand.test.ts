import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCommandTool } from "../runCommand.js";
import type { ToolExecutionContext } from "../types.js";
import type { JsonObject, JsonValue } from "../../../shared/types.js";

let jail: string;
let ctx: ToolExecutionContext;

beforeEach(async () => {
  jail = await fs.mkdtemp(path.join(os.tmpdir(), "runcmd-test-"));
  ctx = { cwd: jail };
});

afterEach(async () => {
  await fs.rm(jail, { recursive: true, force: true });
});

function withBashOpts(overrides: Record<string, JsonValue>): ToolExecutionContext {
  return { cwd: jail, toolOpts: { bash: overrides as JsonObject } };
}

// ─── Disabled / allowlist ────────────────────────────────────────────

describe("runCommand: tool disabled", () => {
  it("returns disabled when no toolOpts at all", async () => {
    const r = await runCommandTool({ command: "echo", args: ["hi"] }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("disabled");
  });

  it("returns disabled when bashAllowlist is empty", async () => {
    const r = await runCommandTool(
      { command: "echo", args: ["hi"] },
      withBashOpts({ allowlist: [] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("disabled");
  });
});

describe("runCommand: allowlist gate", () => {
  it("rejects argv[0] not in allowlist", async () => {
    const r = await runCommandTool(
      { command: "rm", args: ["-rf", "/"] },
      withBashOpts({ allowlist: ["echo"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("not_in_allowlist");
  });

  it("accepts argv[0] in allowlist (basename matches)", async () => {
    const r = await runCommandTool(
      { command: "echo", args: ["hello"] },
      withBashOpts({ allowlist: ["echo"] }),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("hello");
    expect(r.audit.exit_code).toBe(0);
  });

  it("matches by basename when command is an absolute path", async () => {
    const r = await runCommandTool(
      { command: "/bin/echo", args: ["abs"] },
      withBashOpts({ allowlist: ["echo"] }),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("abs");
  });
});

// ─── Hardcoded NEVER-LIST ────────────────────────────────────────────

describe("runCommand: shell + bypass blocklist (never overridable)", () => {
  it.each([
    "sh", "bash", "zsh", "fish", "ksh", "csh", "tcsh", "dash", "ash",
    "env", "xargs", "eval", "exec", "source",
  ])("blocks %s even when explicitly allowlisted", async (name) => {
    const r = await runCommandTool(
      { command: name, args: [] },
      withBashOpts({ allowlist: [name] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("shell_blocked");
  });

  it("blocks /bin/bash by basename, not full path", async () => {
    const r = await runCommandTool(
      { command: "/bin/bash", args: ["-c", "echo pwned"] },
      withBashOpts({ allowlist: ["bash"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("shell_blocked");
  });

  it("blocks env even though env+arg looks innocuous", async () => {
    const r = await runCommandTool(
      { command: "env", args: ["PATH=/bin", "echo", "hi"] },
      withBashOpts({ allowlist: ["env", "echo"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("shell_blocked");
  });
});

// ─── Metacharacter rejection ────────────────────────────────────────

describe("runCommand: shell metacharacters rejected upfront", () => {
  const metas = [";", "|", "&", "`", "$", ">", "<", "\n", "\r", "\t", "*", "?", "~", "(", ")", "{", "}", "\\", "[", "]", "!"];
  it.each(metas)("rejects %j in args[0]", async (ch) => {
    const r = await runCommandTool(
      { command: "echo", args: [`hi${ch}there`] },
      withBashOpts({ allowlist: ["echo"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("metacharacter");
  });

  it("rejects NUL byte in command", async () => {
    const r = await runCommandTool(
      { command: "echo\0", args: [] },
      withBashOpts({ allowlist: ["echo"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("metacharacter");
  });

  it("rejects shell-injection attempt via args", async () => {
    const r = await runCommandTool(
      { command: "echo", args: ["hi; rm -rf /"] },
      withBashOpts({ allowlist: ["echo"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("metacharacter");
  });
});

// ─── Python wrapper restrictions ─────────────────────────────────────

describe("runCommand: python3 restrictions", () => {
  it("rejects python3 -c (inline code execution)", async () => {
    // Use a metachar-free code string so the python3-flag check fires
    // before the metachar check, isolating this assertion to the -c gate.
    const r = await runCommandTool(
      { command: "python3", args: ["-c", "pass"] },
      withBashOpts({ allowlist: ["python3"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("python3_unsafe_args");
  });

  it("rejects python3 -c even when code contains metacharacters (either gate is acceptable)", async () => {
    const r = await runCommandTool(
      { command: "python3", args: ["-c", "print('x')"] },
      withBashOpts({ allowlist: ["python3"] }),
    );
    expect(r.ok).toBe(false);
    expect(["python3_unsafe_args", "metacharacter"]).toContain(r.audit.error);
  });

  it("rejects python3 -m <module>", async () => {
    const r = await runCommandTool(
      { command: "python3", args: ["-m", "http.server"] },
      withBashOpts({ allowlist: ["python3"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("python3_unsafe_args");
  });

  it("rejects python3 with stdin (bare -)", async () => {
    const r = await runCommandTool(
      { command: "python3", args: ["-"] },
      withBashOpts({ allowlist: ["python3"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("python3_unsafe_args");
  });

  it("rejects python3 with no positional script", async () => {
    const r = await runCommandTool(
      { command: "python3", args: [] },
      withBashOpts({ allowlist: ["python3"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("python3_no_script");
  });

  it("rejects python3 with a script path that escapes the cwd jail", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "runcmd-outside-"));
    try {
      const scriptPath = path.join(outside, "evil.py");
      await fs.writeFile(scriptPath, "print('pwned')");
      const r = await runCommandTool(
        { command: "python3", args: [scriptPath] },
        withBashOpts({ allowlist: ["python3"] }),
      );
      expect(r.ok).toBe(false);
      expect(r.audit.error).toBe("lexical_escape");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects python3 with a script that doesn't exist", async () => {
    const r = await runCommandTool(
      { command: "python3", args: ["does-not-exist.py"] },
      withBashOpts({ allowlist: ["python3"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("python3_script_missing");
  });

  it("accepts python3 with a script that exists under cwd", async () => {
    await fs.writeFile(path.join(jail, "ok.py"), "print('done')");
    const r = await runCommandTool(
      { command: "python3", args: ["ok.py"] },
      withBashOpts({ allowlist: ["python3"] }),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("done");
  });

  it("allows non-banned flags before the script (e.g. -O)", async () => {
    await fs.writeFile(path.join(jail, "ok.py"), "print('opt')");
    const r = await runCommandTool(
      { command: "python3", args: ["-O", "ok.py"] },
      withBashOpts({ allowlist: ["python3"] }),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("opt");
  });
});

// ─── Exit code propagation ───────────────────────────────────────────

describe("runCommand: exit codes", () => {
  it("ok=false on nonzero exit", async () => {
    // `false` exits 1; needs to be on allowlist.
    const r = await runCommandTool(
      { command: "false", args: [] },
      withBashOpts({ allowlist: ["false"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.exit_code).toBe(1);
    expect(r.audit.error).toBe("nonzero_exit");
    expect(r.audit.timeout).toBe(false);
  });

  it("ok=true on exit 0", async () => {
    const r = await runCommandTool(
      { command: "true", args: [] },
      withBashOpts({ allowlist: ["true"] }),
    );
    expect(r.ok).toBe(true);
    expect(r.audit.exit_code).toBe(0);
    expect(r.audit.error).toBeUndefined();
  });

  it("ok=false on spawn ENOENT (command not found on PATH)", async () => {
    const r = await runCommandTool(
      { command: "definitely-not-a-real-binary-xyz", args: [] },
      withBashOpts({ allowlist: ["definitely-not-a-real-binary-xyz"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("ENOENT");
  });
});

// ─── Truncation (separate stdout/stderr) ─────────────────────────────

describe("runCommand: truncation", () => {
  it("truncates stdout independently of stderr", async () => {
    await fs.writeFile(
      path.join(jail, "noisy.py"),
      "import sys; sys.stdout.write('o' * 50000); sys.stderr.write('e' * 5000); sys.exit(0)",
    );
    const r = await runCommandTool(
      { command: "python3", args: ["noisy.py"] },
      withBashOpts({ allowlist: ["python3"], maxStdout: 32000, maxStderr: 16000 }),
    );
    expect(r.ok).toBe(true);
    expect(r.audit.truncated_stdout).toBe(true);
    expect(r.audit.truncated_stderr).toBe(false);
    expect(r.audit.truncated).toBe(true); // OR
    expect(r.audit.original_stdout_bytes).toBe(50000);
    expect(r.audit.original_stderr_bytes).toBe(5000);
    expect(r.content).toMatch(/stdout capped at 32000 of 50000 bytes/);
  });

  it("truncates stderr independently when stderr is the noisy one", async () => {
    await fs.writeFile(
      path.join(jail, "noisy.py"),
      "import sys; sys.stdout.write('o' * 1000); sys.stderr.write('e' * 30000); sys.exit(0)",
    );
    const r = await runCommandTool(
      { command: "python3", args: ["noisy.py"] },
      withBashOpts({ allowlist: ["python3"], maxStdout: 32000, maxStderr: 16000 }),
    );
    expect(r.audit.truncated_stdout).toBe(false);
    expect(r.audit.truncated_stderr).toBe(true);
    expect(r.audit.truncated).toBe(true);
    expect(r.content).toMatch(/stderr capped at 16000 of 30000 bytes/);
  });

  it("no truncation flags when output fits under caps", async () => {
    const r = await runCommandTool(
      { command: "echo", args: ["short"] },
      withBashOpts({ allowlist: ["echo"] }),
    );
    expect(r.audit.truncated).toBe(false);
    expect(r.audit.truncated_stdout).toBe(false);
    expect(r.audit.truncated_stderr).toBe(false);
  });
});

// ─── Timeout + kill ──────────────────────────────────────────────────

describe("runCommand: timeout + SIGTERM/SIGKILL", () => {
  it("times out at perCallTimeoutMs and reports timeout=true", async () => {
    await fs.writeFile(
      path.join(jail, "loop.py"),
      "import time\nwhile True: time.sleep(1)\n",
    );
    const r = await runCommandTool(
      { command: "python3", args: ["loop.py"] },
      withBashOpts({
        allowlist: ["python3"],
        perCallTimeoutMs: 300,
        killGraceMs: 100,
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("timeout");
    expect(r.audit.timeout).toBe(true);
    expect(r.audit.signal === "SIGTERM" || r.audit.signal === "SIGKILL").toBe(true);
    expect(r.content).toMatch(/timed out after 300ms/);
  });

  it("escalates SIGTERM → SIGKILL when the process ignores SIGTERM", async () => {
    // Trap SIGTERM and keep running; only SIGKILL can stop it.
    await fs.writeFile(
      path.join(jail, "stubborn.py"),
      [
        "import signal, time",
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
        "while True:",
        "    time.sleep(0.1)",
      ].join("\n") + "\n",
    );
    const r = await runCommandTool(
      { command: "python3", args: ["stubborn.py"] },
      withBashOpts({
        allowlist: ["python3"],
        perCallTimeoutMs: 200,
        killGraceMs: 200,
      }),
    );
    expect(r.audit.timeout).toBe(true);
    expect(r.audit.signal).toBe("SIGKILL");
  });
});

// ─── Audit row shape ─────────────────────────────────────────────────

describe("runCommand: audit row shape", () => {
  it("includes command + summarized args + duration", async () => {
    const r = await runCommandTool(
      { command: "echo", args: ["one", "two"] },
      withBashOpts({ allowlist: ["echo"] }),
    );
    expect(r.audit.command).toBe("echo");
    expect(r.audit.args).toEqual(["one", "two"]);
    expect(typeof r.audit.duration_ms).toBe("number");
    expect(r.audit.exit_code).toBe(0);
    expect(r.audit.signal).toBeNull();
  });

  it("truncates very long args in the audit row", async () => {
    const long = "x".repeat(500);
    const r = await runCommandTool(
      { command: "echo", args: [long] },
      withBashOpts({ allowlist: ["echo"] }),
    );
    const args = r.audit.args as string[];
    expect(args[0]!.length).toBeLessThan(300);
    expect(args[0]).toMatch(/more chars/);
  });
});

// ─── Bad arg shapes ──────────────────────────────────────────────────

describe("runCommand: bad arg shapes", () => {
  it("rejects missing command", async () => {
    const r = await runCommandTool({} as JsonObject, withBashOpts({ allowlist: ["echo"] }));
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("bad_args");
  });

  it("rejects non-array args", async () => {
    const r = await runCommandTool(
      { command: "echo", args: "hi" } as unknown as JsonObject,
      withBashOpts({ allowlist: ["echo"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("bad_args");
  });

  it("rejects non-string elements inside args", async () => {
    const r = await runCommandTool(
      { command: "echo", args: ["ok", 42 as unknown as string] },
      withBashOpts({ allowlist: ["echo"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("bad_args");
  });
});
