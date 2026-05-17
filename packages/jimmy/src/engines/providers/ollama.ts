/**
 * Ollama Chat Completions provider adapter.
 *
 * Scope (V1):
 *   - Non-streaming. Sets `stream: false` on the request body.
 *   - Optional bearer token (set via OllamaAuth.token).
 *   - No auto-retries.
 *   - Tool call normalization differs from OpenAI in two ways:
 *       1. Ollama's `message.tool_calls[i].function.arguments` may arrive
 *          as a JSON object (typical) OR as a JSON string (some models).
 *          We accept either and normalize to a JS object.
 *       2. Ollama tool support is uneven across model families. We
 *          synthesize a stable `id` (call_<uuid>) when missing so the
 *          tool-response round-trip still works.
 *   - If a model ignores the tools schema and replies with plain text that
 *     "looks like" a tool call (e.g. "I would call search(q='x')"), we do
 *     NOT try to parse it. That ambiguity belongs to a higher-level
 *     fallback layer, not the adapter.
 *   - Cost is always 0 (self-hosted; pricing.ts.ollamaCostFor handles this).
 */

import { randomUUID } from "node:crypto";
import type {
  NormalizedToolCall,
  OllamaAuth,
  ProviderCall,
  ProviderCallOpts,
  ProviderCallResult,
  ProviderFinishReason,
  ProviderMessage,
} from "./types.js";
import type { JsonObject, JsonValue } from "../../shared/types.js";

const DEFAULT_TIMEOUT_MS = 60_000;

interface OllamaToolCallWire {
  // Ollama may omit id entirely; we synthesize one when missing.
  id?: string;
  function?: {
    name?: string;
    // Object on the wire (per Ollama docs) but some clients/models send a string.
    arguments?: JsonObject | string;
  };
}

interface OllamaResponseWire {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaToolCallWire[];
  };
  done?: boolean;
  done_reason?: string;
  // Token counts in Ollama's native shape.
  prompt_eval_count?: number;
  eval_count?: number;
}

export function createOllamaProvider(auth: OllamaAuth): ProviderCall {
  const baseUrl = auth.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("ollama: missing baseUrl at provider construction");
  }

  return async function callOllama(opts: ProviderCallOpts): Promise<ProviderCallResult> {
    const fetchFn = opts.fetchFn ?? fetch;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const body = buildRequestBody(opts);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth.token) headers["Authorization"] = `Bearer ${auth.token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`ollama: HTTP timeout after ${timeoutMs}ms`)), timeoutMs);

    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(`ollama: HTTP transport error: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const errBody = await safeReadText(res);
      throw new Error(`ollama: HTTP ${res.status} ${res.statusText}: ${truncate(errBody, 500)}`);
    }

    let parsed: OllamaResponseWire;
    try {
      parsed = (await res.json()) as OllamaResponseWire;
    } catch (err) {
      throw new Error(`ollama: response JSON parse failed: ${(err as Error).message}`);
    }

    return interpretResponse(parsed, opts.model);
  };
}

function buildRequestBody(opts: ProviderCallOpts): JsonObject {
  const body: JsonObject = {
    model: opts.model,
    messages: opts.messages.map(serializeMessage),
    stream: false,
  };
  if (opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
  return body;
}

function serializeMessage(m: ProviderMessage): JsonObject {
  if (m.role === "assistant") {
    const out: JsonObject = { role: "assistant", content: m.content };
    if (m.toolCalls && m.toolCalls.length > 0) {
      // Ollama's wire format accepts object arguments; pass through directly.
      out.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        function: {
          name: tc.name,
          arguments: tc.arguments as JsonValue,
        },
      }));
    }
    return out;
  }
  if (m.role === "tool") {
    // Ollama accepts {role:"tool", content, tool_call_id, name} — name is
    // helpful when present.
    const out: JsonObject = { role: "tool", content: m.content };
    if (m.toolCallId) out.tool_call_id = m.toolCallId;
    if (m.name) out.name = m.name;
    return out;
  }
  return { role: m.role, content: m.content };
}

function interpretResponse(parsed: OllamaResponseWire, requestedModel: string): ProviderCallResult {
  const wireMsg = parsed.message;
  if (!wireMsg) {
    throw new Error("ollama: response missing message");
  }
  const role = wireMsg.role ?? "assistant";
  if (role !== "assistant") {
    throw new Error(`ollama: expected assistant role in response, got "${role}"`);
  }

  const toolCalls: NormalizedToolCall[] = (wireMsg.tool_calls ?? []).map(normalizeToolCall);

  const message: ProviderMessage = {
    role: "assistant",
    content: wireMsg.content ?? "",
  };
  if (toolCalls.length > 0) message.toolCalls = toolCalls;

  const finishReason = normalizeFinishReason(parsed.done_reason, toolCalls.length > 0);
  const billedModel = parsed.model && parsed.model.length > 0 ? parsed.model : requestedModel;

  return {
    message,
    finishReason,
    usage: {
      promptTokens: parsed.prompt_eval_count ?? 0,
      completionTokens: parsed.eval_count ?? 0,
    },
    billedModel,
  };
}

function normalizeToolCall(tc: OllamaToolCallWire): NormalizedToolCall {
  const name = tc.function?.name ?? "";
  if (!name) {
    throw new Error("ollama: tool_call missing function.name");
  }
  const id = tc.id && tc.id.length > 0 ? tc.id : `call_${randomUUID()}`;
  const rawArgs = tc.function?.arguments;
  const args = parseOllamaArgs(name, rawArgs);
  return { id, name, arguments: args };
}

/**
 * Accept either a JSON object or a JSON-encoded string and return a plain
 * object. Empty / null / undefined collapse to `{}`. Throws if the value is
 * non-object after parsing (arrays, primitives) — the agent loop should
 * never have to guess the argument shape.
 */
function parseOllamaArgs(toolName: string, raw: JsonObject | string | undefined | null): JsonObject {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    if (raw === "") return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`ollama: tool_call "${toolName}" arguments JSON parse failed: ${(err as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`ollama: tool_call "${toolName}" arguments must parse to an object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`);
    }
    return parsed as JsonObject;
  }
  throw new Error(`ollama: tool_call "${toolName}" arguments has unexpected type ${typeof raw}`);
}

function normalizeFinishReason(raw: string | undefined, hadToolCalls: boolean): ProviderFinishReason {
  if (hadToolCalls) return "tool_calls";
  switch (raw) {
    case "stop":
    case undefined:
      return "stop";
    case "length":
      return "length";
    default:
      return "unknown";
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
