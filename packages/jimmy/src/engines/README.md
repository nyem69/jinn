# Jin Engines

Jin's gateway routes sessions to one of several engines. This document
covers the V1 HTTP-loop engines (`ollama`, `openai`) added in PR #13
and how they compose with the existing CLI-spawning engines (`claude`,
`codex`, `gemini`).

## Engine roster

| Engine    | Style       | V1 in this PR | Notes |
|-----------|-------------|---------------|-------|
| `claude`  | CLI spawn   | unchanged     | Default; full tool surface via Claude Code |
| `codex`   | CLI spawn   | unchanged     | `sessions.fallbackEngine` target on Claude rate-limit |
| `gemini`  | CLI spawn   | unchanged     | Optional; opt-in via `engines.gemini` config block |
| `ollama`  | HTTP loop   | **NEW**       | Self-hosted; cost always $0 |
| `openai`  | HTTP loop   | **NEW**       | Cloud API; cost from per-model pricing table |
| `mock`    | in-process  | unchanged     | Tests only; not configurable via `engines.default` |

## Compatibility matrix

What works on the HTTP-loop engines vs. the CLI engines:

|                              | claude/codex/gemini | ollama/openai (V1) |
|------------------------------|:-:|:-:|
| One-shot prompt              | ✅ | ✅ |
| Tool calls (read/write/edit/bash/webfetch) | ✅ | ✅ |
| Streaming to web UI          | ✅ | ❌ (non-streaming) |
| `resumeSessionId`            | ✅ | ❌ (errors before any provider call) |
| `mcpConfigPath`              | ✅ | ❌ (errors before any provider call) |
| `attachments`                | ✅ | ❌ (errors before any provider call) |
| `cliFlags`                   | ✅ | ❌ (no CLI to flag) |
| Sub-agent spawn (`Agent` tool) | ✅ | ❌ |
| TodoWrite / Plan / Skill tools | ✅ | ❌ |
| Rate-limit fallback target   | (claude→codex) | not eligible |

A cron that uses any ❌ feature MUST stay on Claude. Eligibility is per-cron, not engine-wide.

## Release notes (V1)

### `apiKeyEnvVar` / `authTokenEnvVar` store the env var NAME, not the value

The config fields `engines.openai.apiKeyEnvVar` and
`engines.ollama.authTokenEnvVar` take the **name** of an environment
variable (e.g. `"OPENAI_API_KEY"`), not the secret itself. The engine
reads `process.env[name]` at construction.

The constructors validate the field against the POSIX env-var-name
regex `^[A-Z_][A-Z0-9_]*$`. If the value looks like a secret (contains
hyphens, lowercase, `/`, etc.) the engine throws at construction with
guidance:

> `openai.apiKeyEnvVar must be an env var NAME matching [A-Z_][A-Z0-9_]* (e.g. "OPENAI_API_KEY"), not the secret value itself. Got a string of length 47. Set openai.apiKeyEnvVar to the env var name; put the actual secret in your shell / .env file.`

The error never echoes the value (we don't want a misconfigured config
file leaking the secret into gateway logs).

**Recommended pattern:** leave the fields at their defaults
(`OPENAI_API_KEY` / `OLLAMA_TOKEN`) and source the secret from
`~/.jinn/.env` per the existing jin convention. Only set
`apiKeyEnvVar`/`authTokenEnvVar` when you need to point at a
differently-named env var (e.g. running multiple OpenAI accounts).

## Startup contract (read this before opting in)

**Declaring `engines.ollama` or `engines.openai` in `config.yaml` is a
startup contract.** The gateway will refuse to boot if the block is
present but construction fails (e.g. missing `url` for ollama, missing
API key env var for openai). The error message includes the failing
engine name and the guidance:

> → Fix the config OR remove the engines.<name> block to opt out.

To opt out cleanly, remove the entire block. To keep it enabled, ensure
the required url / env var is set before booting.

This is intentional. Silent skip-on-construction-failure was the old
behavior in earlier review iterations; it was rejected because it lets
cron jobs that target `engine: "ollama"` succeed in writing run-log
entries while their actual sessions fail downstream. Loud boot failure
forces the operator to either fix the misconfiguration or make the
opt-out explicit.

## Config

Add one or both blocks under `engines:` in `~/.jinn/config.yaml`:

```yaml
engines:
  default: claude   # cannot be "mock"
  claude:           # required, unchanged
    bin: claude
    model: opus
  codex:            # required, unchanged
    bin: codex
    model: gpt-5.4

  # New: opt-in. Remove either block entirely to opt out.
  ollama:
    url: https://ollama.aga.my
    model: qwen2.5:7b-instruct
    maxTurns: 25
    timeoutMs: 300000        # whole-loop wall clock (ms)
    providerTimeoutMs: 60000 # per-HTTP-call timeout (ms)
    authTokenEnvVar: OLLAMA_TOKEN  # optional; default OLLAMA_TOKEN
    tools:
      enabled: [read, write, edit, bash, webfetch]
      bashAllowlist:
        - git
        - curl
        - python3
        - sqlite3
        - jq
      webfetch:
        allowPrivate: false   # default; true only for trusted internal use

  openai:
    baseUrl: https://api.openai.com/v1   # default
    apiKeyEnvVar: OPENAI_API_KEY         # default
    model: gpt-4o-mini
    maxTurns: 25
    timeoutMs: 300000
    tools:
      enabled: [read, write, edit, webfetch]   # bash deliberately omitted here
```

### Tool configuration defaults (V1 deny-by-default)

- `tools.enabled` undefined or `[]` → **text-only mode**. The model
  receives an empty `tools` array; it cannot call any tool. Useful for
  pure-classification / pure-summarization cron jobs.
- `tools.enabled: ["bash"]` with no `bashAllowlist` → bash tool is
  registered but every call returns `error: "disabled"`. The deny-by-
  default posture means you must explicitly list the executables you
  trust.
- The hardcoded NEVER-LIST overrides any allowlist:
  `sh, bash, zsh, fish, ksh, csh, tcsh, dash, ash, env, xargs, eval,
  exec, source` are refused even if added to `bashAllowlist`.
- `python3` invocations get extra scrutiny: must include a positional
  script path that resolves under `cwd` and exists; `-c`, `-m`, `-`,
  `-i` flags are rejected.
- Filesystem tools (`read`, `write`, `edit`) are jailed under the
  session `cwd` via two-stage check (lexical + realpath). Symbolic
  links pointing outside the jail are refused; for `write`/`edit`,
  any symlink leaf is refused regardless of target.
- `webfetch`: http/https only, max 5 same-scheme redirects, custom
  DNS lookup validates the actual socket address at connect time
  (DNS-rebinding mitigation), private/loopback/link-local IPs
  refused unless `tools.webfetch.allowPrivate: true`.

## Cost reporting

| Engine | Cost calculation | Behavior on unknown model |
|--------|------------------|----------------------------|
| ollama | always `0` | n/a |
| openai | `(prompt_tokens × in_rate + completion_tokens × out_rate) / 1e6` from `providers/pricing.ts` | returns `cost: undefined` (NOT 0) so the `cost_log` row records `NULL` |

Pricing uses `response.model` (what the provider actually billed) and
falls back to the requested model only when the response omits it.
An unknown model logs a `logger.warn` so it surfaces in the weekly
rollup as a "pricing gap" signal.

## Audit log

Every tool call produces an `AuditRow` with this exact shape:

```ts
{
  toolName: string;          // "read" | "write" | "edit" | "bash" | "webfetch"
  argsSummary: string;       // JSON.stringify(sanitized args)
  durationMs: number;        // wall-clock for the tool call
  error: string | null;      // short code or null on success
  truncated: boolean;        // any output stream truncated?
  resultBytes: number | null;  // pre-truncation byte count
  exitCode: number | null;     // bash only
  httpStatus: number | null;   // webfetch only
}
```

**Audit rows never contain the tool's output content** (stdout, stderr,
file body, HTTP response body). The model already saw that content in
its conversation; logging it twice doubles storage and creates a leak
surface for secrets the model observed.

The `argsSummary` is sanitized before serialization:

- Object keys matching `api_key`, `authorization`, `token`, `secret`,
  `password`, `bearer`, `cookie` (case-insensitive) → value replaced
  with `[redacted]`.
- URL strings with credentials are stripped: `https://user:pass@host`
  loses the userinfo; `?api_key=...`, `?token=...`, `?password=...`,
  `?signature=...` query values redacted while preserving the key
  name as a debug signal.
- Long string values capped at 200 chars + `…[N more]` marker.
- Recursion depth capped at 5.

In V1 the `AuditLogger` interface is pluggable but the sink is **not
yet wired to sqlite**. The engine wrappers accept an optional
`{ audit: AuditLogger }` constructor argument; production wiring (to
`~/.jinn/sessions/registry.db tool_call_log`) ships in a follow-up.
Until then, audit calls go to a no-op. Audit-sink failures (when wired)
do NOT abort the agent loop; they log via `logger.warn` so persistent
issues are visible.

## Migration recipe

Move a Claude cron to ollama or openai when:
- The cron's task is one of: BM polish, classification, summarization,
  URL triage, transcript reading.
- The cron does NOT use sub-agents, MCP, attachments, or session resume.

### Step-by-step

1. **Pick the target engine.** Default to `openai` for tasks needing
   strong reasoning; default to `ollama` for high-volume tasks where
   cost matters more than ceiling quality.

2. **Validate config block** in `config.yaml` before touching the cron.
   Boot the gateway once after adding the block. If it doesn't start,
   fix the error or remove the block.

3. **Duplicate the cron job** in `~/.jinn/cron/jobs.json`:
   - Same prompt
   - `engine: "ollama"` or `engine: "openai"`
   - `name: "<original>-shadow"`
   - `enabled: false`
   - `schedule`: offset by a few minutes from the original

4. **Enable the shadow.** Let it run alongside the Claude cron for
   3 wall-clock days, minimum 3 fires each.

5. **Compare deliverables side-by-side.** What you actually need to
   verify:
   - Issue rows / news rows written with the same structural shape
   - Headlines / classifications match on factual claims
   - `cost_log.cost_usd` for the shadow is at least N× cheaper than
     the Claude run (where N matches your savings target)

   **Do not rely on cron run-log status alone for migration monitoring.**
   The run-log records the synchronous `route()` return value of
   `sessions.manager.route()`. If the actual `runSession()` fails
   asynchronously after route() has returned (engine missing, provider
   error, max_turns), the run-log still says `success`. This is a
   pre-existing limitation across all engines and is out of scope for
   V1 to change. Use the SHADOW's actual delivered outputs, the
   `sessions` table `last_error` column, and gateway logs (look for
   `Engine "<name>" not available` or `<engine>: <error_kind>:` lines)
   to gate the migration decision.

6. **If parity holds**: flip the original cron to the new engine,
   leave the shadow disabled as a rollback artifact. Watch for one
   more week before deleting the shadow entry.

7. **If parity fails**: keep the original on Claude. Either tighten the
   prompt for the new engine, switch target model, or accept that the
   task isn't eligible for migration.

### Rollback

One JSON edit: flip `engine` back to `"claude"` on the original cron
entry. The next gateway reload (or restart) picks it up.

## Operational visibility

- `GET /api/status` returns one entry per **registered** engine. An
  opt-in HTTP engine that's declared in config but failed construction
  is NOT in the response (the gateway never booted in that state).
- Cron route failures (manager.ts:230) deliver the message
  `Error: engine "<name>" not available.` via the cron's configured
  delivery connector (Telegram, WhatsApp, etc.). The error is also
  logged at `error` level.
- `sessions.fallbackEngine` still only accepts `"codex"` — this is the
  existing Claude rate-limit fallback, NOT a provider-fallback
  mechanism. There is no automatic ollama→openai or openai→claude
  routing in V1.

## Known V1 limitations (carry into the docs of any cron that opts in)

- No streaming responses (not exposed in web UI).
- No resume of previous sessions (`resumeSessionId` rejected before
  provider call).
- No MCP server support.
- No file attachments.
- No sub-agent spawning (`Agent` tool isn't in the registry).
- No automatic provider-level fallback.
- Audit-log sqlite writer not yet wired (interface is pluggable;
  default is no-op).
- Cron run-log `success` status is async-decoupled from session
  outcome — see migration recipe step 5.

## File map

```
packages/jimmy/src/engines/
├── ollama.ts                   # Engine wrapper
├── openai.ts                   # Engine wrapper (reuses rejectUnsupported)
├── agentLoop.ts                # Provider-agnostic loop
├── audit.ts                    # AuditLogger interface + sanitizer
├── providers/
│   ├── ollama.ts               # HTTP adapter
│   ├── openai.ts               # HTTP adapter
│   ├── pricing.ts              # Per-model rate table
│   └── types.ts                # NormalizedToolCall, ProviderMessage, ...
├── tools/
│   ├── index.ts                # buildToolRegistry
│   ├── schemas.ts              # JSON schemas exposed to the model
│   ├── cwdJail.ts              # lexical + realpath jail
│   ├── ipBlocklist.ts          # IPv4/IPv6 block ranges for webfetch
│   ├── read.ts / write.ts / edit.ts
│   ├── runCommand.ts           # argv-only "bash" tool
│   └── webfetch.ts             # http/https with DNS-rebinding mitigation
└── __tests__/
    ├── audit.test.ts
    ├── agentLoop.test.ts
    ├── wrappers.test.ts
    ├── buildLookup.test.ts
    ├── report-url.fixture.test.ts
    └── fixtures/
        └── report-url/
            ├── input.txt
            └── expected-classification.schema.json
```
