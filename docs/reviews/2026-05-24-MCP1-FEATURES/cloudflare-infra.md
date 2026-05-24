# Cloudflare Infrastructure Review — jin (2026-05-24)

## Summary

Jin (the gateway daemon) is firmly a local Node.js process and almost nothing about its core architecture is a CF migration candidate: it spawns child CLIs (claude, codex), holds WebSocket connections, runs cron via node-cron, and persists sessions to local SQLite — all of which are fundamentally incompatible with CF's request/response and stateless execution model. The relevant CF surface is entirely on the **downstream services** jin talks to: `manamurah.com` (KV-cached SvelteKit Worker, WAE telemetry, R2 for FAMA images) and `warroom.my` (SvelteKit on CF Pages/Workers, Hyperdrive → Aiven MySQL, R2 for evidence uploads). Jin's skills call these services from its local machine, often making redundant round-trips that cold-hit CF without any local deduplication. The one genuine CF bridge jin already has — a cloudflared tunnel exposing `127.0.0.1:7777` at `jin.aga.my` (CF Access + OTP) — is correctly scoped for remote human access and is not a migration target. Three actionable opportunities exist, all at medium value and low-to-medium effort: (1) a local read-through cache for high-frequency warroom.my/api reads done by cron skills, (2) a purpose-built CF Worker webhook ingress to decouple inbound events from the always-on tunnel, and (3) Workers AI for the cheap, latency-tolerant classification tasks currently burning Claude tokens in cron. Overall CF-relevance rating: **3/10** for the jin system itself, **7/10** for optimizing the downstream CF services it monitors.

---

## Applicability Verdict

The following do **not** belong on CF — avoid wasted effort here:

| Component | Why NOT CF |
|---|---|
| **Jimmy gateway** (Node.js, 127.0.0.1:7777) | Requires persistent processes (claude/codex CLI spawning, WebSocket server, node-cron scheduler, chokidar file watchers, wacli shell calls). CF Workers are stateless with a 30 s CPU limit. |
| **Session registry** (SQLite, ~60 MB) | File-based DB with multi-writer needs. CF D1 is SQLite-over-HTTP with a 10 GB free limit — migration would require rewriting every `better-sqlite3` call to async HTTP fetches, gaining nothing for a single-user local workload. |
| **Cron scheduler** (`node-cron` + skills) | Skills are markdown prompts that spawn Claude as a child process. CF Cron Triggers fire Workers; they cannot exec local CLIs. The correct primitive is what already exists: launchd on macOS. |
| **Web UI** (Next.js static, served by gateway on :7777) | Single-user dashboard accessed locally or via the existing CF Tunnel. Deploying to CF Pages gains zero UX benefit and adds a separate deploy pipeline. |
| **Connectors** (Telegram, WhatsApp/wacli, Discord, Slack) | WhatsApp via wacli requires a local authenticated session. Telegram long-polls from the gateway process. Neither fits the stateless Worker model. |
| **LLM engines** (Claude, Codex, Gemini) | These call Anthropic/OpenAI APIs, not CF. Workers AI does not run Claude. |

**The CF Tunnel (`jin.aga.my`) is correctly placed.** It provides secure remote UI/API access without opening a port. It is not a candidate for replacement or expansion — keep it as-is.

---

## Findings / Opportunities

| # | Value | Effort | Confidence | Opportunity | Location |
|---|---|---|---|---|---|
| 1 | Med | Low | High | Local read-through cache for warroom.my/api reads in cron skills | `~/.jinn/skills/sitrep-{pahang,melaka,ns}/SKILL.md`, `sitrep-selangor`, `investigate`, `brief`, `report-url`, `extract` |
| 2 | Med | Med | Med | CF Worker webhook ingress to decouple event delivery from the always-on tunnel | `integrations.md` line 69-71; jin.aga.my tunnel |
| 3 | Low-Med | Low | High | KV write:read ratio is still above target (17.8% vs <5% target) — finish the caching strategy | `~/.jinn/cron/runs/manamurah-kv-metrics-2026-05-24.md`; `manamurah_20240322` src |
| 4 | Low | Low | High | Cache-purge tooling already correct — no action needed | `manamurah-price-analysis/SKILL.md` lines 739-807, `manamurah-weekly-recap/SKILL.md` lines 490-530 |
| 5 | Low | High | Low | R2 as jin artifact store (shareable cron/runs/ report links) | `~/.jinn/cron/runs/` |
| 6 | Low | High | Low | Workers AI for cheap BM classification / dedup | `~/.jinn/scripts/source_grader.py`, `rollup_social_sentiment.py` |
| 7 | Theoretical | Very High | Low | DO/Queues for multi-node cron locking | N/A — single-box only |

---

## Detailed Opportunities

### 1. Local read-through cache for repeated warroom.my/api reads

**Value:** Medium  
**Effort:** Low (an in-memory TTL map or a small SQLite table in registry.db)  
**Confidence:** High  
**Where:** Every SITREP skill (pahang/melaka/ns/selangor), `investigate`, `brief`, and `report-url` each independently call `warroom.my/api/news`, `/api/issues`, `/api/social/feed`, and `/api/social/stats`. A single cron run of `sitrep-pahang` makes at least 5 distinct round-trips to the same news endpoint with overlapping time windows.

**Rationale:** From the skills audit, the top-called warroom.my endpoints are `/api/news` (9 skill references), `/api/issues` (7 refs), `/api/social/channels` (5), `/api/social/stats` (4), `/api/social/feed` (4). In a given hour, multiple cron jobs fire — e.g. `melaka-sitrep-daily`, `pahang-sitrep-daily`, and `malaysia-sitrep-daily` all hit `/api/news` within the same scheduling window. The warroom.my Worker handles Hyperdrive → Aiven MySQL queries per call; caching responses for 5-15 minutes locally eliminates redundant Hyperdrive connections and shaves the tail latency that slows SITREP generation.

**Recommendation:** Add a lightweight in-process response cache in jimmy's webfetch tool (or a dedicated `~/.jinn/scripts/warroom-cache.json` with TTL metadata) keyed on `(url, headers)` with a configurable TTL (suggest 5 min for `/api/news`, 15 min for `/api/social/stats`). This requires no CF changes — it's entirely local.

**Risk:** Stale news during a breaking-news window. Mitigate by bypassing the cache when the calling skill sets a `fresh=true` hint (e.g. `sitrep-*` breaking-watch crons).

---

### 2. CF Worker webhook ingress for event delivery decoupling

**Value:** Medium  
**Effort:** Medium (new Worker + gateway `/api/webhook` endpoint)  
**Confidence:** Medium  
**Where:** `~/.jinn/knowledge/integrations.md` lines 66-71 (CF Tunnel config). Currently the tunnel exposes the full jimmy API at `jin.aga.my`. Any external service that needs to POST to jin (e.g. a GitLab CI deploy hook, a Stripe event, a warroom.my event notification) must go through the CF Access / OTP gate, which blocks automated callers.

**Rationale:** A thin CF Worker at `webhook.jin.aga.my` (or `jin.aga.my/ingest`) could validate a pre-shared secret, strip the CF Access layer for the specific `/ingest/*` path, and forward to `127.0.0.1:7777/api/webhook` via the tunnel. This is the standard "webhook forwarder" pattern. It would allow warroom.my to notify jin of new breaking-news articles without jin polling, and let GitLab CI trigger a cron re-run on deploy. The deploy-hook mention in `~/.jinn/docs/fama-crawler.md` line "Deploy hooks (when CF webhooks misbehave)" suggests this need already exists.

**Recommendation:** Only build this if a concrete producer (warroom.my, GitLab CI, Stripe) needs push delivery to jin. Don't build speculatively. If built: one Worker file, PSK in a CF Secret, 50 lines of code.

**Risk:** Exposes an unauthenticated ingress surface if PSK is weak or leaked. Scope strictly to `/ingest/*` — do not remove CF Access from the rest of `jin.aga.my`.

---

### 3. Manamurah KV write:read ratio — finish the caching strategy

**Value:** Low-Medium  
**Effort:** Low (continuation of in-flight work)  
**Confidence:** High  
**Where:** `manamurah-kv-metrics-2026-05-24.md` — write:read ratio 17.81%, not-found rate 18.63%; both above target (<5% and <3% respectively). Storage: 935,787 keys / 1.54 GB. Active monitoring via `manamurah-kv-snapshot` cron and WAE SQL queries.

**Rationale:** This is already being actively tracked (cron + two one-shot verify/remeasure jobs). The `manamurah-kv-ratio-remeasure-2026-05-24` job correctly identifies the expected Monday key-version-flip spike pattern. The remaining gap: ultra-long-tail premise pages (`/kedai/[premise]`) are being cached but rarely read organically — they get minted on sitemap walks and then sit cold. These inflate both write count and not-found rate (when the key rotates weekly). The fix options are already identified in the cron job prompt (stop caching these routes, or pre-warm on Monday after version flip).

**Recommendation:** This is **not a new finding** — the operator already knows. It's noted here for completeness. The expected steady-state ratio after full warm is ~8-10% write:read (per the cron job rationale). If it doesn't reach that level by week 2 post-flip (around 2026-06-01), implement the pre-warm Monday sitemap walk or stop caching ultra-long-tail premise pages.

**Risk:** Pre-warming is a batch KV write operation — benchmark the cost before enabling.

---

### 4. Cache-purge tooling — already correct, no action needed

**Value:** Low (documentation note only)  
**Effort:** N/A  
**Confidence:** High  
**Where:** `manamurah-price-analysis/SKILL.md` lines 739-807; `manamurah-weekly-recap/SKILL.md` lines 490-530; `manamurah-pemantauan-daily/SKILL.md` lines 485-528.

**Rationale:** All three manamurah blog-producing skills implement the correct CF cache-purge pattern: (1) poll with a cache-buster query (`?_cb=$RANDOM`) to detect when CF Pages deploy lands without poisoning the canonical URL's cache, (2) purge by URL via `api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache` with the blog post URL plus `/blog`, `/`, and `/sitemap.xml`, (3) graceful skip if `CF_MANAMURAH_ZONE_TOKEN` is absent. The zone token is correctly scoped per-zone (not account-scoped), as noted in the skill comments. The `?_cb=` cache-buster pattern correctly avoids the gotcha where a bare-URL probe caches a 404 from the pre-deploy window. No changes needed.

---

### 5. R2 as jin artifact store (shareable cron/runs/ links)

**Value:** Low  
**Effort:** High (new upload step in every report-generating skill)  
**Confidence:** Low  
**Where:** `~/.jinn/cron/runs/` (local flat-file JSONL/MD reports); `~/.jinn/skills/report-url/SKILL.md` line 766 (R2 already used for warroom.my evidence).

**Rationale:** Cron run reports (`manamurah-kv-metrics-*.md`, SITREP markdown files, investigation outputs) are currently local-only — accessible only via the CF Tunnel web UI. If a second person needed access (or if the Mac was offline), they could not retrieve historical reports. R2 would make them shareable via `https://warroom.my/api/upload/<key>`.

**Recommendation:** Skip unless a concrete sharing need emerges. The current single-operator model doesn't justify the upload plumbing. The warroom.my R2 path already exists for evidence (`warroom-my-r2` bucket); if this need arises, the upload pattern is already proven in `report-url` skill Step 5.

**Risk:** Report files may contain sensitive intelligence (SITREP content, political analysis). R2 objects would need access control — warroom.my's API already provides this via `/api/upload/<key>`.

---

### 6. Workers AI for cheap BM classification / dedup

**Value:** Low  
**Effort:** High  
**Confidence:** Low  
**Where:** `~/.jinn/scripts/source_grader.py`, `rollup_social_sentiment.py`, `social_alert.py`; guard skill uses `llama-guard3:8b` via local Ollama on AGALLM (172.20.100.212).

**Rationale:** Some classification work — source quality grading, social sentiment rollup — currently calls Claude (expensive). Workers AI has `@cf/meta/llama-3.1-8b-instruct` and text-classification models that could handle binary/ternary tasks. However: (a) these scripts run from AGALLM or the local Mac, not from a CF Worker; (b) routing them through Workers AI would require HTTP calls to the CF AI Gateway or a Worker wrapper; (c) the guard skill already uses local Ollama (llama-guard3:8b) as the cheap classification layer, which is the right architecture — local Ollama is faster and free for this workload. Workers AI adds network latency and per-token cost where local compute is available.

**Recommendation:** Do not migrate to Workers AI. The local Ollama path on AGALLM is the correct "cheap classifier" layer. Only revisit if AGALLM is decommissioned.

---

### 7. Durable Objects / Queues for cron locking (theoretical)

**Value:** Theoretical  
**Effort:** Very High  
**Confidence:** Low  
**Where:** N/A

**Rationale:** Cron job exclusion (preventing double-fires) is currently handled by node-cron's single-process model — there's only one gateway, so overlap is impossible by construction. If jin were ever distributed across multiple nodes (e.g. a staging instance + production instance), DO would be the right primitive for distributed cron locking. CF Queues could replace the in-memory session queue for async job dispatch. Neither applies today — single-box, single-process, macOS.

**Recommendation:** No action. Note only as a "if jin ever scales to multi-node" design input.

---

## Quick Wins

1. **Local response cache for warroom.my/api reads** — add a 5-min TTL in-process cache keyed on URL+headers to `webfetch.ts` or as a standalone module. Eliminates redundant Hyperdrive queries during same-window multi-skill cron runs. Estimated implementation: ~2h, ~100 lines. Zero CF changes required.

2. **Address the manamurah KV not-found rate** (18.6% vs 3% target) — stop caching ultra-long-tail `/kedai/[premise]` routes that are written on sitemap walks but never organically read. This reduces both write count and the not-found bucket. The monitoring infrastructure (cron + WAE SQL) is already in place to verify the fix. Estimated implementation: 1 line in `withStaleCache` route filter in `manamurah_20240322`.

---

## Overall Rating & Rationale

**CF relevance to jin core: 3/10**  
**CF relevance to downstream services (manamurah + warroom.my): 7/10**

Jin's architecture is fundamentally incompatible with serverless primitives — it's a multi-process, stateful, filesystem-coupled daemon that runs on a Mac. Moving any part of it to CF would increase complexity with no benefit. The correct verdict is: keep jin local, keep the CF Tunnel for remote access, and accept that CF only matters insofar as jin interacts with CF-hosted downstream services.

The real CF opportunities are in those downstream services, which are already well-instrumented (WAE telemetry, daily KV snapshots, cache purge scripts). The KV write ratio fix is in-flight and on the right path. The one genuinely new recommendation is the local read-through cache for warroom.my API calls, which would reduce redundant Hyperdrive load and cron job latency — and requires zero CF changes to implement.
