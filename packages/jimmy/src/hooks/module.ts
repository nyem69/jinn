import path from "node:path";
import { logger } from "../shared/logger.js";

type HookFn = (payload: Record<string, unknown>) => Promise<unknown>;

const moduleCache = new Map<string, HookFn | null>();

/**
 * Load and cache a JS/TS module hook. The module must export a default async function.
 */
async function loadModule(modulePath: string, jinnHome: string): Promise<HookFn | null> {
  const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(jinnHome, modulePath);

  if (moduleCache.has(resolved)) {
    return moduleCache.get(resolved)!;
  }

  try {
    const mod = await import(resolved);
    const fn = typeof mod.default === "function" ? (mod.default as HookFn) : null;
    if (!fn) {
      logger.warn(`Hook module "${resolved}" does not export a default function — skipping`);
    }
    moduleCache.set(resolved, fn);
    return fn;
  } catch (err) {
    logger.warn(`Hook module "${resolved}" failed to load: ${err instanceof Error ? err.message : err}`);
    moduleCache.set(resolved, null);
    return null;
  }
}

/**
 * Run a module hook with timeout enforcement.
 * Returns the module's return value, or null on failure/timeout.
 */
export async function runModuleHook(
  modulePath: string,
  payload: Record<string, unknown>,
  jinnHome: string,
  timeoutMs: number,
): Promise<unknown> {
  const fn = await loadModule(modulePath, jinnHome);
  if (!fn) return null;

  try {
    const result = await Promise.race([
      fn(payload),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Module hook "${modulePath}" timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return result;
  } catch (err) {
    logger.warn(`Module hook "${modulePath}" error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
