# Architecture Reviewer Review — jin (2026-05-24)

## Summary

jin's `jimmy` daemon is a well-layered codebase with a genuinely cohesive
`shared/` core, a clean dependency-injection seam for engines, and strong test
discipline in the highest-risk areas (tool execution, cost logging, sessions).
The engine-adapter layer (44 files) is *not* a god-module — it is a consistent,
interface-driven set of adapters (`implements Engine` / `InterruptibleEngine`)
with shared loop logic extracted into `agentLoop.ts` and reused by the HTTP
engines. The two real structural weaknesses are (1) `gateway/api.ts` — a single
2934-LOC `handleApiRequest` function dispatching 112 routes with ~31 inline
db/fs/exec operations, conflating HTTP routing, validation, and business logic;
and (2) a set of value-level import cycles caused by domain logic
(`org.ts`, `services.ts`, `budgets.ts`) being misfiled under `gateway/` and then
reached back into by `sessions/` and `cron/`. Raw SQL is scattered across ~40
call sites outside the `sessions/` layer (no DAO boundary), and the `web` package
re-declares API DTOs independently of `shared/types.ts`, creating drift risk.
Dead code is minimal — only `MockEngine` is genuinely orphaned. **Overall: 7/10**
— solid bones, two concentration points (`api.ts`, misfiled gateway domain logic)
that will impede testing and extraction if left unaddressed.

### Module map / layering (text diagram)

```
                         ┌─────────────────────────────┐
   bin/jimmy.ts ───────► │  cli/ (17) dynamic-imported  │
   (CLI entry)           └──────────────┬──────────────┘
                                        │ → gateway/lifecycle
   ┌────────────────────────────────────────────────────────────────┐
   │  gateway/ (19)  HTTP server + 112-route dispatcher                │
   │   server.ts ── builds engines Map, injects into SessionManager    │
   │   api.ts (2934 LOC god-fn) ── routing + inline business + raw SQL  │
   │   ┌── MISFILED DOMAIN LOGIC (no HTTP): org.ts, services.ts,        │
   │   │   org-hierarchy.ts, budgets.ts, costs.ts, goals.ts            │
   └───┼──────────────┬──────────────────┬───────────────┬───────────┘
       │ ▲            │ ▲                │               │
       │ │ CYCLE      │ │ CYCLE          ▼               ▼
       │ │            │ │            sessions/ (19)    cron/ (4)
       │ │            │ │            manager,registry  scheduler,runner
       │ │            │ └───────────────┘  (DI'd in)    (type-only→sessions)
       │ └── cron/runner→gateway/org (value) ⇄ gateway/api→cron/runner
       └──── sessions/manager→gateway/budgets (value) ⇄ gateway→sessions
   ┌──────────────────────────────────────────────────────────────┐
   │  engines/ (44)  COHESIVE adapter layer                          │
   │   claude/codex/gemini = CLI-spawn  · ollama/openai = HTTP-loop  │
   │   agentLoop.ts (shared tool loop) · tools/ (jailed exec)        │
   │   audit.ts + sqliteAuditLogger.ts                              │
   ├──────────────────────────────────────────────────────────────┤
   │  events/ (12) own DB ctx │ connectors/ (19) isolated transports │
   ├──────────────────────────────────────────────────────────────┤
   │  shared/ (11)  SINK — types, config, paths, logger, rateLimit,  │
   │                timeout, effort, version. No cross-dir deps.      │
   └──────────────────────────────────────────────────────────────┘

   packages/web/ (Next.js) — NO dependency on jimmy; re-declares API DTOs
   (Employee, QueueItem, OrgData) in lib/api.ts → drift risk
```

Dependency sink ordering is correct: everything flows *down* to `shared/`
(27/26/17/16/13 inbound edges), and `shared/` has zero cross-directory imports.
`sessions/registry.ts` (the SQLite data layer) also has zero cross-dir imports —
a clean data-layer leaf.

## Findings table

| # | Severity | Confidence | Finding | Location |
|---|----------|-----------|---------|----------|
| 1 | HIGH | High | `handleApiRequest` is a 2934-LOC god-function: 112 route branches + ~31 inline db/fs/exec ops; HTTP routing mixed with business logic | `gateway/api.ts:403` |
| 2 | MEDIUM | High | Value-level circular dependency `gateway ⇄ sessions` (domain logic misfiled in gateway) | `sessions/manager.ts:35`, `sessions/context.ts:5-6`, `gateway/api.ts:10` |
| 3 | MEDIUM | High | Value-level circular dependency `gateway ⇄ cron` | `cron/runner.ts:5`, `gateway/api.ts:67` |
| 4 | MEDIUM | High | Pure domain logic (`org.ts`, `services.ts`, `org-hierarchy.ts`, `budgets.ts`) misfiled under `gateway/`; consumed by sessions+cron — root cause of cycles | `gateway/org.ts`, `gateway/services.ts`, `gateway/budgets.ts` |
| 5 | MEDIUM | High | Raw SQL (`.prepare(...)`) scattered across ~40 call sites in gateway/events/engines; no repository/DAO boundary | `gateway/api.ts:380`, `gateway/costs.ts`, `gateway/budgets.ts`, `engines/claude/emitter.ts` |
| 6 | MEDIUM | High | `web` re-declares API DTOs (`Employee`, `QueueItem`, `OrgData`) independent of `shared/types.ts` — no compile-time contract link → drift risk | `packages/web/src/lib/api.ts:22` vs `jimmy/src/shared/types.ts` |
| 7 | LOW | High | Dead code: `MockEngine` exported, in `EngineName` union, doc-comment claims "registered in engines Map for tests" — but never registered (server.ts) and never imported by any test | `engines/mock.ts`, `shared/types.ts:387,398` |
| 8 | LOW | High | `cron/scheduler.ts` (timing/reload logic) has no test; `handleApiRequest` dispatcher has no direct test | `cron/scheduler.ts`, `gateway/api.ts:403` |
| 9 | LOW | Medium | Mild under-abstraction: each connector reimplements `deriveSessionKey` + `threads.ts` with no shared base/helper | `connectors/*/threads.ts` |
| 10 | INFO | High | `gateway/api.ts` reaches into `cli/instances.ts` (`gateway → cli`) — wrong direction; cli is a higher layer | `gateway/api.ts:72` |

## Detailed Findings

### [HIGH] `gateway/api.ts` is a 2934-LOC routing god-function
**Severity:** High **Confidence:** High
**Location:** `gateway/api.ts:403` (`handleApiRequest`)
**Evidence:** `handleApiRequest` is a single async function containing 112 route
branches (`grep -cE "if \(method ===|matchRoute\(" → 112`), dispatched via a long
`if (method === "..." && pathname === ...)` / `matchRoute(...)` chain rather than a
route table. Inside it sit ~31 inline persistence/IO operations
(`grep -cnE "initDb|\.prepare\(|execSync|spawn\(|writeFileSync|readFileSync" → 31`),
e.g. `gateway/api.ts:380` runs `SELECT COALESCE(MAX(seq)...` directly, and
`gateway/api.ts:1507/1694/1934/2004/2076/2187` do `fs.writeFileSync` against
`CONFIG_PATH`, board files, CLAUDE.md, etc. The file has 35 imports and is the
single largest source file in the daemon (2934 of 5338 gateway LOC, 55%).
**Impact:** The HTTP surface cannot be unit-tested in isolation (no per-route
handlers); any route change risks the whole dispatcher; business logic
(config-writing, board persistence, cost queries) is undiscoverable because it is
buried inside transport handling. This is the primary testability bottleneck —
note `handleApiRequest` has **no direct test** (`gateway/__tests__/` covers helpers
like `costs`, `org`, `services`, `spawn-checkpoint-spec`, `api-last-n`, but not the
dispatcher itself).
**Recommendation:** Introduce a route table (`Map<pattern, handler>`) and extract
per-resource handler modules (`routes/sessions.ts`, `routes/config.ts`,
`routes/goals.ts` — several already exist as separate domain files: `costs.ts`,
`goals.ts`, `budgets.ts`, `files.ts`). Push raw SQL behind the `sessions/registry`
(or a new `repository`) layer. Each extracted handler becomes independently
testable.

### [MEDIUM] Value-level cycle: gateway ⇄ sessions
**Severity:** Medium **Confidence:** High
**Location:** `sessions/manager.ts:35` (`import { checkBudget } from "../gateway/budgets.js"`),
`sessions/context.ts:5-6` (`scanOrg` from `../gateway/org.js`, `buildServiceRegistry`
from `../gateway/services.js`), back-edge `gateway/api.ts:10` and
`gateway/server.ts:12` import `SessionManager`.
**Evidence:** Directory-level edge counts show `gateway → sessions` (9) and
`sessions → gateway` (3), and the `sessions → gateway` imports are **value**
imports (not `import type`), so the cycle survives compilation.
**Impact:** `sessions/` cannot be extracted or unit-tested without dragging in
`gateway/`. The cycle is purely accidental — `budgets`, `org`, `services` are not
HTTP concerns.
**Recommendation:** Move `org.ts`, `services.ts`, `org-hierarchy.ts`, `budgets.ts`
into a transport-agnostic module (e.g. `org/` or `domain/`). Both `sessions/` and
`gateway/` then depend *down* on it, breaking the cycle. See Finding #4.

### [MEDIUM] Value-level cycle: gateway ⇄ cron
**Severity:** Medium **Confidence:** High
**Location:** `cron/runner.ts:5` (`import { scanOrg, findEmployee } from
"../gateway/org.js"`) ⇄ `gateway/api.ts:65-67` (`loadJobs`/`saveJobs` from
`../cron/jobs.js`, `reloadScheduler` from `../cron/scheduler.js`, `runCronJob` from
`../cron/runner.js`).
**Evidence:** `cron → gateway` (1, value) and `gateway → cron` (5, value). Note
`cron/scheduler.ts:9` and `cron/runner.ts:7` import `SessionManager` as
`import type` — those are erased and do **not** form a runtime cycle with
`sessions/`. The only live cron cycle is with `gateway` via `org.ts`.
**Impact:** Same as #2 — cron can't be isolated.
**Recommendation:** Resolved automatically by relocating `org.ts` (Finding #4).

### [MEDIUM] Domain logic misfiled under `gateway/`
**Severity:** Medium **Confidence:** High
**Location:** `gateway/org.ts` (`scanOrg`, `findEmployee`, `extractMention`),
`gateway/services.ts` (`buildServiceRegistry`, `resolveManagerChain`,
`findCommonAncestor`, `buildRoutePath`), `gateway/org-hierarchy.ts`,
`gateway/budgets.ts`.
**Evidence:** These files contain **no HTTP code** (`grep "express|router|req|res|http"
gateway/org.ts → empty`). They are pure org-roster parsing and routing-chain domain
logic, yet they live under `gateway/` and are consumed by `sessions/context.ts`,
`sessions/manager.ts`, and `cron/runner.ts`. This misplacement is the *single root
cause* of cycles #2 and #3.
**Impact:** Forces non-gateway layers to depend on `gateway/`, inverting the
intended layering (gateway should be the top transport layer that depends on
domain, not vice-versa).
**Recommendation:** Extract a `domain/` (or `org/`) directory holding org +
service-registry + budget logic. Gateway, sessions, and cron all consume it
downward. Low-risk mechanical move; high structural payoff.

### [MEDIUM] Raw SQL scattered — no repository boundary
**Severity:** Medium **Confidence:** High
**Location:** ~40 `.prepare(...)` call sites outside `sessions/`
(`grep -rn "\.prepare(" gateway/ events/ engines/ → 40`), e.g.
`gateway/api.ts:380`, `gateway/costs.ts`, `gateway/budgets.ts`,
`engines/claude/emitter.ts`, `engines/sqliteAuditLogger.ts`.
**Evidence:** While `initDb()` centralises the *connection*, raw SQL strings live
in 6 directories. `gateway/api.ts:380` queries `session_events` directly rather
than going through `sessions/registry`. `events/` has its own `events/db.ts`
(acceptable bounded context), but gateway/engines reaching into session tables is
a layering smell.
**Impact:** Schema changes ripple unpredictably; no single place owns table access;
hard to mock the DB for handler tests.
**Recommendation:** Funnel session/cost/budget table access through
`sessions/registry.ts` (or split into focused repos: `costRepo`, `budgetRepo`).
Keep `events/db.ts` as its own bounded data module.

### [MEDIUM] Web re-declares API DTOs (contract drift)
**Severity:** Medium **Confidence:** High
**Location:** `packages/web/src/lib/api.ts:22` (`interface Employee`, `QueueItem`,
`OrgData`, `OrgHierarchy`, `TranscriptEntry`) vs `jimmy/src/shared/types.ts`.
**Evidence:** `packages/web/package.json` has **no dependency** on the `jimmy`
package, and `grep "from \"@jinn|jimmy" packages/web/src → empty`. The web client
hand-declares the same DTO shapes the daemon serialises.
**Impact:** No compile-time guarantee the two stay in sync; a field rename in the
daemon API silently diverges from the web types until runtime.
**Recommendation:** Publish the wire-contract subset of `shared/types.ts` as a
shared workspace package (e.g. `@jinn/contracts`) consumed by both, or generate web
types from the daemon. Given the monorepo + workspace setup this is low-friction.

### [LOW] Dead code: `MockEngine`
**Severity:** Low **Confidence:** High
**Location:** `engines/mock.ts:15`, type union `shared/types.ts:398`,
doc-comment `shared/types.ts:387`.
**Evidence:** `MockEngine` is referenced **only** within its own file
(`grep -rln "MockEngine" src → engines/mock.ts` only). It is *not* registered in
`gateway/server.ts` (which registers claude/codex/gemini/ollama/openai), and *not*
imported by any test or by the `e2e/smoke.spec.ts` Playwright test. The doc-comment
at `shared/types.ts:387` asserts "`mock` is registered in the engines Map for
tests" — this is stale/false.
**Impact:** Minor — a 57-LOC dead adapter plus a misleading comment and an unused
arm of the `EngineName` type.
**Recommendation:** Either wire `MockEngine` into a test harness (register it in a
test-only engines Map) or delete it and the `"mock"` union member, and fix the
`shared/types.ts:387` comment.

### [LOW] Untested critical paths: scheduler & dispatcher
**Severity:** Low **Confidence:** High
**Location:** `cron/scheduler.ts`, `gateway/api.ts:403`.
**Evidence:** `cron/__tests__/` contains only `runner.test.ts`; no test references
`scheduler`/`startScheduler`/`reloadScheduler`. `handleApiRequest` has no direct
test. By contrast, tool execution is *excellently* covered
(`engines/tools/__tests__/`: cwdJail, ipBlocklist, fs-tools-jail, runCommand,
webfetch, registry, buildLookup) and cost logging is covered
(`sessions/__tests__/cost-log-dedup.test.ts`, `gateway/__tests__/costs.test.ts`).
**Impact:** Cron timing/reload regressions and route-dispatch regressions would not
be caught by CI.
**Recommendation:** Add a scheduler test (fake timers; assert next-run computation
and reload behaviour). Dispatcher testing is unlocked once #1 splits routes into
handlers.

### [LOW] Connector under-abstraction
**Severity:** Low **Confidence:** Medium
**Location:** `connectors/{telegram,slack,discord}/threads.ts`.
**Evidence:** Each connector reimplements `deriveSessionKey(...)` and a `threads.ts`
with near-identical structure (session-key derivation, reply-context). No shared
base class or helper exists (`grep "BaseConnector|abstract class" connectors → none`).
**Impact:** Minor copy-paste; new connectors restate the same threading scaffold.
The transports *are* legitimately different, so this is defensible — flagged for
awareness, not urgency.
**Recommendation:** Optional — extract a `connectors/shared/threads.ts` with the
common reply-context shape; keep per-transport key derivation.

### [INFO] `gateway → cli` wrong-direction edge
**Severity:** Info **Confidence:** High
**Location:** `gateway/api.ts:72` (`import { loadInstances } from
"../cli/instances.js"`).
**Evidence:** `cli/` is the top entry layer (dynamically imported by
`bin/jimmy.ts`) yet `gateway/api.ts` imports from it. `cli` also imports `gateway`
(4 edges) — but those are lifecycle calls (`cli/start.ts → gateway/lifecycle`),
the correct direction.
**Impact:** Negligible today (`loadInstances` is a pure helper), but it inverts the
layer order and could seed a future cycle.
**Recommendation:** Move `instances.ts` to `shared/` or `gateway/` if the gateway
needs it.

## Dead Code Inventory

| File / Export | Evidence of non-use |
|---|---|
| `engines/mock.ts` :: `MockEngine` | Referenced only in its own file (`grep -rln "MockEngine" src` → mock.ts only); not registered in `server.ts`; not imported by any test or e2e. Doc-comment claiming test registration is false. |
| `shared/types.ts:398` :: `"mock"` arm of `EngineName` | Only exists to type the unregistered `MockEngine`. |
| (no other dead exports) | All 296 named function/const/class exports have ≥1 non-self importer. Zero exports are test-only-dead. |
| (no orphan files) | All `cli/*` flagged as "uninported in src" are dynamically imported by `bin/jimmy.ts` (verified). `gateway/costs.ts`,`goals.ts` dynamically imported by `api.ts`. `mcp/gateway-server.ts` spawned via path string in `mcp/resolver.ts:105`. |
| (no abandoned migrations) | `migrations/0001..0007` sequential, each paired up/down (0001 lacks a `.down` — initial, expected). |
| Tech-debt markers | Only 5 `TODO/FIXME/HACK/XXX/@deprecated` across all non-test src — very low. |

## Circular Dependencies

Real **value-level** cycles (survive TS compilation):

1. **`gateway ⇄ sessions`** — `sessions/manager.ts:35` → `gateway/budgets.js`;
   `sessions/context.ts:5-6` → `gateway/org.js` + `gateway/services.js`; back-edge
   `gateway/api.ts:10` + `gateway/server.ts:12` → `sessions/manager.js`.
2. **`gateway ⇄ cron`** — `cron/runner.ts:5` → `gateway/org.js`; back-edge
   `gateway/api.ts:65-67` → `cron/jobs.js`, `cron/scheduler.js`, `cron/runner.js`.

Both cycles share a single root cause: org/service/budget **domain** logic living
under `gateway/`. Relocating it (Finding #4) eliminates both.

**Type-only (NOT cycles — erased at compile):** `cron/scheduler.ts:9` and
`cron/runner.ts:7` import `SessionManager` via `import type`; so the apparent
`sessions ⇄ cron` relationship is one-directional at runtime
(`sessions/manager.ts:33-34` → `cron/jobs.js` + `cron/scheduler.js`, value).

No cycles found within `engines/`, `events/`, `connectors/`, or `shared/`.
`shared/` and `sessions/registry.ts` are clean leaves (zero cross-dir imports).

## Quick Wins

1. **Delete or wire `MockEngine`** and fix the false `shared/types.ts:387` comment
   (Finding #7) — 5 minutes, removes the only dead code.
2. **Relocate `org.ts`/`services.ts`/`org-hierarchy.ts`/`budgets.ts`** out of
   `gateway/` into a `domain/` dir (Finding #4) — mechanical move that kills *both*
   import cycles (#2, #3) in one change.
3. **Add a `cron/scheduler.test.ts`** with fake timers (Finding #8) — closes the
   highest-value untested critical path without refactoring.
4. **Move `cli/instances.ts` helper** so gateway stops importing up into cli
   (Finding #10).

## Overall Rating & Rationale

**7/10.**

What's genuinely good: the engine layer is a textbook adapter pattern (consistent
`implements Engine`/`InterruptibleEngine`, shared `agentLoop.ts`, DI via an engines
`Map` injected into `SessionManager` at `gateway/server.ts:205`); `shared/` is a
disciplined sink, not a dumping ground (9 focused modules, zero internal tangle,
`types.ts` is a pure zero-import contract); connectors are cleanly isolated (core
never imports them); tool execution is fortified with security tests (cwd jail, IP
blocklist); migrations are sequential and reversible; dead code is near-zero; and
tech-debt markers are minimal (5).

What holds it back from 8-9: the `gateway/api.ts` 2934-LOC dispatcher is a real
maintainability and testability liability (Finding #1), and the misfiling of domain
logic under `gateway/` produces two avoidable value-level cycles (#2-#4). Raw SQL
sprawl (#5) and the un-shared web DTO contract (#6) are moderate boundary issues.
None are architecturally fatal — they are concentration and placement problems with
clear, low-risk remediations. Fixing #1 and #4 alone would lift this to an 8.
