# Consolidated Review — jin (2026-05-24-MCP1-FEATURES)

Seven parallel review agents (security, performance, type-safety, UX/a11y, architecture,
Cloudflare-infra, cost) audited the jin system read-only. Individual reports live alongside
this file. This document synthesizes them, de-duplicates overlapping findings, and feeds the
companion `FIX_PLAN.md`.

**Scope reviewed:** the `jin` gateway monorepo at `~/PROJECTS/LLM/jinn` (`packages/jimmy`
~33k LOC Node daemon + `packages/web` ~19.5k LOC Next.js UI) and the runtime config/data at
`~/.jinn/` (cron/jobs.json, sessions/registry.db cost_log). Primary goal per the request:
**cut cost without losing much quality.**

## Health scorecard

| Dimension | Rating | One-line verdict |
|---|---|---|
| Security | 5/10 | Solid SQL/sandbox/SSRF base; weak HTTP-API auth + one Critical secret leak |
| Performance | 5/10 | Unbounded `listSessions()` full-scan on 6 routes; sync config reads on hot path |
| Type safety | 6.5/10 | `strict:true`, zero `@ts-ignore`; 92 `as any` at two boundaries; DTO drift |
| UX / a11y | 5/10 | Real a11y awareness; gaps in live-regions, error states, focus traps |
| Architecture | 7/10 | Clean engine-adapter pattern; one 2934-LOC god-function + 2 import cycles |
| Cloudflare infra | n/a (honest) | jin is a local daemon — **mostly not a CF candidate**; 1 small caching win |
| **Cost efficiency** | **4.5/10** | **~20% of cron spend runs `bash` through a full LLM; pollers over-modelled** |

## The cost story (primary deliverable)

7-day spend **$188.06**, of which **cron = 89.3% ($167.96)**. The user-facing UI is essentially
free. Money is lost to two structural patterns, not algorithmic inefficiency:

1. **Two cron jobs are pure shell wrappers** (`crawl-news` = `bash run.sh`, `sync-news-v2` =
   `bash sync_news_v2.sh`) that spawn a full `claude -p` cold subprocess per run, paying the
   CLAUDE.md + MCP-schema input load for **zero reasoning**. Combined **$33.6/wk**.
2. **High-frequency pollers over-model the no-op path** — `jinn-group-watcher` (sonnet hourly,
   87/101 runs near-no-op), `pahang`/`melaka-breaking-watch` (sonnet 5×/day, mostly no-fire).
   Their shell prefilters already do the deterministic work; the LLM only classifies → **haiku-class**.

**Prompt caching is NOT a usable lever** — cron runs are cold one-shot subprocesses spaced beyond
Anthropic's 5-min cache TTL, and there's no `cache_control` in the engine layer anyway.

**Realistic Low-risk savings: ~$58–66/wk (~31–35% of cron, ~$250–290/mo).** See FIX_PLAN.

### Ranked cost cuts

| # | Lever | $/wk | Quality risk | Effort | Where |
|---|---|---|---|---|---|
| C1 | De-LLM `crawl-news` + `sync-news-v2` → launchd/system cron | **$33.6** | Low | Low–Med | jobs.json (2 jobs) + launchd |
| C2 | Downshift `jinn-group-watcher` + 2 breaking-watch to haiku | **$10–13** | Low | Low | jobs.json `model` (3) |
| C3 | Cap SITREP output verbosity (≤~1200 words, drop boilerplate) | **$8–12** | Low–Med | Low | 5 sitrep prompts |
| C4 | pemantau-weekly: feeders→sonnet/haiku, opus synthesis-only | **$8–10** | Med | Med | pemantau-weekly prompt |
| C5 | manamurah blog: cap output, drop sonnet-4-6 → sonnet | **$3–5** | Low–Med | Low | 2 jobs + skill |
| C6 | Fix input-token logging (enabler — $0 now, unblocks future ROI measurement) | $0 | None | Med | gateway cost logger |

**What NOT to cut:** SITREP *generation* model stays sonnet (haiku risks factual/tone loss on
political content — trim verbosity, don't downshift). pemantau-weekly *synthesis* stays opus.
manusiawi/guard/bm-polish gates already run near-free on local Ollama — leave. Breaking-watch
*escalation* (real event → actual SITREP) stays sonnet; only the no-op scan path downshifts.

## Cross-cutting findings beyond cost

### Critical (act regardless of cost work)
- **SEC-1 — Hardcoded plaintext MySQL password** (`<REDACTED>`) in `~/.jinn/cron/jobs.json:317`
  (the disabled `crisis-watch-lss` job), committed to git + echoed into session rows / cron run
  logs. A sibling job already uses the `$PAHANG_WARROOM_MYSQL_PASSWORD` env form. **Rotate →
  replace with env var → purge git history.** Directly intersects the pending git-hygiene decision.

### High
- **SEC-2 — Wildcard CORS (`Access-Control-Allow-Origin: *`) + no AuthN/CSRF** (`server.ts:634`).
  Any browser tab can silently POST `/api/cron`, `/api/config`, `/api/sessions`. Fix: narrow CORS
  to the configured host:port + optional `X-Jinn-Token` on mutating routes.
- **SEC-3 — Arbitrary file write** via caller-supplied `path` in `POST /api/files`
  (`files.ts:122-125`). Jail to `FILES_DIR`/`JINN_HOME`.
- **SEC-4 — Path traversal** — URL-decoded route params flow into `path.join` at 4 routes
  (`api.ts:1151,1491,1590,1599`). The existing `cwdJail.ts` already implements the fix; just apply it.
- **PERF-1 — `listSessions()` full table scan + temp B-TREE sort** (no LIMIT, no `last_activity`
  index) on 6 API routes, re-fetched on every WebSocket cache invalidation. One migration adding
  two indexes + a LIMIT is the top perf quick win.

### Medium
- **PERF-2** — synchronous `readFileSync(config.yaml)` + YAML parse on every session event
  (`loadHandlersFlagConfig`); add an in-memory cache invalidated by the existing file watcher.
- **PERF-3** — children endpoint ignores `idx_sessions_parent`, filters in JS.
- **ARCH-1** — `gateway/api.ts` is a 2934-LOC `handleApiRequest` god-function (112 route branches,
  31 inline db/fs/exec ops), untested. Split into a route table + handlers.
- **ARCH-2/3** — two value-level import cycles (`gateway⇄sessions`, `gateway⇄cron`) caused by
  domain logic (`org.ts`, `services.ts`, `budgets.ts`) misfiled under `gateway/`. One relocation
  kills both cycles.
- **TYPE-1** — 92 `as any` casts, concentrated in `gateway/api.ts` (34, where `readJsonBody`
  returns `unknown` but callsites cast to any instead of narrowing) and `connectors/slack` (32).
- **TYPE-2 / ARCH-6** — `Session` and `CronJob` DTOs re-declared 3× in web with visible `status`
  union drift vs jimmy. Extract a shared types module.
- **SEC-6** — 13 cron prompts name secret env vars in prompt text (logged to disk); move secret
  provisioning to a gateway pre-exec env-injection hook.
- **UX-1/2/3** — no `aria-live` on toast/notification containers; `loadSession` catch silently
  wipes the chat pane with no error UI; `window.confirm`/`alert` used instead of the existing Radix dialog.

### Low (batched)
- Telegram/Discord `allowFrom` default-allow when unconfigured (should default-deny).
- `--dangerously-skip-permissions` hardcoded (make config-toggleable).
- `POST /api/skills/install` runs caller-controlled `npx skills add <source>` (allowlist the source).
- `GET /api/config` returns full topology (model routing, WhatsApp JIDs) to any tab.
- 4 tsconfig strictness flags absent (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitReturns`, `noImplicitOverride`).
- emojilib 264KB iterated at module load; context values created inline (BreadcrumbProvider, SettingsProvider).

## What's genuinely well-built (preserve)
- Parameterized SQLite everywhere (no injection surface).
- `runCommand` tool sandbox (metachar rejection, NEVER_LIST, allowlist, timeouts) + `webfetch`
  SSRF blocklist with DNS-rebinding protection — above average.
- `cwdJail.ts` lexical+realpath jail (just under-applied).
- Engine-adapter pattern across `engines/` is clean, DI'd, not a god-module.
- `.env` is `600`; gateway binds `127.0.0.1` not `0.0.0.0`; config sanitization strips connector tokens.
- Near-zero dead code (only `MockEngine`).

## Cloudflare verdict (honest)
jin's gateway is a stateful Mac daemon (CLI child processes, WebSockets, local SQLite/files) —
**not a CF migration candidate**, and the existing CF Tunnel for remote access needs no change.
The only real CF-adjacent win is a **local read-through TTL cache** in jimmy's webfetch layer for
the redundant `warroom.my/api` calls several cron skills make in the same window (cuts Hyperdrive
load). Workers AI / R2 artifact store / DO / Queues were assessed and rejected as low-value for a
single-box deploy. (Manamurah KV write:read ratio + cache-purge tooling findings belong to those
repos, not jin.)
