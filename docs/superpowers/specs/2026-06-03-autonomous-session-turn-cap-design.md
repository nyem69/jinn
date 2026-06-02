# Autonomous Session Turn Cap (v1) — Design

**Date:** 2026-06-03
**Status:** approved — ready for implementation plan
**Repo:** `~/PROJECTS/LLM/jinn` (jimmy gateway, `packages/jimmy`)
**Branch:** `feat/autonomous-session-turn-cap`

## Problem

Claude usage is architecturally concentrated: a small number of marathon
sessions (≥200 turns) account for ~90% of spend. Cache hit ratio is already
excellent (~97%), so the lever is **turn × prefix volume** — a long-running
session re-reading a large cached prefix on every turn — not prompt polish or
caching.

The interactive side is already covered by a shipped Claude Code
`UserPromptSubmit` hook (`~/.jinn/scripts/session-budget-guard.py`) that nudges
the human to checkpoint/handoff at 150/250/400 turns. The gap is **autonomous
sessions** (cron- and sdk-triggered) where there is no human in the loop to heed
a nudge. This spec adds a server-side hard cap for those.

## Architectural constraints (discovered, drove the design)

1. **Cron = fresh session per trigger.** `cron/runner.ts` builds
   `sessionKey = cron:${job.id}:${Date.now()}`, so every trigger creates a new
   session. Cron sessions do **not** resume or accumulate turns across triggers.
   A 1,253-turn marathon is therefore a **single `engine.run()`** — one Claude
   CLI subprocess looping internally — not an accumulation across triggers.
2. **`engine.run()` is a black-box subprocess.** The Claude engine spawns the
   `claude` CLI and only learns `num_turns` from the final `result` event. There
   is **no mid-run server hook** to fire a "you hit turn 150" intervention.
3. **The queue awaits completion.** `SessionQueue.enqueue` resolves only after
   `runSession` finishes, and `route()` awaits it, so `cron/runner.ts` regains
   control *after* the run ends and can classify the outcome.
4. **The CLI already signals a max-turns stop.** When `--max-turns` is hit, the
   CLI emits a `result` event with `subtype: "error_max_turns"` and
   `is_error: true`. The current parser reads `is_error` but **drops `subtype`**,
   so a budget-stop is presently indistinguishable from a generic error.

These constraints rule out the staged live-interception model (soft@150 →
handoff@250 → terminate@350 as mid-run events) that an earlier handoff assumed.
The honest enforcement point is the CLI's own `--max-turns` flag.

## Scope

- **Applies to:** sessions where `source ∈ {cron, sdk}` (autonomous, no human).
- **Excluded:** `interactive`, `web`, `slack`, and any other human-driven
  source — already covered by the `UserPromptSubmit` guard.
- **Out of scope for v1:** any formal continuation-artifact schema, stream-level
  turn parsing, cross-trigger accumulation. Deferred until system-steward data
  shows which jobs actually need a formal handoff contract.

## Design

One enforcement lever (the CLI ceiling) + one advisory layer (a short prompt
contract so well-behaved agents exit cleanly *before* the kill) + precise
post-run classification.

### 1. Config & schema (`packages/jimmy/src/shared/types.ts`)

- `EngineRunOpts += maxTurns?: number` — per-run turn ceiling.
- `EngineResult += subtype?: string` — pass through **any** Claude result
  subtype generically (not narrowed to `error_max_turns`); future CLI result
  modes get it for free. Only the *classifier* special-cases values.
- `CronJob +=`
  - `maxTurns?: number` — per-job cap override.
  - `sessionBudget?: { hardCap?: boolean; reason?: string; sideEffects?: boolean }`
- `JinnConfig.sessions += budget?: { maxTurns?: number }` — global default.
  Ships at **300**.

### 2. Cap resolution (new unit `packages/jimmy/src/sessions/budget.ts`)

Isolated, unit-testable. Exposes:

- `isAutonomousSource(source: string): boolean` → `source === "cron" || source === "sdk"`.
- `resolveJobBudget(job, config): { maxTurns: number | null; sideEffects: boolean }`
  — used by the cron runner. Precedence:
  1. `job.sessionBudget?.hardCap === false` → `maxTurns: null` (**uncapped**;
     `reason` is documentation only).
  2. else `maxTurns = job.maxTurns ?? config.sessions?.budget?.maxTurns ?? 300`.
  3. `sideEffects = job.sessionBudget?.sideEffects === true`.
- `budgetContractPrompt(cap: number): string` — the system-prompt block (below).

`maxTurns: null` means "no ceiling passed to the CLI" (opt-out). A resolved
positive number is the ceiling.

### 3. Enforcement (`packages/jimmy/src/engines/claude.ts`)

`buildClaudeArgs` pushes `--max-turns <n>` when `opts.maxTurns` is a positive
number. Claude-CLI-only; other engines (codex/gemini/http-loop) ignore the opt.

The two result builders (`buildEngineResultFromResultEvent`, `extractResult`)
populate `subtype` from `resultEvent.subtype` / `result.subtype` when present —
generically, no value filtering.

### 4. Prompt contract + wiring (`packages/jimmy/src/sessions/manager.ts`)

In `runSession`, for autonomous + capped sessions:

- Read the resolved budget from `session.transportMeta.sessionBudget`
  (`{ maxTurns, sideEffects }`, stashed by the runner — keeps `runSession`
  decoupled from `cron/jobs.json` parsing). If `maxTurns` is a positive number:
  - Append `budgetContractPrompt(cap)` to the system prompt.
  - Pass `maxTurns: cap` to `engine.run({...})`.
- After the run returns, classify **strictly** on
  `result.subtype === "error_max_turns"` (never `numTurns >= cap` — a clean
  agent may finish exactly at the cap; turn count is logging/context only). On a
  budget-stop:
  - Set session `status: "interrupted"` (cut off by a limit, not a crash).
  - Set `lastError` to a sentinel-prefixed string:
    `session_budget_stop: hit max-turns cap (<cap>)`.
  - Do not emit a generic `Error: …` reply for this case.

The budget contract block (short, advisory):

```
## Turn Budget Contract
This is an autonomous run with a hard ceiling of <cap> agent turns. At the
ceiling the process is force-stopped with no output saved.
- Work efficiently; avoid unnecessary tool calls and re-reading.
- By ~80% of the budget, stop expanding scope — finish and deliver what you have.
- If the task cannot complete within budget, STOP CLEANLY before the ceiling and
  write a short continuation note (done / remaining / next step) into your normal
  output so the next run can resume.
```

### 5. Runlog + alert (`packages/jimmy/src/cron/runner.ts`)

- Before routing, call `resolveJobBudget(job, config)` and stash the result in
  the outgoing message `transportMeta.sessionBudget = { maxTurns, sideEffects }`.
- After `route()` returns, re-read the session. If it was budget-stopped
  (detect via the `session_budget_stop:` sentinel on `lastError`, mirroring the
  existing `result.error?.startsWith("Interrupted")` idiom):
  - Write runlog `status: "session_budget_stop"` (instead of `success` or a
    generic `error`), with `{ maxTurns, actualTurns: session.totalTurns }`.
  - Fire `opsAlert(...)` (Telegram chat 535655138, the infra/ops sink) **only
    if** `sideEffects === true`.

### Known gap (called out per review)

`sideEffects` defaults to `false` for alert-noise control. Consequently, the
**first** budget-stop on a *mutating* cron (one that writes to a DB, publishes,
or delivers) is **runlog-only / silent on Telegram** unless its owner has set
`"sessionBudget": { "sideEffects": true }`. This is accepted for v1. Mitigation:
document, in the cron-job schema reference, that owners of write/deliver jobs
must opt their job in. The monthly system-steward audit (Check 8) can flag
mutating jobs missing the flag once budget-stops start appearing in runlogs.

## Data flow

```
cron scheduler
  └─ runCronJob(job)                       [cron/runner.ts]
       budget = resolveJobBudget(job, cfg) [sessions/budget.ts]
       route({ ...msg, transportMeta.sessionBudget = budget })
            └─ runSession(session)         [sessions/manager.ts]
                 if isAutonomousSource && budget.maxTurns:
                   systemPrompt += budgetContractPrompt(cap)
                   result = engine.run({ ..., maxTurns: cap })   [engines/claude.ts]
                              → buildClaudeArgs pushes --max-turns
                   if result.subtype === "error_max_turns":
                     status=interrupted, lastError="session_budget_stop: …"
       (route resolves)
       if budget-stopped (sentinel on lastError):
         appendRunLog(status="session_budget_stop", {maxTurns, actualTurns})
         if budget.sideEffects: opsAlert(…)
```

## Error handling

- **No cap configured / opt-out:** no `--max-turns` flag, no contract block —
  behavior identical to today. Fully backward compatible.
- **Non-cron/sdk sources:** untouched.
- **Non-Claude engines:** `maxTurns` opt is ignored by the engine.
- **`opsAlert` failure:** already fail-soft (logs, never throws).
- **Missing `subtype` in result:** classifier simply doesn't fire — degrades to
  prior behavior (generic completion/error), never a false budget-stop.

## Testing

- `buildClaudeArgs`: `--max-turns <n>` present when `opts.maxTurns` set; absent
  when unset; absent when `0`/negative (guard against bad config).
- `resolveJobBudget`: opt-out (`hardCap:false` → null), per-job override
  (`job.maxTurns`), global default (300), `sideEffects` propagation.
- `subtype` capture: result builder preserves an arbitrary subtype string
  (generic), and `error_max_turns` specifically.
- Optional: a `runSession` classification check (subtype → interrupted +
  sentinel) if a lightweight harness exists; otherwise covered by the unit
  pieces above.

## Files

| File | Change |
|---|---|
| `packages/jimmy/src/shared/types.ts` | add fields to `EngineRunOpts`, `EngineResult`, `CronJob`, `JinnConfig.sessions` |
| `packages/jimmy/src/sessions/budget.ts` | **new** — `isAutonomousSource`, `resolveJobBudget`, `budgetContractPrompt` |
| `packages/jimmy/src/engines/claude.ts` | `buildClaudeArgs` `--max-turns`; capture `subtype` in both result builders |
| `packages/jimmy/src/sessions/manager.ts` | `runSession`: contract injection, pass `maxTurns`, classify budget-stop |
| `packages/jimmy/src/cron/runner.ts` | resolve budget, stash in transportMeta, classify runlog, conditional `opsAlert` |
| `packages/jimmy/src/engines/__tests__/…`, `sessions/__tests__/…` | tests above |

## Non-goals (v1)

- Continuation-artifact schema / enforced handoff format.
- Stream-level live turn counting or mid-run intervention.
- Cross-trigger turn accumulation.
- Auto-requeue of budget-stopped jobs (the next scheduled trigger is the retry).
- Applying caps to interactive/web/slack sessions.
