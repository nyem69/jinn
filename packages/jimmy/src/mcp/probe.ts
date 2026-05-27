import { spawn } from "node:child_process";
import type { McpServerConfig } from "../shared/types.js";

export interface ProbedTool {
  name: string;
  inputSchema?: unknown;
}

/** Result of probing one server. `tools === null` means transient failure
 *  (down/timeout/unreachable) — NOT a poison signal. `tools` populated (even
 *  empty) means a successful tools/list we can validate. */
export interface ProbeResult {
  tools: ProbedTool[] | null;
  error?: string;
}

const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "jimmy-probe", version: "1" } },
};
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
const UA = "Mozilla/5.0 (jimmy-mcp-probe)";

function parseToolsList(text: string): ProbedTool[] | null {
  // Accept raw JSON lines or SSE "data: {...}" frames.
  const candidates: string[] = [];
  for (const m of text.matchAll(/data:\s*(\{.*\})/g)) candidates.push(m[1]);
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("{")) candidates.push(t);
  }
  for (const c of candidates) {
    try {
      const d = JSON.parse(c);
      if (d?.id === 2 && d?.result?.tools) return d.result.tools as ProbedTool[];
    } catch { /* skip non-JSON frame */ }
  }
  return null;
}

async function probeStdio(server: Extract<McpServerConfig, { command: string }>, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: ProbeResult) => {
      if (!done) {
        done = true;
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        resolve(r);
      }
    };
    const proc = spawn(server.command, server.args ?? [], { env: { ...process.env, ...(server.env ?? {}) } });
    let out = "";
    const timer = setTimeout(() => finish({ tools: null, error: "timeout" }), timeoutMs);
    proc.stdout.on("data", (b) => {
      out += b.toString();
      const tools = parseToolsList(out);
      if (tools) { clearTimeout(timer); finish({ tools }); }
    });
    proc.on("error", (e) => { clearTimeout(timer); finish({ tools: null, error: e.message }); });
    proc.on("exit", () => { clearTimeout(timer); finish({ tools: parseToolsList(out) }); });
    proc.stdin.write(JSON.stringify(INIT) + "\n" + JSON.stringify(INITIALIZED) + "\n" + JSON.stringify(LIST) + "\n");
    proc.stdin.end();
  });
}

async function probeHttp(url: string, headers: Record<string, string>, timeoutMs: number): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": UA, ...headers };
  try {
    await fetch(url, { method: "POST", headers: h, body: JSON.stringify(INIT), signal: ctrl.signal });
    const resp = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(LIST), signal: ctrl.signal });
    const text = await resp.text();
    return { tools: parseToolsList(text) };
  } catch (e) {
    return { tools: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe one server's tools/list. Fail-soft: never throws. */
export async function probeServer(server: McpServerConfig, timeoutMs = 8000): Promise<ProbeResult> {
  if ("url" in server && server.url) {
    return probeHttp(server.url, server.headers ?? {}, timeoutMs);
  }
  if ("command" in server && server.command) {
    return probeStdio(server as Extract<McpServerConfig, { command: string }>, timeoutMs);
  }
  return { tools: null, error: "unknown server shape" };
}
