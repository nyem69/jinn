import type Database from 'better-sqlite3';
import { initDb } from './registry.js';
import { emitAndDispatch, emitEventOn } from '../events/emit.js';
import type { SessionEventRow } from '../events/db.js';

// T1A.PR3: thin SessionResult.
//
// Counters (step_count, tool_call_count) are *derived* from
// session_events at finalize time, not stored. That means a result
// can be rebuilt at any point by re-running the count query — useful
// when crash recovery has to reconstruct what a half-finished session
// produced. The bare numbers go on the result; the per-step details
// live in the event log itself.
//
// finalizeSession emits a session_completed event, which the cost_log
// handler (PR2.D) consumes to autofill the cost_log row. When the
// session has a parent and the caller supplies quality+outcome, we
// also emit subagent_completed on the parent so performance_archive
// can record the row. Both side-effects flow through the standard
// dispatch path; PR3 itself owns nothing in cost_log/performance_log.
//
// Idempotency: if session_completed has already been emitted for this
// session, finalize is a no-op and returns the cached result. That
// covers the crash-recovery double-finalize case the plan calls out.

export type SessionResultState =
  | 'completed'
  | 'max_iterations'
  | 'error'
  | 'cancelled';

export interface SessionResult {
  sessionId: string;
  state: SessionResultState;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  costUsd: number | null;
  stepCount: number;
  toolCallCount: number;
  finalAnswer: string | null;
  errorMessage: string | null;
}

export type SubagentQuality = 'excellent' | 'good' | 'fair' | 'poor';
export type SubagentOutcome = 'success' | 'partial' | 'failed' | 'blocked';

export interface FinalizeOpts {
  state: SessionResultState;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  costUsd?: number | null;
  finalAnswer?: string | null;
  errorMessage?: string | null;
  // When both are present and the session has a parent, finalize emits
  // subagent_completed on the parent — that's the trigger for
  // performance_archive's row insert.
  quality?: SubagentQuality;
  outcome?: SubagentOutcome;
}

interface CountRow {
  n: number;
}

function computeCounts(
  db: Database.Database,
  sessionId: string,
): { stepCount: number; toolCallCount: number } {
  const tools = (
    db
      .prepare(
        "SELECT count(*) AS n FROM session_events WHERE session_id = ? AND kind = 'tool_invoked'",
      )
      .get(sessionId) as CountRow
  ).n;
  const skills = (
    db
      .prepare(
        "SELECT count(*) AS n FROM session_events WHERE session_id = ? AND kind = 'skill_invoked'",
      )
      .get(sessionId) as CountRow
  ).n;
  return { stepCount: tools + skills, toolCallCount: tools };
}

export function buildSessionResult(
  db: Database.Database,
  sessionId: string,
  opts: FinalizeOpts,
): SessionResult {
  const { stepCount, toolCallCount } = computeCounts(db, sessionId);
  return {
    sessionId,
    state: opts.state,
    tokensIn: opts.tokensIn ?? 0,
    tokensOut: opts.tokensOut ?? 0,
    durationMs: opts.durationMs ?? 0,
    costUsd: opts.costUsd ?? null,
    stepCount,
    toolCallCount,
    finalAnswer: opts.finalAnswer ?? null,
    errorMessage: opts.errorMessage ?? null,
  };
}

// Look up the most recent session_completed event for sessionId and
// reconstruct a SessionResult from its payload. Returns null if the
// session hasn't been finalized yet.
export function getExistingResult(
  db: Database.Database,
  sessionId: string,
): SessionResult | null {
  const row = db
    .prepare(
      "SELECT payload FROM session_events WHERE session_id = ? AND kind = 'session_completed' ORDER BY id DESC LIMIT 1",
    )
    .get(sessionId) as { payload?: string } | undefined;
  if (!row?.payload) return null;
  try {
    const p = JSON.parse(row.payload) as {
      state: SessionResultState;
      tokens_in: number;
      tokens_out: number;
      duration_ms: number;
      cost_usd: number | null;
      step_count: number;
      tool_call_count: number;
      final_answer: string | null;
      error_message: string | null;
    };
    return {
      sessionId,
      state: p.state,
      tokensIn: p.tokens_in,
      tokensOut: p.tokens_out,
      durationMs: p.duration_ms,
      costUsd: p.cost_usd,
      stepCount: p.step_count,
      toolCallCount: p.tool_call_count,
      finalAnswer: p.final_answer,
      errorMessage: p.error_message,
    };
  } catch {
    return null;
  }
}

function resultToPayload(result: SessionResult): Record<string, unknown> {
  return {
    state: result.state,
    tokens_in: result.tokensIn,
    tokens_out: result.tokensOut,
    duration_ms: result.durationMs,
    cost_usd: result.costUsd,
    step_count: result.stepCount,
    tool_call_count: result.toolCallCount,
    final_answer: result.finalAnswer,
    error_message: result.errorMessage,
  };
}

export function finalizeSession(
  sessionId: string,
  opts: FinalizeOpts,
): SessionResult {
  const db = initDb();
  const existing = getExistingResult(db, sessionId);
  if (existing) return existing;

  const result = buildSessionResult(db, sessionId, opts);

  emitAndDispatch(sessionId, 'session_completed', resultToPayload(result));

  if (opts.quality && opts.outcome) {
    const parent = (
      db
        .prepare('SELECT parent_session_id FROM sessions WHERE id = ?')
        .get(sessionId) as { parent_session_id?: string } | undefined
    )?.parent_session_id;
    if (parent) {
      emitAndDispatch(parent, 'subagent_completed', {
        child_session_id: sessionId,
        quality: opts.quality,
        outcome: opts.outcome,
      });
    }
  }

  return result;
}

// Test variant: takes an explicit Database handle and uses emitEventOn
// (no auto-dispatch). Tests run dispatchEventHandlers explicitly on
// the events this function returns so they can verify both PR3's emit
// payloads and PR2.D's handler chain end-to-end on the same in-memory
// DB without round-tripping through initDb().
export function finalizeSessionOn(
  db: Database.Database,
  sessionId: string,
  opts: FinalizeOpts,
): {
  result: SessionResult;
  primaryEvent: SessionEventRow | null;
  subagentEvent: SessionEventRow | null;
  alreadyFinalized: boolean;
} {
  const existing = getExistingResult(db, sessionId);
  if (existing) {
    return {
      result: existing,
      primaryEvent: null,
      subagentEvent: null,
      alreadyFinalized: true,
    };
  }

  const result = buildSessionResult(db, sessionId, opts);

  const primary = emitEventOn(
    db,
    sessionId,
    'session_completed',
    resultToPayload(result),
  );
  const primaryEvent = primary.ok ? primary.event : null;

  let subagentEvent: SessionEventRow | null = null;
  if (opts.quality && opts.outcome) {
    const parent = (
      db
        .prepare('SELECT parent_session_id FROM sessions WHERE id = ?')
        .get(sessionId) as { parent_session_id?: string } | undefined
    )?.parent_session_id;
    if (parent) {
      const sub = emitEventOn(db, parent, 'subagent_completed', {
        child_session_id: sessionId,
        quality: opts.quality,
        outcome: opts.outcome,
      });
      if (sub.ok) subagentEvent = sub.event;
    }
  }

  return { result, primaryEvent, subagentEvent, alreadyFinalized: false };
}
