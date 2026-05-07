import type Database from 'better-sqlite3';
import { initDb } from '../sessions/registry.js';
import { logger } from '../shared/logger.js';
import { rowToSessionEvent, type SessionEventRow } from './db.js';
import { validateEvent } from './schema.js';
import { dispatchEventHandlers } from './handlers.js';

// T1A.PR2: gateway-internal write path. Every emitter (engine parsers,
// skill harnesses, manual API callers under the loopback auth) funnels
// through emitEvent so schema validation and seq assignment happen in
// one place.

export interface EmitOk {
  ok: true;
  event: SessionEventRow;
}

export interface EmitErr {
  ok: false;
  // 'unknown_session' -- session_id not in sessions table
  // 'invalid_payload' -- failed Zod validation
  // 'collision' -- caller-supplied seq already taken (caller-supplied path only)
  reason: 'unknown_session' | 'invalid_payload' | 'collision';
  errors?: Array<{ path: string; message: string }>;
}

export interface EmitOpts {
  // Optional caller-supplied seq for replay/import workflows. If omitted
  // the gateway assigns the next monotonic value for that session.
  seq?: number;
}

export function emitEvent(
  sessionId: string,
  kind: string,
  payload: unknown,
  opts: EmitOpts = {},
): EmitOk | EmitErr {
  const db = initDb();
  return emitEventOn(db, sessionId, kind, payload, opts);
}

// Same as emitEvent but takes an explicit Database handle so tests can
// run against an in-memory DB without touching the global initDb().
export function emitEventOn(
  db: Database.Database,
  sessionId: string,
  kind: string,
  payload: unknown,
  opts: EmitOpts = {},
): EmitOk | EmitErr {
  const validated = validateEvent(kind, payload);
  if (!validated.ok) {
    return { ok: false, reason: 'invalid_payload', errors: validated.errors };
  }

  // Resolve root_session_id from the sessions row. PR1 guarantees the
  // invariant root_session_id IS NOT NULL, so a missing value here means
  // the caller passed an unknown session id.
  const sess = db
    .prepare('SELECT root_session_id FROM sessions WHERE id = ?')
    .get(sessionId) as { root_session_id?: string } | undefined;
  if (!sess?.root_session_id) {
    return { ok: false, reason: 'unknown_session' };
  }

  const payloadJson = JSON.stringify(validated.payload);

  // seq assignment: per-session monotonic. We compute the next value
  // inside a transaction with the insert so two concurrent emits can't
  // race to the same seq -- better-sqlite3 is synchronous so this is
  // effectively serialized, but the pattern stays correct if the engine
  // ever moves to async.
  const txn = db.transaction((sid: string, supplied: number | undefined) => {
    const seq =
      supplied ??
      ((db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM session_events WHERE session_id = ?').get(sid) as { n: number }).n);

    try {
      const info = db
        .prepare(
          `INSERT INTO session_events (session_id, root_session_id, seq, kind, payload)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sid, sess.root_session_id, seq, kind, payloadJson);
      return { id: info.lastInsertRowid as number, seq };
    } catch (e) {
      const msg = (e as Error).message || '';
      if (msg.includes('UNIQUE') && msg.includes('session_events.session_id, session_events.seq')) {
        return { collision: true as const };
      }
      throw e;
    }
  });

  const result = txn(sessionId, opts.seq);
  if ('collision' in result) {
    return { ok: false, reason: 'collision' };
  }

  const row = db
    .prepare('SELECT * FROM session_events WHERE id = ?')
    .get(result.id) as Record<string, unknown>;

  return { ok: true, event: rowToSessionEvent(row) };
}

// emitAndDispatch — convenience wrapper that fires the default handler
// dispatch as a fire-and-forget side effect after a successful emit.
// Production callers (gateway POST /events, engine emitters) should use
// this; tests + replay use the bare emitEvent.
export function emitAndDispatch(
  sessionId: string,
  kind: string,
  payload: unknown,
  opts: EmitOpts = {},
): EmitOk | EmitErr {
  const result = emitEvent(sessionId, kind, payload, opts);
  if (result.ok) {
    queueMicrotask(() => {
      const db = initDb();
      void dispatchEventHandlers(db, result.event).catch((e) => {
        logger.error(
          `dispatchEventHandlers crashed for event ${result.event.id}: ${(e as Error).message}`,
        );
      });
    });
  }
  return result;
}
