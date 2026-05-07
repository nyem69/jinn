import type Database from 'better-sqlite3';
import { readEventsSingleOn, readEventsSubtreeOn } from './api.js';
import type { SessionEventRow } from './db.js';

// T1A.PR2.C: Server-Sent Events live tail over the event log.
//
// Two modes mirror the read API's two cursor models:
// - single: paginates per-session `seq`. Stable cursor under sibling
//   activity. Reconnect via `since_seq` query param OR `Last-Event-ID`
//   header (the latter carries the GLOBAL id which is also stored on
//   the session_events row, so we keep both cursors in sync per-emit).
// - subtree: paginates the GLOBAL `id`. Required for reading a tree
//   because per-session seq would silently drop sibling-descendant
//   events.
//
// Backpressure: if write() returns false (kernel send buffer full), we
// arm a 30s drop timer. The drain handler cancels it. If 30s elapses
// without drain, we close the stream — the client reconnects via the
// cursor and resumes from where it left off, no event loss.

export type SseMode = 'single' | 'subtree';

// Minimal interface so tests don't need a real http server. The gateway
// wraps a ServerResponse to satisfy this shape.
export interface SseClient {
  write(chunk: string): boolean;
  end(): void;
  onClose(handler: () => void): void;
  onDrain(handler: () => void): void;
}

export interface SseOptions {
  mode: SseMode;
  sessionId: string;
  cursorSeq?: number;
  cursorId?: number;
  pollMs?: number;
  heartbeatMs?: number;
  slowConsumerDropMs?: number;
  pageLimit?: number;
}

export interface SseHandle {
  stop(reason?: string): void;
  isStopped(): boolean;
}

const DEFAULT_POLL_MS = 250;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_SLOW_DROP_MS = 30_000;
const DEFAULT_PAGE_LIMIT = 200;

export function formatEventFrame(e: SessionEventRow): string {
  const data = JSON.stringify({
    id: e.id,
    session_id: e.sessionId,
    seq: e.seq,
    kind: e.kind,
    payload: e.payload,
    created_at: e.createdAt,
  });
  return `event: session_event\nid: ${e.id}\ndata: ${data}\n\n`;
}

export function formatHeartbeatFrame(): string {
  return `event: heartbeat\ndata: {}\n\n`;
}

export function startSseStream(
  db: Database.Database,
  client: SseClient,
  opts: SseOptions,
): SseHandle {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const slowDropMs = opts.slowConsumerDropMs ?? DEFAULT_SLOW_DROP_MS;
  const limit = opts.pageLimit ?? DEFAULT_PAGE_LIMIT;

  let cursorSeq = opts.cursorSeq ?? 0;
  let cursorId = opts.cursorId ?? 0;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;
  let lastWriteAt = Date.now();

  function clearTimers(): void {
    if (pollTimer) clearTimeout(pollTimer);
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (slowTimer) clearTimeout(slowTimer);
    pollTimer = heartbeatTimer = slowTimer = null;
  }

  function stop(_reason?: string): void {
    if (stopped) return;
    stopped = true;
    clearTimers();
    try {
      client.end();
    } catch {
      // socket may already be torn down; ignore
    }
  }

  function send(chunk: string): void {
    if (stopped) return;
    const flushed = client.write(chunk);
    lastWriteAt = Date.now();
    if (!flushed && !slowTimer) {
      slowTimer = setTimeout(() => stop('slow_consumer'), slowDropMs);
    }
  }

  client.onDrain(() => {
    if (slowTimer) {
      clearTimeout(slowTimer);
      slowTimer = null;
    }
  });

  client.onClose(() => {
    if (stopped) return;
    stopped = true;
    clearTimers();
  });

  function poll(): void {
    if (stopped) return;
    let pageWasFull = false;
    try {
      if (opts.mode === 'single') {
        const r = readEventsSingleOn(db, opts.sessionId, { sinceSeq: cursorSeq, limit });
        for (const e of r.events) {
          send(formatEventFrame(e));
          cursorSeq = e.seq;
          if (e.id > cursorId) cursorId = e.id;
        }
        pageWasFull = r.events.length === limit;
      } else {
        const r = readEventsSubtreeOn(db, opts.sessionId, { afterId: cursorId, limit });
        for (const e of r.events) {
          send(formatEventFrame(e));
          cursorId = e.id;
        }
        pageWasFull = r.events.length === limit;
      }
    } catch {
      stop('db_error');
      return;
    }

    if (!stopped) {
      // If we drained a full page, more events may already be queued;
      // re-poll immediately. Otherwise back off to pollMs.
      const nextDelay = pageWasFull ? 0 : pollMs;
      pollTimer = setTimeout(poll, nextDelay);
    }
  }

  function heartbeat(): void {
    if (stopped) return;
    if (Date.now() - lastWriteAt >= heartbeatMs) {
      send(formatHeartbeatFrame());
    }
    if (!stopped) heartbeatTimer = setTimeout(heartbeat, heartbeatMs);
  }

  // Drain any backlog before scheduling the steady-state pollers.
  pollTimer = setTimeout(poll, 0);
  heartbeatTimer = setTimeout(heartbeat, heartbeatMs);

  return {
    stop,
    isStopped: () => stopped,
  };
}

// Parse a Last-Event-ID header value into a global id cursor. Returns
// undefined when missing or unparseable so the caller can fall back to
// query params.
export function parseLastEventId(value: string | string[] | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const n = parseInt(value.trim(), 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

// Single-session reconnect: the SSE id field carries the global id, but
// single-session pagination uses per-session seq. Resolve the global id
// back to its seq via the row. Returns undefined when the row is not
// found (caller falls back to the since_seq query param).
export function resolveSingleCursorFromLastEventId(
  db: Database.Database,
  sessionId: string,
  lastEventId: number,
): number | undefined {
  const row = db
    .prepare('SELECT seq FROM session_events WHERE id = ? AND session_id = ?')
    .get(lastEventId, sessionId) as { seq?: number } | undefined;
  return row?.seq;
}
