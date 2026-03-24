# Consolidated Code Review — `feat/agentic-patterns`

**Reviewers:** Security Auditor, Performance Engineer, Type Safety Reviewer, UX/Accessibility, Architecture Reviewer
**Date:** 2026-03-24
**Scope:** 4 files, +117 lines across `api.ts`, `manager.ts`, `gateway-server.ts`, `types.ts`

---

## CRITICAL (1 finding, confirmed by 3/5 reviewers)

### C1 — `cleanupMcpConfigFile` called with file path instead of session ID
**File:** `api.ts:1971`
**Confirmed by:** Performance, Type Safety, Architecture
**Description:** `cleanupMcpConfigFile(mcpConfigPath)` passes the full path, but the function expects a session ID and reconstructs the path internally. The constructed path is nonsensical (`~/.jinn/tmp/mcp//Users/azmi/.jinn/tmp/mcp/<uuid>.json.json`), so the temp file is never deleted. `manager.ts` correctly passes `session.id`.
**Impact:** Every web session with MCP leaks a JSON file in `~/.jinn/tmp/mcp/`. Unbounded disk growth.
**Fix:** `cleanupMcpConfigFile(currentSession.id)`

---

## HIGH (6 unique findings)

### H1 — Timer leak in `manager.ts` error path
**File:** `manager.ts:330-360`
**Confirmed by:** Performance
**Description:** `timeoutHandle` is cleared on the happy path (line 360) but NOT in the `catch`/`finally` block. If `engine.run()` throws, the timeout fires on an already-completed session.
**Fix:** Move `clearTimeout(timeoutHandle)` into the existing `finally` block.

### H2 — Timeout logic duplicated between `api.ts` and `manager.ts`
**File:** `api.ts:1905-1921`, `manager.ts:329-344`
**Confirmed by:** Performance, Architecture
**Description:** 18 lines of identical timeout code in both run paths. C1 above is a direct consequence — the copy diverged. Any future fix must be applied twice.
**Fix:** Extract to `shared/timeout.ts` helper.

### H3 — `invoke_employee` has no upper bound on `timeoutSeconds`
**File:** `gateway-server.ts:303`
**Confirmed by:** Security
**Description:** Caller can pass `86400` (24h) or `Infinity`. No concurrency limit exists. Multiple long polls exhaust the session table and event loop.
**Fix:** Clamp to `Math.min(Math.max(rawTimeout, 1), 600)` and validate as finite number.

### H4 — Untyped `as any` casts on API responses in `invoke_employee`
**File:** `gateway-server.ts:299, 310`
**Confirmed by:** Type Safety
**Description:** `createResult as any` and `session as any` skip all shape validation. A malformed response silently produces `undefined` access.
**Fix:** Add runtime shape guards before property access.

### H5 — `invoke_employee` leaks full internal API response on failure
**File:** `gateway-server.ts:301`
**Confirmed by:** Security
**Description:** `detail: createResult` returns raw gateway error body (potentially stack traces, config details) to the MCP caller.
**Fix:** Return opaque error message only; log full response server-side.

### H6 — Timed-out sessions use `"error"` status in web path (should be `"interrupted"`)
**File:** `api.ts:2274`
**Confirmed by:** UX
**Description:** `manager.ts` correctly distinguishes `wasInterrupted` from genuine errors. `api.ts` does not — all errors become `status: "error"`. Web UI shows red error badge for intentional timeout kills.
**Fix:** Mirror `manager.ts` pattern: `status: wasInterrupted ? "idle" : (result.error ? "error" : "idle")`.

---

## MEDIUM (10 unique findings)

### M1 — Race condition: `isAlive()` check after `engine.kill()` is not atomic
**File:** `api.ts:1911-1919`, `manager.ts:334-342`
**Confirmed by:** Security, UX, Architecture
**Description:** `kill()` sends SIGTERM asynchronously. `isAlive()` immediately after will return `true` for live processes (not yet exited). The fallback works for the "never started" case by coincidence but is semantically fragile.
**Fix:** Check `isAlive()` BEFORE calling `kill()`. If alive → kill only. If not alive → force-mark interrupted.

### M2 — `invoke_employee` blocks MCP stdio channel for full duration
**File:** `gateway-server.ts:293-336`
**Confirmed by:** Architecture
**Description:** The MCP server is single-process stdio. While polling, no other MCP tool calls can be served. Not documented in tool description.
**Fix:** Document blocking nature in tool description. Consider gateway-level `/api/sessions/invoke` endpoint for non-blocking alternative.

### M3 — `invoke_employee` timeout returns no partial output
**File:** `gateway-server.ts:329-335`
**Confirmed by:** UX
**Description:** When polling times out, response contains no partial assistant content even though the child may have produced output.
**Fix:** Fetch last assistant message before returning timeout response.

### M4 — Orphaned child sessions on `invoke_employee` timeout
**File:** `gateway-server.ts:329-335`
**Confirmed by:** Performance, UX, Architecture
**Description:** On timeout, child session keeps running with no consumer. Accumulates cost and resources.
**Fix:** Send interrupt/stop request to child before returning timeout error.

### M5 — `args.timeoutSeconds` not validated as number
**File:** `gateway-server.ts:303`
**Confirmed by:** Type Safety
**Description:** `as number` cast without guard. String values produce `NaN`, causing instant timeout (poll loop never runs).
**Fix:** `typeof rawTimeout === "number" && rawTimeout > 0 ? rawTimeout : 300`

### M6 — URL path injection via unvalidated string args
**File:** `gateway-server.ts:244,272,287,344,349,354`
**Confirmed by:** Security
**Description:** `sessionId`, `employee`, `name` interpolated directly into HTTP paths. No format validation.
**Fix:** Validate UUID format for session IDs, `^[a-z0-9-]+$` for names.

### M7 — Cross-employee prompt injection via `invoke_employee`
**File:** `gateway-server.ts:295-299`
**Confirmed by:** Security
**Description:** Any employee can invoke any other employee (including higher-rank) with arbitrary prompts. No access control.
**Fix:** Consider `allowedCallers`/`denyInvoke` in employee YAML. At minimum, log all cross-employee invocations.

### M8 — No WebSocket event emitted at timeout moment
**File:** `api.ts:1910`, `manager.ts:333`
**Confirmed by:** UX
**Description:** Timeout callback kills engine but emits no event. UI learns about it only via delayed `session:completed`.
**Fix:** Emit `session:interrupted` with `reason: "timeout"` immediately after kill.

### M9 — `invoke_employee` missing `engine`/`model` override passthrough
**File:** `gateway-server.ts:295-300`
**Confirmed by:** Architecture
**Description:** `create_child_session` supports engine/model overrides but `invoke_employee` does not.
**Fix:** Add optional `engine` and `model` to input schema and pass through.

### M10 — MCP config `fs.writeFileSync` not wrapped in try/catch
**File:** `api.ts:1890-1895`
**Confirmed by:** Architecture
**Description:** Sync I/O in async function. If write fails, unformatted exception crashes the session.
**Fix:** Wrap in try/catch, log warning, continue without MCP if write fails.

---

## LOW (8 unique findings)

### L1 — `maxDurationMinutes` not validated at config/YAML load time
**Confirmed by:** Security, Type Safety
**Description:** Non-numeric YAML values produce `NaN`. The `> 0` guard mitigates (`NaN > 0` is `false`) but explicit `typeof` check is safer.

### L2 — `[...messages].reverse().find()` unnecessary array copy
**Confirmed by:** Performance
**Fix:** Use `findLast()` (Node 18+).

### L3 — Fixed 2s poll interval not adaptive
**Confirmed by:** Performance
**Fix:** Exponential back-off (1s → 2s → 5s cap) or SSE push endpoint.

### L4 — First poll waits full 2s even for fast sessions
**Confirmed by:** UX
**Fix:** Initial 500ms delay before first poll.

### L5 — `logger.warn` used for expected timeout behavior
**Confirmed by:** UX
**Fix:** Use `logger.info` for normal kills, `logger.warn` for the fallback (engine never started).

### L6 — Timeout log messages omit employee name
**Confirmed by:** UX
**Fix:** Include employee and source in log: `Session <id> (historian, web) exceeded 10m timeout`.

### L7 — `JINN_GATEWAY_URL` env var can redirect MCP to external host (SSRF)
**Confirmed by:** Security
**Fix:** Validate loopback address at startup.

### L8 — `apiGet` has no per-request timeout
**Confirmed by:** Architecture
**Fix:** Add `AbortController` with 10s timeout to fetch calls.

---

## Statistics

| Severity | Count |
|----------|-------|
| CRITICAL | 1 |
| HIGH | 6 |
| MEDIUM | 10 |
| LOW | 8 |
| **Total** | **25** |

Cross-reviewer agreement: C1 confirmed by 3 reviewers, M1 by 3, M4 by 3, H2 by 2. Strong convergence on the most impactful issues.
