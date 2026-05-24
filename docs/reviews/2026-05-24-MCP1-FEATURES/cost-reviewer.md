# Cost Reviewer Review — jin (2026-05-24)

## Summary

7-day spend is **$188.06 across 506 sessions**, and **89.3% ($167.96) is cron automation** — the user-facing surface is essentially free. The money is concentrated in two distinct failure modes. First, **two cron jobs (`crawl-news`, `sync-news-v2`) are pure shell wrappers** — their entire prompt is `bash run.sh` — yet they spin up a full `claude -p` subprocess every run, paying the cold system-prompt + tool/MCP-schema input load for zero LLM reasoning. They cost **~$33.6/wk combined** ($25.2 sync-news + $8.4 crawl-news) and 95–69% of their runs emit <500 output tokens. Removing the LLM entirely (call the script from launchd/system cron) saves the full amount at **zero quality risk** — this is the single best cut. Second, the **SITREP + manamurah-blog cluster ($57/wk + $14/wk)** burns sonnet on 16k–45k *output* tokens per run; trimming verbosity and downshifting the breaking-watch no-op path to haiku is a large, low-risk win. Third, **`jinn-group-watcher` runs sonnet hourly** and 87/101 runs are effectively no-ops costing $13.88/wk; the prefilter already gates the real work, so the LLM model can drop to haiku. **Prompt caching is NOT a usable lever here** — every cron run is a fresh one-shot `claude -p` subprocess (no `--resume`), and Anthropic's cache TTL (5 min) expires long before the next hourly/3-hourly fire, so the cached prefix never survives between runs. **Total achievable at Low quality-risk: ~$58–66/wk (~31–35% of cron spend, ~$250–290/mo).** Note: input-token logging is broken in 88% of rows (447/507), so input-side analysis relies on the jobs that *do* log plus architecture inspection. **Cost-efficiency rating: 4.5/10** — the system works, but spends LLM dollars on deterministic shell work and over-models high-frequency no-op pollers.

## Cost Breakdown

### By model (7d, queried)
| model | sessions | input_tok* | output_tok* | $ |
|---|---|---|---|---|
| sonnet | 279 | (under-logged) | 1,040,957 | 112.66 |
| haiku | 188 | (under-logged) | 149,957 | 30.32 |
| opus | 6 | 282,660 | 39,152 | 22.95 |
| (default) | 21 | 344,044 | 75,245 | 13.41 |
| claude-sonnet-4-6 | 8 | 8,012,000 | 167,000 | 8.35 |
| gpt-4o-mini | 5 | — | — | 0.00 |

\* **input_tokens is NULL/<1000 in 447 of 507 rows (88%)** — the gateway is not parsing `usage.input_tokens` (or cache_creation/cache_read) from the Claude CLI `--output-format json` envelope for most sessions. Cost is logged correctly; token attribution is not. This blocks DB-level cache-hit verification.

### By trigger (7d, queried)
| trigger | sessions | $ | share |
|---|---|---|---|
| cron | 475 | 167.59 | 89.3% |
| web | 25 | 16.30 | 8.7% |
| user | 4 | 2.89 | 1.5% |
| eval | 3 | 0.91 | 0.5% |

### By cron job (7d, queried, UUID→name mapped)
| job | model | sched | runs | $ | $/run | notes |
|---|---|---|---|---|---|---|
| jinn-group-watcher | sonnet | hourly 8–23 | 101 | 22.00 | 0.218 | 87 runs <$0.25 (no-op-ish) = $13.88 |
| pemantau-weekly | opus | weekly | 1 (+17 agents) | 19.80 | 19.80 | 18-agent opus swarm |
| **sync-news-v2** | haiku | hourly | 160 | **25.26** | 0.158 | **shell wrapper `bash sync_news_v2.sh`** |
| malaysia-sitrep-daily | sonnet | 2×/day | 14 | 17.97 | 1.28 | 17k avg output |
| pahang-breaking-watch | sonnet | 5×/day | 33 | 11.42 | 0.346 | mostly no-fire |
| melaka-breaking-watch | sonnet | 5×/day | 32 | 11.36 | 0.355 | mostly no-fire |
| pahang-sitrep-daily | sonnet | 1×/day | 7 | 9.66 | 1.38 | 16.5k avg output |
| **crawl-news** | sonnet | every 3h | 53 | **8.37** | 0.158 | **shell wrapper `bash run.sh`** |
| manamurah-pemantauan-daily | sonnet | 6×/wk | 6 | 8.30 | 1.38 | 31.5k avg output (verbose) |
| melaka-sitrep-daily | sonnet | 1×/day | 7 | 6.58 | 0.94 | |
| manamurah-pemantauan-daily(v6) | claude-sonnet-4-6 | 6×/wk | 6 | 5.62 | 1.405 | 811k *input*/run logged |

**SITREP cluster total (5 jobs, sonnet): $57.0/wk across 93 runs — largest category.**

### Caching status
- **No `cache_control` anywhere in the engine layer** (`packages/jimmy/src/engines/`).
- Sessions run as `claude -p --output-format json --model <m> --append-system-prompt <p>` one-shot subprocesses (`claude.ts:110-125`). The Claude Code CLI applies caching *within* a process, but cron runs are separate cold spawns minutes-to-hours apart → cache prefix expires (5-min TTL) → **no cross-run cache reuse possible**. Prompt caching is therefore not a lever for cron unless jobs are batched into one resumed session (architecturally large; not recommended now).

## Recommendations table

| # | Lever | Est $/wk saved | Quality risk | Effort | Confidence | Target |
|---|---|---|---|---|---|---|
| 1 | De-LLM `crawl-news` + `sync-news-v2` (pure shell wrappers → system cron/launchd) | **$33.6** | **Low** | Low–Med | High | jobs.json: `FTZ0gjlqsx...`, `sync-news-v2-phase2a` |
| 2 | Downshift breaking-watch no-op path + watcher to haiku | **$10–13** | Low | Low | High | `d4b0e8f2`, `b5d8e1f3`, `1a4a909d` |
| 3 | Trim SITREP output verbosity (cap length, drop boilerplate) | **$8–12** | Low–Med | Low | Med | 5 sitrep jobs |
| 4 | pemantau-weekly: feeders→sonnet/haiku, opus synthesis-only | **$8–10** | Med | Med | Med | `f8e2a1b3` |
| 5 | manamurah-pemantauan/recap: cap output, sonnet not 4-6 | **$3–5** | Low–Med | Low | Med | `436824db`, `1e5286f4` |
| 6 | Drop crawl-news cadence 3h→6h (if it stays LLM-gated) | $2–3 | Med | Low | Low | superseded by #1 |
| 7 | Fix input-token logging (enables future caching ROI) | $0 now | None | Med | High | gateway cost logger |

## Detailed Recommendations

### 1. De-LLM the two shell-wrapper crons (top cut — $33.6/wk, Low risk)
`crawl-news` prompt is literally `Run: bash ~/.jinn/scripts/crawler/run.sh`; `sync-news-v2` is `Run: bash ~/.jinn/scripts/crawler/sync_news_v2.sh`. They do no reasoning — 95/131 crawl-news runs and 69/226 sync-news runs emit <500 output tokens; the rest is the LLM narrating shell output. Yet each run spawns a full `claude -p` cold subprocess that loads CLAUDE.md (~40KB) + the entire MCP/tool schema surface as input. **Spend: $25.26/wk (sync) + $8.37/wk (crawl) = $33.63/wk.**
- **Change:** Move both to plain system cron / launchd (or a tiny gateway "shell job" type that execs the script with no LLM). The scripts already self-contain all logic.
- **Saved:** ~$33.6/wk (≈$1,750/yr). 100% of these jobs' cost.
- **Quality risk: Low.** The only LLM value-add is error narration; route non-zero exit codes to the Telegram ops channel via a 3-line shell trap — strictly better than a $0.15 LLM summarizing `echo`.
- **Impl:** `jobs.json` entries `FTZ0gjlqsx0jgVZ2_0arJ` and `sync-news-v2-phase2a`. If the gateway has no non-LLM job type, the lowest-effort path is a `launchd` plist calling the script directly and disabling both cron entries.

### 2. Downshift breaking-watch + jinn-group-watcher to haiku ($10–13/wk, Low risk)
`pahang-breaking-watch` + `melaka-breaking-watch` (sonnet, 5×/day each = 65 runs/wk, $22.78/wk) mostly *don't fire* — they scan and conclude "nothing breaking." `jinn-group-watcher` (sonnet hourly, $22/wk) has 87/101 runs under $0.25 — the deterministic prefilter already does lock/watermark/dedup in shell, so the LLM only triages whatever URLs survive.
- **Change:** Set `model: haiku` for both breaking-watch jobs and jinn-group-watcher. The decision ("is this breaking?" / "file this URL via report-url") is classification + tool-routing, well within haiku. Keep sonnet only for the actual SITREP *generation* if a breaking event fires (the breaking-watch can escalate-spawn a sonnet sitrep child only on a hit).
- **Saved:** sonnet→haiku is ~5–8× cheaper on output. Conservatively $10–13/wk across the three.
- **Quality risk: Low** for the no-op scan path (haiku reliably says "nothing"); **Low–Med** for URL triage — mitigate by keeping the escalation step (actual filing) on sonnet.
- **Impl:** `d4b0e8f2`, `b5d8e1f3`, `1a4a909d` in jobs.json `model` field.

### 3. Trim SITREP output verbosity ($8–12/wk, Low–Med risk)
The 5 sitrep jobs cost $57/wk; they generate 16k–17k output tokens/run at sonnet's $15/M output. Much is reflexive boilerplate (guardrail recitations, multi-section padding).
- **Change:** Add an explicit length cap to each sitrep prompt ("Final SITREP body ≤ 1,200 words / ~1,800 output tokens; omit empty sections; no meta-commentary"). The source-dating guardrail can be condensed.
- **Saved:** Halving output on the heavy sitreps (~$30/wk of the cluster is the daily ones) → $8–12/wk.
- **Quality risk: Low–Med** — risk is dropping a genuinely useful detail; mitigate by capping length, not content scope, and keeping the dedup/guardrail logic.
- **Impl:** prompt text for `b2c3d4e5`, `c3a9f7e1`, `a4e7b9c3`, `d4b0e8f2`, `b5d8e1f3`.

### 4. Right-size the pemantau-weekly 18-agent opus swarm ($8–10/wk, Med risk)
One weekly run = $19.80, with 2 opus sessions ($21.26 incl. the synthesis) + 7 sonnet + 7 sonnet-4-6 feeders observed in the cost_log. The biggest single session ($19.80) is jin+17 agents on opus.
- **Change:** Run the 17 *feeder* agents on sonnet (or haiku for the mechanical data-pull feeders) and reserve **opus for the final synthesis only**. CLAUDE.md already prescribes "synthesis-only-on-opus while feeders run cheaper" as the pattern — it isn't being followed here.
- **Saved:** opus is ~5× sonnet on output. Moving ~15 feeders off opus ≈ $8–10/wk (amortized; it's weekly so $35–45/mo).
- **Quality risk: Med** — feeder quality matters for synthesis; mitigate by keeping the synthesizer on opus and spot-checking the first downshifted run against the prior opus-all baseline.
- **Impl:** `f8e2a1b3` prompt — instruct feeder spawns with `model: sonnet`, synthesis with `model: opus`.

### 5. Cap manamurah blog-gen output + drop sonnet-4-6 ($3–5/wk, Low–Med risk)
`manamurah-pemantauan-daily` logs ~31k output tokens/run (and a parallel `claude-sonnet-4-6` variant at 811k *input*/run — likely dumping full MCP dataset responses into context). `manamurah-weekly-recap` = 42k output/run.
- **Change:** (a) Cap blog output length in the skill prompt; (b) use plain `sonnet` not `claude-sonnet-4-6` (4-6 is pricier with no clear win for templated blog assembly the skill calls "mechanical"); (c) summarize MCP tool results before they enter the synthesis context rather than passing raw 811k-token payloads.
- **Saved:** $3–5/wk.
- **Quality risk: Low–Med** — the skill itself describes Stage 2 as "mechanical assembly," so a length cap shouldn't hurt; spot-check one post.
- **Impl:** `436824db`, `1e5286f4`; skill `manamurah-pemantauan-daily/SKILL.md` (read-only here — flag for impl phase).

### 7. Fix input-token logging (enabler, $0 now)
88% of cost_log rows have NULL/<1000 input_tokens. The gateway cost logger isn't extracting `usage.input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` from the CLI JSON. Fixing this won't save money directly but is required to *measure* any future caching/prompt-trim ROI and to validate recs 1–5. **Target:** gateway cost-logging path (where `cost_log` rows are inserted after `GET /api/sessions/<id>`).

## What NOT to cut
- **`malaysia-sitrep-daily` / `pahang-sitrep-daily` / `melaka-sitrep-daily` model (keep sonnet for generation).** These are the user-visible intelligence product; haiku-generating a SITREP risks factual/tone degradation on political content. Trim verbosity (rec 3), don't downshift the generation model.
- **pemantau-weekly synthesis on opus.** The final coalition/GE16 assessment is the highest-stakes analytic output; keep the synthesizer on opus (downshift only feeders).
- **manusiawi / guard / bm-polish quality gates** (run on local Ollama/AGALLM or gpt-4o-mini at ~$0.00) — already nearly free, and they protect public-facing BM output. Don't touch.
- **eval-weekly-rotation, episode-grading, cost-rollup** — small spend ($0.4–0.9/run), each provides system-improvement leverage. Leave.
- **The breaking-watch *escalation* (actual SITREP on a real event)** — if a real breaking event fires, generate on sonnet, not haiku. Only the no-op scan path downshifts.

## Overall Rating & Rationale
**Cost-efficiency: 4.5/10.** The architecture is sound (prefilters, model tiers exist, quality gates run cheap/local) but execution leaves easy money on the table: ~20% of cron spend goes to running `bash` scripts through a full LLM, and high-frequency pollers over-model the no-op path. The biggest theoretical lever (prompt caching) is structurally unavailable because cron uses cold one-shot subprocesses spaced beyond cache TTL. **Realistic Low-risk savings: ~$58–66/wk (~31–35% of cron, ~$250–290/mo)**, dominated by rec 1 ($33.6) and rec 2 ($10–13). Recs 3–5 add another $19–27/wk at slightly higher (still bounded) risk. Implementation order: (1) de-LLM shell wrappers → (2) haiku downshift watchers → (7) fix token logging → (3) trim sitrep output → (4) pemantau feeder downshift.
