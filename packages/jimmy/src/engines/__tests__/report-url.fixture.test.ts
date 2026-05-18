/**
 * Golden classification fixture for the report-url triage cron.
 *
 * Why this test exists:
 *   When the cron migrates from Claude → ollama/openai we want a
 *   structural guarantee that downstream consumers (warroom_my.issue
 *   writer, sitrep dispatcher) keep working. The model's prose can drift
 *   between provider runs and is not under our control. The output
 *   SHAPE — field names, types, enum values — IS under our control via
 *   the system prompt and JSON-schema response shaping.
 *
 * What we assert:
 *   - The agent loop completes successfully (kind="ok")
 *   - finalContent parses as JSON
 *   - Required fields are present with the right types
 *   - `as` is one of the documented enum values
 *   - `confidence` is in [0,1]
 *   - `tenants` is a non-empty string array
 *
 * What we deliberately DO NOT assert:
 *   - Exact wording of `reason`
 *   - Specific tenant choice (model judgment)
 *   - The model's chain-of-thought
 *
 * This protects migration goals without making prose drift a blocker.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentLoop } from "../agentLoop.js";
import type { ProviderCall } from "../providers/types.js";

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url)) + "/fixtures/report-url";
const INPUT = fs.readFileSync(path.join(FIXTURE_DIR, "input.txt"), "utf8");
const SCHEMA = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "expected-classification.schema.json"), "utf8")) as {
  fields: Record<string, { type: string; enum?: string[]; minimum?: number; maximum?: number; minLength?: number; minItems?: number; items?: { type: string }; optional?: boolean }>;
  required: string[];
};

const TRIAGE_SYSTEM_PROMPT = `You are a news-URL triage classifier for the warroom monitoring system.
Given a URL + page content, decide how it should be filed.

Respond with a JSON object only, no markdown fence, with these fields:
  as: one of "issue" | "news" | "both" | "breaking"
  reason: a short one-sentence rationale
  confidence: number in [0, 1]
  tenants: array of tenant slugs ("pahang" | "melaka" | "ns" | "selangor" | "editorial")
  category: optional short category label

Definitions:
  - "issue": political content, governance criticism, narrative attacks — anything we'd draft a response for
  - "news": neutral factual reporting — accidents, weather, court rulings on non-political cases
  - "both": when the article reads as both
  - "breaking": story age <1h AND at least one breaking criterion (deaths, VIP arrest, natural disaster, infra failure)`;

// Stand-in provider that returns a single assistant turn with a JSON
// payload matching the documented schema. Stable across runs so the
// structural assertions below are deterministic.
const mockTriageProvider: ProviderCall = async () => ({
  message: {
    role: "assistant",
    content: JSON.stringify({
      as: "issue",
      reason: "Political response to flood-relief criticism; multi-stakeholder governance content.",
      confidence: 0.92,
      tenants: ["pahang"],
      category: "crisis-comms",
    }),
  },
  finishReason: "stop",
  usage: { promptTokens: 480, completionTokens: 70 },
  billedModel: "gpt-4o-mini",
});

describe("report-url triage — golden fixture", () => {
  it("agent loop produces a structurally valid classification", async () => {
    const result = await runAgentLoop({
      provider: mockTriageProvider,
      toolExecutors: new Map(),
      toolSchemas: [],
      model: "gpt-4o-mini",
      systemPrompt: TRIAGE_SYSTEM_PROMPT,
      userPrompt: INPUT,
      maxTurns: 3,
      timeoutMs: 10_000,
      toolContext: { cwd: process.cwd() },
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    // Loop-level invariants
    expect(result.turns).toBe(1);
    expect(typeof result.durationMs).toBe("number");
    expect(result.promptTokens).toBeGreaterThan(0);
    expect(result.completionTokens).toBeGreaterThan(0);

    // Parse the JSON envelope
    const parsed = parseTriageOutput(result.finalContent);
    expect(parsed).not.toBeNull();
    if (!parsed) return;

    // Required fields present
    for (const key of SCHEMA.required) {
      expect(parsed, `missing required field "${key}"`).toHaveProperty(key);
    }

    // Field-by-field structural validation
    const fields = SCHEMA.fields;

    expect(typeof parsed.as).toBe("string");
    expect(fields.as!.enum).toContain(parsed.as);

    expect(typeof parsed.reason).toBe("string");
    expect((parsed.reason as string).length).toBeGreaterThanOrEqual(fields.reason!.minLength!);

    expect(typeof parsed.confidence).toBe("number");
    expect(parsed.confidence as number).toBeGreaterThanOrEqual(fields.confidence!.minimum!);
    expect(parsed.confidence as number).toBeLessThanOrEqual(fields.confidence!.maximum!);

    expect(Array.isArray(parsed.tenants)).toBe(true);
    expect((parsed.tenants as unknown[]).length).toBeGreaterThanOrEqual(fields.tenants!.minItems!);
    for (const t of parsed.tenants as unknown[]) {
      expect(typeof t).toBe("string");
    }

    if (parsed.category !== undefined) {
      expect(typeof parsed.category).toBe("string");
    }
  });

  it("rejects clearly malformed model output cleanly (structural guard)", async () => {
    // What happens if a future model returns a stringified array instead
    // of a JSON object? The loop completes, but downstream parsing fails
    // and we detect it BEFORE writing to warroom_my.issue.
    const badProvider: ProviderCall = async () => ({
      message: {
        role: "assistant",
        content: "[1, 2, 3]", // wrong shape entirely
      },
      finishReason: "stop",
      usage: { promptTokens: 100, completionTokens: 5 },
      billedModel: "gpt-4o-mini",
    });

    const result = await runAgentLoop({
      provider: badProvider,
      toolExecutors: new Map(),
      toolSchemas: [],
      model: "gpt-4o-mini",
      systemPrompt: TRIAGE_SYSTEM_PROMPT,
      userPrompt: INPUT,
      maxTurns: 1,
      timeoutMs: 5_000,
      toolContext: { cwd: process.cwd() },
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const parsed = parseTriageOutput(result.finalContent);
    // Array IS valid JSON but doesn't match our object schema.
    expect(parsed).toBeNull();
  });
});

/**
 * Parse a model response into the triage object, tolerating common
 * envelopes (raw JSON, ```json fenced blocks). Returns null on any
 * structural failure so the test can assert "rejected cleanly".
 */
function parseTriageOutput(raw: string): Record<string, unknown> | null {
  // Strip markdown fences if present.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenceMatch ? fenceMatch[1]! : raw).trim();
  try {
    const j = JSON.parse(body);
    if (j === null || typeof j !== "object" || Array.isArray(j)) return null;
    return j as Record<string, unknown>;
  } catch {
    return null;
  }
}
