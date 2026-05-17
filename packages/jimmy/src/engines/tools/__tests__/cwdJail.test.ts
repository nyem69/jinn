import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveInJail, JailViolation } from "../cwdJail.js";

const cwd = "/tmp/jail-test-base";

describe("resolveInJail — happy path", () => {
  it("resolves a simple relative path under cwd", () => {
    expect(resolveInJail(cwd, "foo.txt")).toBe(path.join(cwd, "foo.txt"));
  });

  it("resolves a nested relative path under cwd", () => {
    expect(resolveInJail(cwd, "sub/dir/file.json")).toBe(path.join(cwd, "sub/dir/file.json"));
  });

  it("normalizes redundant './' segments", () => {
    expect(resolveInJail(cwd, "./foo/./bar.txt")).toBe(path.join(cwd, "foo/bar.txt"));
  });

  it("normalizes internal '..' that stays inside the jail", () => {
    expect(resolveInJail(cwd, "foo/../bar.txt")).toBe(path.join(cwd, "bar.txt"));
  });

  it("accepts an absolute path that is already under cwd", () => {
    expect(resolveInJail(cwd, path.join(cwd, "x/y.txt"))).toBe(path.join(cwd, "x/y.txt"));
  });

  it("allows the cwd itself ('.' or empty-relative)", () => {
    expect(resolveInJail(cwd, ".")).toBe(path.resolve(cwd));
  });
});

describe("resolveInJail — escape attempts", () => {
  it("rejects a leading '..'", () => {
    expect(() => resolveInJail(cwd, "../escape.txt")).toThrow(JailViolation);
  });

  it("rejects a multi-level '..' escape", () => {
    expect(() => resolveInJail(cwd, "foo/../../escape.txt")).toThrow(JailViolation);
  });

  it("rejects an absolute path outside cwd", () => {
    expect(() => resolveInJail(cwd, "/etc/passwd")).toThrow(JailViolation);
  });

  it("rejects an absolute path that is a sibling of cwd", () => {
    expect(() => resolveInJail(cwd, "/tmp/jail-test-base-OTHER/file")).toThrow(JailViolation);
  });

  it("JailViolation carries the requested path and cwd", () => {
    try {
      resolveInJail(cwd, "../oops");
      throw new Error("did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(JailViolation);
      expect((err as JailViolation).requestedPath).toBe("../oops");
      expect((err as JailViolation).cwd).toBe(cwd);
    }
  });
});

describe("resolveInJail — malformed input", () => {
  it("rejects non-string input", () => {
    // @ts-expect-error — intentional bad type
    expect(() => resolveInJail(cwd, 42)).toThrow(/path must be a string/);
  });

  it("rejects empty string", () => {
    expect(() => resolveInJail(cwd, "")).toThrow(/non-empty string/);
  });

  it("rejects NUL bytes in path", () => {
    expect(() => resolveInJail(cwd, "foo\0bar")).toThrow(/NUL bytes/);
  });
});

describe("resolveInJail — cwd normalization", () => {
  it("treats trailing slashes on cwd as equivalent", () => {
    expect(resolveInJail("/tmp/jail-test-base/", "foo.txt")).toBe(path.join(cwd, "foo.txt"));
  });

  it("does not treat a substring-prefix dir as inside the jail", () => {
    // /tmp/jail-test-base-OTHER starts with /tmp/jail-test-base but is a
    // distinct directory. path.relative correctly returns '../jail-test-base-OTHER/x'.
    expect(() => resolveInJail("/tmp/jail-test-base", "/tmp/jail-test-base-OTHER/x")).toThrow(
      JailViolation,
    );
  });
});
