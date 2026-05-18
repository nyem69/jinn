/**
 * Provider-agnostic agent loop for the V1 HTTP engines (ollama, openai).
 *
 * Error taxonomy (distinct kinds, never collapsed):
 *
 *   - Provider parse / transport errors (the adapter threw or returned a
 *     malformed payload) bubble up as `kind: "provider_error"` and abort
 *     the loop. The engine wrapper translates this to EngineResult.error.
 *
 *   - Loop control errors — wall-clock timeout (`kind: "timeout"`) and
 *     max-turn exhaustion (`kind: "max_turns"`) — also abort the loop.
 *
 *   - Tool execution errors stay model-visible: the tool returns
 *     `{ok: false, content, audit}`, we feed `content` back as a `tool`
 *     role message, the loop counts the turn, and the model decides what
 *     to do next. These never abort the loop.
 *
 *   - Unknown tool calls (model invented a name that isn't registered)
 *     are treated the same as tool errors: synthetic
 *     `{ok: false, content: "Unknown tool: ..."}`, fed back as a tool
 *     message, turn counted, loop continues.
 *
 *   - A tool executor that throws unexpectedly is also treated as a tool
 *     error (synthesized result), not a loop abort. The exception text
 *     surfaces in the tool message so the model can recover.
 *
 * Pre-call gates:
 *   - Before every provider call: check turns < maxTurns AND now < deadline.
 *   - Before every individual tool call (inside a multi-tool turn): same.
 */

import type { ProviderCall, ProviderCallResult, ProviderMessage, ProviderToolDef } from "./providers/types.js";
import type { ToolExecutionContext, ToolResult } from "./tools/types.js";
import type { ToolExecutor } from "./tools/index.js";
import { buildAuditRow, type AuditLogger, type AuditRow } from "./audit.js";
import { logger } from "../shared/logger.js";

export interface AgentLoopOpts {
  /** Provider adapter (openai or ollama). */
  provider: ProviderCall;
  /** Tool name → executor (built per-engine via buildToolRegistry). */
  toolExecutors: Map<string, ToolExecutor>;
  /** Schemas exposed to the model — must match toolExecutors. */
  toolSchemas: ProviderToolDef[];
  /** Model to bill against. */
  model: string;
  /** Optional system prompt. */
  systemPrompt?: string;
  /** Initial user prompt. */
  userPrompt: string;
  /** Max provider calls before aborting with kind="max_turns". */
  maxTurns: number;
  /** Wall-clock budget for the whole loop, ms. */
  timeoutMs: number;
  /** ToolExecutionContext shared by every tool call. */
  toolContext: ToolExecutionContext;
  /** Optional audit sink. When present, every successful tool call is recorded. */
  audit?: AuditLogger;
  /** Optional per-provider-call timeout override (ms). Default = remaining budget. */
  providerTimeoutMs?: number;
}

interface AgentLoopUsage {
  promptTokens: number;
  completionTokens: number;
  /** Distinct models actually billed (may include router-routed alts). */
  billedModels: string[];
}

interface AgentLoopBase extends AgentLoopUsage {
  turns: number;
  /** Wall-clock duration of the whole loop, in milliseconds. */
  durationMs: number;
}

export interface AgentLoopOk extends AgentLoopBase {
  kind: "ok";
  finalContent: string;
  /** Each `{role: tool}` message accumulated during the loop. Mostly for tests. */
  toolMessages: ProviderMessage[];
}

export interface AgentLoopErr extends AgentLoopBase {
  kind: "provider_error" | "max_turns" | "timeout";
  message: string;
}

export type AgentLoopResult = AgentLoopOk | AgentLoopErr;

export async function runAgentLoop(opts: AgentLoopOpts): Promise<AgentLoopResult> {
  const messages: ProviderMessage[] = [];
  if (opts.systemPrompt) messages.push({ role: "system", content: opts.systemPrompt });
  messages.push({ role: "user", content: opts.userPrompt });

  const loopStart = Date.now();
  const deadline = loopStart + opts.timeoutMs;
  let promptTokens = 0;
  let completionTokens = 0;
  const billedModels: string[] = [];
  const toolMessages: ProviderMessage[] = [];

  for (let turn = 0; turn < opts.maxTurns; turn++) {
    // Gate 1: wall-clock check BEFORE provider call.
    if (Date.now() >= deadline) {
      return {
        kind: "timeout",
        message: `loop deadline exceeded before provider call at turn ${turn}`,
        turns: turn,
        durationMs: Date.now() - loopStart,
        promptTokens,
        completionTokens,
        billedModels,
      };
    }

    const remaining = deadline - Date.now();
    const providerTimeout = Math.min(opts.providerTimeoutMs ?? remaining, remaining);

    let providerResult: ProviderCallResult;
    try {
      providerResult = await opts.provider({
        messages,
        tools: opts.toolSchemas,
        model: opts.model,
        timeoutMs: providerTimeout,
      });
    } catch (err) {
      return {
        kind: "provider_error",
        message: (err as Error).message,
        turns: turn,
        durationMs: Date.now() - loopStart,
        promptTokens,
        completionTokens,
        billedModels,
      };
    }

    promptTokens += providerResult.usage.promptTokens;
    completionTokens += providerResult.usage.completionTokens;
    if (!billedModels.includes(providerResult.billedModel)) {
      billedModels.push(providerResult.billedModel);
    }

    // Append the assistant turn to history.
    messages.push(providerResult.message);

    const toolCalls = providerResult.message.toolCalls ?? [];
    if (toolCalls.length === 0) {
      // Terminal: model decided not to call any tool.
      return {
        kind: "ok",
        finalContent: providerResult.message.content,
        turns: turn + 1,
        durationMs: Date.now() - loopStart,
        promptTokens,
        completionTokens,
        billedModels,
        toolMessages,
      };
    }

    // Execute each tool call sequentially.
    for (const tc of toolCalls) {
      // Gate 2: wall-clock check BEFORE every individual tool call.
      if (Date.now() >= deadline) {
        return {
          kind: "timeout",
          message: `loop deadline exceeded before tool call "${tc.name}" at turn ${turn}`,
          turns: turn + 1,
          durationMs: Date.now() - loopStart,
          promptTokens,
          completionTokens,
          billedModels,
        };
      }

      const executor = opts.toolExecutors.get(tc.name);
      const callStart = Date.now();
      let result: ToolResult;

      if (!executor) {
        // Unknown tool — synthesize a structured error result, do NOT throw.
        const known = [...opts.toolExecutors.keys()];
        result = {
          ok: false,
          content: JSON.stringify({
            error: "unknown_tool",
            requested: tc.name,
            available: known,
          }),
          audit: { truncated: false, error: "unknown_tool" },
        };
      } else {
        try {
          result = await executor(tc.arguments, opts.toolContext);
        } catch (err) {
          // Executor threw unexpectedly. Surface as a structured tool
          // error so the model can recover, and record the exception in
          // audit. Do NOT abort the loop.
          result = {
            ok: false,
            content: JSON.stringify({
              error: "tool_exception",
              message: (err as Error).message,
            }),
            audit: { truncated: false, error: "tool_exception" },
          };
        }
      }

      const toolDurationMs = Date.now() - callStart;

      if (opts.audit) {
        const row = buildAuditRow(tc.name, tc.arguments, result, toolDurationMs, {
          sessionId: opts.toolContext.sessionId,
          engineName: opts.toolContext.engineName,
        });
        await safeAudit(opts.audit, row, tc.name);
      }

      const toolMessage: ProviderMessage = {
        role: "tool",
        content: result.content,
        toolCallId: tc.id,
        name: tc.name,
      };
      messages.push(toolMessage);
      toolMessages.push(toolMessage);
    }
  }

  // Loop exited without a terminal assistant message.
  return {
    kind: "max_turns",
    message: `loop reached maxTurns=${opts.maxTurns} without a final assistant message`,
    turns: opts.maxTurns,
    durationMs: Date.now() - loopStart,
    promptTokens,
    completionTokens,
    billedModels,
  };
}

async function safeAudit(audit: AuditLogger, row: AuditRow, toolName: string): Promise<void> {
  try {
    await audit.record(row);
  } catch (err) {
    // Audit failures must NOT break the loop, but they MUST be visible —
    // log via the gateway logger so persistent sink issues are surfaced
    // (e.g. sqlite-locked, disk full, schema drift).
    const msg = (err as Error)?.message ?? String(err);
    logger.warn(`agentLoop: audit sink failed for tool "${toolName}": ${msg}`);
  }
}
