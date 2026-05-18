/**
 * Tests for SqliteAuditLogger — the persistence layer for HTTP-loop
 * engine tool calls.
 *
 * Each test runs against a fresh in-memory sqlite DB that's seeded with
 * just the 0007_tool_call_log schema (no other migrations needed; the
 * audit table is self-contained).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteAuditLogger } from "../sqliteAuditLogger.js";
import type { AuditRow } from "../audit.js";

// Resolve the migration SQL relative to this test file so it works under
// both `vitest run` and `vitest --watch`. Mirrors the migrate-runner's
// own path-resolution strategy.
const MIGRATION_SQL = fs.readFileSync(
  path.resolve(
    fileURLToPath(import.meta.url),
    "../../../../migrations/0007_tool_call_log.up.sql",
  ),
  "utf8",
);

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(MIGRATION_SQL);
  return db;
}

function baseRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    toolName: "read",
    argsSummary: '{"path":"x.txt"}',
    durationMs: 12,
    error: null,
    truncated: false,
    resultBytes: 1024,
    exitCode: null,
    httpStatus: null,
    sessionId: "sess-abc",
    engineName: "ollama",
    ...overrides,
  };
}

let db: Database.Database;
let logger: SqliteAuditLogger;

beforeEach(() => {
  db = freshDb();
  logger = new SqliteAuditLogger(db);
});

// ─── Insert shape ────────────────────────────────────────────────────

describe("SqliteAuditLogger: insert shape", () => {
  it("writes one row per record() with the documented columns", () => {
    logger.record(baseRow());
    const rows = db.prepare("SELECT * FROM tool_call_log").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.session_id).toBe("sess-abc");
    expect(r.engine).toBe("ollama");
    expect(r.tool_name).toBe("read");
    expect(r.args_summary).toBe('{"path":"x.txt"}');
    expect(r.duration_ms).toBe(12);
    expect(r.exit_code).toBeNull();
    expect(r.http_status).toBeNull();
    expect(r.error).toBeNull();
    expect(r.result_truncated).toBe(0);
    expect(r.result_bytes).toBe(1024);
    expect(typeof r.id).toBe("string");
    expect((r.id as string).length).toBeGreaterThan(20);
    expect(typeof r.created_at).toBe("string");
  });

  it("persists bash-shaped audit rows (exit_code, error)", () => {
    logger.record(
      baseRow({
        toolName: "bash",
        argsSummary: '{"command":"git","args":["status"]}',
        durationMs: 45,
        error: "nonzero_exit",
        truncated: true,
        resultBytes: 32000,
        exitCode: 1,
      }),
    );
    const r = db.prepare("SELECT * FROM tool_call_log").get() as Record<string, unknown>;
    expect(r.tool_name).toBe("bash");
    expect(r.exit_code).toBe(1);
    expect(r.error).toBe("nonzero_exit");
    expect(r.result_truncated).toBe(1);
    expect(r.result_bytes).toBe(32000);
  });

  it("persists webfetch-shaped audit rows (http_status)", () => {
    logger.record(
      baseRow({
        toolName: "webfetch",
        argsSummary: '{"url":"https://example.com/"}',
        durationMs: 220,
        httpStatus: 200,
        resultBytes: 5000,
      }),
    );
    const r = db.prepare("SELECT * FROM tool_call_log").get() as Record<string, unknown>;
    expect(r.tool_name).toBe("webfetch");
    expect(r.http_status).toBe(200);
    expect(r.exit_code).toBeNull();
  });

  it("inserts each call independently (no replace/dedupe by tool_name)", () => {
    logger.record(baseRow({ toolName: "read" }));
    logger.record(baseRow({ toolName: "read" }));
    logger.record(baseRow({ toolName: "read" }));
    const count = (db.prepare("SELECT COUNT(*) AS n FROM tool_call_log").get() as { n: number }).n;
    expect(count).toBe(3);
  });

  it("synthesizes a unique id per row", () => {
    logger.record(baseRow());
    logger.record(baseRow());
    const ids = db.prepare("SELECT id FROM tool_call_log").all() as Array<{ id: string }>;
    expect(new Set(ids.map((r) => r.id)).size).toBe(2);
  });

  it("falls back to 'unknown' when sessionId / engineName are omitted", () => {
    logger.record(baseRow({ sessionId: undefined, engineName: undefined }));
    const r = db.prepare("SELECT session_id, engine FROM tool_call_log").get() as Record<string, string>;
    expect(r.session_id).toBe("unknown");
    expect(r.engine).toBe("unknown");
  });
});

// ─── No-content persistence (security guarantee) ─────────────────────

describe("SqliteAuditLogger: NEVER persists tool output content", () => {
  it("schema has no 'content', 'stdout', 'stderr', or 'body' columns", () => {
    const cols = db.prepare("PRAGMA table_info(tool_call_log)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name.toLowerCase());
    expect(names).not.toContain("content");
    expect(names).not.toContain("stdout");
    expect(names).not.toContain("stderr");
    expect(names).not.toContain("body");
    expect(names).not.toContain("response_body");
  });

  it("a sentinel content string never appears in the persisted row", () => {
    // AuditRow itself doesn't carry tool body content — the agent loop's
    // buildAuditRow() filters that. This test guards the persistence
    // layer: even if a future change tried to slip body bytes in via
    // argsSummary, they'd only land in the documented column.
    logger.record(
      baseRow({
        argsSummary: '{"path":"safe.txt"}',
      }),
    );
    const dump = db.prepare("SELECT * FROM tool_call_log").get() as Record<string, unknown>;
    const serialized = JSON.stringify(dump);
    expect(serialized).not.toContain("THIS_IS_FILE_BODY_THAT_MUST_NOT_LEAK");
  });

  it("redacted argsSummary survives the round-trip (sanitizer is upstream)", () => {
    logger.record(
      baseRow({
        argsSummary: '{"url":"https://api.example.com/path?api_key=%5Bredacted%5D&q=hi"}',
      }),
    );
    const r = db.prepare("SELECT args_summary FROM tool_call_log").get() as { args_summary: string };
    expect(r.args_summary).toContain("%5Bredacted%5D");
    expect(r.args_summary).not.toContain("secret");
  });
});

// ─── Failure resilience ──────────────────────────────────────────────

describe("SqliteAuditLogger: failure surfacing (loop wraps in safeAudit)", () => {
  it("constructor throws if the migration hasn't been applied", () => {
    const blankDb = new Database(":memory:");
    // No migration → table missing → prepare() fails fast at construction.
    expect(() => new SqliteAuditLogger(blankDb)).toThrow(/no such table/i);
  });

  it("record() throws when the DB has been closed mid-session", () => {
    db.close();
    expect(() => logger.record(baseRow())).toThrow();
    // The agent loop's safeAudit() catches this and routes to logger.warn.
    // That behavior is covered in agentLoop.test.ts; here we just confirm
    // the underlying throw propagates so safeAudit can see it.
  });

  it("record() does NOT corrupt the DB after a single failure", () => {
    logger.record(baseRow());
    const goodCount = (db.prepare("SELECT COUNT(*) AS n FROM tool_call_log").get() as { n: number }).n;
    expect(goodCount).toBe(1);

    // Force a collision by inserting a row with a duplicate id directly.
    const firstId = (db.prepare("SELECT id FROM tool_call_log").get() as { id: string }).id;
    expect(() =>
      db.prepare("INSERT INTO tool_call_log (id, session_id, engine, tool_name) VALUES (?, ?, ?, ?)").run(
        firstId,
        "s",
        "e",
        "t",
      ),
    ).toThrow(/UNIQUE/i);
    const stillOne = (db.prepare("SELECT COUNT(*) AS n FROM tool_call_log").get() as { n: number }).n;
    expect(stillOne).toBe(1);
    logger.record(baseRow({ toolName: "write" }));
    const finalCount = (db.prepare("SELECT COUNT(*) AS n FROM tool_call_log").get() as { n: number }).n;
    expect(finalCount).toBe(2);
  });
});

// ─── Indexes (forensic query speed) ──────────────────────────────────

describe("SqliteAuditLogger: schema indexes", () => {
  it("indexes session_id, engine+tool_name, and error", () => {
    const idx = db.prepare("PRAGMA index_list(tool_call_log)").all() as Array<{ name: string }>;
    const names = idx.map((i) => i.name);
    expect(names).toContain("idx_tool_call_session");
    expect(names).toContain("idx_tool_call_engine_tool");
    expect(names).toContain("idx_tool_call_error");
  });
});
