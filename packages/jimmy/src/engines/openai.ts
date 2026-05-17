/**
 * OpenAI engine wrapper — same shape as OllamaEngine but reads
 * apiKey from env at construction and computes cost via the OpenAI
 * pricing table (Phase 2). cost is `undefined` when the billed model
 * is not in the pricing table — the cost_log row goes to NULL and the
 * weekly rollup surfaces the gap.
 *
 * Construction-time validation:
 *   - API key required (read from process.env[config.apiKeyEnvVar ??
 *     "OPENAI_API_KEY"]); throws if missing.
 *
 * Per-call validation mirrors OllamaEngine: rejectUnsupported() runs
 * BEFORE any provider call.
 */

import { randomUUID } from "node:crypto";
import type { Engine, EngineRunOpts, EngineResult, OpenAIConfig } from "../shared/types.js";
import type { JsonObject, JsonValue } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { createOpenAIProvider } from "./providers/openai.js";
import { openaiCostFor } from "./providers/pricing.js";
import { buildToolRegistry, type ToolRegistry } from "./tools/index.js";
import { runAgentLoop, type AgentLoopResult } from "./agentLoop.js";
import type { AuditLogger } from "./audit.js";
import type { ProviderCall } from "./providers/types.js";
import { rejectUnsupported } from "./ollama.js";

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_LOOP_TIMEOUT_MS = 300_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;

export class OpenAIEngine implements Engine {
  name = "openai" as const;

  private readonly provider: ProviderCall;
  private readonly toolRegistry: ToolRegistry;
  private readonly defaultModel: string | undefined;
  private readonly maxTurns: number;
  private readonly loopTimeoutMs: number;
  private readonly providerTimeoutMs: number;
  private readonly audit: AuditLogger | undefined;
  private readonly toolOpts: Record<string, JsonObject>;

  constructor(config: OpenAIConfig, opts: { audit?: AuditLogger } = {}) {
    const apiKeyEnvVar = config.apiKeyEnvVar ?? "OPENAI_API_KEY";
    const apiKey = process.env[apiKeyEnvVar];
    if (!apiKey || apiKey.length === 0) {
      throw new Error(
        `openai: missing API key — env var "${apiKeyEnvVar}" is unset or empty`,
      );
    }
    this.provider = createOpenAIProvider({ apiKey, baseUrl: config.baseUrl });
    this.toolRegistry = buildToolRegistry(config.tools);
    if (this.toolRegistry.unknownRequested.length > 0) {
      logger.warn(
        `openai: engines.openai.tools.enabled lists unknown names: ${this.toolRegistry.unknownRequested.join(", ")}`,
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
        error: `openai: no model resolved (set engines.openai.model in config or pass opts.model)`,
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

/**
 * Compute USD cost from accumulated usage. Uses billedModels[0] (the
 * first model the provider actually billed against — may differ from
 * the requested model if the provider routes silently). Returns
 * undefined when the model is not in the pricing table.
 */
function mapLoopResult(sessionId: string, r: AgentLoopResult, engineName: string): EngineResult {
  const billed = r.billedModels[0] ?? "";
  const cost = openaiCostFor(billed, r.promptTokens, r.completionTokens);
  if (cost === undefined && billed) {
    logger.warn(
      `openai: unknown pricing for model "${billed}"; cost_log row will record NULL`,
    );
  }
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

function buildToolOpts(config: OpenAIConfig): Record<string, JsonObject> {
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
