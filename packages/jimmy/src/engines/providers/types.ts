/**
 * Shared types for HTTP-based provider adapters (openai, ollama).
 *
 * The adapter layer's job is to normalize the wire-format differences
 * between providers so the agent loop never sees provider-specific shapes.
 * `NormalizedToolCall` is the lingua franca: every adapter returns assistant
 * messages in this exact shape, regardless of how the wire protocol
 * delivered them.
 */

import type { JsonObject } from "../../shared/types.js";

/**
 * A tool invocation requested by the model. The adapter is responsible for:
 *   - Parsing whatever shape the wire protocol used (e.g. OpenAI's
 *     `tool_calls[].function.arguments` is a JSON-string; Ollama may return
 *     it as an object already).
 *   - Always producing `arguments` as a real JS object, never a string.
 *   - Synthesizing a stable `id` when the provider doesn't supply one
 *     (Ollama tool support varies).
 */
export interface NormalizedToolCall {
  /** Stable id used to round-trip the `tool` role message back to the model. */
  id: string;
  /** Tool name as the model requested it. May not match a registered tool. */
  name: string;
  /** Parsed argument object. Empty object if the model supplied no arguments. */
  arguments: JsonObject;
}

/**
 * One message in a provider chat completion request/response.
 *
 * Mirrors the OpenAI chat-completion shape because both providers accept it
 * (Ollama added compatibility with the OpenAI format in 0.1.30+). The
 * adapter handles any wire-format differences internally.
 */
export type ProviderRole = "system" | "user" | "assistant" | "tool";

export interface ProviderMessage {
  role: ProviderRole;
  /** Plain text content. Empty string is valid (e.g. assistant returning only tool_calls). */
  content: string;
  /** Set when role==="assistant" and the model requested tool execution. */
  toolCalls?: NormalizedToolCall[];
  /** Set when role==="tool". Echoes the tool_call.id this is a response to. */
  toolCallId?: string;
  /** Optional tool name on a `tool` role message; some providers require it. */
  name?: string;
}

/**
 * Tool definition presented to the model. JSON-schema parameters, OpenAI
 * function-calling format. Ollama accepts the same shape on its OpenAI-
 * compatible endpoint and on `/api/chat` since 0.3.x.
 */
export interface ProviderToolDef {
  name: string;
  description: string;
  parameters: JsonObject;
}

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
}

export type ProviderFinishReason = "stop" | "tool_calls" | "length" | "unknown";

export interface ProviderCallResult {
  /** The assistant message produced by this turn. May carry toolCalls. */
  message: ProviderMessage;
  finishReason: ProviderFinishReason;
  usage: ProviderUsage;
  /**
   * The model that was actually billed (response.model from the provider).
   * For cost lookup, prefer this over the requested model — providers can
   * route to a different tier silently. Falls back to the requested model
   * if the response omits it.
   */
  billedModel: string;
}

export interface ProviderCallOpts {
  messages: ProviderMessage[];
  tools: ProviderToolDef[];
  model: string;
  /** Per-call HTTP timeout in ms. Default 60_000. */
  timeoutMs?: number;
  /**
   * Optional fetch override. Used by tests to inject mocked HTTP responses.
   * Production callers leave this undefined to use the global `fetch`.
   */
  fetchFn?: typeof fetch;
}

/**
 * Adapter call function shape. Each provider module exports one of these.
 * Throws on transport errors, HTTP non-2xx, or malformed payloads (so the
 * agent loop can catch and surface a clear error). Never auto-retries — V1
 * policy is fail-fast.
 */
export type ProviderCall = (opts: ProviderCallOpts) => Promise<ProviderCallResult>;

/**
 * Auth options passed at module/engine construction time, not per-call.
 */
export interface OpenAIAuth {
  apiKey: string;
  /** Defaults to https://api.openai.com/v1 */
  baseUrl?: string;
}

export interface OllamaAuth {
  /** e.g. https://ollama.aga.my */
  baseUrl: string;
  /** Optional bearer token. Sent as `Authorization: Bearer <token>` if set. */
  token?: string;
}
