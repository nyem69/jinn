# Type Safety Review

## Summary

The `feat/agentic-patterns` branch introduces session timeout enforcement and a synchronous `invoke_employee` MCP tool across four files. One critical API contract bug was found (`cleanupMcpConfigFile` called with the wrong argument type), along with several medium-to-low issues around `as any` casts, missing runtime guards on API responses, and type narrowing loss in closures.

---

## Findings

### CRITICAL — `cleanupMcpConfigFile` called with path instead of sessionId

**File:** `packages/jimmy/src/gateway/api.ts:1971`

**Description:**
The `cleanupMcpConfigFile` function signature is:
```ts
export function cleanupMcpConfigFile(sessionId: string): void
```
It internally constructs the file path as `path.join(JINN_HOME, "tmp", "mcp", `${sessionId}.json`)`. However, the call site in `api.ts` passes `mcpConfigPath` (the full absolute path returned by `writeMcpConfigFile`) instead of the session ID:
```ts
if (mcpConfigPath) cleanupMcpConfigFile(mcpConfigPath);
```
This means the cleanup function builds a path like `~/.jinn/tmp/mcp//Users/azmi/.jinn/tmp/mcp/SESSION_ID.json.json`, which never exists, so the temp MCP config file is never deleted. Every web session leaks a JSON file in `~/.jinn/tmp/mcp/`.

**Risk:** Resource leak on every web session that uses MCP. The leaked files are not sensitive, but the directory will grow unboundedly over time.

**Recommendation:** Pass `currentSession.id` instead of `mcpConfigPath`:
```ts
if (mcpConfigPath) cleanupMcpConfigFile(currentSession.id);
```
Alternatively, make `cleanupMcpConfigFile` accept a path (rename parameter, remove path construction from inside), which would match how `writeMcpConfigFile` returns the path — the caller already has it.

---

### HIGH — `as any` cast silences type on `createResult` in `invoke_employee`

**File:** `packages/jimmy/src/mcp/gateway-server.ts:299`

**Description:**
```ts
const createResult = await apiPost("/api/sessions", { ... }) as any;
const childId = createResult.id;
```
`apiPost` returns `Promise<unknown>`. The cast to `any` propagates unsafely — `createResult.id` is accessed without any runtime check on shape. If the API returns an error body (`{ error: "..." }`) instead of a session object, `childId` will be `undefined` and the null guard on the next line only catches that, but the `detail: createResult` in the error response then also leaks the error JSON without it being typed.

Similarly at line 310:
```ts
const session = await apiGet(`/api/sessions/${childId}`) as any;
const status = session.status;
```
`session.status` is read without checking that `session` is a non-null object.

**Risk:** If the gateway returns an unexpected shape (e.g. a 5xx wrapped in a non-JSON body, or the fetch throws), the `as any` masks the failure. A network error inside the poll loop will propagate as an unhandled rejection, which the MCP protocol handler's `try/catch` in `handleTool` will catch — but only after an uninformative error.

**Recommendation:** Define a narrow inline type or interface for the expected session response, or at minimum add a runtime shape guard:
```ts
const createResult = await apiPost("/api/sessions", { ... });
if (!createResult || typeof createResult !== "object" || !("id" in createResult)) {
  return JSON.stringify({ error: "Unexpected response from gateway", detail: createResult });
}
const childId = (createResult as { id: string }).id;
```

---

### HIGH — Type narrowing lost inside `setTimeout` closure (both `api.ts` and `manager.ts`)

**File:** `packages/jimmy/src/gateway/api.ts:1908-1920`, `packages/jimmy/src/sessions/manager.ts:331-343`

**Description:**
The pattern used is:
```ts
if (timeoutMinutes && timeoutMinutes > 0 && isInterruptibleEngine(engine)) {
  timeoutHandle = setTimeout(() => {
    engine.kill(currentSession.id, ...);     // engine used as InterruptibleEngine
    if (!engine.isAlive(currentSession.id)) { // engine used as InterruptibleEngine
```
TypeScript's type narrowing via type guards does not carry into callback closures. Inside the `setTimeout` callback, `engine` reverts to its declared type `Engine`, which lacks `kill` and `isAlive`. TypeScript may or may not emit an error here depending on strictness settings — at minimum the code relies on a runtime contract that the compiler cannot enforce across the closure boundary. This is a latent unsafety.

**Risk:** If `engine` is ever reassigned before the timeout fires (it is a `const` parameter so currently safe), or if the type system is relied upon in future refactors, the narrowing assumption silently breaks.

**Recommendation:** Capture the narrowed reference before entering the closure:
```ts
if (timeoutMinutes && timeoutMinutes > 0 && isInterruptibleEngine(engine)) {
  const interruptibleEngine = engine; // InterruptibleEngine
  timeoutHandle = setTimeout(() => {
    interruptibleEngine.kill(currentSession.id, ...);
    if (!interruptibleEngine.isAlive(currentSession.id)) { ... }
  }, timeoutMinutes * 60_000);
}
```
This makes the narrowing explicit and safe across the closure boundary. Apply the same pattern in `manager.ts`.

---

### MEDIUM — `args.timeoutSeconds as number` coercion without validation

**File:** `packages/jimmy/src/mcp/gateway-server.ts:303`

**Description:**
```ts
const timeoutMs = ((args.timeoutSeconds as number) || 300) * 1000;
```
`args` is typed `Record<string, unknown>`. `args.timeoutSeconds` is cast directly to `number` without checking that it is actually a number. If the MCP client passes `"300"` (a string) or `null`, the `|| 300` fallback handles the falsy case (`0` or `null`/`undefined`), but a non-numeric string would produce `NaN * 1000 = NaN`, which makes `Date.now() - startTime < NaN` always `false`, causing the poll loop to never execute and immediately returning a timeout result.

**Risk:** An MCP client that passes `timeoutSeconds: "five"` or `timeoutSeconds: 0` would silently get an instant timeout with no polling.

**Recommendation:** Add a numeric type guard:
```ts
const rawTimeout = args.timeoutSeconds;
const timeoutMs = (typeof rawTimeout === "number" && rawTimeout > 0 ? rawTimeout : 300) * 1000;
```

---

### MEDIUM — `(currentSession.transportMeta as any)?.claudeSyncSince` unsafe cast

**File:** `packages/jimmy/src/gateway/api.ts:1923`

**Description:**
```ts
const syncSinceIso = (currentSession.transportMeta as any)?.claudeSyncSince;
```
`currentSession.transportMeta` is already typed as `JsonObject | null` (i.e. `{ [key: string]: JsonValue } | null`). The `as any` cast is unnecessary — `JsonObject` already supports arbitrary string keys. Accessing `currentSession.transportMeta?.["claudeSyncSince"]` would be fully type-safe and would return `JsonValue | undefined`, after which the existing `typeof syncSinceIso === "string"` guard correctly narrows it.

**Risk:** Low immediate risk (the `as any` doesn't introduce new unsafety here), but it disables type checking on the field access and is a code smell that could mask refactor regressions.

**Recommendation:** Remove the `as any`:
```ts
const syncSinceIso = currentSession.transportMeta?.["claudeSyncSince"];
```
The existing `typeof syncSinceIso === "string"` guard that follows is already the correct narrowing pattern.

---

### MEDIUM — `as any[]` on `apiGet` results in `gateway-server.ts` (pre-existing but expanded by new code)

**File:** `packages/jimmy/src/mcp/gateway-server.ts:253`, `365`

**Description:**
```ts
const sessions = await apiGet("/api/sessions") as any[];
const jobs = await apiGet("/api/cron") as any[];
```
These casts existed before this branch, but the new `invoke_employee` case follows the same pattern with an additional `as any` for the session poll result. The API helpers return `Promise<unknown>`, so some assertion is required — but `as any[]` removes all element-level checking.

**Risk:** If the API changes shape (e.g. wraps results in `{ data: [...] }`), the cast silently produces `undefined` access errors at runtime.

**Recommendation:** Define response types or use a narrower assertion with a runtime guard:
```ts
const raw = await apiGet("/api/sessions");
if (!Array.isArray(raw)) throw new Error("Unexpected sessions response shape");
const sessions = raw as Array<{ id: string; status: string; employee?: string; [k: string]: unknown }>;
```

---

### LOW — `toolName` and `toolArgs` unsafe casts in MCP protocol handler

**File:** `packages/jimmy/src/mcp/gateway-server.ts:424-425`

**Description:**
```ts
const toolName = params?.name as string;
const toolArgs = (params?.arguments as Record<string, unknown>) || {};
```
`params` is typed `Record<string, unknown> | undefined`. Casting `params?.name` directly to `string` does not validate that `name` is actually present or is a string. If an MCP client sends a malformed `tools/call` with a missing or non-string `name`, `toolName` will be `undefined as string`, and `handleTool` will hit the `default: throw new Error("Unknown tool: undefined")` branch — which is caught and returned as an error, so the consequence is handled gracefully. Still, the cast is dishonest.

**Risk:** Low (graceful fallback exists), but a missing `name` will produce a confusing error message `"Unknown tool: undefined"` rather than `"Missing tool name"`.

**Recommendation:** Add an explicit guard:
```ts
if (typeof params?.name !== "string") {
  sendResponse({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request: missing tool name" } });
  break;
}
const toolName = params.name;
const toolArgs = (typeof params.arguments === "object" && params.arguments !== null)
  ? params.arguments as Record<string, unknown>
  : {};
```

---

### LOW — `maxDurationMinutes` field is not validated at config load time

**File:** `packages/jimmy/src/shared/types.ts:212`

**Description:**
The new `maxDurationMinutes?: number` field on `Employee` is declared as an optional number in the TypeScript type, but employee configs are loaded from YAML files using `js-yaml` with no schema validation. A user who writes `maxDurationMinutes: "thirty"` in their YAML file will produce a string at runtime that passes the `?? config.sessions?.maxDurationMinutes` chain and then is multiplied by `60_000`, yielding `NaN` — causing `setTimeout(fn, NaN)` which fires immediately.

**Risk:** A misconfigured employee YAML immediately kills every session for that employee.

**Recommendation:** Add a runtime guard in both timeout enforcement sites:
```ts
const timeoutMinutes = employee?.maxDurationMinutes ?? config.sessions?.maxDurationMinutes;
if (typeof timeoutMinutes === "number" && timeoutMinutes > 0 && isInterruptibleEngine(engine)) {
```
The existing `timeoutMinutes > 0` already filters `NaN` (`NaN > 0` is `false`), so this is partially mitigated. However, explicit `typeof timeoutMinutes === "number"` would be clearer and fully type-safe.
