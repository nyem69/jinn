/**
 * OpenAI Chat Completions provider adapter.
 *
 * Scope (V1):
 *   - Non-streaming. Streaming is out of scope until web UI demand exists.
 *   - No auto-retries. Transport / HTTP non-2xx / parse errors are thrown
 *     and surface as engine errors.
 *   - Tool-call shape parsed from `response.choices[0].message.tool_calls`.
 *     Arguments come as JSON-strings on the wire; we parse to JS object
 *     before handing to the agent loop (NormalizedToolCall.arguments is
 *     always object-typed).
 *   - Billed model from `response.model` (falls back to requested model
 *     only when the response omits it — providers can route to a different
 *     tier silently and cost lookup must follow the actual billing).
 */

import { randomUUID } from "node:crypto";
import type {
  NormalizedToolCall,
  OpenAIAuth,
  ProviderCall,
  ProviderCallOpts,
  ProviderCallResult,
  ProviderFinishReason,
  ProviderMessage,
} from "./types.js";
import type { JsonObject } from "../../shared/types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 60_000;

interface OpenAIToolCallWire {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIChoiceWire {
  index?: number;
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: OpenAIToolCallWire[];
  };
  finish_reason?: string;
}

interface OpenAIResponseWire {
  id?: string;
  model?: string;
  choices?: OpenAIChoiceWire[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Build a call function bound to the given auth. The returned function
 * matches ProviderCall and can be passed to the agent loop directly.
 */
export function createOpenAIProvider(auth: OpenAIAuth): ProviderCall {
  const baseUrl = (auth.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!auth.apiKey) {
    throw new Error("openai: missing apiKey at provider construction");
  }

  return async function callOpenAI(opts: ProviderCallOpts): Promise<ProviderCallResult> {
    const fetchFn = opts.fetchFn ?? fetch;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const body = buildRequestBody(opts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`openai: HTTP timeout after ${timeoutMs}ms`)), timeoutMs);

    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(`openai: HTTP transport error: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const errBody = await safeReadText(res);
      throw new Error(`openai: HTTP ${res.status} ${res.statusText}: ${truncate(errBody, 500)}`);
    }

    let parsed: OpenAIResponseWire;
    try {
      parsed = (await res.json()) as OpenAIResponseWire;
    } catch (err) {
      throw new Error(`openai: response JSON parse failed: ${(err as Error).message}`);
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
      out.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          // OpenAI requires arguments as a string on the wire.
          arguments: JSON.stringify(tc.arguments),
        },
      }));
    }
    return out;
  }
  if (m.role === "tool") {
    return {
      role: "tool",
      tool_call_id: m.toolCallId ?? "",
      content: m.content,
    };
  }
  return { role: m.role, content: m.content };
}

function interpretResponse(parsed: OpenAIResponseWire, requestedModel: string): ProviderCallResult {
  const choice = parsed.choices?.[0];
  if (!choice || !choice.message) {
    throw new Error("openai: response missing choices[0].message");
  }
  const wireRole = choice.message.role ?? "assistant";
  if (wireRole !== "assistant") {
    throw new Error(`openai: expected assistant role in response, got "${wireRole}"`);
  }

  const toolCalls: NormalizedToolCall[] = (choice.message.tool_calls ?? []).map(normalizeToolCall);

  const message: ProviderMessage = {
    role: "assistant",
    content: choice.message.content ?? "",
  };
  if (toolCalls.length > 0) message.toolCalls = toolCalls;

  const finishReason = normalizeFinishReason(choice.finish_reason);
  // If the wire layer reported tool_calls but finish_reason was something
  // odd, trust the tool_calls signal — the agent loop needs to execute them.
  const effectiveFinish: ProviderFinishReason =
    toolCalls.length > 0 ? "tool_calls" : finishReason;

  const billedModel = parsed.model && parsed.model.length > 0 ? parsed.model : requestedModel;

  return {
    message,
    finishReason: effectiveFinish,
    usage: {
      promptTokens: parsed.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
      totalTokens: parsed.usage?.total_tokens,
    },
    billedModel,
  };
}

function normalizeToolCall(tc: OpenAIToolCallWire): NormalizedToolCall {
  const id = tc.id && tc.id.length > 0 ? tc.id : `call_${randomUUID()}`;
  const name = tc.function?.name ?? "";
  if (!name) {
    throw new Error("openai: tool_call missing function.name");
  }
  let args: JsonObject = {};
  const rawArgs = tc.function?.arguments;
  if (rawArgs !== undefined && rawArgs !== null && rawArgs !== "") {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`tool_call "${name}" arguments must parse to an object, got ${typeof parsed}`);
      }
      args = parsed as JsonObject;
    } catch (err) {
      throw new Error(`openai: tool_call "${name}" arguments JSON parse failed: ${(err as Error).message}`);
    }
  }
  return { id, name, arguments: args };
}

function normalizeFinishReason(raw: string | undefined): ProviderFinishReason {
  switch (raw) {
    case "stop":
      return "stop";
    case "tool_calls":
      return "tool_calls";
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
