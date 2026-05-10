import type Database from 'better-sqlite3';
import { initDb } from './registry.js';
import { applyPendingMigrations } from './migrate-runner.js';

// T1A.PR5: session checkpoints + replay context.
//
// A checkpoint is a frozen COO state captured immediately before each
// delegation: the persona being delegated to, the post-pruning prompt,
// the active plan/TodoWrite snapshot, and any prior fan-out results
// already collected. Replay reconstructs from a checkpoint by feeding
// the recorded tool_invoked/tool_completed events from session_events
// back into a fresh child as observations.
//
// The schema is owned by `applyPendingMigrations` (0005_checkpoints.up.sql);
// `initCheckpointsSchema` remains as a compat shim for tests/callers that
// still invoke it directly.

/**
 * @deprecated Compat shim. Schema is owned by `applyPendingMigrations`.
 */
export function initCheckpointsSchema(database: Database.Database): void {
  applyPendingMigrations(database);
}

// 2 MB cap on state JSON. Plan says ~50 KB typical / ~500 KB worst-case
// per checkpoint; 2 MB leaves four-x headroom while still preventing a
// runaway state from filling registry.db. Callers that hit this should
// trim active_plan / prior_results — they are the elastic fields.
const MAX_STATE_BYTES = 2 * 1024 * 1024;

export type CheckpointState = Record<string, unknown> & {
  persona?: string;
  prompt?: string;
  active_plan?: unknown;
  prior_results?: unknown;
};

export interface CheckpointRow {
  id: number;
  sessionId: string;
  stepSeq: number;
  branch: string;
  state: CheckpointState;
  createdAt: string;
}

export interface WriteCheckpointOpts {
  sessionId: string;
  stepSeq: number;
  branch?: string;
  state: CheckpointState;
}

export interface WriteCheckpointResult {
  id: number;
  dedup: boolean;
}

function rowToCheckpoint(row: Record<string, unknown>): CheckpointRow {
  let state: CheckpointState;
  try {
    state = JSON.parse(row.state as string) as CheckpointState;
  } catch {
    state = {};
  }
  return {
    id: row.id as number,
    sessionId: row.session_id as string,
    stepSeq: row.step_seq as number,
    branch: row.branch as string,
    state,
    createdAt: row.created_at as string,
  };
}

export function writeCheckpoint(
  opts: WriteCheckpointOpts,
): WriteCheckpointResult {
  return writeCheckpointOn(initDb(), opts);
}

export function writeCheckpointOn(
  db: Database.Database,
  opts: WriteCheckpointOpts,
): WriteCheckpointResult {
  const branch = opts.branch ?? 'main';
  const stateJson = JSON.stringify(opts.state ?? {});
  if (Buffer.byteLength(stateJson, 'utf-8') > MAX_STATE_BYTES) {
    throw new Error(
      `checkpoint state exceeds ${MAX_STATE_BYTES} bytes — trim active_plan / prior_results before writing`,
    );
  }

  // INSERT OR IGNORE leaves the existing row intact when (session,
  // branch, step) collides — the function then surfaces the existing
  // id with dedup=true so callers can rely on a stable handle.
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO session_checkpoints (session_id, step_seq, branch, state)
       VALUES (?, ?, ?, ?)`,
    )
    .run(opts.sessionId, opts.stepSeq, branch, stateJson);

  if (Number(info.changes) > 0) {
    return { id: Number(info.lastInsertRowid), dedup: false };
  }

  // Collision — fetch the existing row's id.
  const existing = db
    .prepare(
      'SELECT id FROM session_checkpoints WHERE session_id = ? AND branch = ? AND step_seq = ?',
    )
    .get(opts.sessionId, branch, opts.stepSeq) as { id: number } | undefined;
  return { id: existing?.id ?? 0, dedup: true };
}

export interface ListCheckpointsOpts {
  branch?: string;
  limit?: number;
}

export function listCheckpoints(
  sessionId: string,
  opts: ListCheckpointsOpts = {},
): CheckpointRow[] {
  return listCheckpointsOn(initDb(), sessionId, opts);
}

export function listCheckpointsOn(
  db: Database.Database,
  sessionId: string,
  opts: ListCheckpointsOpts = {},
): CheckpointRow[] {
  const limit = Number.isFinite(opts.limit) && opts.limit && opts.limit > 0
    ? Math.floor(opts.limit)
    : 1000;
  const rows = opts.branch
    ? (db
        .prepare(
          `SELECT * FROM session_checkpoints
            WHERE session_id = ? AND branch = ?
            ORDER BY step_seq ASC LIMIT ?`,
        )
        .all(sessionId, opts.branch, limit) as Array<Record<string, unknown>>)
    : (db
        .prepare(
          `SELECT * FROM session_checkpoints
            WHERE session_id = ?
            ORDER BY branch ASC, step_seq ASC LIMIT ?`,
        )
        .all(sessionId, limit) as Array<Record<string, unknown>>);
  return rows.map(rowToCheckpoint);
}

export interface ReadCheckpointOpts {
  branch?: string;
  stepSeq?: number;
}

// Returns the checkpoint at exact (branch, stepSeq) when both are
// supplied, the latest checkpoint on a branch when only branch is set,
// or the latest checkpoint across all branches when neither is set.
export function readCheckpoint(
  sessionId: string,
  opts: ReadCheckpointOpts = {},
): CheckpointRow | null {
  return readCheckpointOn(initDb(), sessionId, opts);
}

export function readCheckpointOn(
  db: Database.Database,
  sessionId: string,
  opts: ReadCheckpointOpts = {},
): CheckpointRow | null {
  const branch = opts.branch ?? 'main';
  if (typeof opts.stepSeq === 'number') {
    const row = db
      .prepare(
        `SELECT * FROM session_checkpoints
          WHERE session_id = ? AND branch = ? AND step_seq = ?`,
      )
      .get(sessionId, branch, opts.stepSeq) as Record<string, unknown> | undefined;
    return row ? rowToCheckpoint(row) : null;
  }
  // Latest checkpoint on the branch.
  const row = db
    .prepare(
      `SELECT * FROM session_checkpoints
        WHERE session_id = ? AND branch = ?
        ORDER BY step_seq DESC LIMIT 1`,
    )
    .get(sessionId, branch) as Record<string, unknown> | undefined;
  return row ? rowToCheckpoint(row) : null;
}

// Retention helper. Returns the number of rows deleted. Plan suggests
// keeping the last 30 days; the operator wires this into a cron via
// runCheckpointRetention in their schedule.
export function deleteCheckpointsOlderThan(days: number): number {
  return deleteCheckpointsOlderThanOn(initDb(), days);
}

export function deleteCheckpointsOlderThanOn(
  db: Database.Database,
  days: number,
): number {
  if (!Number.isFinite(days) || days <= 0) return 0;
  const info = db
    .prepare(
      `DELETE FROM session_checkpoints
        WHERE created_at < datetime('now', ?)`,
    )
    .run(`-${Math.floor(days)} days`);
  return Number(info.changes);
}

// ── Replay context builder ──────────────────────────────────────────
//
// buildReplayContext gathers everything needed to spin up a fresh child
// session that resumes from a checkpoint:
//
//   - The checkpoint itself (persona / prompt / active_plan / prior_results)
//   - Session metadata (engine, model, employee, parent) — what the
//     engine adapter needs to spawn the right kind of process
//   - The tool sequence between checkpoint.step_seq and the next
//     checkpoint's step_seq (or end of log) — these are the recorded
//     tool_invoked / tool_completed events the new session replays
//     instead of executing
//   - The next available step_seq on the chosen branch — so the new
//     child writes its own checkpoints under a forked branch name
//     without colliding with the original session's main branch.

export interface ReplayContextOpts {
  branch?: string;
  fromStep?: number;
  toBranch?: string;
}

export interface ReplayTool {
  callId: string;
  tool: string;
  invokedAt: string;
  args: unknown;
  result: unknown;
  error: string | null;
  durationMs: number | null;
}

export interface ReplaySessionMeta {
  sessionId: string;
  engine: string;
  model: string | null;
  employee: string | null;
  parentSessionId: string | null;
  rootSessionId: string | null;
}

export interface ReplayContext {
  checkpoint: CheckpointRow;
  session: ReplaySessionMeta;
  toolSequence: ReplayTool[];
  nextStepSeq: number;
  fromBranch: string;
  toBranch: string;
}

export type ReplayContextError =
  | { ok: false; reason: 'unknown_session' }
  | { ok: false; reason: 'no_checkpoints' }
  | { ok: false; reason: 'step_out_of_bounds'; available: number[] };

export type ReplayContextResult =
  | ({ ok: true } & ReplayContext)
  | ReplayContextError;

export function buildReplayContext(
  sessionId: string,
  opts: ReplayContextOpts = {},
): ReplayContextResult {
  return buildReplayContextOn(initDb(), sessionId, opts);
}

export function buildReplayContextOn(
  db: Database.Database,
  sessionId: string,
  opts: ReplayContextOpts = {},
): ReplayContextResult {
  const sessRow = db
    .prepare(
      `SELECT engine, model, employee, parent_session_id, root_session_id
        FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as
    | {
        engine?: string;
        model?: string;
        employee?: string;
        parent_session_id?: string;
        root_session_id?: string;
      }
    | undefined;
  if (!sessRow) return { ok: false, reason: 'unknown_session' };

  const fromBranch = opts.branch ?? 'main';
  const allOnBranch = listCheckpointsOn(db, sessionId, { branch: fromBranch });
  if (allOnBranch.length === 0) return { ok: false, reason: 'no_checkpoints' };

  let checkpoint: CheckpointRow | undefined;
  if (typeof opts.fromStep === 'number') {
    checkpoint = allOnBranch.find((c) => c.stepSeq === opts.fromStep);
    if (!checkpoint) {
      return {
        ok: false,
        reason: 'step_out_of_bounds',
        available: allOnBranch.map((c) => c.stepSeq),
      };
    }
  } else {
    checkpoint = allOnBranch[allOnBranch.length - 1];
  }

  // Bound tool slice between this checkpoint's step_seq and the next.
  // session_events.seq aligns with checkpoint.step_seq per the plan, so
  // we read events with seq in (checkpoint.stepSeq, nextStep].
  const next = allOnBranch.find((c) => c.stepSeq > checkpoint!.stepSeq);
  const upperBoundClause = next ? 'AND seq <= ?' : '';
  const params: unknown[] = [sessionId, checkpoint.stepSeq];
  if (next) params.push(next.stepSeq);

  const eventRows = db
    .prepare(
      `SELECT seq, kind, payload, created_at FROM session_events
        WHERE session_id = ? AND seq > ? ${upperBoundClause}
          AND kind IN ('tool_invoked', 'tool_completed')
        ORDER BY seq ASC`,
    )
    .all(...params) as Array<{
      seq: number;
      kind: string;
      payload: string;
      created_at: string;
    }>;

  // Pair tool_invoked + tool_completed by call_id into ReplayTool rows.
  const invocations = new Map<string, ReplayTool>();
  const ordered: ReplayTool[] = [];
  for (const row of eventRows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const callId = String(payload.call_id || '');
    if (!callId) continue;

    if (row.kind === 'tool_invoked') {
      const tool: ReplayTool = {
        callId,
        tool: String(payload.tool || ''),
        invokedAt: row.created_at,
        args: payload.args ?? null,
        result: null,
        error: null,
        durationMs: null,
      };
      invocations.set(callId, tool);
      ordered.push(tool);
    } else {
      const tool = invocations.get(callId);
      if (tool) {
        tool.result = payload.result ?? null;
        tool.error = (payload.error as string | null) ?? null;
        tool.durationMs = typeof payload.duration_ms === 'number' ? payload.duration_ms : null;
      } else {
        // Unpaired tool_completed (rare) — surface anyway so the engine
        // adapter can decide whether to drop it.
        ordered.push({
          callId,
          tool: String(payload.tool || ''),
          invokedAt: row.created_at,
          args: null,
          result: payload.result ?? null,
          error: (payload.error as string | null) ?? null,
          durationMs:
            typeof payload.duration_ms === 'number' ? payload.duration_ms : null,
        });
      }
    }
  }

  // Next step on the destination branch. New replays fork into a new
  // branch by default so the original session is untouched per plan.
  const toBranch =
    opts.toBranch ?? `replay-${Date.now().toString(36)}-${checkpoint.stepSeq}`;
  const branchRows = listCheckpointsOn(db, sessionId, { branch: toBranch });
  const nextStepSeq =
    branchRows.length > 0
      ? branchRows[branchRows.length - 1].stepSeq + 1
      : checkpoint.stepSeq + 1;

  return {
    ok: true,
    checkpoint,
    session: {
      sessionId,
      engine: sessRow.engine ?? '(unknown)',
      model: sessRow.model ?? null,
      employee: sessRow.employee ?? null,
      parentSessionId: sessRow.parent_session_id ?? null,
      rootSessionId: sessRow.root_session_id ?? null,
    },
    toolSequence: ordered,
    nextStepSeq,
    fromBranch,
    toBranch,
  };
}
