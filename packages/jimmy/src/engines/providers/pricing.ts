/**
 * Per-model pricing for cost reporting from provider responses.
 *
 * Rates are USD per 1 million tokens, broken down by input vs output.
 * OpenAI does not separate cache writes from base input in their billing
 * surface (cached input is auto-discounted in `usage.prompt_tokens_details`
 * if the SDK reports it); we treat `prompt_tokens` as one bucket for V1.
 *
 * Pricing snapshot: 2026-05.
 */

export interface ModelRate {
  /** USD per 1M prompt (input) tokens. */
  in: number;
  /** USD per 1M completion (output) tokens. */
  out: number;
}

/** OpenAI model price table. Keys match the model id used in the API. */
const OPENAI_PRICING: Record<string, ModelRate> = {
  // GPT-4o family
  "gpt-4o":              { in: 2.50, out: 10.00 },
  "gpt-4o-2024-08-06":   { in: 2.50, out: 10.00 },
  "gpt-4o-2024-11-20":   { in: 2.50, out: 10.00 },
  "gpt-4o-mini":         { in: 0.15, out: 0.60 },
  "gpt-4o-mini-2024-07-18": { in: 0.15, out: 0.60 },

  // GPT-4.1 family
  "gpt-4.1":             { in: 2.00, out: 8.00 },
  "gpt-4.1-mini":        { in: 0.40, out: 1.60 },
  "gpt-4.1-nano":        { in: 0.10, out: 0.40 },

  // o1 / o3 reasoning models
  "o1":                  { in: 15.00, out: 60.00 },
  "o1-mini":             { in: 1.10, out: 4.40 },
  "o3-mini":             { in: 1.10, out: 4.40 },
  "o3":                  { in: 2.00, out: 8.00 },
  "o4-mini":             { in: 1.10, out: 4.40 },

  // GPT-5 family
  "gpt-5":               { in: 1.25, out: 10.00 },
  "gpt-5-mini":          { in: 0.25, out: 2.00 },
  "gpt-5-nano":          { in: 0.05, out: 0.40 },
};

/**
 * Look up the rate for an OpenAI model. Returns undefined if not in the
 * table — callers must report cost as undefined rather than zero so the
 * pricing gap is visible in cost_log + the weekly rollup.
 */
export function openaiRate(model: string): ModelRate | undefined {
  return OPENAI_PRICING[model];
}

/**
 * Compute USD cost for a single OpenAI completion. Returns undefined when
 * no pricing entry exists for the model — the caller should pass through
 * to cost_log as NULL and log a warning. Never returns 0 for missing data.
 */
export function openaiCostFor(model: string, promptTokens: number, completionTokens: number): number | undefined {
  const rate = openaiRate(model);
  if (!rate) return undefined;
  return (promptTokens * rate.in) / 1e6 + (completionTokens * rate.out) / 1e6;
}

/**
 * Ollama runs locally / self-hosted, no per-token billing. Always returns 0
 * so cost_log rows from ollama sessions are recorded but show $0 spend.
 */
export function ollamaCostFor(_model: string, _promptTokens: number, _completionTokens: number): number {
  return 0;
}
