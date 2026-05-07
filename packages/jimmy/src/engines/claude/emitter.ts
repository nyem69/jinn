import type Database from 'better-sqlite3';
import { logger } from '../../shared/logger.js';
import { emitAndDispatch, emitEventOn } from '../../events/emit.js';
import { finalizeSession, finalizeSessionOn } from '../../sessions/result.js';
import type { SessionResult } from '../../sessions/result.js';
import { ClaudeStreamParser, type ParserOpts, type ParserOutput } from './parser.js';

// T1A.PR4: thin emitter — routes ParserOutput onto the jin event log.
//
// Production path uses emitAndDispatch (which fires PR2.D handlers) and
// finalizeSession (which is itself idempotent and emits session_completed
// via emitAndDispatch). The injected variant (dispatchParserOutputOn)
// takes an explicit Database handle for tests, mirroring the pattern in
// PR3 — emit via emitEventOn (no auto-dispatch) so the test can run
// dispatch / cost_log assertions on the same in-memory DB.
//
// Transport: read JIN_CLAUDE_EVENT_TRANSPORT once and cache. The plan's
// rollout default is 'off' (gateway falls back to existing summary path);
// flip to 'stdout' once soaked, and 'sideband' once a Claude Code
// release ships --event-fd or equivalent.

export type ClaudeTransport = 'sideband' | 'stdout' | 'off';

export function getClaudeTransport(env: NodeJS.ProcessEnv = process.env): ClaudeTransport {
  const v = (env.JIN_CLAUDE_EVENT_TRANSPORT || '').toLowerCase();
  if (v === 'sideband' || v === 'stdout') return v;
  if (v === 'off') return 'off';
  return 'off';
}

export function dispatchParserOutput(
  sessionId: string,
  output: ParserOutput,
): SessionResult | null {
  if (output.type === 'event') {
    emitAndDispatch(sessionId, output.kind, output.payload);
    return null;
  }
  if (output.type === 'finalize') {
    return finalizeSession(sessionId, {
      state: output.state,
      tokensIn: output.tokensIn,
      tokensOut: output.tokensOut,
      durationMs: output.durationMs,
      costUsd: output.costUsd,
      finalAnswer: output.finalAnswer,
      errorMessage: output.errorMessage,
    });
  }
  // unknown — log at debug; CI watches ParserStats.unknownEventCount for alerts.
  if (output.type === 'unknown') {
    const summary = JSON.stringify(output.raw).slice(0, 200);
    logger.debug(`[claude parser] unknown event: ${summary}`);
  }
  return null;
}

// Test variant: explicit DB, no auto-dispatch on emits, no initDb()
// hop. Returns the same shape as finalizeSessionOn for the finalize
// branch so callers can chain the result + emitted events.
export function dispatchParserOutputOn(
  db: Database.Database,
  sessionId: string,
  output: ParserOutput,
): {
  result: SessionResult | null;
  primaryEvent: ReturnType<typeof emitEventOn> | null;
} {
  if (output.type === 'event') {
    const r = emitEventOn(db, sessionId, output.kind, output.payload);
    return { result: null, primaryEvent: r };
  }
  if (output.type === 'finalize') {
    const fin = finalizeSessionOn(db, sessionId, {
      state: output.state,
      tokensIn: output.tokensIn,
      tokensOut: output.tokensOut,
      durationMs: output.durationMs,
      costUsd: output.costUsd,
      finalAnswer: output.finalAnswer,
      errorMessage: output.errorMessage,
    });
    return { result: fin.result, primaryEvent: null };
  }
  return { result: null, primaryEvent: null };
}

// Entry point used by the engine adapter when transport != 'off'. Drives
// the parser line by line, dispatches each output, and returns the final
// SessionResult (or null if the stream ended without a finalize).
export function runClaudeStream(
  sessionId: string,
  lines: AsyncIterable<string> | Iterable<string>,
  opts: ParserOpts = {},
): Promise<SessionResult | null> {
  const parser = new ClaudeStreamParser(opts);
  let result: SessionResult | null = null;
  return (async () => {
    for await (const line of lines as AsyncIterable<string>) {
      for (const out of parser.parse(line)) {
        const finalized = dispatchParserOutput(sessionId, out);
        if (finalized) result = finalized;
      }
    }
    if (!result && parser.hasOrphanToolInvocations()) {
      // Stream ended mid-tool — synthesize a cancelled finalize.
      const fin = parser.finalize('cancelled', 'stream ended without result line');
      result = dispatchParserOutput(sessionId, fin);
    }
    return result;
  })();
}
