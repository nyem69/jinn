import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readTool } from "../read.js";
import { writeTool } from "../write.js";
import { editTool } from "../edit.js";
import type { ToolExecutionContext } from "../types.js";

let tmpDir: string;
let ctx: ToolExecutionContext;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jin-fs-tools-"));
  ctx = { cwd: tmpDir };
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── read ────────────────────────────────────────────────────────────

describe("tools/read", () => {
  it("reads a file and returns its content", async () => {
    await fs.writeFile(path.join(tmpDir, "a.txt"), "line1\nline2\nline3");
    const r = await readTool({ path: "a.txt" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.content).toBe("line1\nline2\nline3");
    expect(r.audit.truncated).toBe(false);
    expect(r.audit.total_lines).toBe(3);
    expect(r.audit.returned_lines).toBe(3);
  });

  it("applies 1-indexed offset", async () => {
    await fs.writeFile(path.join(tmpDir, "a.txt"), "a\nb\nc\nd\ne");
    const r = await readTool({ path: "a.txt", offset: 3 }, ctx);
    expect(r.content).toBe("c\nd\ne");
  });

  it("respects limit", async () => {
    await fs.writeFile(path.join(tmpDir, "a.txt"), "a\nb\nc\nd\ne");
    const r = await readTool({ path: "a.txt", offset: 2, limit: 2 }, ctx);
    expect(r.content).toBe("b\nc");
    expect(r.audit.returned_lines).toBe(2);
  });

  it("truncates when content exceeds maxChars and appends a marker", async () => {
    const big = "x".repeat(80_000);
    await fs.writeFile(path.join(tmpDir, "big.txt"), big);
    const r = await readTool({ path: "big.txt" }, ctx);
    expect(r.audit.truncated).toBe(true);
    expect(r.content.length).toBeGreaterThan(64_000);
    expect(r.content.length).toBeLessThan(64_500);
    expect(r.content).toMatch(/\[truncated: 64000 of 80000 characters\]/);
    expect(r.audit.originalBytes).toBe(80_000);
  });

  it("honors a per-engine maxChars override from ctx.toolOpts", async () => {
    await fs.writeFile(path.join(tmpDir, "a.txt"), "x".repeat(2000));
    const r = await readTool(
      { path: "a.txt" },
      { ...ctx, toolOpts: { read: { maxChars: 500 } } },
    );
    expect(r.audit.truncated).toBe(true);
    expect(r.content).toMatch(/\[truncated: 500 of 2000/);
  });

  it("returns ok:false with jail_violation on '..' escape", async () => {
    const r = await readTool({ path: "../escape.txt" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("jail_violation");
    expect(r.content).toMatch(/resolves outside of cwd jail/);
  });

  it("returns ok:false with ENOENT when file missing", async () => {
    const r = await readTool({ path: "nope.txt" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("ENOENT");
  });

  it("rejects non-string path with bad_args", async () => {
    const r = await readTool({ path: 42 as unknown as string }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("bad_args");
  });

  it("rejects negative offset with bad_args", async () => {
    await fs.writeFile(path.join(tmpDir, "a.txt"), "x");
    const r = await readTool({ path: "a.txt", offset: 0 }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("bad_args");
  });
});

// ─── write ───────────────────────────────────────────────────────────

describe("tools/write", () => {
  it("writes a new file under cwd", async () => {
    const r = await writeTool({ path: "new.txt", content: "hello" }, ctx);
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmpDir, "new.txt"), "utf8")).toBe("hello");
    expect(r.audit.bytes_written).toBe(5);
  });

  it("overwrites an existing file", async () => {
    await fs.writeFile(path.join(tmpDir, "x.txt"), "old");
    const r = await writeTool({ path: "x.txt", content: "new" }, ctx);
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmpDir, "x.txt"), "utf8")).toBe("new");
  });

  it("creates parent directories recursively under cwd", async () => {
    const r = await writeTool({ path: "a/b/c/file.txt", content: "nested" }, ctx);
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmpDir, "a/b/c/file.txt"), "utf8")).toBe("nested");
  });

  it("rejects jail escape", async () => {
    const r = await writeTool({ path: "../outside.txt", content: "x" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("jail_violation");
  });

  it("rejects missing content arg", async () => {
    // Cast through unknown because JsonObject's index signature is JsonValue;
    // the test intentionally passes an under-specified shape.
    const r = await writeTool({ path: "x.txt" } as unknown as Record<string, never>, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("bad_args");
  });

  it("accepts an empty content string as a valid 'truncate to empty' op", async () => {
    await fs.writeFile(path.join(tmpDir, "x.txt"), "old");
    const r = await writeTool({ path: "x.txt", content: "" }, ctx);
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmpDir, "x.txt"), "utf8")).toBe("");
  });

  it("computes UTF-8 byte length, not char length, for multibyte content", async () => {
    const content = "héllo"; // 6 bytes UTF-8, 5 chars
    const r = await writeTool({ path: "x.txt", content }, ctx);
    expect(r.ok).toBe(true);
    expect(r.audit.bytes_written).toBe(6);
  });
});

// ─── edit ────────────────────────────────────────────────────────────

describe("tools/edit", () => {
  it("replaces a unique occurrence", async () => {
    await fs.writeFile(path.join(tmpDir, "x.ts"), "const foo = 1;\nconst bar = 2;");
    const r = await editTool({ path: "x.ts", old_string: "const foo = 1;", new_string: "const foo = 42;" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.audit.replacements).toBe(1);
    expect(await fs.readFile(path.join(tmpDir, "x.ts"), "utf8")).toBe("const foo = 42;\nconst bar = 2;");
  });

  it("refuses when old_string matches multiple times and replace_all is false", async () => {
    await fs.writeFile(path.join(tmpDir, "x.txt"), "dup\ndup\ndup");
    const r = await editTool({ path: "x.txt", old_string: "dup", new_string: "X" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("ambiguous");
    expect(r.audit.matches).toBe(3);
    expect(await fs.readFile(path.join(tmpDir, "x.txt"), "utf8")).toBe("dup\ndup\ndup"); // unchanged
  });

  it("replaces all when replace_all=true", async () => {
    await fs.writeFile(path.join(tmpDir, "x.txt"), "dup\ndup\ndup");
    const r = await editTool({ path: "x.txt", old_string: "dup", new_string: "X", replace_all: true }, ctx);
    expect(r.ok).toBe(true);
    expect(r.audit.replacements).toBe(3);
    expect(await fs.readFile(path.join(tmpDir, "x.txt"), "utf8")).toBe("X\nX\nX");
  });

  it("refuses no-op (old_string === new_string)", async () => {
    await fs.writeFile(path.join(tmpDir, "x.txt"), "abc");
    const r = await editTool({ path: "x.txt", old_string: "abc", new_string: "abc" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("noop");
  });

  it("returns not_found when old_string is absent", async () => {
    await fs.writeFile(path.join(tmpDir, "x.txt"), "abc");
    const r = await editTool({ path: "x.txt", old_string: "ZZZ", new_string: "YYY" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("not_found");
  });

  it("rejects empty old_string with bad_args", async () => {
    await fs.writeFile(path.join(tmpDir, "x.txt"), "abc");
    const r = await editTool({ path: "x.txt", old_string: "", new_string: "abc" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("bad_args");
  });

  it("rejects jail escape", async () => {
    const r = await editTool({ path: "../e.txt", old_string: "a", new_string: "b" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("jail_violation");
  });

  it("returns ENOENT when file missing", async () => {
    const r = await editTool({ path: "nope.txt", old_string: "a", new_string: "b" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.audit.error).toBe("ENOENT");
  });

  it("can delete content by replacing with empty string", async () => {
    await fs.writeFile(path.join(tmpDir, "x.txt"), "before-DELETEME-after");
    const r = await editTool({ path: "x.txt", old_string: "-DELETEME-", new_string: "" }, ctx);
    expect(r.ok).toBe(true);
    expect(await fs.readFile(path.join(tmpDir, "x.txt"), "utf8")).toBe("beforeafter");
  });
});
