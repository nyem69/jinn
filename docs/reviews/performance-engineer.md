# Performance Review

## Summary

The `feat/agentic-patterns` branch adds session timeout enforcement and a synchronous `invoke_employee` MCP tool. The timeout logic is well-structured but has one timer leak on exception paths in `manager.ts`, and the `api.ts` code path has a file leak due to a mismatched argument passed to `cleanupMcpConfigFile`. The polling loop in `invoke_employee` is functionally correct but holds a reference chain that prevents GC until the poll resolves, and the 2-second fixed interval is not adaptive.

---

## Findings

### [HIGH] — Timer leak in `manager.ts` error path

**File:** `packages/jimmy/src/sessions/manager.ts:725-760`

**Description:** The `timeoutHandle` is declared inside the `try` block (line 330) and cleared on the happy path at line 360 (`if (timeoutHandle) clearTimeout(timeoutHandle)`). However, the outer `catch` block (line 725) and `finally` block (line 749) do NOT clear `timeoutHandle`. If `engine.run()` throws an exception rather than resolving, the timeout timer will continue running and fire after the function has already returned. This causes `engine.kill()` and `updateSession()` to be called on a session that has already been marked as errored or cleaned up.

**Impact:** Stale timer fires after session teardown. In the worst case it calls `engine.kill()` on a session ID that may have been reused (if session IDs are recycled), or triggers redundant `updateSession()` writes that overwrite a valid state with "interrupted".

**Recommendation:** Move `timeoutHandle` declaration outside the `try` block (already done correctly in `api.ts` via the `.finally()` pattern) and clear it in the `finally` block:

```ts
} finally {
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (mcpConfigPath) cleanupMcpConfigFile(session.id);
  // ... attachment cleanup
}
```

---

### [HIGH] — File leak: `cleanupMcpConfigFile` called with wrong argument in `api.ts`

**File:** `packages/jimmy/src/gateway/api.ts:1971`

**Description:** `writeMcpConfigFile` (in `resolver.ts`) returns the **full file path** as a string (e.g. `/home/azmi/.jinn/tmp/mcp/<uuid>.json`). `api.ts` stores this in `mcpConfigPath` and then calls `cleanupMcpConfigFile(mcpConfigPath)`. But `cleanupMcpConfigFile` expects a **session ID**, not a path — it internally constructs `path.join(JINN_HOME, "tmp", "mcp", `${sessionId}.json`)`. Passing the full path as the session ID causes the function to attempt to delete a path like `/home/azmi/.jinn/tmp/mcp//home/azmi/.jinn/tmp/mcp/<uuid>.json.json`, which does not exist. The actual temp file is never deleted.

By contrast, `manager.ts` correctly calls `cleanupMcpConfigFile(session.id)` (line 759), which is the intended usage.

**Impact:** Every web-created session that uses MCP (Claude engine) leaves a `<uuid>.json` file permanently in `~/.jinn/tmp/mcp/`. On a busy instance, this directory grows unboundedly and eventually causes disk exhaustion.

**Recommendation:** Either fix the call site in `api.ts` to pass the session ID:

```ts
// Change:
if (mcpConfigPath) cleanupMcpConfigFile(mcpConfigPath);
// To:
if (mcpConfigPath) cleanupMcpConfigFile(currentSession.id);
```

Or rename the parameter and update `cleanupMcpConfigFile` to accept a path directly (which would also fix the inconsistency in the API), matching how `writeMcpConfigFile` returns a path. The latter is arguably cleaner since callers already have the path.

---

### [MEDIUM] — Polling loop holds strong reference, prevents GC for full timeout duration

**File:** `packages/jimmy/src/mcp/gateway-server.ts:308-327`

**Description:** The `invoke_employee` polling loop captures `childId`, `startTime`, and `timeoutMs` in closure. On each iteration it `await`s a `setTimeout` Promise (line 309), which keeps the enclosing `handleTool` async frame alive. The `session` object fetched on each poll (line 310) is a local, so it is GC-eligible between iterations — that is fine. However, the entire MCP request handler chain (the `handleRequest` frame, its `id`/`method`/`params` closure, and the stdio line buffer entry) stays rooted for the full timeout window (up to 300 seconds). With multiple concurrent `invoke_employee` calls, N frames × 300s = N frames alive simultaneously, each pinning the MCP server process context.

**Impact:** For a typical 16-second employee invocation this is negligible. For the maximum 300-second timeout with several concurrent callers, memory growth is proportional to N concurrent polls. This is low risk at current org sizes but becomes relevant if `invoke_employee` is used heavily in fan-out patterns.

**Recommendation:** No structural change needed now, but document the timeout default. If concurrent usage grows, consider adding an AbortController or capping the default timeout to match the employee's `maxDurationMinutes` setting.

---

### [MEDIUM] — Fixed 2-second poll interval is not adaptive

**File:** `packages/jimmy/src/mcp/gateway-server.ts:305, 309`

**Description:** The poll interval is hardcoded at 2 seconds for the entire wait window. For the expected 16-second use case this means ~8 HTTP GET requests per invocation. For a 300-second timeout (max), that is 150 requests, all hitting the gateway's `/api/sessions/:id` endpoint. Each call fetches the full session record including the `messages` array (see `get_session` handler at line 272 which returns the full session object). With N concurrent `invoke_employee` calls, the gateway sees N × 30 req/min of synthetic load.

**Impact:** At small scale this is negligible. At scale (e.g., a debate skill spawning 3 parallel employees each polling at 2s) the gateway processes 90+ req/min of polling traffic. Event loop contention is low since each poll is a single async I/O, but DB read pressure (if sessions are persisted) scales linearly.

**Recommendation:** Implement exponential back-off with a cap: start at 1s, double each miss up to 5s. This keeps latency low for fast tasks while reducing load for slow ones. Alternatively, add a `/api/sessions/:id/wait` SSE endpoint on the gateway that pushes status changes, eliminating polling entirely.

---

### [MEDIUM] — `invoke_employee` timeout does not cancel or interrupt the child session

**File:** `packages/jimmy/src/mcp/gateway-server.ts:329-335`

**Description:** When `invoke_employee` times out, it returns a `status: "timeout"` JSON response to the caller but leaves the child session running on the gateway. The child session will continue consuming compute, engine quota, and cost until it finishes or hits its own `maxDurationMinutes` limit (if configured). The caller is told to "use get_session to check later", but in practice the parent has already moved on and the orphaned session's result is never consumed.

**Impact:** Orphaned sessions accumulate, consuming engine resources and incurring cost with no consumer. If the parent was invoked under a 5-minute MCP timeout and the child takes 10 minutes, the cost is paid but the value is lost.

**Recommendation:** On timeout, send a DELETE or interrupt request to the child session before returning:

```ts
// After the while loop exits due to timeout:
await apiPost(`/api/sessions/${childId}/interrupt`, {}).catch(() => {});
```

Or document explicitly in the tool description that callers are responsible for cancelling the child if they don't want it to continue.

---

### [LOW] — `resolveMcpServers` called unconditionally on every web session, even when result is unused

**File:** `packages/jimmy/src/gateway/api.ts:1891-1895`

**Description:** `resolveMcpServers()` iterates over global MCP config and builds a server map on every call. The result is only written to disk if at least one server is configured (`Object.keys(mcpConfig.mcpServers).length > 0`). The function itself is cheap (pure object construction, no I/O), but it is called for every Claude-engine web session regardless of whether MCP is enabled at all.

**Impact:** Negligible CPU. No correctness issue. Flagged for awareness.

**Recommendation:** Optional micro-optimisation: guard the call with `if (config.mcp)` before entering `resolveMcpServers`. Already done implicitly inside the function (line 22 returns early if `globalMcp` is falsy), so no change is strictly needed.

---

### [LOW] — Duplicate timeout logic between `api.ts` and `manager.ts` with no shared abstraction

**File:** `packages/jimmy/src/gateway/api.ts:1905-1921`, `packages/jimmy/src/sessions/manager.ts:329-344`

**Description:** The timeout enforcement code is copy-pasted verbatim between the two run paths. Any future change (e.g. SIGKILL escalation after SIGTERM, or a grace period) must be applied in both places. This was already the source of the bug above (the `finally`-vs-inline-clear inconsistency between the two).

**Impact:** Maintainability risk. No current performance impact.

**Recommendation:** Extract a `startSessionTimeout(engine, sessionId, timeoutMinutes)` helper that returns the handle, reducing the two blocks to a one-liner and eliminating the divergence.

---

### [LOW] — `[...messages].reverse().find()` copies full message array on every terminal poll

**File:** `packages/jimmy/src/mcp/gateway-server.ts:316`

**Description:** On reaching a terminal state, the code copies the full messages array with spread and then reverses it in place to find the last assistant message. For sessions with long conversation histories (hundreds of messages), this allocates an unnecessary copy.

**Impact:** One-time allocation at the end of a poll cycle; negligible in practice.

**Recommendation:** Use `findLast()` (available in Node 18+, which this project targets given ESM usage) or iterate from the end:

```ts
const lastAssistant = messages.findLast((m: any) => m.role === "assistant");
```
