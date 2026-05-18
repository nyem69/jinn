/**
 * Tool registry — maps tool names to executors, filtered per engine.
 *
 * The agent loop never sees a tool the engine hasn't enabled. An engine
 * with `tools.enabled: []` (or no tools block at all) operates in
 * text-only mode and the schemas array is empty.
 */

import type { EngineToolsConfig, JsonObject } from "../../shared/types.js";
import type { ProviderToolDef } from "../providers/types.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { runCommandTool } from "./runCommand.js";
import { webfetchTool } from "./webfetch.js";
import { ALL_SCHEMAS } from "./schemas.js";
import type { ToolExecutionContext, ToolResult } from "./types.js";

export type ToolExecutor = (
  args: JsonObject,
  ctx: ToolExecutionContext,
) => Promise<ToolResult>;

interface InternalEntry {
  executor: ToolExecutor;
  schema: ProviderToolDef;
}

const ALL_TOOLS: Record<string, InternalEntry> = {
  read: { executor: readTool, schema: ALL_SCHEMAS.read },
  write: { executor: writeTool, schema: ALL_SCHEMAS.write },
  edit: { executor: editTool, schema: ALL_SCHEMAS.edit },
  bash: { executor: runCommandTool, schema: ALL_SCHEMAS.bash },
  webfetch: { executor: webfetchTool, schema: ALL_SCHEMAS.webfetch },
};

export interface ToolRegistry {
  /** Tool name → executor. Empty in text-only configs. */
  executors: Map<string, ToolExecutor>;
  /** Schemas matching `executors`, in declaration order from config.enabled. */
  schemas: ProviderToolDef[];
  /** Names that were requested in config but don't correspond to a known tool. */
  unknownRequested: string[];
}

const KNOWN_TOOL_NAMES = Object.freeze(Object.keys(ALL_TOOLS));

/**
 * Build a tool registry for one engine instance from its config.
 *
 * - `undefined` or missing `enabled` → text-only mode (empty registry).
 * - Unknown names are reported via `unknownRequested` but do not throw —
 *   the engine wrapper logs a warning at construction time. This lets
 *   forward-compat configs name tools that don't exist yet without
 *   breaking the gateway.
 */
export function buildToolRegistry(toolsConfig?: EngineToolsConfig): ToolRegistry {
  const enabled = toolsConfig?.enabled ?? [];
  const executors = new Map<string, ToolExecutor>();
  const schemas: ProviderToolDef[] = [];
  const unknownRequested: string[] = [];
  for (const name of enabled) {
    const entry = ALL_TOOLS[name];
    if (!entry) {
      unknownRequested.push(name);
      continue;
    }
    if (executors.has(name)) continue; // dedupe
    executors.set(name, entry.executor);
    schemas.push(entry.schema);
  }
  return { executors, schemas, unknownRequested };
}

export { KNOWN_TOOL_NAMES };
