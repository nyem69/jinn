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
    // Whitelist of allowed keys
    expect(Object.keys(row).sort()).toEqual(
      ["argsSummary", "durationMs", "error", "exitCode", "httpStatus", "resultBytes", "toolName", "truncated"].sort(),
    );
    // Sanity: no content leak
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("FULL FILE CONTENTS");
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
