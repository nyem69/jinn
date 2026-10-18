/**
 * A session keeps one `model` column across an engine override (the Claude →
 * Codex usage-limit fallback flips `engine` but leaves `model` alone), so a
 * Claude alias such as "sonnet" must never reach the codex CLI — it answers
 * 400 "The 'sonnet' model is not supported when using Codex with a ChatGPT
 * account." Every engine.run() resolves its model through here.
 *
 * Ceiling: family detection is prefix-based. A model name outside these
 * prefixes is treated as unknown and passed through unchanged (custom/proxy
 * names keep working); extend the patterns when an engine gains a new family.
 */

type ModelFamily = "claude" | "openai" | "gemini";

const FAMILY_PATTERNS: Array<[ModelFamily, RegExp]> = [
  ["claude", /^((claude|opus|sonnet|haiku|fable)\b|opusplan$|default$|best$)/i],
  ["openai", /^(gpt|o\d|codex|chatgpt)\b/i],
  ["gemini", /^gemini\b/i],
];

const ENGINE_FAMILY: Record<string, ModelFamily> = {
  claude: "claude",
  codex: "openai",
  openai: "openai",
  gemini: "gemini",
};

/** Engines that serve only their own local model names: any hosted-family name is foreign. */
const LOCAL_ENGINES = new Set(["ollama"]);

export function modelFamily(model: string): ModelFamily | null {
  for (const [family, re] of FAMILY_PATTERNS) {
    if (re.test(model.trim())) return family;
  }
  return null;
}

function fitsEngine(engine: string, model: string): boolean {
  const have = modelFamily(model);
  if (!have) return true;
  if (LOCAL_ENGINES.has(engine)) return false;
  const want = ENGINE_FAMILY[engine];
  return !want || want === have;
}

/**
 * The model to hand `engine`: the session's own model when it fits that engine
 * (same family, or a name we can't classify), else the engine's configured
 * default when that fits, else undefined so the engine uses its own default.
 * The default is checked too because engines without their own config block
 * (openai, ollama, an unconfigured gemini) are handed the Claude block.
 */
export function resolveEngineModel(
  engine: string,
  sessionModel: string | null | undefined,
  engineDefault: string | null | undefined,
): string | undefined {
  if (sessionModel && fitsEngine(engine, sessionModel)) return sessionModel;
  if (engineDefault && fitsEngine(engine, engineDefault)) return engineDefault;
  return undefined;
}
