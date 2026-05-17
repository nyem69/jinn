import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveInJail, JailViolation } from "../cwdJail.js";

let jail: string;
let realJail: string;
let outside: string;

beforeEach(async () => {
  jail = await fs.mkdtemp(path.join(os.tmpdir(), "cwd-jail-"));
  realJail = await fs.realpath(jail);
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "cwd-jail-outside-"));
});

afterEach(async () => {
  await fs.rm(jail, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("resolveInJail — happy path (lexical)", () => {
  it("resolves a simple relative path under cwd", async () => {
    await expect(resolveInJail(jail, "foo.txt")).resolves.toBe(path.join(realJail, "foo.txt"));
  });

  it("resolves a nested relative path that doesn't yet exist", async () => {
    await expect(resolveInJail(jail, "sub/dir/new.json")).resolves.toBe(
      path.join(realJail, "sub/dir/new.json"),
    );
  });

  it("normalizes redundant './' segments", async () => {
    await expect(resolveInJail(jail, "./foo/./bar.txt")).resolves.toBe(
      path.join(realJail, "foo/bar.txt"),
    );
  });

  it("normalizes internal '..' that stays inside the jail", async () => {
    await expect(resolveInJail(jail, "foo/../bar.txt")).resolves.toBe(
      path.join(realJail, "bar.txt"),
    );
  });

  it("accepts an absolute path that is already under cwd", async () => {
    await expect(resolveInJail(jail, path.join(jail, "x/y.txt"))).resolves.toBe(
      path.join(realJail, "x/y.txt"),
    );
  });

  it("allows the cwd itself ('.')", async () => {
    await expect(resolveInJail(jail, ".")).resolves.toBe(realJail);
  });
});

describe("resolveInJail — lexical_escape", () => {
  it("rejects a leading '..' with reason=lexical_escape", async () => {
    await expect(resolveInJail(jail, "../escape.txt")).rejects.toMatchObject({
      name: "JailViolation",
      reason: "lexical_escape",
    });
  });

  it("rejects an absolute path outside cwd", async () => {
    await expect(resolveInJail(jail, "/etc/passwd")).rejects.toMatchObject({
      reason: "lexical_escape",
    });
  });

  it("rejects a sibling-prefix path", async () => {
    // jail = /tmp/cwd-jail-XYZ; sibling /tmp/cwd-jail-XYZ-EXTRA must be rejected.
    const sibling = `${jail}-EXTRA`;
    await expect(resolveInJail(jail, sibling)).rejects.toMatchObject({
      reason: "lexical_escape",
    });
  });

  it("JailViolation carries requestedPath, cwd, and reason", async () => {
    try {
      await resolveInJail(jail, "../oops");
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(JailViolation);
      expect((err as JailViolation).requestedPath).toBe("../oops");
      expect((err as JailViolation).cwd).toBe(jail);
      expect((err as JailViolation).reason).toBe("lexical_escape");
    }
  });
});

describe("resolveInJail — realpath_escape (symlink-based)", () => {
  it("rejects a leaf-symlink that points outside the jail", async () => {
    const target = path.join(outside, "secret.txt");
    await fs.writeFile(target, "TOP-SECRET");
    await fs.symlink(target, path.join(jail, "link"));
    // Without rejectSymlinkLeaf, the leaf-symlink check is skipped — but
    // the realpath check still rejects because the target is outside.
    await expect(resolveInJail(jail, "link")).rejects.toMatchObject({
      reason: "realpath_escape",
    });
  });

  it("rejects when the path traverses a parent-directory symlink that escapes", async () => {
    await fs.writeFile(path.join(outside, "leak.txt"), "PARENT-LEAK");
    await fs.symlink(outside, path.join(jail, "esc"));
    await expect(resolveInJail(jail, "esc/leak.txt")).rejects.toMatchObject({
      reason: "realpath_escape",
    });
  });

  it("allows a leaf-symlink whose target stays INSIDE the jail (no rejectSymlinkLeaf)", async () => {
    const realFile = path.join(jail, "real.txt");
    await fs.writeFile(realFile, "inside");
    await fs.symlink(realFile, path.join(jail, "alias"));
    // Resolved canonical path is the realpath of the target.
    await expect(resolveInJail(jail, "alias")).resolves.toBe(await fs.realpath(realFile));
  });
});

describe("resolveInJail — symlink_leaf (write/edit posture)", () => {
  it("rejects a leaf-symlink with rejectSymlinkLeaf=true, even if target is inside the jail", async () => {
    const realFile = path.join(jail, "real.txt");
    await fs.writeFile(realFile, "inside");
    await fs.symlink(realFile, path.join(jail, "alias"));
    await expect(resolveInJail(jail, "alias", { rejectSymlinkLeaf: true })).rejects.toMatchObject({
      reason: "symlink_leaf",
    });
  });

  it("does not reject the leaf when it's a regular file under rejectSymlinkLeaf", async () => {
    await fs.writeFile(path.join(jail, "regular.txt"), "x");
    await expect(resolveInJail(jail, "regular.txt", { rejectSymlinkLeaf: true })).resolves.toBe(
      path.join(realJail, "regular.txt"),
    );
  });

  it("does not reject a non-existent leaf under rejectSymlinkLeaf (write-new-file case)", async () => {
    await expect(resolveInJail(jail, "new-file.txt", { rejectSymlinkLeaf: true })).resolves.toBe(
      path.join(realJail, "new-file.txt"),
    );
  });

  it("still rejects parent-symlink-escape under rejectSymlinkLeaf", async () => {
    await fs.symlink(outside, path.join(jail, "esc"));
    await expect(
      resolveInJail(jail, "esc/new-file.txt", { rejectSymlinkLeaf: true }),
    ).rejects.toMatchObject({ reason: "realpath_escape" });
  });
});

describe("resolveInJail — malformed input", () => {
  it("rejects non-string input", async () => {
    await expect(
      // @ts-expect-error — intentional bad type
      resolveInJail(jail, 42),
    ).rejects.toThrow(/path must be a string/);
  });

  it("rejects empty string", async () => {
    await expect(resolveInJail(jail, "")).rejects.toThrow(/non-empty string/);
  });

  it("rejects NUL bytes in path", async () => {
    await expect(resolveInJail(jail, "foo\0bar")).rejects.toThrow(/NUL bytes/);
  });
});

describe("resolveInJail — cwd normalization", () => {
  it("treats a trailing-slash cwd as equivalent", async () => {
    await expect(resolveInJail(jail + path.sep, "foo.txt")).resolves.toBe(
      path.join(realJail, "foo.txt"),
    );
  });
});
