import type { EventKind } from '../../events/schema.js';
import type { SessionResultState } from '../../sessions/result.js';

// T1A.PR4: Claude Code stream-json → jin event-kind mapper.
//
// Claude Code emits a JSON event per line on stdout when run with
// --output-format stream-json --verbose. The shapes we map:
//
//   system (subtype=init)        ignored — gateway already emits session_started
//   assistant (text content)     -> assistant_message
//   assistant (tool_use content) -> tool_invoked  (+ subagent_spawned for Skill/Task tools)
//   user (tool_result content)   -> tool_completed (+ subagent_completed when paired)
//   result                       -> finalize hint (state, tokens, cost, duration)
//   error                        -> finalize hint (state=error)
//   stream_event                 ignored — partial deltas, jin uses consolidated lines
//   rate_limit_event             ignored — surfaced separately by the engine adapter
//
// The parser is stateful per-session: it tracks running token totals
// (taken as max-so-far across the assistant + result lines), the last
// observed assistant text (for the SessionResult.finalAnswer fallback),
// and tool start times so tool_completed can carry duration_ms.
//
// Unknown event kinds increment ParserStats.unknownEventCount. CI alerts
// on this metric (per plan PR4 § "Risks / rollback") when Claude Code
// adds new event types so the parser can be extended.

export type ParserOutput =
  | { type: 'event'; kind: EventKind; payload: Record<string, unknown> }
  | {
      type: 'finalize';
      state: SessionResultState;
      tokensIn: number;
      tokensOut: number;
      durationMs: number;
      costUsd: number | null;
      finalAnswer: string | null;
      errorMessage: string | null;
    }
  | { type: 'unknown'; raw: unknown };

export interface ParserStats {
  unknownEventCount: number;
}

export interface ParserOpts {
  // Allows tests to pin Date.now() for deterministic tool durations.
  now?: () => number;
}

const SUBAGENT_TOOL_NAMES = new Set(['Skill', 'Task', 'Agent']);

export class ClaudeStreamParser {
  private startTimeMs: number;
  private tokensIn = 0;
  private tokensOut = 0;
  private finalText: string | null = null;
  // Per call_id bookkeeping so tool_completed can surface the tool name
  // (Claude pairs by id only on the user-side tool_result block) and the
  // duration relative to the tool_use line.
  private toolStarts = new Map<string, { tool: string; startMs: number }>();
  private skillToolCallIds = new Set<string>();
  private now: () => number;
  public stats: ParserStats = { unknownEventCount: 0 };

  constructor(opts: ParserOpts = {}) {
    this.now = opts.now ?? Date.now;
    this.startTimeMs = this.now();
  }

  parse(input: string | Record<string, unknown>): ParserOutput[] {
    let msg: Record<string, unknown>;
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) return [];
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return [{ type: 'unknown', raw: trimmed }];
      }
    } else {
      msg = input;
    }

    const t = String(msg.type || '');
    switch (t) {
      case 'system':
      case 'stream_event':
      case 'rate_limit_event':
        return [];
      case 'assistant':
        return this.handleAssistant(msg);
      case 'user':
        return this.handleUser(msg);
      case 'result':
        return this.handleResult(msg);
      case 'error':
        return this.handleError(msg);
      default:
        this.stats.unknownEventCount++;
        return [{ type: 'unknown', raw: msg }];
    }
  }

  // Force-finalize when the upstream stream ends without a result line
  // (e.g. SIGINT mid-tool). Caller supplies the terminal state.
  finalize(state: SessionResultState = 'cancelled', errorMessage: string | null = null): ParserOutput {
    return {
      type: 'finalize',
      state,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      durationMs: this.now() - this.startTimeMs,
      costUsd: null,
      finalAnswer: state === 'completed' ? this.finalText : null,
      errorMessage,
    };
  }

  // True when at least one tool_use was seen without a paired tool_result.
  // The cancelled fixture exposes this.
  hasOrphanToolInvocations(): boolean {
    return this.toolStarts.size > 0;
  }

  orphanToolCallIds(): string[] {
    return [...this.toolStarts.keys()];
  }

  // Snapshot of in-flight tool invocations (call_id → tool name).
  // Useful for the engine adapter to surface "still running X" diagnostics.
  inFlightTools(): Array<{ call_id: string; tool: string }> {
    return [...this.toolStarts.entries()].map(([call_id, v]) => ({ call_id, tool: v.tool }));
  }

  private updateUsage(usage: unknown): void {
    if (!usage || typeof usage !== 'object') return;
    const u = usage as { input_tokens?: number; output_tokens?: number };
    if (typeof u.input_tokens === 'number') {
      this.tokensIn = Math.max(this.tokensIn, u.input_tokens);
    }
    if (typeof u.output_tokens === 'number') {
      this.tokensOut = Math.max(this.tokensOut, u.output_tokens);
    }
  }

  private handleAssistant(msg: Record<string, unknown>): ParserOutput[] {
    const message = msg.message as Record<string, unknown> | undefined;
    if (!message) return [];

    this.updateUsage(message.usage);
    const messageId = String(message.id || '');
    const content = (message.content as Array<Record<string, unknown>> | undefined) || [];
    const out: ParserOutput[] = [];

    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        this.finalText = block.text;
        out.push({
          type: 'event',
          kind: 'assistant_message',
          payload: { text: block.text, message_id: messageId },
        });
      } else if (block.type === 'tool_use') {
        const callId = String(block.id || '');
        const tool = String(block.name || 'unknown');
        const args = block.input ?? null;
        if (callId) this.toolStarts.set(callId, { tool, startMs: this.now() });

        if (SUBAGENT_TOOL_NAMES.has(tool)) {
          this.skillToolCallIds.add(callId);
          const argsRecord = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
          out.push({
            type: 'event',
            kind: 'subagent_spawned',
            payload: {
              child_session_id: String(argsRecord.subagent_type || argsRecord.skill || callId),
              kind: tool,
              brief: String(argsRecord.description || argsRecord.prompt || '').slice(0, 500),
            },
          });
        }

        out.push({
          type: 'event',
          kind: 'tool_invoked',
          payload: { tool, call_id: callId, args },
        });
      }
    }

    return out;
  }

  private handleUser(msg: Record<string, unknown>): ParserOutput[] {
    const message = msg.message as Record<string, unknown> | undefined;
    if (!message) return [];
    const content = (message.content as Array<Record<string, unknown>> | undefined) || [];
    const out: ParserOutput[] = [];

    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const callId = String(block.tool_use_id || '');
      const isError = block.is_error === true;
      const resultContent = block.content;
      const start = this.toolStarts.get(callId);
      const duration = start ? this.now() - start.startMs : 0;
      // tool_completed.tool must be non-empty per the PR2.A schema; fall
      // back to '(unknown)' if we somehow get a tool_result without a
      // matching tool_use (shouldn't happen, but the schema enforces it).
      const tool = start?.tool || '(unknown)';
      this.toolStarts.delete(callId);

      out.push({
        type: 'event',
        kind: 'tool_completed',
        payload: {
          tool,
          call_id: callId,
          result: isError ? null : resultContent ?? null,
          error: isError
            ? (typeof resultContent === 'string' ? resultContent : 'tool error')
            : null,
          duration_ms: duration,
        },
      });

      if (this.skillToolCallIds.has(callId)) {
        this.skillToolCallIds.delete(callId);
        out.push({
          type: 'event',
          kind: 'subagent_completed',
          payload: {
            child_session_id: callId,
            // Quality is unknown at parse time; downstream raters
            // (Producer-Critic, /eval) refine this. 'good' is the
            // neutral baseline so episode_capture (which needs
            // 'excellent') doesn't fire from a synthetic guess.
            quality: 'good',
            outcome: isError ? 'failed' : 'success',
          },
        });
      }
    }

    return out;
  }

  private handleResult(msg: Record<string, unknown>): ParserOutput[] {
    const subtype = String(msg.subtype || 'success');
    const isError = msg.is_error === true || subtype.startsWith('error_');
    this.updateUsage(msg.usage);

    const cost = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null;
    const duration =
      typeof msg.duration_ms === 'number' ? msg.duration_ms : this.now() - this.startTimeMs;
    const resultText =
      typeof msg.result === 'string' && (msg.result as string).length > 0
        ? (msg.result as string)
        : this.finalText;
    const errMsg = isError
      ? String(msg.error || msg.error_message || subtype || 'error')
      : null;

    let state: SessionResultState = 'completed';
    if (subtype === 'error_max_turns') state = 'max_iterations';
    else if (isError) state = 'error';

    return [{
      type: 'finalize',
      state,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      durationMs: duration,
      costUsd: cost,
      finalAnswer: errMsg ? null : resultText,
      errorMessage: errMsg,
    }];
  }

  private handleError(msg: Record<string, unknown>): ParserOutput[] {
    const errMsg = String(msg.error || msg.message || 'unknown error');
    return [{
      type: 'finalize',
      state: 'error',
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      durationMs: this.now() - this.startTimeMs,
      costUsd: null,
      finalAnswer: null,
      errorMessage: errMsg,
    }];
  }
}

// Convenience: parse a whole transcript (array of lines or already-
// parsed objects) and collect the outputs.
export function parseTranscript(
  lines: Array<string | Record<string, unknown>>,
  opts: ParserOpts = {},
): { outputs: ParserOutput[]; parser: ClaudeStreamParser } {
  const parser = new ClaudeStreamParser(opts);
  const outputs: ParserOutput[] = [];
  for (const line of lines) {
    for (const o of parser.parse(line)) outputs.push(o);
  }
  return { outputs, parser };
}
