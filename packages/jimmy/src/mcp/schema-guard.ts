/** Keys the Anthropic Messages API rejects at the TOP LEVEL of a tool
 *  input_schema ("does not support oneOf, allOf, or anyOf at the top level").
 *  A single offending tool 400s the whole request. Nested use is fine. */
export const REJECTED_TOP_LEVEL_KEYS = ["anyOf", "oneOf", "allOf", "not"] as const;

export type RejectedKey = (typeof REJECTED_TOP_LEVEL_KEYS)[number];

/** Returns the first rejected top-level key found, or null if the schema is clean. */
export function topLevelCombinator(schema: unknown): RejectedKey | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;
  for (const key of REJECTED_TOP_LEVEL_KEYS) {
    if (key in s) return key;
  }
  return null;
}
