# UX & Error States Review

## Summary

The `feat/agentic-patterns` branch introduces session timeout enforcement and the `invoke_employee` MCP tool. The core logic is sound, but there are several gaps: timed-out sessions emit no dedicated WebSocket event (callers see `session:completed` with an error string, not a distinct signal), the web API path sets `status: "error"` for interrupted sessions instead of `"interrupted"`, and `invoke_employee` returns no partial output on timeout. All findings are actionable without redesign.

---

## Findings

### [HIGH] — Timed-out sessions use `"error"` status in the web path

**File:** `packages/jimmy/src/gateway/api.ts:2274`

**Description:** In `runWebSession()`, after `engine.kill()` fires, the engine returns a result whose `error` field starts with `"Interrupted"`. The `wasInterrupted` flag is set correctly, but the subsequent `updateSession` call at line 2274 uses:

```ts
status: result.error ? "error" : "idle",
```

There is no `wasInterrupted` guard here (unlike `manager.ts` line 704, which correctly sets `status: wasInterrupted ? "idle" : ...`). A timed-out web session therefore lands in `"error"` state, not `"idle"` or `"interrupted"`. Callers polling the session cannot distinguish a timeout-kill from a genuine engine error.

**Impact:** Web UI shows a red error badge on a session that was intentionally killed by a timeout policy. Operators querying sessions by `status=error` get false positives.

**Recommendation:** Mirror the `manager.ts` pattern:

```ts
status: wasInterrupted ? "idle" : (result.error ? "error" : "idle"),
lastError: wasInterrupted ? null : (result.error ?? null),
```

Or introduce a dedicated `"interrupted"` status value and use it for timeout kills, which would make the distinction explicit everywhere.

---

### [HIGH] — No dedicated WebSocket event for timeout/interrupt

**File:** `packages/jimmy/src/gateway/api.ts:2290`, `packages/jimmy/src/sessions/manager.ts` (no emit on timeout)

**Description:** The timeout callback in both `api.ts` and `manager.ts` calls `engine.kill()` and optionally calls `updateSession()`, but emits no WebSocket event at that moment. The web UI only learns about the termination later, when `engine.run()` resolves and `session:completed` is emitted — which may be several seconds after the kill. The `session:interrupted` event that already exists (line 711 in `api.ts`) is only fired for the "new message interrupts running session" case, not for timeout kills.

**Impact:** The web UI has no real-time signal that a session was stopped by timeout. There is no way to show a "session timed out" toast or badge at the moment it happens; the UI learns about it only when the completed event arrives (with an ambiguous `status: "error"`).

**Recommendation:** In both timeout callbacks, emit a `session:timeout` (or reuse `session:interrupted` with `reason: "timeout"`) immediately after `engine.kill()`:

```ts
context.emit("session:interrupted", { sessionId: currentSession.id, reason: "timeout", timeoutMinutes });
```

For `manager.ts`, pass the emitter (or emit via the callback mechanism already used for `notifyParentSession`) so the connector layer can also react.

---

### [MEDIUM] — `invoke_employee` timeout response includes no partial output

**File:** `packages/jimmy/src/mcp/gateway-server.ts:329–335`

**Description:** When `invoke_employee` hits its polling timeout, the response is:

```json
{
  "sessionId": "...",
  "employee": "historian",
  "status": "timeout",
  "error": "invoke_employee timed out after 300s — session <id> is still running. Use get_session to check later."
}
```

The child session is still running at this point. The response correctly tells the caller to use `get_session` to check later, but omits any streamed/partial output the child may have already produced. The session's `messages` array is not consulted before returning.

**Impact:** The calling employee receives no indication of how far the child got. A historian that produced 80% of an answer before the timeout is indistinguishable from one that never started.

**Recommendation:** Before returning the timeout response, fetch the child session's messages and include the last assistant message (if any) as `partialResult`:

```ts
const partialSession = await apiGet(`/api/sessions/${childId}`) as any;
const messages = partialSession.messages || [];
const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant");
return JSON.stringify({
  sessionId: childId,
  employee: args.employee,
  status: "timeout",
  partialResult: lastAssistant?.content || null,
  error: `invoke_employee timed out after ${Math.round(timeoutMs / 1000)}s — session ${childId} is still running. Use get_session to check later.`,
});
```

---

### [MEDIUM] — Race condition: `engine.isAlive()` check immediately after `engine.kill()`

**File:** `packages/jimmy/src/gateway/api.ts:1911–1918`, `packages/jimmy/src/sessions/manager.ts:334–342`

**Description:** The timeout callback calls `engine.kill()` synchronously, then immediately checks `engine.isAlive()` to decide whether to force-mark the session as interrupted:

```ts
engine.kill(currentSession.id, `Interrupted: session timeout (${timeoutMinutes}m)`);
if (!engine.isAlive(currentSession.id)) {
  // force-mark interrupted
}
```

`engine.kill()` sends SIGTERM. If the process is alive, `isAlive()` may return `true` immediately after the signal is sent (before the process has exited). This means the "engine never started" branch only triggers correctly when there is genuinely no registered process — but if the process registered and then is slow to die, neither branch fires: the kill was sent, `isAlive()` returns `true`, so no force-mark happens, and `engine.run()` will eventually resolve normally (or not, depending on engine implementation). The comment says "no-op" but the condition `!isAlive` is also satisfied right after a successful kill if the engine map is cleared synchronously.

**Impact:** In the "kill succeeds, isAlive() returns false immediately because map was cleared" case: the force-mark sets `lastError` to `"engine never started"`, which is incorrect — the engine did start. This produces a misleading error message in the session record.

**Recommendation:** Split the two cases with a clearer precondition check:

```ts
const wasAliveBeforeKill = engine.isAlive(currentSession.id);
engine.kill(currentSession.id, `Interrupted: session timeout (${timeoutMinutes}m)`);
if (!wasAliveBeforeKill) {
  // Engine never started or had already exited — force-mark immediately
  updateSession(currentSession.id, {
    status: "interrupted",
    lastError: `Session timeout (${timeoutMinutes}m) — engine never started`,
  });
}
```

---

### [MEDIUM] — `invoke_employee` error message omits employee name context when session creation fails

**File:** `packages/jimmy/src/mcp/gateway-server.ts:301`

**Description:** When `createResult.id` is falsy, the error response is:

```json
{ "error": "Failed to create child session", "detail": <raw API response> }
```

The raw API response (`detail`) may be a large object or an HTML error page, and the employee name being invoked is not included in the `error` field. The calling AI model sees only the generic message.

**Impact:** When debugging a failed delegation, the model and operator have to infer which employee failed from context rather than from the error message itself.

**Recommendation:**

```ts
if (!childId) return JSON.stringify({
  error: `Failed to create child session for employee "${args.employee}"`,
  detail: createResult,
});
```

---

### [MEDIUM] — Timeout log messages use different session ID prefixes across the two paths

**File:** `packages/jimmy/src/gateway/api.ts:1910`, `packages/jimmy/src/sessions/manager.ts:333`

**Description:** The `api.ts` log message is:

```
Web session <id> exceeded <N>m timeout — killing engine
```

The `manager.ts` log message is:

```
Session <id> exceeded <N>m timeout — killing engine
```

Neither includes the employee name. When a timeout fires, grepping logs by session ID is the only way to correlate it to an employee or connector. For high-volume gateways with many concurrent sessions, this makes incident triage harder.

**Impact:** Low operational friction — adds one extra lookup step per incident.

**Recommendation:** Include `employee` and `connector`/`source` in both log lines:

```
Session <id> (historian, telegram) exceeded 10m timeout — killing engine
```

---

### [LOW] — `invoke_employee` does not cancel the child session on caller timeout

**File:** `packages/jimmy/src/mcp/gateway-server.ts:329–335`

**Description:** When the polling loop exits due to timeout, the child session is left running. The error message tells the caller to use `get_session` to check later, which is functional guidance. However, the child session will continue consuming resources (tokens, compute) and may eventually trigger the employee's own `maxDurationMinutes` limit — but only if one is configured.

**Impact:** A caller that times out `invoke_employee` and moves on leaves an orphaned session that continues running. In high-throughput scenarios, this can accumulate.

**Recommendation:** On polling timeout, send a kill request to the child session before returning:

```ts
// Best-effort kill — fire and forget
apiPost(`/api/sessions/${childId}/stop`, {}).catch(() => {});
```

Or document explicitly in the tool description that callers are responsible for stopping orphaned sessions via `send_to_session` or a dedicated stop tool.

---

### [LOW] — `invoke_employee` polling starts with a sleep, missing an already-fast session

**File:** `packages/jimmy/src/mcp/gateway-server.ts:308–309`

**Description:** The poll loop does `await sleep(pollInterval)` before the first `apiGet`, meaning a session that completes in under 2 seconds always waits the full 2 seconds before its result is returned.

**Impact:** Negligible for typical LLM sessions (16s+ as seen in tests), but suboptimal for very fast fact-lookup sub-tasks.

**Recommendation:** Check session status immediately after creation (with a short initial delay of ~500ms to allow the session to initialize), then fall into the 2-second loop:

```ts
await new Promise((r) => setTimeout(r, 500));
// then enter the polling loop
```

---

### [LOW] — Log level `warn` used for normal timeout enforcement

**File:** `packages/jimmy/src/gateway/api.ts:1910`, `packages/jimmy/src/sessions/manager.ts:333`

**Description:** Both timeout callbacks use `logger.warn()` for the first message ("exceeded timeout — killing engine"). A timeout that fires as designed (e.g. a 10-minute historian session hitting a 10-minute limit) is expected behavior, not a warning condition. Using `warn` means every expected timeout pollutes the warning log level with non-actionable entries.

**Impact:** Warning logs lose signal-to-noise ratio. Operators filtering `warn`/`error` for real problems see expected timeout events.

**Recommendation:** Use `logger.info()` for the initial kill message. Reserve `logger.warn()` for the fallback path where the engine has no live process (which is the unexpected edge case), which is already the second log message.
