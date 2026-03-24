# Security Audit

## Summary

The `feat/agentic-patterns` branch introduces session timeouts and a synchronous `invoke_employee` MCP tool. The timeout logic is sound in structure but carries a race condition and no input bounds. The `invoke_employee` tool has no input validation, exposes internal error details, and the polling loop can be weaponised for sustained resource exhaustion. No new authentication is introduced on any code path.

---

## Findings

### [HIGH] — `invoke_employee` has no upper bound on `timeoutSeconds`, enabling indefinite resource lock

**File:** `packages/jimmy/src/mcp/gateway-server.ts:303`

**Description:**
`timeoutMs` is derived directly from the caller-supplied `args.timeoutSeconds` with no validation, clamping, or maximum:

```ts
const timeoutMs = ((args.timeoutSeconds as number) || 300) * 1000;
```

A caller can pass `timeoutSeconds: 86400` (24 hours) or `Infinity`. Because the MCP server runs as a stdio subprocess inside an employee's Claude Code session, that employee's session will block for the full polling duration — holding a child session open and consuming polling-loop event-loop time for an arbitrarily long period. With multiple concurrent `invoke_employee` calls (there is no concurrency limit), an employee can spawn and hold open many child sessions simultaneously.

**Risk:** Denial of service — sustained resource exhaustion of the gateway's session table, event loop, and underlying engine processes.

**Recommendation:**
- Clamp `timeoutSeconds` to a maximum (e.g. 600s) on entry:
  ```ts
  const rawTimeout = typeof args.timeoutSeconds === "number" && Number.isFinite(args.timeoutSeconds)
    ? args.timeoutSeconds : 300;
  const timeoutMs = Math.min(Math.max(rawTimeout, 1), 600) * 1000;
  ```
- Optionally, limit the number of concurrently polling `invoke_employee` calls per parent session.

---

### [HIGH] — URL path injection via unvalidated MCP tool args (`sessionId`, `employee`, `department`, `connector`)

**File:** `packages/jimmy/src/mcp/gateway-server.ts:244,272,287,344,349,354`

**Description:**
Several tool handlers interpolate caller-controlled string values directly into HTTP paths without any sanitisation:

```ts
apiGet(`/api/sessions/${args.sessionId}`)          // get_session
apiPost(`/api/sessions/${args.sessionId}/message`, …) // send_to_session
apiGet(`/api/org/employees/${args.name}`)           // get_employee
apiGet(`/api/org/departments/${args.department}/board`) // get_board
apiPost(`/api/connectors/${connector}/send`, …)     // send_message
```

If the gateway's route parser does not strictly reject path segments containing `..` or `/`, a value like `../../cron/some-id/trigger` could route to an unintended endpoint. While the default HTTP server (Node `http`) will typically normalise URLs and the gateway's `matchRoute` performs exact-match routing, the defence relies entirely on the server-side routing logic — there is no client-side guard.

**Risk:** If the gateway ever adds a route that shares a prefix with another, or if a future path-normalisation bug exists, crafted `sessionId`/`department`/`name` values could reach unintended endpoints.

**Recommendation:**
- Validate that string args match expected formats before interpolating (UUID regex for sessionIds, `^[a-z0-9-]+$` for names/departments/connectors).
- Example:
  ```ts
  if (!/^[0-9a-f-]{36}$/.test(args.sessionId as string)) {
    return JSON.stringify({ error: "Invalid sessionId format" });
  }
  ```

---

### [HIGH] — `invoke_employee` leaks full internal API response body on session creation failure

**File:** `packages/jimmy/src/mcp/gateway-server.ts:301`

**Description:**
When session creation fails, the full `createResult` object is embedded in the returned JSON:

```ts
if (!childId) return JSON.stringify({ error: "Failed to create child session", detail: createResult });
```

`createResult` is the raw JSON body from the gateway's `POST /api/sessions` error response. Depending on the gateway's error handling, this may include internal state, stack traces, employee configuration details, or error messages from the underlying engine.

**Risk:** Internal error details — including potentially sensitive configuration or stack traces — are returned to the MCP caller (the employee LLM context), which may relay them further (e.g. back to the user or another session).

**Recommendation:**
- Return only a safe, opaque message on failure:
  ```ts
  if (!childId) return JSON.stringify({ error: "Failed to create child session" });
  ```
- Log the full `createResult` server-side only.

---

### [MEDIUM] — Race condition in timeout fallback: `engine.kill()` then `engine.isAlive()` are not atomic

**File:** `packages/jimmy/src/gateway/api.ts:1911-1919`, `packages/jimmy/src/sessions/manager.ts:334-342`

**Description:**
The timeout callback does:

```ts
engine.kill(currentSession.id, `Interrupted: session timeout (${timeoutMinutes}m)`);
if (!engine.isAlive(currentSession.id)) {
  updateSession(currentSession.id, { status: "interrupted", … });
}
```

`kill()` sends SIGTERM and schedules SIGKILL after 2 seconds. The process is still alive immediately after the `kill()` call — `isAlive()` checks `proc.exitCode === null`, which will be `null` until the process actually exits. This means `engine.isAlive()` returns `true` immediately after `kill()`, so the force-interrupt fallback branch **never fires** for a live process.

Conversely, for a session that was never started (no process mapped), `kill()` is a no-op and `liveProcesses.get(sessionId)` returns undefined, so `isAlive()` returns `false` — the fallback fires correctly. So the dead-session case works, but the comment "If engine.kill() was a no-op" is misleading: a live-but-slow-to-die process could leave the session stuck in `running` state if the SIGTERM is not processed before the engine's `run()` promise resolves.

Additionally, if the timeout fires at the exact moment the engine's `run()` call resolves naturally, `clearTimeout(timeoutHandle)` at line 360/1970 may not fire before the setTimeout callback has already entered execution — there is a small window where both the normal completion path and the timeout path attempt to update session state concurrently.

**Risk:** Sessions may remain in `running` state if the SIGTERM races with process resolution. Double-update of session status (interrupted + normal completion) can corrupt session state.

**Recommendation:**
- Add a `killed` flag in the timeout callback scope and check it in the normal completion path:
  ```ts
  let timedOut = false;
  timeoutHandle = setTimeout(() => {
    timedOut = true;
    engine.kill(…);
    …
  }, …);
  // After engine.run():
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (timedOut) return; // timeout already handled state
  ```
- Consider listening to the process `exit` event within the timeout callback rather than calling `isAlive()` synchronously.

---

### [MEDIUM] — No authentication on the gateway REST API used by the MCP server

**File:** `packages/jimmy/src/mcp/gateway-server.ts:15`

**Description:**
The MCP server connects to the gateway via `http://127.0.0.1:7777` (or `JINN_GATEWAY_URL`) with no credentials or API key:

```ts
const GATEWAY_URL = process.env.JINN_GATEWAY_URL || "http://127.0.0.1:7777";
```

The gateway itself has no authentication middleware on its REST API (confirmed by inspection of `api.ts`). Any process on the same machine can call any gateway API endpoint — including `POST /api/sessions` (spawn arbitrary employee sessions), `PUT /api/cron/:id` (modify cron jobs), and `POST /api/sessions/:id/message` (inject messages into live sessions).

While the MCP server is launched as a child subprocess per-employee, an attacker with local code execution (e.g. via prompt injection causing an employee to run `curl`) can reach the gateway API directly without going through the MCP server at all.

**Risk:** Any local process can control all employees, sessions, cron jobs, and connectors — no privilege boundary exists at the network layer.

**Recommendation:** This is a pre-existing issue, but the new `invoke_employee` tool increases the attack surface materially by providing a clean, synchronous RPC path for lateral movement between employees. At minimum, add a shared secret (`X-Jinn-Token` header) validated by the gateway for all non-public endpoints. The MCP server should inject this header in all `apiGet`/`apiPost`/`apiPut` calls.

---

### [MEDIUM] — `invoke_employee` prompt and employee name pass through without validation, enabling cross-employee prompt injection

**File:** `packages/jimmy/src/mcp/gateway-server.ts:295-299`

**Description:**
The `prompt` and `employee` fields are forwarded verbatim to `POST /api/sessions`:

```ts
const createResult = await apiPost("/api/sessions", {
  prompt: args.prompt,
  employee: args.employee,
  parentSessionId: args.parentSessionId,
});
```

A malicious or compromised employee session can call `invoke_employee` with:
- `employee`: any employee name (including privileged ones with filesystem or API access)
- `prompt`: instructions designed to exfiltrate data, modify system files, or escalate via the target employee's tools

Because `invoke_employee` is synchronous and returns the result inline, the calling employee immediately receives the target's output — making it an efficient data-exfiltration channel if the target employee has broader permissions.

**Risk:** Lateral privilege escalation: a low-privilege employee can invoke a high-privilege employee to perform actions outside their own permission boundary.

**Recommendation:**
- Validate `employee` against the org registry and optionally enforce rank-based invocation rules (e.g. junior employees cannot invoke executive-rank employees).
- Consider allowing employee YAML to declare `allowedCallers` or `denyInvoke: true` for sensitive employees.
- At minimum, log all `invoke_employee` calls with the parent session ID, source employee, and target employee for audit trails.

---

### [MEDIUM] — `maxDurationMinutes` sourced from employee YAML with no validated upper bound

**File:** `packages/jimmy/src/shared/types.ts:212`, `packages/jimmy/src/sessions/manager.ts:329`, `packages/jimmy/src/gateway/api.ts:1906`

**Description:**
`maxDurationMinutes` from employee YAML or global config is used directly:

```ts
const timeoutMinutes = employee?.maxDurationMinutes ?? config.sessions?.maxDurationMinutes;
…
timeoutHandle = setTimeout(() => { … }, timeoutMinutes * 60_000);
```

There is no validation that `timeoutMinutes` is a positive finite number. If a YAML file contains `maxDurationMinutes: Infinity`, `maxDurationMinutes: -1`, or `maxDurationMinutes: 0.00001`, the `timeoutMinutes > 0` guard passes for `Infinity` and very small values, potentially scheduling a timer that fires immediately or never (since `setTimeout` with `Infinity` ms is implementation-defined and often fires immediately in Node.js).

**Risk:** Misconfigured YAML can cause immediate session termination or a timer that never fires (session runs indefinitely despite a configured limit).

**Recommendation:**
- Clamp and validate before using:
  ```ts
  const raw = employee?.maxDurationMinutes ?? config.sessions?.maxDurationMinutes;
  const timeoutMinutes = typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.min(raw, 1440) // cap at 24h
    : undefined;
  ```

---

### [LOW] — `JINN_GATEWAY_URL` environment variable can redirect MCP server to an external host (SSRF vector)

**File:** `packages/jimmy/src/mcp/gateway-server.ts:15`

**Description:**
```ts
const GATEWAY_URL = process.env.JINN_GATEWAY_URL || "http://127.0.0.1:7777";
```

If an attacker can influence the environment of the MCP server process (e.g. via prompt injection causing an employee to set environment variables, or via a compromised `.env` file), they can redirect all gateway API calls to an external host, turning the MCP server into an SSRF proxy that exfiltrates session data, prompts, and org structure to an attacker-controlled server.

**Risk:** Low in practice (requires prior local access), but the absence of URL validation makes it an easy amplifier if combined with another finding.

**Recommendation:**
- Validate that `GATEWAY_URL` is a loopback address (`127.0.0.1` or `::1`) at startup, or ignore the env var in production builds.

---

### [LOW] — MCP config temp files use session ID in filename; cleanup errors are silently swallowed

**File:** `packages/jimmy/src/mcp/resolver.ts:151-168`

**Description:**
MCP config files are written to `$JINN_HOME/tmp/mcp/<sessionId>.json`. The `cleanupMcpConfigFile` function silently ignores all errors:

```ts
} catch {
  // Ignore cleanup errors
}
```

If cleanup fails (permissions error, disk full), the file persists. These files contain the full MCP server configuration including any injected environment variables or authentication headers for custom MCP servers. Additionally, if a session ID is reused (unlikely with UUIDs but not impossible), a stale config from a previous session could be read.

**Risk:** Sensitive MCP server credentials (e.g. API keys in `env` fields of custom MCP servers) may persist on disk after the session ends.

**Recommendation:**
- Log cleanup failures at `warn` level rather than silently ignoring them.
- Ensure the `tmp/mcp/` directory has restrictive permissions (`chmod 700`) set at creation time.
- Consider encrypting or omitting sensitive env values from the written file, passing them via process environment instead.
