import { describe, it, expect } from "vitest";
import { sanitizeArgsForAudit, buildAuditRow } from "../audit.js";
import type { ToolResult } from "../tools/types.js";

describe("audit: sanitizeArgsForAudit redaction", () => {
  it("redacts api_key field", () => {
    const s = sanitizeArgsForAudit({ api_key: "sk-abc123", q: "hi" });
    const parsed = JSON.parse(s);
    expect(parsed.api_key).toBe("[redacted]");
    expect(parsed.q).toBe("hi");
  });

  it("redacts authorization header case-insensitively", () => {
    const s = sanitizeArgsForAudit({ Authorization: "Bearer abc", method: "GET" });
    const parsed = JSON.parse(s);
    expect(parsed.Authorization).toBe("[redacted]");
  });

  it("redacts apiKey camelCase", () => {
    const parsed = JSON.parse(sanitizeArgsForAudit({ apiKey: "x" }));
    expect(parsed.apiKey).toBe("[redacted]");
  });

  it("redacts nested secret fields", () => {
    const s = sanitizeArgsForAudit({
      headers: { Authorization: "Bearer xyz", "X-Custom": "fine" },
    });
    const parsed = JSON.parse(s);
    expect(parsed.headers.Authorization).toBe("[redacted]");
    expect(parsed.headers["X-Custom"]).toBe("fine");
  });

  it("redacts password, token, secret, cookie keys", () => {
    const s = sanitizeArgsForAudit({
      password: "p",
      token: "t",
      secret: "s",
      cookie: "c",
      keep: "ok",
    });
    const p = JSON.parse(s);
    expect(p.password).toBe("[redacted]");
    expect(p.token).toBe("[redacted]");
    expect(p.secret).toBe("[redacted]");
    expect(p.cookie).toBe("[redacted]");
    expect(p.keep).toBe("ok");
  });

  it("truncates long string values to 200 chars + marker", () => {
    const long = "x".repeat(500);
    const s = sanitizeArgsForAudit({ blob: long });
    const p = JSON.parse(s);
    expect(p.blob.length).toBeLessThan(300);
    expect(p.blob).toMatch(/more\]$/);
  });

  it("caps deep nesting at depth-5", () => {
    let v: unknown = "deep";
    for (let i = 0; i < 12; i++) v = { nested: v };
    // Cast through unknown — intentional test-only escape hatch since
    // JsonObject's index signature is JsonValue and we want a deep tree.
    const s = sanitizeArgsForAudit(v as never);
    expect(s).toMatch(/depth-capped/);
  });

  it("walks arrays", () => {
    const s = sanitizeArgsForAudit({ items: [{ token: "x" }, "fine"] });
    const p = JSON.parse(s);
    expect(p.items[0].token).toBe("[redacted]");
    expect(p.items[1]).toBe("fine");
  });
});

describe("audit: URL credential redaction", () => {
  it("redacts ?api_key= query parameter", () => {
    const s = sanitizeArgsForAudit({ url: "https://example.com/path?api_key=secret123&q=hi" });
    expect(s).not.toContain("secret123");
    // URLSearchParams URL-encodes the value, so we accept either form.
    expect(s).toMatch(/api_key=(\[redacted\]|%5Bredacted%5D)/);
    expect(s).toContain("q=hi"); // non-secret query params preserved
  });

  it("redacts ?token= and ?access_token=", () => {
    const s = sanitizeArgsForAudit({ url: "https://x.com/?token=abc&access_token=xyz" });
    expect(s).not.toContain("abc");
    expect(s).not.toContain("xyz");
  });

  it("strips https://user:password@host userinfo", () => {
    const s = sanitizeArgsForAudit({ url: "https://user:hunter2@example.com/path" });
    expect(s).not.toContain("hunter2");
    expect(s).not.toContain("user:");
  });

  it("leaves URLs without credentials untouched", () => {
    const s = sanitizeArgsForAudit({ url: "https://example.com/path?q=hi" });
    const p = JSON.parse(s);
    expect(p.url).toBe("https://example.com/path?q=hi");
  });

  it("redacts URL secrets in arrays (e.g. webfetch redirect_chain)", () => {
    const s = sanitizeArgsForAudit({
      chain: ["https://a.com/?api_key=A", "https://b.com/"] as never,
    });
    expect(s).not.toContain("api_key=A");
    expect(s).toContain("https://b.com/");
  });

  it("redacts URL secret BEFORE truncation so a long token can't survive at the tail", () => {
    const longSecret = "k".repeat(500);
    const s = sanitizeArgsForAudit({ url: `https://e.com/?api_key=${longSecret}` });
    expect(s).not.toContain(longSecret);
    expect(s).not.toContain("kkkk"); // even a fragment of the token
  });

  it("variants: ?password=, ?secret=, ?signature=, ?sig=", () => {
    const cases = [
      "https://x.com/?password=p",
      "https://x.com/?secret=s",
      "https://x.com/?signature=sig",
      "https://x.com/?sig=short",
    ];
    for (const url of cases) {
      const s = sanitizeArgsForAudit({ url });
      expect(s).not.toMatch(/=p[^a-zA-Z]|=s[^a-zA-Z]|=sig[^a-zA-Z]|=short/);
    }
  });

  it("doesn't crash on malformed URL strings (returns them untouched)", () => {
    const s = sanitizeArgsForAudit({ url: "not a url at all" });
    const p = JSON.parse(s);
    expect(p.url).toBe("not a url at all");
  });
});

describe("audit: buildAuditRow keeps NO content / stdout / stderr / body", () => {
  it("produces only the documented metadata keys", () => {
    const result: ToolResult = {
      ok: true,
      content: "FULL FILE CONTENTS that must NEVER appear in audit",
      audit: {
        truncated: false,
        originalBytes: 1234,
        total_lines: 42,
        returned_lines: 42,
      },
    };
    const row = buildAuditRow("read", { path: "x.txt" }, result, 5);
    // Whitelist of allowed keys. sessionId + engineName are populated
    // by the agent loop from ToolExecutionContext; they're optional in
    // the shape but always present (possibly undefined) on the object.
    expect(Object.keys(row).sort()).toEqual(
      [
        "argsSummary",
        "durationMs",
        "engineName",
        "error",
        "exitCode",
        "httpStatus",
        "resultBytes",
        "sessionId",
        "toolName",
        "truncated",
      ].sort(),
    );
    // Sanity: no content leak
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("FULL FILE CONTENTS");
  });

  it("populates sessionId + engineName when scope is provided (Phase 7a)", () => {
    const result: ToolResult = {
      ok: true,
      content: "x",
      audit: { truncated: false },
    };
    const row = buildAuditRow("read", { path: "x.txt" }, result, 1, {
      sessionId: "sess-42",
      engineName: "ollama",
    });
    expect(row.sessionId).toBe("sess-42");
    expect(row.engineName).toBe("ollama");
  });

  it("leaves sessionId + engineName undefined when scope is omitted", () => {
    const result: ToolResult = { ok: true, content: "", audit: { truncated: false } };
    const row = buildAuditRow("read", {}, result, 1);
    expect(row.sessionId).toBeUndefined();
    expect(row.engineName).toBeUndefined();
  });

  it("captures bash exit_code", () => {
    const result: ToolResult = {
      ok: false,
      content: "[exit 2]",
      audit: {
        truncated: false,
        truncated_stdout: false,
        truncated_stderr: false,
        original_stdout_bytes: 10,
        original_stderr_bytes: 0,
        exit_code: 2,
        signal: null,
        timeout: false,
        duration_ms: 30,
        command: "false",
        args: [],
        error: "nonzero_exit",
      },
    };
    const row = buildAuditRow("bash", { command: "false", args: [] }, result, 30);
    expect(row.exitCode).toBe(2);
    expect(row.error).toBe("nonzero_exit");
    expect(row.resultBytes).toBe(10); // pulled from original_stdout_bytes
  });

  it("captures webfetch http_status", () => {
    const result: ToolResult = {
      ok: true,
      content: "...",
      audit: {
        truncated: false,
        original_bytes: 5000,
        http_status: 200,
        content_type: "text/html",
        redirect_chain: ["https://example.com/"],
        hops: 0,
      },
    };
    const row = buildAuditRow("webfetch", { url: "https://example.com/" }, result, 50);
    expect(row.httpStatus).toBe(200);
    expect(row.resultBytes).toBe(5000);
    expect(row.exitCode).toBeNull();
  });

  it("redacts secrets in argsSummary", () => {
    const result: ToolResult = { ok: true, content: "", audit: { truncated: false } };
    const row = buildAuditRow(
      "webfetch",
      { url: "https://api.example.com/x", authorization: "Bearer xyz" } as Record<string, unknown> as never,
      result,
      1,
    );
    expect(row.argsSummary).toContain("[redacted]");
    expect(row.argsSummary).not.toContain("Bearer xyz");
  });
});
