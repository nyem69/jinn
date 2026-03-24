# Fix Plan — `feat/agentic-patterns` Code Review

Prioritized by severity and dependency order. Each fix is self-contained unless noted.

---

## Phase 1: Critical + High bugs (ship-blocking)

### Fix 1 — `cleanupMcpConfigFile` wrong argument [C1]
**File:** `api.ts:1971`
**Change:** `cleanupMcpConfigFile(mcpConfigPath)` → `cleanupMcpConfigFile(currentSession.id)`
**Effort:** 1 line
**Risk:** None

### Fix 2 — Timer leak in `manager.ts` error path [H1]
**File:** `manager.ts:360` → move to `finally` block (~line 749)
**Change:** Add `if (timeoutHandle) clearTimeout(timeoutHandle);` to existing `finally` block
**Effort:** 2 lines
**Risk:** None

### Fix 3 — Extract shared timeout helper [H2]
**File:** New `shared/timeout.ts`
**Change:** Extract the 18-line timeout block into `startSessionTimeout()`. Import in both `api.ts` and `manager.ts`.
**Effort:** ~30 lines (new file + 2 call sites)
**Risk:** Low — straightforward extraction
**Depends on:** Fix 2 (merge timer cleanup into the helper)

### Fix 4 — Clamp and validate `timeoutSeconds` in `invoke_employee` [H3, M5]
**File:** `gateway-server.ts:303`
**Change:**
```ts
const rawTimeout = args.timeoutSeconds;
const timeoutSec = typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
  ? Math.min(rawTimeout, 600) : 300;
const timeoutMs = timeoutSec * 1000;
```
**Effort:** 3 lines
**Risk:** None

### Fix 5 — Remove `detail: createResult` leak [H5]
**File:** `gateway-server.ts:301`
**Change:** Remove `detail` field. Log full response server-side.
```ts
if (!childId) {
  logger.warn(`invoke_employee: failed to create session for "${args.employee}"`, createResult);
  return JSON.stringify({ error: `Failed to create child session for employee "${args.employee}"` });
}
```
**Effort:** 3 lines
**Risk:** None

### Fix 6 — Fix interrupted status in web path [H6]
**File:** `api.ts:2274`
**Change:** Add `wasInterrupted` guard to match `manager.ts`:
```ts
status: wasInterrupted ? "idle" : (result.error ? "error" : "idle"),
lastError: wasInterrupted ? null : (result.error ?? null),
```
**Effort:** 2 lines
**Risk:** Low — mirrors existing pattern in `manager.ts`

### Fix 7 — Add runtime shape guards for API responses [H4]
**File:** `gateway-server.ts:299, 310`
**Change:** Replace `as any` with runtime checks:
```ts
const createResult = await apiPost("/api/sessions", { ... });
if (!createResult || typeof createResult !== "object" || !("id" in createResult)) { ... }
```
**Effort:** 8 lines
**Risk:** None

---

## Phase 2: Medium fixes (quality + robustness)

### Fix 8 — Fix `isAlive` race in timeout fallback [M1]
**File:** `api.ts:1911`, `manager.ts:334` (or shared helper from Fix 3)
**Change:** Check `isAlive()` BEFORE `kill()`:
```ts
const wasAlive = engine.isAlive(sessionId);
engine.kill(sessionId, reason);
if (!wasAlive) {
  updateSession(sessionId, { status: "interrupted", lastError: "..." });
}
```
**Effort:** 4 lines per site (or once in shared helper)
**Depends on:** Fix 3

### Fix 9 — Cancel orphaned child on `invoke_employee` timeout [M4]
**File:** `gateway-server.ts:329`
**Change:** Before returning timeout, send interrupt:
```ts
await apiPost(`/api/sessions/${childId}/interrupt`, {}).catch(() => {});
```
**Effort:** 1 line
**Risk:** Low — best-effort, fire-and-forget

### Fix 10 — Include partial output in timeout response [M3]
**File:** `gateway-server.ts:329-335`
**Change:** Fetch child session messages before returning, include `partialResult`.
**Effort:** 5 lines
**Depends on:** Fix 9 (cancel after fetching partial)

### Fix 11 — Validate URL path segments [M6]
**File:** `gateway-server.ts` (multiple handlers)
**Change:** Add validation helper:
```ts
function validateId(val: unknown): string | null {
  if (typeof val !== "string" || !/^[a-z0-9-]{1,64}$/i.test(val)) return null;
  return val;
}
```
Apply to `sessionId`, `employee`, `name`, `department`, `connector` args.
**Effort:** ~15 lines
**Risk:** Low

### Fix 12 — Document MCP blocking + add engine/model params [M2, M9]
**File:** `gateway-server.ts:95-113`
**Change:** Update tool description to note blocking behavior. Add `engine` and `model` to input schema.
**Effort:** 8 lines
**Risk:** None

### Fix 13 — Emit `session:interrupted` on timeout [M8]
**File:** `api.ts` timeout callback (or shared helper)
**Change:** `context.emit("session:interrupted", { sessionId, reason: "timeout" })`
**Effort:** 1 line
**Risk:** Low — additive event

### Fix 14 — Wrap MCP config write in try/catch [M10]
**File:** `api.ts:1890-1895`
**Change:**
```ts
try {
  mcpConfigPath = writeMcpConfigFile(mcpConfig, currentSession.id);
} catch (err) {
  logger.warn(`Failed to write MCP config for session ${currentSession.id}: ${err}`);
}
```
**Effort:** 4 lines
**Risk:** None

---

## Phase 3: Low-priority polish (defer to next PR)

| # | Fix | File | Effort |
|---|-----|------|--------|
| 15 | Validate `maxDurationMinutes` as finite number [L1] | shared/timeout.ts | 1 line |
| 16 | Use `findLast()` instead of `[...arr].reverse().find()` [L2] | gateway-server.ts | 1 line |
| 17 | Exponential back-off on poll interval [L3] | gateway-server.ts | 5 lines |
| 18 | Initial 500ms fast-check before 2s loop [L4] | gateway-server.ts | 2 lines |
| 19 | `logger.info` for normal timeout, `logger.warn` for fallback [L5] | shared/timeout.ts | 1 line |
| 20 | Include employee name in timeout log messages [L6] | shared/timeout.ts | 1 line |
| 21 | Validate `JINN_GATEWAY_URL` is loopback [L7] | gateway-server.ts | 3 lines |
| 22 | Add `AbortController` timeout to `apiGet`/`apiPost` [L8] | gateway-server.ts | 6 lines |

---

## Summary

| Phase | Fixes | Effort | Impact |
|-------|-------|--------|--------|
| 1 — Ship-blocking | 7 | ~50 lines | Fixes all CRITICAL + HIGH |
| 2 — Quality | 7 | ~40 lines | Fixes MEDIUM issues |
| 3 — Polish | 8 | ~20 lines | LOW priority, defer OK |
| **Total** | **22** | **~110 lines** | |

**Recommended approach:** Apply Phase 1 as a single commit before merging the PR. Phase 2 can be a follow-up commit on the same branch or a separate PR. Phase 3 can be deferred.
