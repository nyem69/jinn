# Security Auditor Review — jin (2026-05-24)

## Summary

The jin gateway (jimmy) is a single-user local-only system with a generally
sound architectural base: the HTTP server binds to 127.0.0.1 by default, SQLite
queries are exclusively parameterized, and the tool-execution sandbox for non-
Claude engines (runCommand, webfetch) is thoughtfully hardened. However, three
issues are serious enough to warrant prompt remediation. First, a wildcard CORS
header (`Access-Control-Allow-Origin: *`) combined with the complete absence of
any authentication or CSRF protection means any browser tab can silently call
every state-mutating API route (including POST /api/cron, PUT /api/config, POST
/api/sessions) without the user's knowledge. Second, a hardcoded plaintext MySQL
password (`<REDACTED>`) is embedded in a cron prompt in jobs.json, which is
committed to git and visible in cron run logs stored in the same repository.
Third, the file-upload endpoint accepts a caller-supplied `path` field and writes
the uploaded bytes to any filesystem path the OS user can write to, with no
scope restriction.

**Overall security posture: 5 / 10** — Strong in sandboxing and SQL safety;
weak in authentication surface and operational secret hygiene.

---

## Findings Table

| # | Severity | Confidence | Finding | Location |
|---|----------|------------|---------|----------|
| 1 | **Critical** | High | Hardcoded plaintext MySQL password in cron prompt (committed to git) | `~/.jinn/cron/jobs.json` line 317 |
| 2 | **High** | High | Wildcard CORS + no AuthN/CSRF: any local browser tab can mutate state | `packages/jimmy/src/gateway/server.ts:634` |
| 3 | **High** | High | Arbitrary filesystem write via `POST /api/files` `path` field — no scope restriction | `packages/jimmy/src/gateway/files.ts:122-125` |
| 4 | **High** | High | Path traversal: URL-decoded route params go directly into `path.join` (skills, org, cron-runs) | `packages/jimmy/src/gateway/api.ts:1151,1491,1590,1599` |
| 5 | **Medium** | High | `--dangerously-skip-permissions` hardcoded for every Claude spawn (no config toggle) | `packages/jimmy/src/engines/claude.ts:110` |
| 6 | **Medium** | High | 13 cron prompts embed `~/.jinn/.env` reference + secret variable names; prompt text stored in cron run JSONL logs | `~/.jinn/cron/jobs.json` (multiple entries) |
| 7 | **Medium** | Medium | `POST /api/skills/install` passes caller-controlled `source` string to `npx skills add` — installs arbitrary npm packages without validation | `packages/jimmy/src/gateway/api.ts:1552` |
| 8 | **Medium** | Medium | `GET /api/config` sanitizes connector tokens but leaks full gateway config (engine API keys from env, cron schedule, employee prompts, model names) | `packages/jimmy/src/gateway/api.ts:1608-1639` |
| 9 | **Low** | High | Telegram `allowFrom` is optional; if not configured, **any** Telegram user who knows the bot token can trigger sessions | `packages/jimmy/src/connectors/telegram/index.ts:36-39` |
| 10 | **Low** | High | Discord `allowFrom` is optional and empty-Set-means-no-restriction; any member of a server with the bot can trigger sessions | `packages/jimmy/src/connectors/discord/index.ts:263` |
| 11 | **Low** | Medium | `POST /api/cron` / `PUT /api/cron/:id` accept arbitrary prompt text with no length cap or content policy check | `packages/jimmy/src/gateway/api.ts:1162-1201` |
| 12 | **Low** | Medium | `POST /api/sessions` `engine` field is user-controlled and unchecked — could dispatch to any registered engine including `ollama`/`openai` if configured | `packages/jimmy/src/gateway/api.ts:980` |
| 13 | **Low** | Low | Debug-level logging of the first 5 lines of Claude stdout (300 chars each) may capture prompt or tool-output fragments in `gateway.log` | `packages/jimmy/src/engines/claude.ts:414` |

---

## Detailed Findings

### [CRITICAL] Hardcoded plaintext MySQL password in cron prompt

- **Severity:** Critical
- **Confidence:** High
- **Location:** `~/.jinn/cron/jobs.json` line 317 (crisis-watch-lss job)
- **Evidence:**
  ```
  mysql -h 124.217.249.135 -u azmi -p'<REDACTED>' --skip-ssl pahang_warroom_cc
  ```
  A second job (job at line 110) references the same DB using the env-var form
  (`$PAHANG_WARROOM_MYSQL_PASSWORD`). The job at line 317 is the older version
  that was not updated and still has the literal credential inline.
  `jobs.json` is committed to git in the `~/.jinn` repo (confirmed via `git status`
  showing `cron/jobs.json` as a modified tracked file).
- **Impact:** Anyone who can read the git history or the file gains a MySQL
  password to a production Pahang warroom database at `124.217.249.135`. The host
  accepts remote connections. The password is also emitted verbatim into every
  Claude prompt run and therefore appears in session message rows in
  `registry.db` and in cron run JSONL files under `cron/runs/`.
- **Recommendation:**
  1. Immediately rotate the password on the Pahang warroom MySQL instance.
  2. Replace the hardcoded credential with `$PAHANG_WARROOM_MYSQL_PASSWORD` (the
     env-var form already used in the updated version of the same job).
  3. Purge the literal credential from git history using `git filter-repo` or
     BFG Repo Cleaner.
  4. Add a `.gitattributes` or pre-commit hook that blocks committing
     `jobs.json` lines matching `password\|passwd\|-p'` patterns.

---

### [HIGH] Wildcard CORS + no authentication/CSRF protection

- **Severity:** High
- **Confidence:** High
- **Location:** `packages/jimmy/src/gateway/server.ts:633-636`
- **Evidence:**
  ```typescript
  // CORS headers for development
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  ```
  No `Authorization` header check, no `Origin` validation, no CSRF token, no
  `SameSite` cookies anywhere in the codebase.
- **Impact:** Any web page open in the user's browser can issue
  `fetch("http://127.0.0.1:7777/api/cron", {method:"POST", body:...})` and
  create/modify cron jobs, spawn sessions, update config, delete skills, or
  trigger cron runs — all silently in the background. A single phishing link or
  malicious ad on any tab is sufficient.  The "it's localhost" rationale is
  negated by the wildcard `Access-Control-Allow-Origin: *`, which is
  specifically what browsers check before allowing cross-origin requests.
- **Recommendation:**
  1. Replace `Access-Control-Allow-Origin: *` with a locked-down origin list
     (e.g., `http://localhost:7777` or the configured host:port only).
  2. For state-mutating routes add either: (a) a shared secret header
     (`X-Jinn-Token`) checked on every POST/PUT/DELETE; or (b) `Origin`
     validation against the configured host, which is a CSRF mitigation
     sufficient for a single-user local tool.
  3. The comment says "for development" — this should be gated behind a
     `config.gateway.corsOrigins` config that defaults to `null` (deny all
     cross-origin) and only opens up when explicitly set.

---

### [HIGH] Arbitrary filesystem write via `POST /api/files` `path` field

- **Severity:** High
- **Confidence:** High
- **Location:** `packages/jimmy/src/gateway/files.ts:122-125`
- **Evidence:**
  ```typescript
  if (result.customPath) {
    const expanded = expandPath(result.customPath);
    fs.mkdirSync(path.dirname(expanded), { recursive: true });
    fs.writeFileSync(expanded, result.buffer);
  }
  ```
  `expandPath` only expands `~/` to `os.homedir()`. There is no check that
  the resulting path is within `FILES_DIR` or `JINN_HOME`. A caller can POST
  with `path=/etc/cron.d/backdoor` or `path=~/.ssh/authorized_keys` and the
  gateway will write the multipart body to that path.
- **Impact:** Given the CSRF/CORS gap (Finding #2), any browser tab can silently
  overwrite arbitrary files owned by the process user. Combined with the
  `open=true` field (which calls `spawn("open", [targetPath])`), an attacker
  can both place and open a malicious file.
- **Recommendation:**
  1. Validate `expanded` starts with `FILES_DIR` or optionally `JINN_HOME`; if
     not, reject with 400.
  2. Remove or strictly gate the `open` parameter — arbitrarily opening files
     via the API is a privilege escalation surface even without the path issue.

---

### [HIGH] Path traversal: route params unsanitized before `path.join`

- **Severity:** High
- **Confidence:** High
- **Location:** `packages/jimmy/src/gateway/api.ts:1151, 1491, 1590, 1599`
- **Evidence:**
  ```typescript
  // matchRoute decodes params with decodeURIComponent — no ../ check
  params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);

  // Then used directly in path.join:
  const runFile = path.join(CRON_RUNS, `${params.id}.jsonl`);         // line 1151
  const boardPath = path.join(ORG_DIR, params.name, "board.json");    // line 1491
  const skillMd = path.join(SKILLS_DIR, params.name, "SKILL.md");     // line 1590
  const skillDir = path.join(SKILLS_DIR, params.name);                // line 1599
  ```
  Confirmed with `node -e`:
  ```
  path.join('/home/user/.jinn/skills', '../../../etc/passwd', 'SKILL.md')
  // → /home/etc/passwd/SKILL.md
  ```
  A URL-encoded `..` (`%2e%2e`) is decoded by `decodeURIComponent` before being
  passed to `path.join`. `path.join` does not prevent `..` traversal.
- **Impact:**
  - `GET /api/skills/..%2F..%2F..%2Fetc/passwd` → reads arbitrary files.
  - `DELETE /api/skills/..%2F..%2F..%2Fetc/passwd` → `fs.rmSync` on arbitrary
    paths (blocked by the OS user's write permissions, but could delete important
    files under `~/.jinn`).
  - `GET /api/cron/..%2F..%2Fsome-id/runs` → exposes run files from other
    directories.
- **Recommendation:**
  After `path.join`, add a jail check:
  ```typescript
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(BASE_DIR) + path.sep)) {
    return res.writeHead(403).end();
  }
  ```
  Apply to every route that uses params in `path.join`. The `cwdJail.ts` module
  (used by the tool sandbox) already implements exactly this pattern; reuse it.

---

### [MEDIUM] `--dangerously-skip-permissions` hardcoded for every Claude spawn

- **Severity:** Medium
- **Confidence:** High
- **Location:** `packages/jimmy/src/engines/claude.ts:110`
- **Evidence:**
  ```typescript
  const args = ["-p", "--output-format", streaming ? "stream-json" : "json",
    "--verbose", "--dangerously-skip-permissions", "--chrome"];
  ```
- **Impact:** Claude Code runs without any permission confirmation dialogs.
  A prompt-injected payload or jailbroken sub-agent can read, write, and
  execute arbitrary files on the host without any UX confirmation gate. This is
  the intended design for an automated pipeline, but it means the gateway's
  security posture depends entirely on upstream prompt hygiene — there is no
  last-resort brake.
- **Recommendation:**
  Make this flag opt-in via `config.engines.claude.dangerouslySkipPermissions`
  (default `false`). When `false`, omit the flag so the Claude CLI's permission
  system acts as a depth-defense layer. Document the trade-off clearly.

---

### [MEDIUM] Cron prompts embed `.env` path + secret variable names; logged to disk

- **Severity:** Medium
- **Confidence:** High
- **Location:** `~/.jinn/cron/jobs.json` (13 entries referencing `~/.jinn/.env`)
- **Evidence (representative):**
  ```
  "Secrets are in ~/.jinn/.env: CF_ANALYTICS_API_TOKEN (analytics read),
  CF_MANAMURAH_ZONE_TOKEN (zone read+edit). Source it: set -a; . ~/.jinn/.env; set +a."
  ```
  Also: NEO4J_AURA_PASSWORD, PAHANG_WARROOM_MYSQL_PASSWORD, RESEND_API_KEY,
  MANAMURAH_RESEND_API_KEY, TELEGRAM_BOT_TOKEN all mentioned by name.
  These prompt strings are stored as session messages in `registry.db`
  (via `insertMessage`) and as JSONL in `cron/runs/*.jsonl`, which are
  untracked files in the git repo (visible in `git status`).
- **Impact:** If `registry.db` or `cron/runs/` are ever accidentally committed
  or exfiltrated, the secret variable names are exposed. For Finding #1's case
  the actual value was also inline. Prompts that run `source ~/.jinn/.env` then
  expand tokens into `curl` invocations may also have the expanded values
  captured in stderr/stdout and written to session message rows.
- **Recommendation:**
  1. Move secret provisioning from prompt text to a gateway-side pre-execution
     hook: before spawning Claude, load `.env` and inject variables into the
     subprocess environment (not the prompt string). The claude engine's
     `buildCleanEnv()` already passes `process.env` to subprocesses; add an
     optional `dotenvPath` config key to load `.env` at gateway startup.
  2. Avoid naming specific secret variables in prompt text. Replace with a
     general instruction ("secrets are pre-loaded into the environment").
  3. Ensure `cron/runs/` is in `.gitignore` for the `~/.jinn` repo.

---

### [MEDIUM] `POST /api/skills/install` executes caller-controlled npm package source

- **Severity:** Medium
- **Confidence:** Medium
- **Location:** `packages/jimmy/src/gateway/api.ts:1542-1552`
- **Evidence:**
  ```typescript
  const source = body.source;   // directly from request body, no validation
  if (!source) return badRequest(res, "source is required");
  // ...
  execFileSync("npx", ["skills", "add", String(source), "-g", "-y"], {
    encoding: "utf-8",
    timeout: 60000,
  });
  ```
- **Impact:** The `source` value is passed as an argv element to `npx skills add`.
  `execFileSync` with an argv array (not `exec`) does prevent shell injection,
  but `npx skills add` will execute whatever `source` specifies as an npm
  package identifier. An attacker who reaches this endpoint (possible via CSRF,
  Finding #2) can install and execute arbitrary npm packages globally.
  This is an effective code-execution primitive on the host.
- **Recommendation:**
  1. Validate `source` against a format allowlist: known registry package names
     (`/^[a-z0-9-_@/]+$/`) or explicit HTTPS GitHub URLs. Reject anything else.
  2. Require a secondary confirmation token for package installs.

---

### [MEDIUM] `GET /api/config` leaks engine models, cron schedule, employee prompts

- **Severity:** Medium
- **Confidence:** High
- **Location:** `packages/jimmy/src/gateway/api.ts:1608-1639`
- **Evidence:**
  The sanitization strips `token`, `botToken`, `signingSecret`, `appToken` from
  connector configs but returns the full `config` object including:
  `engines.claude`, `engines.openai`, `engines.ollama` (with model names and any
  URLs), `cron` settings, `portal` config, `context` block, and `sessions`
  config. Engine API keys held in env vars are not in `config.yaml` and thus not
  leaked here, but model routing and cron delivery channel IDs are.
- **Impact:** Any browser tab (via CSRF, Finding #2) can learn the full system
  topology: engine endpoints, default models, cron delivery channels (WhatsApp
  group JIDs).
- **Recommendation:** Scope the response to the fields the UI actually needs.
  At minimum, confirm no credentials are reachable through nested config blocks
  as the config schema evolves.

---

### [LOW] Telegram `allowFrom` optional — open bot if unconfigured

- **Severity:** Low
- **Confidence:** High
- **Location:** `packages/jimmy/src/connectors/telegram/index.ts:36-39`
- **Evidence:**
  ```typescript
  this.allowedUsers =
    config.allowFrom && config.allowFrom.length > 0
      ? new Set(config.allowFrom)
      : null;           // null → skip allowlist check entirely
  ```
  At line 77: `if (this.allowedUsers) { ... check ... }`. If `allowFrom` is
  absent from config, `allowedUsers` is `null` and the check is skipped.
- **Impact:** Any Telegram user who learns the bot token can send messages to
  the bot and trigger full session execution. The token is the only gate.
- **Recommendation:** Change the default to deny-all: if `allowFrom` is not
  configured, log a warning and reject all incoming messages (or refuse to start
  the connector).

---

### [LOW] Discord `allowFrom` optional — empty Set means no restriction

- **Severity:** Low
- **Confidence:** High
- **Location:** `packages/jimmy/src/connectors/discord/index.ts:63-69, 263`
- **Evidence:**
  ```typescript
  this.allowedUserIds = new Set(
    Array.isArray(config.allowFrom) ? config.allowFrom
    : config.allowFrom ? [config.allowFrom] : [],
  );
  // line 263:
  if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(message.author.id)) return;
  ```
  An empty `allowFrom` → `size === 0` → the condition short-circuits and every
  message is processed.
- **Impact:** Any Discord user in a server where the bot is present (or in DMs)
  can trigger sessions if `allowFrom` is empty.
- **Recommendation:** Same as Telegram: default to deny-all when `allowFrom` is
  empty. Or at minimum document that an empty list means "allow all" so operators
  make an explicit choice.

---

### [LOW] `POST /api/cron` and `PUT /api/cron/:id` accept unlimited prompt text

- **Severity:** Low
- **Confidence:** Medium
- **Location:** `packages/jimmy/src/gateway/api.ts:1162-1201`
- **Evidence:**
  ```typescript
  const newJob: CronJob = {
    // ...
    prompt: body.prompt || "",   // no length cap, no content validation
  };
  ```
- **Impact:** A large prompt can fill disk via `cron/runs/*.jsonl` and
  `messages` table rows. Combined with Finding #2, a malicious page could plant
  a prompt-injection payload in a future cron job.
- **Recommendation:** Add a reasonable length cap (e.g., 64 KB) and emit a
  warning when the prompt contains patterns that look like credential references.

---

### [LOW] `POST /api/sessions` `engine` field is user-controlled

- **Severity:** Low
- **Confidence:** Medium
- **Location:** `packages/jimmy/src/gateway/api.ts:980`
- **Evidence:**
  ```typescript
  const engineName = body.engine || config.engines.default;
  // ...
  const engine = context.sessionManager.getEngine(engineName);
  ```
  The engine name is passed from the body without validation against the
  registered engine map until `getEngine` is called. If `ollama` or `openai`
  is configured with liberal tool allowlists, a caller may intentionally route
  to the weaker engine.
- **Impact:** Low in isolation; higher if combined with CSRF and a less-hardened
  engine.
- **Recommendation:** Validate `engineName` against `context.engines.keys()`
  before creating the session; reject unknown values with 400.

---

### [LOW] Debug logging may capture prompt/tool fragments

- **Severity:** Low
- **Confidence:** Low
- **Location:** `packages/jimmy/src/engines/claude.ts:414`
- **Evidence:**
  ```typescript
  if (lineCount <= 5) {
    logger.debug(`[claude stream] line ${lineCount}: ${trimmed.slice(0, 300)}`);
  }
  ```
  Debug logging is only active when `config.logging.level` includes debug. The
  first 5 lines of Claude's stdout JSON stream (up to 300 chars each) are
  written to `logs/gateway.log`.
- **Impact:** Depending on Claude's stream format, this may include fragments
  of the prompt or tool inputs, which could contain secrets injected by the
  user via cron prompts (see Finding #6).
- **Recommendation:** Guard this behind a separate `config.logging.logStreamData`
  boolean (default `false`), rather than coupling it to the log level.

---

## Quick Wins (low-effort, high-value)

1. **Rotate the MySQL password** (`<REDACTED>`) immediately — 5 minutes, no
   code change required.
2. **Add `.gitignore` for `cron/runs/` and `sessions/`** in `~/.jinn` — prevents
   accidental secret leakage in git, 1 line change.
3. **Narrow the CORS origin** from `*` to `http://127.0.0.1:7777` (or the
   configured host:port) — 2-line change in `server.ts`, blocks browser CSRF
   entirely.
4. **Add path-jail check after every `path.join(BASE, params.x)`** — reuse the
   existing `cwdJail.ts` resolve logic, ~5 lines per affected route.
5. **Validate the files `path` field against `JINN_HOME`** — 3 lines in
   `files.ts:saveFile`.
6. **Add `allowFrom` required validation** in Telegram and Discord constructors —
   fail loud or default deny when the field is absent, rather than silently
   opening to all.

---

## Positive Findings

The following areas are well-handled and should be preserved:

- **SQLite queries** — all queries in `registry.ts` use `better-sqlite3`
  prepared statements with `?` placeholders. No string interpolation in SQL
  was found. Immune to injection.
- **runCommand tool sandbox** — shell metacharacter rejection, NEVER_LIST
  (blocks `sh`, `bash`, `env`, `xargs`, etc.), configurable allowlist,
  python3 script-file-only restriction, and per-call timeout are all solid.
- **webfetch SSRF mitigations** — comprehensive IPv4/IPv6 blocklist covering
  loopback, private, link-local, CGNAT; two-phase DNS check (pre-resolve +
  connect-time lookup intercept) provides DNS rebinding protection. This is
  noticeably above average.
- **cwdJail.ts** — the lexical + realpath two-stage jail with symlink-leaf
  protection is a clean implementation. The gap is that it is not applied to
  the API route params (Finding #4).
- **`.env` file permissions** — `~/.jinn/.env` is `600` (owner-read-only).
  Correct.
- **Config sanitization in `GET /api/config`** — connector tokens are replaced
  with `"***"`. The `deepMerge` function also preserves original secret values
  when the UI sends back a `"***"` placeholder during `PUT /api/config`.
- **Gateway bind address** — defaults to `127.0.0.1`, not `0.0.0.0`. Correct.
- **Telegram and WhatsApp** both implement per-message ID/JID allowlist checks
  when configured. The gap is only in the absence of a default-deny posture.

---

## Overall Rating & Rationale

**5 / 10**

The infrastructure plumbing (database, tool sandbox, SSRF protection) is
above average for a personal AI automation system. The weaknesses are
concentrated in the HTTP API layer and operational practices, which is the
attack surface that matters most for a persistent local service that any
browser tab on the machine can reach.

The critical finding (hardcoded password) is a data breach risk independent of
any code path. The high CORS/CSRF finding transforms every other API vulnerability
into a remotely exploitable one with no user interaction beyond visiting a
malicious URL. The arbitrary file-write and path traversal findings compound
each other. These three issues together represent a meaningful risk of
filesystem compromise and credential theft from a single phishing link.

None of the issues require deep architectural changes — the hardest fix is the
CORS/auth story, which only requires adding a shared-secret header check (~10
lines) and narrowing the CORS origin list (~2 lines).
