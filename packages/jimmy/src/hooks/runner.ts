import type { HookDefinition, HooksConfig } from "../shared/types.js";
import type {
  PreSessionContext,
  PreSessionResult,
  PostSessionContext,
  ToolUseContext,
  ToolResultContext,
} from "./types.js";
import { runShellHook } from "./shell.js";
import { runModuleHook } from "./module.js";
import { logger } from "../shared/logger.js";

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_CONCURRENT_FIRE_AND_FORGET = 5;

let activeFires = 0;

function buildEnv(ctx: Record<string, unknown>, jinnHome: string): Record<string, string> {
  const env: Record<string, string> = { JINN_HOME: jinnHome };
  if (ctx.hook) env.HOOK_EVENT = String(ctx.hook);
  if (ctx.sessionId) env.HOOK_SESSION_ID = String(ctx.sessionId);
  if (ctx.engine) env.HOOK_ENGINE = String(ctx.engine);
  if (ctx.employee) env.HOOK_EMPLOYEE = String(ctx.employee);
  if (ctx.toolName) env.HOOK_TOOL_NAME = String(ctx.toolName);
  return env;
}

function shouldRun(hook: HookDefinition, engine?: string, employee?: string): boolean {
  if (hook.engines?.length && engine && !hook.engines.includes(engine)) return false;
  if (hook.employees?.length && employee && !hook.employees.includes(employee)) return false;
  return true;
}

export class HookRunner {
  private config: HooksConfig;
  private jinnHome: string;

  constructor(config: HooksConfig, jinnHome: string) {
    this.config = config;
    this.jinnHome = jinnHome;
  }

  /** Check if any hooks are configured for onToolUse or onToolResult (requires streaming). */
  hasToolHooks(): boolean {
    return (this.config.onToolUse?.length ?? 0) > 0 || (this.config.onToolResult?.length ?? 0) > 0;
  }

  /**
   * Run preSession hooks. Blocking hooks execute sequentially and can modify
   * prompt/systemPrompt or abort. Non-blocking hooks fire and forget.
   */
  async runPreSession(ctx: PreSessionContext): Promise<PreSessionResult> {
    const hooks = this.config.preSession ?? [];
    let currentPrompt = ctx.prompt;
    let currentSystemPrompt = ctx.systemPrompt;

    for (const hook of hooks) {
      if (!shouldRun(hook, ctx.engine, ctx.employee)) continue;

      const payload: Record<string, unknown> = {
        hook: "preSession",
        ...ctx,
        prompt: currentPrompt,
        systemPrompt: currentSystemPrompt,
      };

      if (hook.blocking) {
        const timeout = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        let raw: unknown = null;

        if (hook.type === "shell" && hook.command) {
          const env = buildEnv(payload, this.jinnHome);
          const result = await runShellHook(hook.command, payload, env, timeout);
          if (result) {
            try { raw = JSON.parse(result); } catch { raw = null; }
          }
        } else if (hook.type === "module" && hook.path) {
          raw = await runModuleHook(hook.path, payload, this.jinnHome, timeout);
        }

        if (raw && typeof raw === "object") {
          const obj = raw as Record<string, unknown>;
          if (obj.action === "abort") {
            return { action: "abort", reason: String(obj.reason ?? "Hook aborted session") };
          }
          if (typeof obj.prompt === "string") currentPrompt = obj.prompt;
          if (typeof obj.systemPrompt === "string") currentSystemPrompt = obj.systemPrompt;
        }
      } else {
        // Fire and forget
        this.fireHook(hook, payload);
      }
    }

    return { action: "continue", prompt: currentPrompt, systemPrompt: currentSystemPrompt };
  }

  /** Fire postSession hooks (all non-blocking). */
  firePostSession(ctx: PostSessionContext): void {
    const hooks = this.config.postSession ?? [];
    const payload: Record<string, unknown> = { hook: "postSession", ...ctx };
    for (const hook of hooks) {
      if (!shouldRun(hook, ctx.engine, ctx.employee)) continue;
      this.fireHook(hook, payload);
    }
  }

  /** Fire onToolUse hooks (non-blocking). */
  fireOnToolUse(ctx: ToolUseContext): void {
    const hooks = this.config.onToolUse ?? [];
    const payload: Record<string, unknown> = { hook: "onToolUse", ...ctx };
    for (const hook of hooks) {
      if (!shouldRun(hook, ctx.engine, ctx.employee)) continue;
      this.fireHook(hook, payload);
    }
  }

  /** Fire onToolResult hooks (non-blocking). */
  fireOnToolResult(ctx: ToolResultContext): void {
    const hooks = this.config.onToolResult ?? [];
    const payload: Record<string, unknown> = { hook: "onToolResult", ...ctx };
    for (const hook of hooks) {
      if (!shouldRun(hook, ctx.engine, ctx.employee)) continue;
      this.fireHook(hook, payload);
    }
  }

  /** Fire a single hook in the background. Respects concurrency limit. */
  private fireHook(hook: HookDefinition, payload: Record<string, unknown>): void {
    if (activeFires >= MAX_CONCURRENT_FIRE_AND_FORGET) {
      logger.debug("Hook concurrency limit reached, dropping fire-and-forget hook");
      return;
    }

    activeFires++;
    const done = () => { activeFires = Math.max(0, activeFires - 1); };

    if (hook.type === "shell" && hook.command) {
      const env = buildEnv(payload, this.jinnHome);
      runShellHook(hook.command, payload, env, hook.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        .catch(() => {})
        .finally(done);
    } else if (hook.type === "module" && hook.path) {
      runModuleHook(hook.path, payload, this.jinnHome, hook.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        .catch(() => {})
        .finally(done);
    } else {
      done();
    }
  }
}
