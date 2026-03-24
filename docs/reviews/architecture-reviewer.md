# Architecture Review

**Branch:** `feat/agentic-patterns`
**Reviewer:** Architecture Reviewer
**Date:** 2026-03-24

## Summary

The branch introduces three gateway features — session timeout enforcement, `invoke_employee` MCP tool, and MCP config injection for web sessions. The overall direction is sound, but there is one concrete bug (wrong argument to `cleanupMcpConfigFile` in `api.ts`), one design-level concern with `invoke_employee` blocking the MCP server process, and several medium/low issues around duplication and timeout logic correctness.

---

## Findings

### CRITICAL — Wrong argument passed to `cleanupMcpConfigFile` in `api.ts`

**File:** `packages/jimmy/src/gateway/api.ts:1971`

**Description:**
`cleanupMcpConfigFile` has the signature `cleanupMcpConfigFile(sessionId: string): void` — it reconstructs the file path internally using `path.join(JINN_HOME, "tmp", "mcp", `${sessionId}.json`)`. In `manager.ts` (line 759) this is called correctly as `cleanupMcpConfigFile(session.id)`. However, the new code in `api.ts` calls it as `cleanupMcpConfigFile(mcpConfigPath)`, passing the full absolute file path instead of the session ID:

```ts
// api.ts:1971 — WRONG: mcpConfigPath is a full path like "/home/user/.jinn/tmp/mcp/<uuid>.json"
if (mcpConfigPath) cleanupMcpConfigFile(mcpConfigPath);

// manager.ts:759 — CORRECT
if (mcpConfigPath) cleanupMcpConfigFile(session.id);
```

The function will construct a nonsensical path like `/home/user/.jinn/tmp/mcp//home/user/.jinn/tmp/mcp/<uuid>.json.json`, the `fs.existsSync` check will return false, and the temp file will never be deleted. Since MCP config files are created per-session, this is a file descriptor / disk leak that accumulates silently on every web session that uses MCP.

**Impact:** Every web session that invokes `invoke_employee` or uses gateway MCP tools leaks a temp JSON file in `$JINN_HOME/tmp/mcp/`. Over time this grows without bound and goes unnoticed because `cleanupMcpConfigFile` silently swallows errors.

**Recommendation:** Change the call in `api.ts` to pass the session ID, consistent with `manager.ts`:
```ts
if (mcpConfigPath) cleanupMcpConfigFile(currentSession.id);
```
Alternatively, rename `cleanupMcpConfigFile` to accept the path directly and update both call sites, which would also eliminate the implicit path-reconstruction coupling.

---

### HIGH — Timeout logic duplicated verbatim between `api.ts` and `manager.ts`

**File:** `packages/jimmy/src/gateway/api.ts:1905-1921`, `packages/jimmy/src/sessions/manager.ts:329-344`

**Description:**
The 18-line timeout block is copy-pasted identically in both files, including comments, log message format, and the post-kill `isAlive` fallback logic. The only difference is the log prefix (`"Web session"` vs `"Session"`).

This violates DRY and creates a maintenance hazard: if the timeout logic needs to change (e.g. the fallback check logic, the `isAlive` race — see below), both files must be updated in sync. The critical bug above (`cleanupMcpConfigFile` argument) is itself a direct consequence of this duplication — the code was copied but one detail was wrong.

**Impact:** Future bug fixes or behavioural changes to timeout logic must be applied in two places. Divergence is likely over time.

**Recommendation:** Extract the timeout logic into a shared helper in `packages/jimmy/src/sessions/timeout.ts` or `packages/jimmy/src/shared/timeout.ts`:
```ts
export function startSessionTimeout(
  engine: InterruptibleEngine,
  sessionId: string,
  timeoutMinutes: number,
): ReturnType<typeof setTimeout> { ... }
```
Both `api.ts` and `manager.ts` import and call it. This also makes the logic unit-testable in isolation.

---

### HIGH — Race condition in post-kill `isAlive` check

**File:** `packages/jimmy/src/gateway/api.ts:1911-1919`, `packages/jimmy/src/sessions/manager.ts:334-342`

**Description:**
After calling `engine.kill(sessionId, reason)`, the code immediately checks `engine.isAlive(sessionId)` to determine whether the kill was a no-op. But `kill()` sends SIGTERM and then schedules a SIGKILL after 2000ms — it is asynchronous. The process map entry is not removed until the process actually exits (via the `close` event handler in `ClaudeEngine.run()`).

This means that immediately after `engine.kill()` returns, `isAlive()` will almost always return `true` (the process has been signalled but hasn't exited yet). The intent of the fallback — to handle the case where there is no live process mapped at all — is correct, but the check condition is inverted for the normal case: it will typically not enter the `if (!engine.isAlive(...))` branch on a live process, which is correct by accident. However, the logic will also silently fail to force-interrupt if the process takes longer than the JS event loop turn to exit.

The real no-op case (session queued, engine never spawned) is actually when `liveProcesses` has no entry for the session ID — `isAlive` returns `false` immediately in that case, so the fallback would work. But this is fragile: any future change to `ClaudeEngine` that pre-registers a process entry before spawn would silently break the fallback.

**Impact:** The fallback for "engine never started" works today but is semantically fragile. The comment (`"If engine.kill() was a no-op"`) does not accurately describe what `isAlive` actually measures.

**Recommendation:** Add a `hasProcess(sessionId: string): boolean` method to `InterruptibleEngine` that checks whether any process entry exists at all (regardless of exit state), or check `liveProcesses.has(sessionId)` indirectly. Alternatively, have `kill()` return a boolean indicating whether it found a live process:
```ts
kill(sessionId: string, reason?: string): boolean; // true = process found and signalled
```

---

### MEDIUM — `invoke_employee` blocks the MCP server process for up to 5 minutes

**File:** `packages/jimmy/src/mcp/gateway-server.ts:293-336`

**Description:**
The MCP server (`gateway-server.ts`) is a single-process stdio server. `handleTool` is `async`, and `invoke_employee` runs a `while` loop that polls every 2 seconds for up to `timeoutSeconds` (default 300). During this time, the MCP server process is tied up in an async loop and cannot handle other JSON-RPC requests from Claude Code.

In practice, Claude Code opens a single stdio channel to the MCP server process, so all MCP tool calls are serialised through it. A call to `invoke_employee` that takes 60 seconds means no other MCP tool (`list_sessions`, `get_board`, etc.) can be called by the same Claude session during that time.

This is architecturally consistent with the stated design ("synchronous inline invocation"), but the description says "blocks until the employee finishes." This constraint is not mentioned in the tool's description or in `agentic-patterns.md`, so callers may not realise they are surrendering all MCP access for the duration.

**Impact:** An employee calling `invoke_employee` on a slow sub-task (e.g. a historian doing deep research) loses access to all other MCP tools for the duration. This could cause Claude to time out or silently fail on unrelated tool calls.

**Recommendation:** Either (a) document the blocking nature explicitly in the tool description so callers can make an informed choice, or (b) implement the polling loop as a gateway-level endpoint (`POST /api/sessions/invoke`) that resolves asynchronously, allowing the MCP stdio channel to remain free. Option (b) also enables the same functionality from connectors and the web API without requiring MCP.

---

### MEDIUM — MCP config injection is engine-gated to `claude` only in `api.ts` but pattern inconsistency with `manager.ts`

**File:** `packages/jimmy/src/gateway/api.ts:1890-1895`, `packages/jimmy/src/sessions/manager.ts:260-265`

**Description:**
Both files gate MCP injection on `engine === "claude"`. This is currently correct since Claude Code is the only engine that supports `--mcp-config`. However, `manager.ts` does this check inside the `try` block before the engine run, while `api.ts` does it before the heartbeat setup (also before `engine.run()`). The ordering is cosmetically inconsistent — in `api.ts` the MCP config is written before the timeout handle is set, while in `manager.ts` the timeout handle is set after MCP. This does not cause a bug but makes the two paths structurally harder to compare at a glance.

More importantly, the MCP config file is written synchronously using `fs.writeFileSync` inside what is otherwise an async function. If the `tmp/mcp` directory creation or write fails, it will throw synchronously inside an `async` function, which will cause the caller to get an unhandled rejection rather than a clean error message.

**Impact:** An I/O error writing the MCP config file would crash the session run with an unformatted exception rather than a clean session error.

**Recommendation:** Wrap `writeMcpConfigFile` in a try/catch in both call sites and log a warning + continue without MCP if the write fails. The session should still run, just without MCP tools.

---

### MEDIUM — `invoke_employee` does not propagate `engine` or `model` overrides

**File:** `packages/jimmy/src/mcp/gateway-server.ts:295-300`

**Description:**
`create_child_session` accepts `engine` and `model` overrides, allowing the caller to control which engine runs the child session. `invoke_employee` calls the same `POST /api/sessions` endpoint but does not pass these fields through its schema or implementation. There is no way for a caller to invoke a specific employee on a specific engine (e.g. `invoke_employee` with `engine: "codex"` for a cheaper sub-task).

**Impact:** Minor feature gap. Callers cannot optimise cost by routing quick sub-tasks to cheaper engines.

**Recommendation:** Add optional `engine` and `model` parameters to `invoke_employee`'s `inputSchema` and pass them through to `apiPost`.

---

### LOW — `isInterruptibleEngine` import added to `manager.ts` but was already available via `shared/types.ts`

**File:** `packages/jimmy/src/sessions/manager.ts:11`

**Description:**
The new import `import { isInterruptibleEngine } from "../shared/types.js"` was added as a named import on its own line, separate from the existing `import type { ... } from "../shared/types.js"` block. This works correctly because TypeScript/ESM handles multiple imports from the same module, but it creates a stylistic inconsistency — the existing code uses a single `import type` block for types from `shared/types`, and `isInterruptibleEngine` (a value, not a type) is now a separate import.

**Impact:** None functional. Minor style inconsistency.

**Recommendation:** Keep the `import type` block for types and add `isInterruptibleEngine` as a separate value import (which the diff already does). This is actually already correct — just note that it cannot be merged into the `import type` block since it is a runtime value.

---

### LOW — No timeout on `GET /api/sessions/:id` polls inside `invoke_employee`

**File:** `packages/jimmy/src/mcp/gateway-server.ts:310`

**Description:**
The `apiGet` helper has no request timeout. If the gateway is under load or the HTTP server becomes unresponsive, each `await apiGet(...)` call inside the `invoke_employee` polling loop can hang indefinitely, causing the MCP server's event loop to stall even after the nominal `timeoutMs` has elapsed (since the timeout only guards the outer `while` loop condition, not the in-flight `apiGet`).

**Impact:** In a degraded gateway scenario, `invoke_employee` could block the MCP server for significantly longer than `timeoutSeconds`.

**Recommendation:** Add an `AbortController`-based timeout to `apiGet` (and `apiPost`) in `gateway-server.ts`:
```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10_000);
const res = await fetch(url, { signal: controller.signal });
clearTimeout(timer);
```

---

### LOW — `invoke_employee` timeout does not cancel the orphaned child session

**File:** `packages/jimmy/src/mcp/gateway-server.ts:329-335`

**Description:**
When `invoke_employee` times out, it returns a timeout response to the caller but leaves the child session running in the gateway. The timeout message says "session is still running — use `get_session` to check later," which is honest, but there is no mechanism to automatically clean it up. The child session will eventually complete or error on its own, but its result is never delivered to anyone.

**Impact:** Orphaned sessions accumulate in the gateway after invoke timeouts. Each consumes memory and (if using Claude) API quota. In a high-volume system this is a resource leak.

**Recommendation:** On timeout, attempt to interrupt the child session via `DELETE /api/sessions/:id/interrupt` or `PATCH /api/sessions/:id` before returning. If the gateway supports it, send a kill signal. Include the attempted cleanup in the timeout response so callers know the state.

---

## Summary Table

| Severity | Finding |
|----------|---------|
| CRITICAL | Wrong argument to `cleanupMcpConfigFile` in `api.ts` — temp files leak |
| HIGH | Timeout logic duplicated verbatim — maintenance hazard, source of the bug above |
| HIGH | Post-kill `isAlive` check is semantically fragile due to async SIGTERM |
| MEDIUM | `invoke_employee` blocks MCP stdio channel for its full duration |
| MEDIUM | MCP config write not wrapped in try/catch — sync I/O error in async path |
| MEDIUM | `invoke_employee` missing `engine`/`model` override passthrough |
| LOW | Separate `isInterruptibleEngine` import line (style only, functionally correct) |
| LOW | `apiGet` has no per-request timeout — stall risk inside polling loop |
| LOW | Timed-out `invoke_employee` leaves orphaned child sessions running |
