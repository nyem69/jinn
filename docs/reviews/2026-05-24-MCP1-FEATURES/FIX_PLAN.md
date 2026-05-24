# Fix Plan — jin (2026-05-24-MCP1-FEATURES)

> **Implemented 2026-05-24** (this session): **SEC-1** (0.2), **C2**, **C1**.
> - SEC-1: literal MySQL password removed from `cron/jobs.json` (both jobs now use
>   `$SHINJIRU_PASSWORD`, already in `secrets/crawler.env`). *Still pending (user/manual):*
>   rotate the DB password (0.1) + purge git history (0.3).
> - C2: `jinn-group-watcher` + `pahang-breaking-watch` + `melaka-breaking-watch` → `model: haiku`.
> - C1: `crawl-news` + `sync-news-v2` cron entries disabled (`enabled:false`, reversible);
>   replaced by LaunchAgents `com.jinn.crawl-news` / `com.jinn.sync-news-v2` calling
>   `scripts/crawler/launchd_wrap.sh` (Telegram failure alert on non-zero exit). Both verified
>   standalone + end-to-end via launchd kickstart (rc=0).
> - **Realized savings: ~$44–47/wk (~$190–200/mo).** Not done this pass: C3, C4, C5, C6, Phase 4/5.
> - **Revert C1:** `launchctl bootout gui/$(id -u)/com.jinn.<label>` + set the two crons `enabled:true`.



Sequenced by **value × safety**. The request was to "revise and enhance jin to cut cost without
losing much quality," so cost cuts lead. Each item notes risk + reversibility because these touch
**live unattended automation** and `cron/jobs.json` may have a **concurrent editor** (re-read before
every edit; never blind-clobber).

Legend: ⚡ reversible config edit · 🔧 source change · 🏗 infra change · 🔒 security

---

## Phase 0 — Critical security (do first, independent of cost)

- **0.1 🔒 Rotate the Pahang MySQL password** `<REDACTED>` on `124.217.249.135` (manual, user).
- **0.2 ⚡ Replace `jobs.json:317` literal credential** with `$PAHANG_WARROOM_MYSQL_PASSWORD`
  (the sibling job at ~line 110 already uses the env form). Job is the disabled `crisis-watch-lss`.
- **0.3 🏗 Purge the literal from git history** (`git filter-repo`/BFG) — coordinate, it rewrites history.
- **0.4 ⚡ Confirm `cron/runs/` + `sessions/` git posture** — ties into the pending git-hygiene
  decision. `sessions/registry.db*` already gitignored; add `sessions/registry.db.bak-*`.

## Phase 1 — Cost cuts, lowest risk first (primary deliverable)

- **C2 ⚡ Haiku downshift (≈$10–13/wk, Low risk)** — set `model: haiku` on 3 jobs:
  `jinn-group-watcher`, `pahang-breaking-watch`, `melaka-breaking-watch`. Pure `model`-field edits,
  trivially reversible. Keep the breaking-watch *escalation* (real event → SITREP) on sonnet.
  **Verify:** watch the next few runs still classify correctly (no-op detection + URL triage).
- **C3 ⚡ Trim SITREP verbosity (≈$8–12/wk, Low–Med)** — add "≤~1200 words, omit empty sections,
  no meta-commentary" cap to the 5 sitrep prompts; condense the source-dating guardrail. Cap
  *length*, not *scope*. **Verify:** one SITREP per tenant reads complete, not truncated.
- **C5 ⚡ manamurah blog (≈$3–5/wk, Low–Med)** — cap output length; switch `claude-sonnet-4-6`
  → `sonnet`; summarize MCP tool results before they enter synthesis context (the 811k-input/run
  variant). Touches 2 jobs + the skill prompt.

## Phase 2 — Cost cuts, higher effort/risk

- **C1 🏗 De-LLM the shell wrappers (≈$33.6/wk, Low quality-risk but infra change)** — biggest win.
  `crawl-news` + `sync-news-v2` prompts are literally `bash <script>`. Move to launchd plists (or a
  new non-LLM "shell job" gateway type) calling the scripts directly; disable the 2 cron entries.
  Route non-zero exit to the Telegram ops channel via a shell trap (replaces the LLM's only value:
  error narration). **Verify:** news ingestion continues (row counts in the news DB), failures alert.
- **C4 🔧/⚡ pemantau-weekly feeder downshift (≈$8–10/wk, Med risk)** — run the 17 feeders on
  sonnet/haiku, reserve opus for final synthesis only (CLAUDE.md already prescribes this). **Verify:**
  spot-check the first downshifted weekly run against the prior opus-all baseline before trusting it.

## Phase 3 — Cost-measurement enabler

- **C6 🔧 Fix input-token logging** — gateway cost logger isn't extracting
  `usage.input_tokens`/`cache_creation`/`cache_read` from the Claude CLI JSON envelope (NULL in 88%
  of `cost_log` rows). No direct $ saving but required to measure any future caching/trim ROI.

## Phase 4 — Security hardening (high/medium, after cost work)

- **S2 🔧 Narrow CORS + add CSRF gate** — replace `Access-Control-Allow-Origin: *` (`server.ts:634`)
  with the configured host:port; add optional `X-Jinn-Token` (or Origin check) on mutating routes.
- **S3 🔧 Jail `POST /api/files` path** to `FILES_DIR`/`JINN_HOME` (`files.ts`); gate the `open` param.
- **S4 🔧 Apply `cwdJail.ts` to the 4 path-traversal routes** (`api.ts:1151,1491,1590,1599`).
- **S6 🔧 Move secret provisioning out of prompt text** into a gateway pre-exec env-injection hook.
- **S-low** — Telegram/Discord default-deny `allowFrom`; config-toggle `--dangerously-skip-permissions`;
  allowlist `skills/install` source; scope `GET /api/config`.

## Phase 5 — Perf + architecture + types (quality, not cost)

- **P1 🔧 Add migration: index `sessions(last_activity)` + LIMIT on `listSessions()`** (top perf win).
- **P2 🔧 In-memory cache for `config.yaml`** invalidated by the existing watcher.
- **P3 🔧 Use `idx_sessions_parent`** in the children endpoint (drop JS filter).
- **A1 🔧 Split `handleApiRequest`** (2934 LOC) into a route table + handlers.
- **A2 🔧 Relocate `org.ts`/`services.ts`/`budgets.ts`** out of `gateway/` to kill both import cycles.
- **T1/T2 🔧 Extract shared `Session`/`CronJob` types**; narrow `readJsonBody` callsites instead of
  `as any`; consider enabling `noUncheckedIndexedAccess`.
- **UX 🔧** `aria-live` on toast/notification; error UI in `loadSession` catch; replace
  `window.confirm`/`alert` with the existing Radix dialog.

---

## Recommended execution order
1. **Phase 0** (Critical security — needs user action on rotation + history purge).
2. **Phase 1** (safe reversible cost cuts — the bulk of the $/wk at Low risk).
3. **Phase 3 (C6)** then **Phase 2** (measure, then the bigger structural cuts).
4. **Phase 4** security, **Phase 5** quality — as separate follow-up work.

**Estimated cost impact if Phases 1–2 land: ~$58–66/wk (~$250–290/mo), ≈31–35% of cron spend.**

> ⚠️ All `jobs.json` edits: re-read the file immediately before editing (concurrent sessions edit
> it), change only the targeted field/entry, and never run `wrangler`/deploy — warroom apps
> auto-deploy via CI. Cron edits hot-reload via the gateway watcher.
