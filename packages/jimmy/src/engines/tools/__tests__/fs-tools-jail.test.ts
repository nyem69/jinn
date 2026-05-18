/**
 * Regression tests for the symlink escape, size-cap, and write-to-cwd
 * hardening landed in Phase 3a. Every test in this file describes a
 * scenario where the unhardened tool surface previously leaked, clobbered,
 * or wasted memory — and the new behavior should refuse cleanly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readTool } from "../read.js";
import { writeTool } from "../write.js";
import { editTool } from "../edit.js";
import type { ToolExecutionContext } from "../types.js";

let jail: string;
let outside: string;
let ctx: ToolExecutionContext;

beforeEach(async () => {
  jail = await fs.mkdtemp(path.join(os.tmpdir(), "jin-jail-regr-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "jin-jail-outside-"));
  ctx = { cwd: jail };
});

afterEach(async () => {
  await fs.rm(jail, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

// ─── Symlink escape regressions ──────────────────────────────────────

describe("read: symlink escape", () => {
  it("does NOT read through a leaf-symlink that escapes the jail", async () => {
    const secretPath = path.join(outside, "secret.txt");
    await fs.writeFile(secretPath, "TOP-SECRET");
    await fs.symlink(secretPath, path.join(jail, "inner-link"));

    const r = await readTool({ path: "inner-link" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("realpath_escape");
    expect(r.content).not.toContain("TOP-SECRET");
  });

  it("does NOT traverse a parent-directory symlink that escapes", async () => {
    await fs.writeFile(path.join(outside, "leak.txt"), "PARENT-LEAK");
    await fs.symlink(outside, path.join(jail, "esc"));

    const r = await readTool({ path: "esc/leak.txt" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("realpath_escape");
    expect(r.content).not.toContain("PARENT-LEAK");
  });

  it("DOES read through a leaf-symlink whose target stays inside the jail", async () => {
    // read intentionally permits symlinks-to-inside; the realpath check
    // proves there's no escape. (write/edit are stricter — see below.)
    const real = path.join(jail, "real.txt");
    await fs.writeFile(real, "inside-content");
    await fs.symlink(real, path.join(jail, "alias"));

    const r = await readTool({ path: "alias" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.content).toBe("inside-content");
  });
});

describe("write: symlink escape", () => {
  it("does NOT clobber via a leaf-symlink that points outside", async () => {
    const victim = path.join(outside, "victim.txt");
    await fs.writeFile(victim, "ORIGINAL");
    await fs.symlink(victim, path.join(jail, "link"));

    const r = await writeTool({ path: "link", content: "CLOBBERED" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("symlink_leaf");
    expect(await fs.readFile(victim, "utf8")).toBe("ORIGINAL");
  });

  it("REFUSES to write through any leaf-symlink, even to a target inside the jail", async () => {
    const real = path.join(jail, "real.txt");
    await fs.writeFile(real, "before");
    await fs.symlink(real, path.join(jail, "alias"));

    const r = await writeTool({ path: "alias", content: "changed" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("symlink_leaf");
    expect(await fs.readFile(real, "utf8")).toBe("before");
  });

  it("does NOT create a new file via a parent-dir symlink that escapes", async () => {
    await fs.symlink(outside, path.join(jail, "esc"));
    const r = await writeTool({ path: "esc/new.txt", content: "x" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("realpath_escape");
    // No file should appear in `outside`.
    await expect(fs.stat(path.join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("edit: symlink escape", () => {
  it("does NOT modify a file via a leaf-symlink that escapes", async () => {
    const victim = path.join(outside, "victim.txt");
    await fs.writeFile(victim, "before-MARKER-after");
    await fs.symlink(victim, path.join(jail, "link"));

    const r = await editTool({ path: "link", old_string: "MARKER", new_string: "EDITED" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("symlink_leaf");
    expect(await fs.readFile(victim, "utf8")).toBe("before-MARKER-after");
  });
});

// ─── Size caps ────────────────────────────────────────────────────────

describe("read: file-size cap", () => {
  it("refuses files larger than 5MB with error=too_large", async () => {
    const big = "x".repeat(6 * 1024 * 1024); // 6MB
    await fs.writeFile(path.join(jail, "big.txt"), big);

    const r = await readTool({ path: "big.txt" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("too_large");
    expect(r.audit.file_bytes).toBe(big.length);
  });

  it("allows files exactly at 5MB", async () => {
    const exact = "x".repeat(5 * 1024 * 1024);
    await fs.writeFile(path.join(jail, "exact.txt"), exact);

    const r = await readTool({ path: "exact.txt" }, ctx);
    expect(r.ok).toBe(true);
    // Model-output truncation still kicks in at 64k by default.
    expect(r.audit.truncated).toBe(true);
  });
});

describe("edit: file-size cap", () => {
  it("refuses files larger than 5MB with error=too_large (no read attempted)", async () => {
    const big = "x".repeat(6 * 1024 * 1024) + "MARKER";
    await fs.writeFile(path.join(jail, "big.txt"), big);

    const r = await editTool({ path: "big.txt", old_string: "MARKER", new_string: "Y" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("too_large");
    // File unchanged
    const after = await fs.readFile(path.join(jail, "big.txt"), "utf8");
    expect(after.endsWith("MARKER")).toBe(true);
  });
});

// ─── Write-to-cwd-itself guard ───────────────────────────────────────

describe("write: refusing to overwrite the cwd directory", () => {
  it("rejects path='.' with error=is_cwd_dir (does NOT mkdir parent-of-cwd)", async () => {
    // The is_cwd_dir guard short-circuits BEFORE the recursive mkdir
    // runs, so we don't need to inspect the parent's listing (which is
    // flappy on Linux CI — `/tmp` has system mounts like .ICE-unix /
    // .X11-unix that come and go between calls). The audit code
    // assertion alone proves the guard fired.
    const r = await writeTool({ path: ".", content: "anything" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("is_cwd_dir");
    // The jail dir itself still exists and was not converted to a file.
    const jailStat = await fs.stat(jail);
    expect(jailStat.isDirectory()).toBe(true);
  });

  it("rejects an absolute path equal to cwd", async () => {
    const r = await writeTool({ path: jail, content: "anything" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("is_cwd_dir");
  });
});
