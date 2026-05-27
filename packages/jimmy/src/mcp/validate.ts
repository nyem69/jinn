import { createHash } from "node:crypto";
import type { McpServerConfig } from "../shared/types.js";
import { probeServer } from "./probe.js";
import { topLevelCombinator } from "./schema-guard.js";
import { opsAlert } from "../shared/ops-alert.js";
import { logger } from "../shared/logger.js";

export interface Quarantined { server: string; tool: string; reason: string; }
export interface ValidationResult { servers: Record<string, McpServerConfig>; quarantined: Quarantined[]; }

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
type Verdict = { poison: Quarantined | null; checkedAt: number };
const cache = new Map<string, Verdict>();

/** test-only */
export function _clearCache(): void { cache.clear(); }

function keyOf(name: string, server: McpServerConfig): string {
  const ident = "url" in server ? server.url : `${server.command} ${(server.args ?? []).join(" ")}`;
  return createHash("sha1").update(`${name}::${ident}`).digest("hex");
}

/** Probe + validate each resolved server. Drops (and alerts on) any server with
 *  an API-invalid tool schema. Servers that merely fail to probe (down/timeout)
 *  are KEPT — a transient outage must not silently strip a server. Fail-soft:
 *  any unexpected error keeps the server. Cached per server identity (TTL). */
export async function validateServers(input: Record<string, McpServerConfig>): Promise<ValidationResult> {
  const servers: Record<string, McpServerConfig> = {};
  const quarantined: Quarantined[] = [];
  const now = Date.now();

  for (const [name, server] of Object.entries(input)) {
    const key = keyOf(name, server);
    const cached = cache.get(key);
    let verdict: Verdict;

    if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
      verdict = cached;
    } else {
      let poison: Quarantined | null = null;
      try {
        const { tools } = await probeServer(server);
        if (tools) {
          for (const t of tools) {
            const bad = topLevelCombinator(t.inputSchema);
            if (bad) { poison = { server: name, tool: t.name, reason: bad }; break; }
          }
        } // tools === null → transient; leave poison null (keep server)
      } catch (e) {
        logger.warn(`[mcp-validate] probe error for "${name}", keeping it: ${e instanceof Error ? e.message : String(e)}`);
      }
      verdict = { poison, checkedAt: now };
      cache.set(key, verdict);
    }

    if (verdict.poison) {
      quarantined.push(verdict.poison);
      await opsAlert(`MCP server "${name}" quarantined: tool "${verdict.poison.tool}" has top-level "${verdict.poison.reason}" (Anthropic API 400). Excluded from automation sessions until fixed.`);
    } else {
      servers[name] = server;
    }
  }
  return { servers, quarantined };
}
