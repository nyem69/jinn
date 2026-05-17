/**
 * Ollama engine wrapper — implements the Engine interface by composing
 * the Ollama provider adapter (Phase 2), the tool registry (Phase 6),
 * and the agent loop (Phase 6).
 *
 * V1 posture: non-streaming, no resume, no MCP, no attachments, no
 * cliFlags. Each of those produces a clean EngineResult.error BEFORE
 * any provider HTTP call.
 *
 * Construction-time validation:
 *   - config.url is required (throws if missing)
 *   - if config.authTokenEnvVar is set, the env var is consulted
 *     (no error if absent — Ollama may run unauthenticated)
 *
 * Per-call validation:
 *   - opts.model || config.model || error
 *   - reject unsupported features before touching the network
 */

import { randomUUID } from "node:crypto";
import type { Engine, EngineRunOpts, EngineResult, OllamaConfig } from "../shared/types.js";
import type { JsonObject, JsonValue } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { createOllamaProvider } from "./providers/ollama.js";
import { ollamaCostFor } from "./providers/pricing.js";
import { buildToolRegistry, type ToolRegistry } from "./tools/index.js";
import { runAgentLoop, type AgentLoopResult } from "./agentLoop.js";
import type { AuditLogger } from "./audit.js";
import type { ProviderCall } from "./providers/types.js";

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_LOOP_TIMEOUT_MS = 300_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;

export class OllamaEngine implements Engine {
  name = "ollama" as const;

  private readonly provider: ProviderCall;
  private readonly toolRegistry: ToolRegistry;
  private readonly defaultModel: string | undefined;
  private readonly maxTurns: number;
  private readonly loopTimeoutMs: number;
  private readonly providerTimeoutMs: number;
  private readonly audit: AuditLogger | undefined;
  private readonly toolOpts: Record<string, JsonObject>;

  constructor(config: OllamaConfig, opts: { audit?: AuditLogger } = {}) {
    if (!config.url) {
      throw new Error("ollama: config.url is required (engines.ollama.url in config.yaml)");
    }

    const tokenEnvVar = config.authTokenEnvVar ?? "OLLAMA_TOKEN";
    const token = process.env[tokenEnvVar];

    this.provider = createOllamaProvider({ baseUrl: config.url, token });
    this.toolRegistry = buildToolRegistry(config.tools);
    if (this.toolRegistry.unknownRequested.length > 0) {
      logger.warn(
        `ollama: engines.ollama.tools.enabled lists unknown names: ${this.toolRegistry.unknownRequested.join(", ")}`,
      );
    }

    this.defaultModel = config.model;
    this.maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
    this.loopTimeoutMs = config.timeoutMs ?? DEFAULT_LOOP_TIMEOUT_MS;
    this.providerTimeoutMs = config.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    this.audit = opts.audit;
    this.toolOpts = buildToolOpts(config);
  }

  async run(runOpts: EngineRunOpts): Promise<EngineResult> {
    const sessionId = runOpts.sessionId ?? randomUUID();

    const unsupported = rejectUnsupported(this.name, runOpts);
    if (unsupported) {
      return { sessionId, result: "", error: unsupported };
    }

    const model = runOpts.model || this.defaultModel;
    if (!model) {
      return {
        sessionId,
        result: "",
        error: `ollama: no model resolved (set engines.ollama.model in config or pass opts.model)`,
      };
    }

    const loopResult = await runAgentLoop({
      provider: this.provider,
      toolExecutors: this.toolRegistry.executors,
      toolSchemas: this.toolRegistry.schemas,
      model,
      systemPrompt: runOpts.systemPrompt,
      userPrompt: runOpts.prompt,
      maxTurns: this.maxTurns,
      timeoutMs: this.loopTimeoutMs,
      providerTimeoutMs: this.providerTimeoutMs,
      toolContext: {
        cwd: runOpts.cwd,
        sessionId,
        engineName: this.name,
        toolOpts: this.toolOpts,
      },
      audit: this.audit,
    });

    return mapLoopResult(sessionId, loopResult, this.name);
  }
}

/** Ollama cost is always 0 (self-hosted). */
function mapLoopResult(sessionId: string, r: AgentLoopResult, engineName: string): EngineResult {
  const cost = ollamaCostFor(r.billedModels[0] ?? "", r.promptTokens, r.completionTokens);
  if (r.kind === "ok") {
    return {
      sessionId,
      result: r.finalContent,
      cost,
      durationMs: r.durationMs,
      numTurns: r.turns,
    };
  }
  return {
    sessionId,
    result: "",
    error: `${engineName}: ${r.kind}: ${r.message}`,
    cost,
    durationMs: r.durationMs,
    numTurns: r.turns,
  };
}

/**
 * Translate the user-facing EngineToolsConfig shape into the
 * ToolExecutionContext.toolOpts shape the tool executors read at runtime.
 * Keeps config naming friendly (`bashAllowlist`) while preserving the
 * runtime key the tool expects (`bash.allowlist`).
 */
function buildToolOpts(config: OllamaConfig): Record<string, JsonObject> {
  const t = config.tools;
  if (!t) return {};
  const out: Record<string, JsonObject> = {};
  if (t.bashAllowlist || t.bash) {
    out.bash = {
      allowlist: (t.bashAllowlist ?? []) as JsonValue,
      ...(t.bash ?? {}),
    } as JsonObject;
  }
  if (t.read) out.read = { ...t.read } as JsonObject;
  if (t.webfetch) out.webfetch = { ...t.webfetch } as JsonObject;
  return out;
}

/**
 * Validate per-call options BEFORE any provider call. Returns a
 * descriptive error string if the request is incompatible with V1
 * semantics, or undefined if it can proceed.
 */
export function rejectUnsupported(engineName: string, runOpts: EngineRunOpts): string | undefined {
  if (runOpts.resumeSessionId) {
    return `${engineName}: resumeSessionId is not supported in V1; multi-turn resume is reserved for claude/codex/gemini`;
  }
  if (runOpts.mcpConfigPath) {
    return `${engineName}: MCP servers are not supported in V1`;
  }
  if (runOpts.attachments && runOpts.attachments.length > 0) {
    return `${engineName}: attachments are not supported in V1`;
  }
  if (runOpts.cliFlags && runOpts.cliFlags.length > 0) {
    return `${engineName}: cliFlags are not supported (engine is HTTP-based, has no CLI)`;
  }
  return undefined;
}
