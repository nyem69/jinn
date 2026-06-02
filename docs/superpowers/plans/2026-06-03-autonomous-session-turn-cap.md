# Autonomous Session Turn Cap (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap autonomous (cron) Claude sessions with the CLI's `--max-turns` ceiling plus an advisory prompt contract, and classify a ceiling-hit as a distinct `session_budget_stop` rather than a generic error.

**Architecture:** A new pure module `sessions/budget.ts` owns cap resolution + classification. `cron/runner.ts` resolves a per-job budget and stashes it in `transportMeta`; `sessions/manager.ts` reads it, appends the contract to the system prompt (after pre-session hooks), passes `--max-turns` to `engine.run`, and classifies `error_max_turns` *first*. `engines/claude.ts` learns to emit the result `subtype` and to never transient-retry a budget stop.

**Tech Stack:** TypeScript (NodeNext ESM — imports use `.js`), vitest, the Claude CLI (`claude -p`).

**Spec:** `docs/superpowers/specs/2026-06-03-autonomous-session-turn-cap-design.md`

**Branch:** `feat/autonomous-session-turn-cap` (already created off `origin/main`).

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `packages/jimmy/src/sessions/budget.ts` | Pure budget logic: source check, cap resolution, contract text, stop classification, shared constants | **New** |
| `packages/jimmy/src/sessions/__tests__/budget.test.ts` | Unit tests for the above | **New** |
| `packages/jimmy/src/shared/types.ts` | Schema fields on `EngineRunOpts`, `EngineResult`, `CronJob`, `JinnConfig.sessions` | Modify |
| `packages/jimmy/src/engines/claude.ts` | `--max-turns` arg, `subtype` capture, no-retry on budget stop | Modify |
| `packages/jimmy/src/engines/__tests__/claude-args.test.ts` | `--max-turns` arg tests | Modify |
| `packages/jimmy/src/sessions/manager.ts` | Contract injection, pass cap, classify stop (incl. retry path) | Modify |
| `packages/jimmy/src/cron/runner.ts` | Resolve budget, stash in transportMeta, classify runlog, conditional ops alert | Modify |

All commands below run from `packages/jimmy/`:
```bash
cd /Users/azmi/PROJECTS/LLM/jinn/packages/jimmy
```

---

## Task 1: Schema fields (type foundation)

Adds the optional fields every later task references. Type-only; verified by the TypeScript compiler.

**Files:**
- Modify: `packages/jimmy/src/shared/types.ts` (`EngineRunOpts` ~L28, `EngineResult` ~L49, `CronJob` ~L184, `JinnConfig.sessions` ~L482)

- [ ] **Step 1: Add `maxTurns` to `EngineRunOpts`**

In `interface EngineRunOpts`, immediately after the `sessionId?: string;` line, add:

```typescript
  /** Per-run agent-turn ceiling. Passed to the Claude CLI as --max-turns.
   *  Claude-only; other engines ignore it. Set by SessionManager for
   *  autonomous (cron) sessions from the resolved session budget. */
  maxTurns?: number;
```

- [ ] **Step 2: Add `subtype` to `EngineResult`**

In `interface EngineResult`, after `numTurns?: number;`, add:

```typescript
  /** Raw result subtype reported by the engine (Claude CLI result event),
   *  e.g. "success" | "error_max_turns" | "error_during_execution".
   *  Preserved generically — only classifiers special-case values. */
  subtype?: string;
```

- [ ] **Step 3: Add budget fields to `CronJob`**

In `interface CronJob`, after `delivery?: CronDelivery;`, add:

```typescript
  /** Per-job override of the autonomous turn ceiling (else global default). */
  maxTurns?: number;
  /** Session-budget controls for this job. */
  sessionBudget?: {
    /** Set false to opt this job OUT of the turn ceiling entirely. */
    hardCap?: boolean;
    /** Free-text justification for an opt-out (documentation only). */
    reason?: string;
    /** True if this job mutates external state (writes/publishes/delivers).
     *  Owners of such jobs MUST set this so a budget stop raises an ops alert
     *  instead of being runlog-only. Default false = no alert. */
    sideEffects?: boolean;
  };
```

- [ ] **Step 4: Add `budget` to `JinnConfig.sessions`**

In `JinnConfig`'s `sessions?: { … }` block, after `fallbackEngine?: "codex";`, add:

```typescript
    /** Default autonomous (cron) turn ceiling. Default 300. Per-job override
     *  via CronJob.maxTurns; opt out via CronJob.sessionBudget.hardCap=false. */
    budget?: {
      maxTurns?: number;
    };
```

- [ ] **Step 5: Typecheck**

Run: `npm run build`
Expected: PASS (no type errors). If `build` is slow, `npx tsc --noEmit -p tsconfig.json` is equivalent.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): session-budget schema fields (EngineRunOpts.maxTurns, EngineResult.subtype, CronJob.maxTurns/sessionBudget, sessions.budget)"
```

---

## Task 2: `sessions/budget.ts` — pure budget core (TDD)

The testable heart: source check, cap resolution, contract text, stop classification, shared constants.

**Files:**
- Create: `packages/jimmy/src/sessions/budget.ts`
- Test: `packages/jimmy/src/sessions/__tests__/budget.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/jimmy/src/sessions/__tests__/budget.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  isAutonomousSource,
  resolveJobBudget,
  budgetContractPrompt,
  isBudgetStop,
  DEFAULT_MAX_TURNS,
  BUDGET_STOP_SUBTYPE,
  SESSION_BUDGET_STOP_PREFIX,
} from "../budget.js";
import type { CronJob, JinnConfig } from "../../shared/types.js";

const job = (over: Partial<CronJob> = {}): CronJob => ({
  id: "j1", name: "Job 1", enabled: true, schedule: "* * * * *", prompt: "go", ...over,
});
const cfg = (maxTurns?: number): JinnConfig =>
  ({ sessions: maxTurns === undefined ? {} : { budget: { maxTurns } } } as unknown as JinnConfig);

describe("isAutonomousSource", () => {
  it("is true for cron", () => expect(isAutonomousSource("cron")).toBe(true));
  it("is false for human/web sources", () => {
    for (const s of ["web", "slack", "user", "discord", ""]) {
      expect(isAutonomousSource(s)).toBe(false);
    }
  });
});

describe("resolveJobBudget", () => {
  it("falls back to DEFAULT_MAX_TURNS when nothing is set", () => {
    expect(resolveJobBudget(job(), cfg())).toEqual({ maxTurns: DEFAULT_MAX_TURNS, sideEffects: false });
  });
  it("uses the global config default when present", () => {
    expect(resolveJobBudget(job(), cfg(200)).maxTurns).toBe(200);
  });
  it("per-job maxTurns beats the global default", () => {
    expect(resolveJobBudget(job({ maxTurns: 120 }), cfg(200)).maxTurns).toBe(120);
  });
  it("hardCap=false opts out (null) even if maxTurns is set", () => {
    expect(resolveJobBudget(job({ maxTurns: 120, sessionBudget: { hardCap: false } }), cfg(200)).maxTurns).toBeNull();
  });
  it("propagates sideEffects", () => {
    expect(resolveJobBudget(job({ sessionBudget: { sideEffects: true } }), cfg()).sideEffects).toBe(true);
  });
});

describe("budgetContractPrompt", () => {
  it("states the cap and the hard ceiling", () => {
    const p = budgetContractPrompt(250);
    expect(p).toContain("250");
    expect(p.toLowerCase()).toContain("hard ceiling");
  });
});

describe("isBudgetStop", () => {
  it("is true only for the max-turns subtype", () => {
    expect(isBudgetStop({ subtype: BUDGET_STOP_SUBTYPE })).toBe(true);
    expect(isBudgetStop({ subtype: "success" })).toBe(false);
    expect(isBudgetStop({})).toBe(false);
  });
});

describe("constants", () => {
  it("are the agreed values", () => {
    expect(DEFAULT_MAX_TURNS).toBe(300);
    expect(BUDGET_STOP_SUBTYPE).toBe("error_max_turns");
    expect(SESSION_BUDGET_STOP_PREFIX).toBe("session_budget_stop:");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sessions/__tests__/budget.test.ts`
Expected: FAIL — cannot resolve `../budget.js` (module does not exist yet).

- [ ] **Step 3: Write the module**

Create `packages/jimmy/src/sessions/budget.ts`:

```typescript
import type { CronJob, JinnConfig } from "../shared/types.js";

/** Default autonomous (cron) turn ceiling when nothing overrides it. */
export const DEFAULT_MAX_TURNS = 300;

/** Claude CLI result subtype emitted when --max-turns is hit. */
export const BUDGET_STOP_SUBTYPE = "error_max_turns";

/** Sentinel prefix written to Session.lastError on a budget stop, so the cron
 *  runner can classify the run without re-reading the engine result. Mirrors
 *  the existing `result.error.startsWith("Interrupted")` idiom. */
export const SESSION_BUDGET_STOP_PREFIX = "session_budget_stop:";

/** Sources that run unattended through SessionManager.runSession and so get the
 *  turn cap. v1 = cron only. (Web/API sessions use dispatchWebSessionRun, a
 *  separate path; "sdk" does not exist yet — extend here when it does.) */
export function isAutonomousSource(source: string): boolean {
  return source === "cron";
}

/** Resolve a job's effective turn budget. Precedence:
 *  1. sessionBudget.hardCap === false  -> uncapped (null)
 *  2. job.maxTurns                     -> per-job override
 *  3. config.sessions.budget.maxTurns  -> global default
 *  4. DEFAULT_MAX_TURNS                -> hard default */
export function resolveJobBudget(
  job: CronJob,
  config: JinnConfig,
): { maxTurns: number | null; sideEffects: boolean } {
  const sideEffects = job.sessionBudget?.sideEffects === true;
  if (job.sessionBudget?.hardCap === false) {
    return { maxTurns: null, sideEffects };
  }
  const maxTurns = job.maxTurns ?? config.sessions?.budget?.maxTurns ?? DEFAULT_MAX_TURNS;
  return { maxTurns, sideEffects };
}

/** Short advisory contract appended to the system prompt of a capped run. */
export function budgetContractPrompt(cap: number): string {
  return [
    "## Turn Budget Contract",
    `This is an autonomous run with a hard ceiling of ${cap} agent turns. At the`,
    "ceiling the process is force-stopped with no output saved.",
    "- Work efficiently; avoid unnecessary tool calls and re-reading.",
    "- By ~80% of the budget, stop expanding scope — finish and deliver what you have.",
    "- If the task cannot complete within budget, STOP CLEANLY before the ceiling and",
    "  write a short continuation note (done / remaining / next step) into your normal",
    "  output so the next run can resume.",
  ].join("\n");
}

/** True when an engine result indicates a turn-budget (max-turns) stop. */
export function isBudgetStop(result: { subtype?: string }): boolean {
  return result.subtype === BUDGET_STOP_SUBTYPE;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sessions/__tests__/budget.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/sessions/budget.ts src/sessions/__tests__/budget.test.ts
git commit -m "feat(sessions): budget.ts — cap resolution, contract prompt, stop classification"
```

---

## Task 3: `--max-turns` in `buildClaudeArgs` (TDD)

**Files:**
- Modify: `packages/jimmy/src/engines/claude.ts` (`buildClaudeArgs`, ~L10-30)
- Test: `packages/jimmy/src/engines/__tests__/claude-args.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these cases inside the existing `describe("buildClaudeArgs", () => { … })` block in `claude-args.test.ts`:

```typescript
  it("adds --max-turns with the value when maxTurns is a positive number", () => {
    const args = buildClaudeArgs({ ...base, maxTurns: 300 }, false);
    const i = args.indexOf("--max-turns");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("300");
  });

  it("omits --max-turns when maxTurns is unset", () => {
    expect(buildClaudeArgs({ ...base }, false)).not.toContain("--max-turns");
  });

  it("omits --max-turns when maxTurns is zero or negative", () => {
    expect(buildClaudeArgs({ ...base, maxTurns: 0 }, false)).not.toContain("--max-turns");
    expect(buildClaudeArgs({ ...base, maxTurns: -5 }, false)).not.toContain("--max-turns");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/engines/__tests__/claude-args.test.ts`
Expected: FAIL — `--max-turns` not present (3 new cases red; the positive-number one fails on `indexOf` = -1).

- [ ] **Step 3: Add the flag**

In `buildClaudeArgs` (claude.ts), immediately after the `effortLevel` line:

```typescript
  if (opts.effortLevel && opts.effortLevel !== "default") args.push("--effort", opts.effortLevel);
```

add:

```typescript
  if (typeof opts.maxTurns === "number" && opts.maxTurns > 0) args.push("--max-turns", String(opts.maxTurns));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/engines/__tests__/claude-args.test.ts`
Expected: PASS (existing + 3 new cases).

- [ ] **Step 5: Commit**

```bash
git add src/engines/claude.ts src/engines/__tests__/claude-args.test.ts
git commit -m "feat(claude-engine): pass --max-turns to the CLI when opts.maxTurns is set"
```

---

## Task 4: Capture `subtype` + never retry a budget stop

Plumbing in the Claude engine. The classification logic itself is already unit-tested (`isBudgetStop`, Task 2); this task wires it in. Verified by build + the Task 7 smoke (matches the codebase's existing integration-tested approach for these private result builders — see the comment in `sessions/__tests__/result.test.ts`).

**Files:**
- Modify: `packages/jimmy/src/engines/claude.ts` (import ~L1-6; `run` loop ~L101-117; `buildEngineResultFromResultEvent` ~L510-518; `extractResult` ~L600-608)

- [ ] **Step 1: Import the classifier**

At the top of `claude.ts`, after the existing imports, add:

```typescript
import { isBudgetStop } from "../sessions/budget.js";
```

- [ ] **Step 2: Capture `subtype` in `buildEngineResultFromResultEvent`**

In the returned object of `buildEngineResultFromResultEvent`, after the `numTurns:` line, add:

```typescript
      subtype: typeof resultEvent.subtype === "string" ? (resultEvent.subtype as string) : undefined,
```

- [ ] **Step 3: Capture `subtype` in `extractResult`**

In the returned object of `extractResult`, after the `numTurns:` line, add:

```typescript
      subtype: typeof result.subtype === "string" ? result.subtype : undefined,
```

- [ ] **Step 4: Never transient-retry a budget stop**

In `run()`, the retry loop currently has early returns for `Interrupted` and dead sessions. After the `Interrupted` early-return line:

```typescript
      // If the process was intentionally killed, don't retry
      if (result.error.startsWith("Interrupted")) return result;
```

add:

```typescript
      // A turn-budget stop is a deliberate ceiling, not a flaky failure — never retry it.
      if (isBudgetStop(result)) return result;
```

- [ ] **Step 5: Typecheck + full unit suite**

Run: `npm run build && npx vitest run`
Expected: PASS (no type errors; all existing tests still green — this change adds an optional field and an early return that only triggers on `error_max_turns`).

- [ ] **Step 6: Commit**

```bash
git add src/engines/claude.ts
git commit -m "feat(claude-engine): capture result subtype; never transient-retry a budget stop"
```

---

## Task 5: `runSession` — inject contract, pass cap, classify stop

Wires the budget into the live session run. Verified by build + the Task 7 smoke (this method spawns subprocesses; it is integration-tested, not unit-tested, matching the codebase).

**Files:**
- Modify: `packages/jimmy/src/sessions/manager.ts` (imports ~L14-24; `runSession` budget read after the preSession-hook block ~L412; first `engine.run` ~L439-453; new classify branch after L453; rate-limit retry `engine.run` ~L685; **not** the Codex fallback ~L536)

- [ ] **Step 1: Import budget helpers**

In `manager.ts`, add to the import from `"./registry.js"` nothing new (it already imports `accumulateSessionCost`, `updateSession`, etc.), and add a new import line after the existing local imports:

```typescript
import { isAutonomousSource, isBudgetStop, budgetContractPrompt, SESSION_BUDGET_STOP_PREFIX } from "./budget.js";
```

- [ ] **Step 2: Resolve the cap from transportMeta and inject the contract**

In `runSession`, find the end of the preSession-hook block (the `if (this.hookRunner) { … }` that may set `systemPrompt = hookResult.systemPrompt`). Immediately **after** that block and **before** `const hookOnStream = …`, insert:

```typescript
      // Autonomous turn budget: the cron runner stashes the resolved cap in
      // transportMeta.sessionBudget. Read it AFTER pre-session hooks so a hook
      // that replaces systemPrompt can't erase the contract.
      const sessionBudgetMeta = (session.transportMeta as Record<string, unknown> | null)?.["sessionBudget"] as
        | { maxTurns?: number | null }
        | undefined;
      const budgetCap =
        isAutonomousSource(session.source) &&
        typeof sessionBudgetMeta?.maxTurns === "number" &&
        sessionBudgetMeta.maxTurns > 0
          ? sessionBudgetMeta.maxTurns
          : null;
      if (budgetCap) {
        systemPrompt += "\n\n" + budgetContractPrompt(budgetCap);
      }
```

- [ ] **Step 3: Pass the cap to the first `engine.run`**

In the first `const result = await engine.run({ … })` call, add `maxTurns` alongside the other opts (after the `onStream: hookOnStream,` line, before the closing `});`):

```typescript
        maxTurns: budgetCap ?? undefined,
```

- [ ] **Step 4: Classify the budget stop FIRST, before any other result handling**

Immediately after that first `engine.run` call returns (i.e. right after the `const result = await engine.run({…});` statement and **before** `const wasInterrupted = …`), insert:

```typescript
      // Turn-budget stop — classify BEFORE dead-session / rate-limit / reply
      // handling so it isn't misread as a crash or a normal assistant message.
      if (budgetCap && isBudgetStop(result)) {
        logger.warn(`Session ${session.id} hit turn budget cap (${budgetCap}, ran ${result.numTurns ?? "?"} turns)`);
        if (result.cost || result.numTurns) {
          accumulateSessionCost(session.id, result.cost ?? 0, result.numTurns ?? 1);
        }
        this.hookRunner?.firePostSession({
          sessionId: session.id,
          engine: session.engine,
          model: session.model ?? engineConfig.model,
          employee: employee?.name,
          result: result.result,
          error: `${SESSION_BUDGET_STOP_PREFIX} hit max-turns cap (${budgetCap})`,
          cost: result.cost,
          durationMs: result.durationMs,
          numTurns: result.numTurns,
          timestamp: new Date().toISOString(),
        });
        if (decorateMessages && connector.setTypingStatus) {
          await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
        }
        if (decorateMessages && capabilities.reactions) {
          await connector.removeReaction(target, "eyes").catch(() => {});
        }
        updateSession(session.id, {
          ...(result.sessionId?.trim() ? { engineSessionId: result.sessionId } : {}),
          status: "interrupted",
          lastActivity: new Date().toISOString(),
          lastError: `${SESSION_BUDGET_STOP_PREFIX} hit max-turns cap (${budgetCap})`,
        });
        return;
      }
```

- [ ] **Step 5: Carry the cap into the rate-limit retry `engine.run`**

In the usage-limit retry loop, the retry call is `const retryResult = await engine.run({ … });` (the Claude one, ~L685, with `strictMcp: session.source === "cron"`). Add `maxTurns` after `sessionId: session.id,`:

```typescript
              maxTurns: budgetCap ?? undefined,
```

Then, immediately after `const retryInterrupted = retryResult.error?.startsWith("Interrupted");`, add a budget-stop short-circuit (so a retried run that hits the ceiling is classified, not delivered as a normal reply):

```typescript
            if (budgetCap && isBudgetStop(retryResult)) {
              logger.warn(`Session ${session.id} hit turn budget cap on retry (${budgetCap})`);
              if (retryResult.cost || retryResult.numTurns) {
                accumulateSessionCost(session.id, retryResult.cost ?? 0, retryResult.numTurns ?? 1);
              }
              if (decorateMessages && connector.setTypingStatus) {
                await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
              }
              if (decorateMessages && capabilities.reactions) {
                await connector.removeReaction(target, "eyes").catch(() => {});
                await connector.removeReaction(target, waitEmoji).catch(() => {});
              }
              updateSession(session.id, {
                ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
                status: "interrupted",
                lastActivity: new Date().toISOString(),
                lastError: `${SESSION_BUDGET_STOP_PREFIX} hit max-turns cap (${budgetCap})`,
              });
              return;
            }
```

> NOTE: Do **not** add `maxTurns` to the Codex fallback `engine.run` (~L536). Codex has no `--max-turns` equivalent; it keeps the (already-injected) prompt contract only. This is the accepted v1 limitation.

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run build && npx vitest run`
Expected: PASS. (No new unit test here — logic lives in tested helpers; behavior is exercised by the Task 7 smoke.)

- [ ] **Step 7: Commit**

```bash
git add src/sessions/manager.ts
git commit -m "feat(sessions): runSession applies turn cap + contract, classifies budget stop (incl. retry path)"
```

---

## Task 6: `cron/runner.ts` — resolve budget, stash, classify runlog, alert

**Files:**
- Modify: `packages/jimmy/src/cron/runner.ts` (imports ~L1-7; after employee resolution ~L31; route `transportMeta` ~L57-62; success runlog block ~L73-82)

- [ ] **Step 1: Add imports**

After the existing imports in `runner.ts`, add:

```typescript
import { resolveJobBudget, SESSION_BUDGET_STOP_PREFIX } from "../sessions/budget.js";
import { getSession } from "../sessions/registry.js";
import { opsAlert } from "../shared/ops-alert.js";
```

- [ ] **Step 2: Resolve the budget before routing**

After the employee-resolution block (`if (job.employee) { … }`) and before `const connector = new CronConnector(...)`, add:

```typescript
  const budget = resolveJobBudget(job, config);
```

- [ ] **Step 3: Stash the budget in the routed message's transportMeta**

In the `transportMeta: { … }` object passed to `sessionManager.route(...)`, after the `deliveryChannel: delivery?.channel ?? null,` line, add:

```typescript
          sessionBudget: { maxTurns: budget.maxTurns, sideEffects: budget.sideEffects },
```

- [ ] **Step 4: Classify the run + alert on budget stop**

Replace the existing success-path `appendRunLog(job.id, { … status: "success" … });` call with:

```typescript
    const durationMs = Date.now() - startTime;
    const finalSession = routeResult?.sessionId ? getSession(routeResult.sessionId) : undefined;
    const budgetStopped = !!finalSession?.lastError?.startsWith(SESSION_BUDGET_STOP_PREFIX);
    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      sessionId: routeResult?.sessionId ?? null,
      status: budgetStopped ? "session_budget_stop" : "success",
      durationMs,
      error: budgetStopped ? finalSession?.lastError ?? null : null,
      ...(budgetStopped ? { maxTurns: budget.maxTurns, actualTurns: finalSession?.totalTurns ?? null } : {}),
      resultPreview: null,
    });
    if (budgetStopped && budget.sideEffects) {
      await opsAlert(
        `Cron "${job.name}" (${job.id}) hit its turn-budget cap (${budget.maxTurns}) and was stopped mid-task ` +
        `after ~${finalSession?.totalTurns ?? "?"} turns. This job is flagged sideEffects:true — check for partial external writes.`,
      ).catch(() => {});
    }
```

> The original success block declared `const durationMs = Date.now() - startTime;` — keep exactly one declaration. If the replaced block already had it, do not re-declare it later in the function (the latency-alert section below reuses `durationMs`).

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run build && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cron/runner.ts
git commit -m "feat(cron): resolve+stash session budget, classify session_budget_stop runlog, conditional ops alert"
```

---

## Task 7: End-to-end smoke + finish

Prove the cap actually fires against the real CLI with a tiny budget, then close out.

**Files:** none (verification only). Uses a throwaway cron job.

- [ ] **Step 1: Confirm the gateway is running**

Run: `curl -s localhost:7777/api/cron >/dev/null && echo OK || echo "gateway down"`
Expected: `OK`. (If down, start the gateway per repo README before continuing.)

- [ ] **Step 2: Add a throwaway low-cap test job to `~/.jinn/cron/jobs.json`**

Add one job to the `jobs` array (the scheduler hot-reloads). Use a disabled schedule so it only runs on manual trigger, a low cap, and `sideEffects:true` to also exercise the alert path:

```json
{
  "id": "budget-cap-smoke",
  "name": "Budget Cap Smoke",
  "enabled": true,
  "schedule": "0 0 31 2 *",
  "engine": "claude",
  "maxTurns": 3,
  "sessionBudget": { "sideEffects": true, "reason": "smoke test" },
  "prompt": "Use your tools to do a deep, multi-step exploration: list the files in the current directory, then read several of them one at a time across many separate tool calls, summarizing after each. Keep going thoroughly — do not stop early."
}
```

(`schedule` `0 0 31 2 *` = Feb 31, i.e. never auto-fires.)

- [ ] **Step 3: Trigger it manually and watch**

Run (from any connector, or via the gateway): trigger `budget-cap-smoke`. From a chat connector that's wired in, send `/cron run budget-cap-smoke`. Otherwise trigger via the cron API/UI.

Then inspect the runlog:

Run: `tail -n 3 ~/.jinn/cron/runs/budget-cap-smoke.jsonl`
Expected: a line with `"status":"session_budget_stop"`, `"maxTurns":3`, and `"actualTurns"` ≈ 3.

- [ ] **Step 4: Verify the ops alert and session state**

- Telegram chat `535655138` should receive a `🚨 Cron "Budget Cap Smoke" … hit its turn-budget cap (3) …` message (the job has `sideEffects:true`). If `TELEGRAM_BOT_TOKEN` is unset in this env, confirm the equivalent `[ops-alert]` line in the gateway log instead.
- The session's `lastError` starts with `session_budget_stop:` and status is `interrupted`:

Run: `sqlite3 ~/.jinn/sessions/registry.db "SELECT status, total_turns, substr(last_error,1,40) FROM sessions WHERE source='cron' ORDER BY created_at DESC LIMIT 1;"`
Expected: `interrupted|3|session_budget_stop: hit max-turns cap (3)` (turns ≈ 3).

- [ ] **Step 5: Remove the throwaway job**

Delete the `budget-cap-smoke` entry from `~/.jinn/cron/jobs.json` (scheduler hot-reloads). Confirm it's gone:

Run: `python3 -c "import json;print([j['id'] for j in json.load(open('/Users/azmi/.jinn/cron/jobs.json'))['jobs'] if j['id']=='budget-cap-smoke'])"`
Expected: `[]`

- [ ] **Step 6: Full suite + typecheck once more, then push**

Run: `npm run build && npx vitest run`
Expected: PASS.

```bash
git push -u origin feat/autonomous-session-turn-cap
```

- [ ] **Step 7: Open the PR**

```bash
gh pr create --base main --title "feat: autonomous (cron) session turn cap" \
  --body "$(cat <<'EOF'
Caps autonomous cron Claude sessions via the CLI's --max-turns ceiling + an
advisory prompt contract, and classifies a ceiling-hit as a distinct
`session_budget_stop` (not a generic error).

Design: docs/superpowers/specs/2026-06-03-autonomous-session-turn-cap-design.md
Plan:   docs/superpowers/plans/2026-06-03-autonomous-session-turn-cap.md

- New `sessions/budget.ts`: cap resolution, contract prompt, stop classification (unit-tested).
- `--max-turns` passed to the Claude CLI for cron sessions; default 300, per-job
  `maxTurns` override, opt-out via `sessionBudget.hardCap:false`.
- Budget stop classified BEFORE dead-session/rate-limit handling; carried through
  the rate-limit retry path; Codex fallback is advisory-only (no hard cap).
- Runlog `session_budget_stop` + ops alert only for `sessionBudget.sideEffects:true` jobs.
- Smoke-tested end-to-end with a low-cap throwaway cron.

Scope: cron only (web/API uses dispatchWebSessionRun; interactive covered by the
shipped UserPromptSubmit guard). No continuation-artifact schema in v1.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review notes

- **Spec coverage:** schema (T1), cap resolution + contract + classification (T2), `--max-turns` (T3), subtype + no-retry (T4), runSession injection/cap/classify + retry path (T5), runner stash/runlog/alert (T6), smoke incl. `sideEffects` alert + opt-out field exercised (T7). The Codex-fallback advisory-only caveat is honored in T5 Step 5 (no `maxTurns` on the Codex call).
- **Type consistency:** `resolveJobBudget` returns `{ maxTurns, sideEffects }` everywhere; `isBudgetStop`/`SESSION_BUDGET_STOP_PREFIX`/`isAutonomousSource`/`budgetContractPrompt` names are used identically across T4/T5/T6; `EngineRunOpts.maxTurns`, `EngineResult.subtype`, `CronJob.maxTurns/sessionBudget`, `sessions.budget.maxTurns` match T1.
- **Known v1 gap (documented in spec):** a mutating cron without `sessionBudget.sideEffects:true` produces a runlog-only (Telegram-silent) budget stop.
