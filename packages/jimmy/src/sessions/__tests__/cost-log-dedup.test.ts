import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { migrateSessionsSchema } from "../registry.js";
import { initEventsSchema } from "../../events/db.js";
import { initHandlerRegistry } from "../../events/handlers.js";
import { initCheckpointsSchema } from "../checkpoint.js";

// logSessionCost dedup test. Goes through the on-disk path because
// logSessionCost calls initDb() under the hood. We point JINN_HOME at a
// per-test temp dir so the global registry.db isn't touched.

const OPS_DDL: string[] = [
  `CREATE TABLE cost_log (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    employee TEXT,
    engine TEXT NOT NULL,
    model TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    trigger_ref TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

let tmpHome: string;
let originalHome: string | undefined;

async function freshHome(): Promise<void> {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jin-cost-log-dedup-"));
  fs.mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });
  originalHome = process.env.JINN_HOME;
  process.env.JINN_HOME = tmpHome;

  // Reset module registry so initDb() picks up the new home.
  vi.resetModules();
  const { initDb } = await import("../registry.js");
  const db = initDb();
  migrateSessionsSchema(db);
  initEventsSchema(db);
  initHandlerRegistry(db);
  initCheckpointsSchema(db);
  for (const stmt of OPS_DDL) db.prepare(stmt).run();
}

function cleanupHome(): void {
  if (originalHome === undefined) delete process.env.JINN_HOME;
  else process.env.JINN_HOME = originalHome;
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
}

function insertSession(db: Database.Database, id: string): void {
  db.prepare(`
    INSERT INTO sessions (id, engine, source, source_ref, root_session_id, created_at, last_activity)
    VALUES (?, 'claude', 'web', ?, ?, '2026-05-08T00:00:00.000Z', '2026-05-08T00:00:00.000Z')
  `).run(id, `web:${id}`, id);
}

describe("logSessionCost — dedup against the T1A handler", () => {
  beforeEach(async () => {
    await freshHome();
  });

  afterEach(() => {
    cleanupHome();
  });

  it("skips when a cost_log row already exists for this session_id", async () => {
    const { initDb } = await import("../registry.js");
    const { logSessionCost } = await import("../registry.js");
    const db = initDb();

    insertSession(db, "s1");

    // Pre-populate as if the T1A cost_log handler had already written
    // (with full token attribution).
    db.prepare(
      `INSERT INTO cost_log (id, session_id, employee, engine, model, trigger_type, trigger_ref, input_tokens, output_tokens, cost_usd)
       VALUES ('handler-row', 's1', 'writer', 'claude', 'opus', 'web', 'web:s1', 100, 50, 0.12)`,
    ).run();

    // Legacy call — should NOT insert a second row.
    logSessionCost({
      sessionId: "s1",
      engine: "claude",
      model: "opus",
      employee: "writer",
      costUsd: 0.12,
    });

    const rows = db.prepare("SELECT id, input_tokens FROM cost_log WHERE session_id = 's1'").all() as Array<{ id: string; input_tokens: number | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("handler-row");
    expect(rows[0].input_tokens).toBe(100);
  });

  it("inserts when no prior cost_log row exists (legacy path)", async () => {
    const { initDb } = await import("../registry.js");
    const { logSessionCost } = await import("../registry.js");
    const db = initDb();

    insertSession(db, "s2");

    logSessionCost({
      sessionId: "s2",
      engine: "claude",
      model: "opus",
      employee: "writer",
      costUsd: 0.05,
    });

    const rows = db.prepare("SELECT input_tokens, output_tokens, cost_usd FROM cost_log WHERE session_id = 's2'").all() as Array<{
      input_tokens: number | null; output_tokens: number | null; cost_usd: number;
    }>;
    expect(rows).toHaveLength(1);
    // Legacy path writes NULL tokens; cost_usd is the authoritative number.
    expect(rows[0].input_tokens).toBeNull();
    expect(rows[0].output_tokens).toBeNull();
    expect(rows[0].cost_usd).toBe(0.05);
  });

  it("two legacy calls in sequence — second is a no-op", async () => {
    const { initDb } = await import("../registry.js");
    const { logSessionCost } = await import("../registry.js");
    const db = initDb();

    insertSession(db, "s3");

    logSessionCost({ sessionId: "s3", engine: "claude", model: "opus", employee: null, costUsd: 0.01 });
    logSessionCost({ sessionId: "s3", engine: "claude", model: "opus", employee: null, costUsd: 0.99 });

    const rows = db.prepare("SELECT cost_usd FROM cost_log WHERE session_id = 's3'").all() as Array<{ cost_usd: number }>;
    expect(rows).toHaveLength(1);
    // First write wins (the second was a no-op).
    expect(rows[0].cost_usd).toBe(0.01);
  });
});
