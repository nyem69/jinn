# Performance Engineer Review — jin (2026-05-24)

## Summary

The system has a solid structural foundation — WAL mode on SQLite, proper use of better-sqlite3 synchronous APIs, WebSocket-driven cache invalidation with 500 ms debounce, and lazy loading of the xyflow graph via `next/dynamic`. The primary bottlenecks are (1) **unbounded `listSessions()` returning all 4,932 rows on every HTTP request with no `LIMIT` and no index on `last_activity`**, causing a full table scan + temp B-TREE sort, (2) **a `readFileSync(config.yaml)` + YAML parse on every session event** via `loadHandlersFlagConfig`, (3) an N+1 in the children endpoint that filters 4,932 rows in JS instead of using the existing `idx_sessions_parent` SQL index, and (4) **emojilib's 264 KB JSON dictionary iterated into `ALL_EMOJIS` at module load time**, adding to the shared JS chunk even when no emoji picker is open. React context and render patterns are largely acceptable; the two context providers use inline object literals but their fields are individually `useCallback`-stabilized so the impact is modest. No virtual scrolling exists for the chat message list or session sidebar, which will degrade at scale but is tolerable today. Overall rating: **5 / 10** — works correctly, meaningful headroom for improvement in hot paths.

---

## Findings Table

| # | Severity | Confidence | Finding | Location |
|---|----------|------------|---------|----------|
| 1 | **Critical** | High | `listSessions()` — full table scan + temp B-TREE sort (4,932 rows), no `LIMIT`, called on 6 different API routes | `gateway/api.ts:416,469,927,1873,1894`; `sessions/registry.ts:371` |
| 2 | **High** | High | `readFileSync(config.yaml)` + `yaml.load` on every session event dispatch via `loadHandlersFlagConfig` | `events/handlers.ts:327`; `events/emit.ts:122` |
| 3 | **High** | High | `GET /api/sessions/:id/children` does `listSessions().filter(JS)` instead of querying `idx_sessions_parent` | `gateway/api.ts:927` |
| 4 | **High** | High | No index on `sessions.status` or `sessions.employee` — `getInterruptedSessions` and `getBudgetStatus` full-scan 4,932 rows | `sessions/registry.ts:396`; `gateway/budgets.ts:22` |
| 5 | **High** | High | `SELECT COUNT(*) FROM sessions` full scan on every `createSession` call (`getNextSessionNumber`) | `sessions/registry.ts:149` |
| 6 | **Medium** | High | emojilib `ALL_EMOJIS` (3,500+ entries, 264 KB JSON source) built eagerly at module load time; included in shared chunk (~134 KB raw in `743.*` chunk) | `components/ui/emoji-picker.tsx:14-16` |
| 7 | **Medium** | High | `callbacks.ts` calls `loadConfig()` (sync file read) on every parent-session notification and every Discord notification | `sessions/callbacks.ts:98,121` |
| 8 | **Medium** | High | `syncSkillSymlinks()` on every skill-dir change reads all 58 `SKILL.md` files synchronously via `isSkillHidden`; `warnOnMissingSkillDependencies` (→ `scanSkills`) then reads them all again | `gateway/watcher.ts:61`; `skills/validator.ts:78-91` |
| 9 | **Medium** | High | `BreadcrumbContext.Provider` passes inline `{ items, setItems }` object — new reference every render — to all consumers | `context/breadcrumb-context.tsx:31` |
| 10 | **Medium** | Medium | `SettingsContext.Provider` passes a 14-key inline object literal — new reference on every `settings` change — all consumers re-render | `app/settings-provider.tsx:224` |
| 11 | **Medium** | High | `GET /api/sessions` returns all 4,932 sessions with no pagination; web sidebar fetches and serializes them all on every invalidation | `gateway/api.ts:469`; `components/chat/chat-sidebar.tsx:260` |
| 12 | **Medium** | High | `groupMessages()` in `ChatMessages` called inline on every render with no `useMemo`; messages array passed as prop | `components/chat/chat-messages.tsx:500` |
| 13 | **Low** | High | `useSessionQueue` polls every 5 s unconditionally when a session is selected, triggering `listAllPendingQueueItems` (full scan) regardless of session status | `hooks/use-sessions.ts:41`; `sessions/registry.ts:744` |
| 14 | **Low** | Medium | `SELECT * FROM sessions` used in `getSession`, `getSessionBySessionKey`, `getInterruptedSessions`, `listSessions` — transfers all columns including large JSON blobs (`reply_context`, `transport_meta`) when only a subset is needed | `sessions/registry.ts:261,271,371,396` |
| 15 | **Low** | Medium | `chat-pane` polling interval (`setInterval` 5 s) runs while `loading === true` even when WebSocket events already cover session completion | `components/chat/chat-pane.tsx:337` |

---

## Detailed Findings

### [CRITICAL] listSessions() — unbounded full-table scan on 4,932 rows, called on 6 routes

**Severity:** Critical  
**Confidence:** High  
**Location:** `packages/jimmy/src/sessions/registry.ts:371`; `packages/jimmy/src/gateway/api.ts:416,469,927,1873,1894`

**Evidence:**
```ts
// registry.ts:371
const rows = db.prepare(`SELECT * FROM sessions ${where} ORDER BY last_activity DESC`).all(...values)
```
```sql
-- EXPLAIN QUERY PLAN (verified on live db):
SCAN sessions
USE TEMP B-TREE FOR ORDER BY
```
Called from: `GET /api/status` (line 416), `GET /api/sessions` (line 469), `GET /api/sessions/:id/children` (line 927, then filtered in JS), `GET /api/activity` (line 1873), `GET /api/onboarding` (line 1894).

**Impact:** Every request to any of these 5 endpoints (all hit on page load) scans all 4,932 rows and materializes a temporary B-TREE sort. At current row count this is ~2–5 ms per call; at 20 k rows (6 months of cron activity) it becomes 15–30 ms per call. The web UI calls `/api/sessions` on every WebSocket-driven cache invalidation (debounced to 500 ms), meaning every completed session triggers a full re-scan.

**Recommendation:** Add `CREATE INDEX idx_sessions_last_activity ON sessions (last_activity DESC)` in a new migration. Add pagination: `LIMIT ? OFFSET ?` on `listSessions` and a `?limit=&before=` cursor parameter on `GET /api/sessions`. Short-term: cap the list endpoint at 200 most-recent rows; the sidebar only renders visible rows anyway.

---

### [HIGH] readFileSync(config.yaml) + yaml.load on every session event

**Severity:** High  
**Confidence:** High  
**Location:** `packages/jimmy/src/events/handlers.ts:325-332`; `packages/jimmy/src/events/emit.ts:122`

**Evidence:**
```ts
// handlers.ts:325-332
export function loadHandlersFlagConfig(): HandlersFlagConfig {
  try {
    const cfg = loadConfig() as { features?: { handlers?: Record<string, boolean> } };
    return cfg.features?.handlers ?? {};
  } catch { return {}; }
}
// emit.ts:122 — no flagConfig passed, so loadHandlersFlagConfig() fires:
void dispatchEventHandlers(db, result.event).catch(...)
```
```ts
// shared/config.ts:12-13
const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
return yaml.load(raw) as JinnConfig;
```

**Impact:** Every session event (session_started, session_completed, tool_call, etc.) triggers a synchronous disk read + YAML parse. With 33,965 events in the current DB and cron jobs firing multiple events per run, this adds constant low-level blocking to the Node.js event loop. On macOS HFS+ the inode cache usually absorbs the read, but YAML parse is still CPU-bound per-event.

**Recommendation:** Cache the parsed config in memory. The config watcher already fires `onConfigReload` when `config.yaml` changes — store the current `HandlersFlagConfig` in a module-level variable and update it on reload. Pass `flagConfig` explicitly from `emit.ts` after reading the cached value once.

---

### [HIGH] GET /api/sessions/:id/children — JS filter instead of SQL index

**Severity:** High  
**Confidence:** High  
**Location:** `packages/jimmy/src/gateway/api.ts:927`

**Evidence:**
```ts
// api.ts:927
const children = listSessions().filter((s) => s.parentSessionId === params!.id);
```
This loads all 4,932 sessions into memory and filters in JavaScript, ignoring the `idx_sessions_parent` index that already exists on `sessions(parent_session_id)`.

**Impact:** O(N) JS work when a direct SQL lookup using the existing index would be O(log N + k) where k = number of children (typically 1–10).

**Recommendation:**
```ts
// Replace with:
const children = db.prepare(
  'SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at ASC'
).all(params.id);
```
The index `idx_sessions_parent` is already in place (migration 0003_lineage). No new migration needed.

---

### [HIGH] Missing indexes on sessions.status and sessions.employee

**Severity:** High  
**Confidence:** High  
**Location:** `packages/jimmy/src/sessions/registry.ts:396`; `packages/jimmy/src/gateway/budgets.ts:22`

**Evidence:**
```ts
// registry.ts:396 — full scan at gateway startup + on /api/sessions/interrupted:
"SELECT * FROM sessions WHERE status = 'interrupted' AND engine_session_id IS NOT NULL ORDER BY last_activity DESC"

// budgets.ts:22 — full scan on every session start to check employee budget:
`SELECT COALESCE(SUM(total_cost), 0) as spend FROM sessions WHERE employee = ? AND created_at >= ?`
```
```sql
-- EXPLAIN QUERY PLAN (verified):
SCAN sessions  -- both queries
```
`sessions.status` and `sessions.employee` have no dedicated index. The `getBudgetStatus` query is called before every delegated session start.

**Recommendation:** Add to a new migration:
```sql
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status, last_activity);
CREATE INDEX IF NOT EXISTS idx_sessions_employee_cost ON sessions (employee, created_at, total_cost);
```

---

### [HIGH] getNextSessionNumber — COUNT(*) full scan on every session create

**Severity:** High  
**Confidence:** High  
**Location:** `packages/jimmy/src/sessions/registry.ts:149`

**Evidence:**
```ts
function getNextSessionNumber(): number {
  const db = initDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
  return row.count + 1;
}
```
```sql
-- EXPLAIN QUERY PLAN:
SCAN sessions USING COVERING INDEX idx_sessions_root  -- full scan on covering index
```
Called on every `createSession` invocation (including cron-triggered ones).

**Impact:** Minor but unnecessary. At 4,932 rows the covering index scan is fast (~0.5 ms), but it's a full index scan where a simple autoincrement counter would cost nothing.

**Recommendation:** Add a `session_seq` INTEGER autoincrement column, or maintain a module-level in-memory counter seeded from `SELECT MAX(rowid) FROM sessions` at startup. Alternatively, use `SELECT seq FROM sqlite_sequence WHERE name='sessions'` if the table uses AUTOINCREMENT (requires schema change).

---

### [MEDIUM] emojilib ALL_EMOJIS built eagerly at module load time (264 KB source)

**Severity:** Medium  
**Confidence:** High  
**Location:** `packages/web/src/components/ui/emoji-picker.tsx:14-16`

**Evidence:**
```ts
// emoji-picker.tsx:14-16 — executes at import/module evaluation time:
const ALL_EMOJIS: Array<{ emoji: string; keywords: string[] }> = []
for (const [emoji, keywords] of Object.entries(emojilib as Record<string, string[]>)) {
  ALL_EMOJIS.push({ emoji, keywords })
}
```
- `emojilib/dist/emoji-en-US.json` is **264 KB** (verified: `wc -c` = 264,089 bytes)
- This chunk lands in `743.588b42b673795913.js` (**134 KB raw / ~45 KB gzip**) shared across all routes
- `EmojiPicker` is statically imported (not dynamic) in both `settings/page.tsx` and `org/employee-detail.tsx`

**Impact:** ~45 KB of gzip added to pages that may never open the emoji picker. The for-loop iteration (~3,500 objects) also runs eagerly at module load, blocking the main thread briefly on cold start.

**Recommendation:** 
1. Lazy-load `emojilib` inside the component with `React.lazy` + dynamic import, or move it to a `useMemo/useEffect` that only runs when the picker opens.
2. Long-term: replace `emojilib` with a smaller hand-curated subset (the `EMOJI_POOL` in `emoji-pool.ts` is already 60 entries — consider using that as the search corpus unless full emoji search is required).

---

### [MEDIUM] loadConfig() called on every parent-session notification

**Severity:** Medium  
**Confidence:** High  
**Location:** `packages/jimmy/src/sessions/callbacks.ts:98,121`

**Evidence:**
```ts
// callbacks.ts:98 — in _sendDiscordNotification, called per rate-limit alert:
const config = loadConfig();
port = config.gateway?.port || 7777;

// callbacks.ts:121 — in _sendRaw, called on every child→parent notification:
const config = loadConfig();
port = config.gateway?.port || 7777;
```
Both functions call `loadConfig()` (sync `readFileSync`) solely to read the gateway port, which is static for the daemon's lifetime.

**Impact:** Every child-session completion (which fires `_sendRaw`) incurs a sync file read. With multi-agent tasks spawning 5–10 children, this is 5–10 unnecessary file reads per pipeline run.

**Recommendation:** Pass the port as a parameter from the caller (which already has `context.getConfig().gateway.port`), or cache the port in a module-level variable after the first read.

---

### [MEDIUM] syncSkillSymlinks double-reads all 58 SKILL.md files on every skills/ change

**Severity:** Medium  
**Confidence:** High  
**Location:** `packages/jimmy/src/gateway/watcher.ts:61`; `packages/jimmy/src/gateway/server.ts:692,739`

**Evidence:**
```ts
// watcher.ts:61 — inside syncSkillSymlinks, called on every skills/ FS event:
const visibleNames = skillNames.filter((name) => !isSkillHidden(name))
// isSkillHidden reads SKILL.md via readFileSync for each of 58 skills

// server.ts:739 — also in onSkillsChange, after syncSkillSymlinks completes:
import("../skills/validator.js")
  .then(({ warnOnMissingSkillDependencies }) => warnOnMissingSkillDependencies())
// warnOnMissingSkillDependencies → scanSkills() → reads all 58 SKILL.md files AGAIN
```
Skills directory has 58 entries (verified: `ls ~/.jinn/skills/ | wc -l`). Each change triggers 116 `readFileSync` calls.

**Impact:** Skills changes are infrequent (install/uninstall) and debounced at 500 ms, so real-world impact is low. However, on a slow filesystem or network mount this could block the event loop for tens of milliseconds.

**Recommendation:** Cache the hidden-flag scan result and invalidate only on actual `SKILL.md` changes. Pass the skill list between `syncSkillSymlinks` and `warnOnMissingSkillDependencies` to avoid the second full scan. The debounce already reduces frequency — this is a polish item.

---

### [MEDIUM] BreadcrumbContext.Provider inline object literal

**Severity:** Medium  
**Confidence:** High  
**Location:** `packages/web/src/context/breadcrumb-context.tsx:31`

**Evidence:**
```tsx
// breadcrumb-context.tsx:31
<BreadcrumbContext.Provider value={{ items, setItems }}>
```
A new `{ items, setItems }` object is created on every render of `BreadcrumbProvider`. Any component that reads from this context (via `useBreadcrumbs`) will re-render whenever `BreadcrumbProvider` re-renders, even if `items` hasn't changed.

**Impact:** `BreadcrumbProvider` re-renders whenever `items` state changes (which happens on every route navigation). Consumers re-render in cascade. In practice `BreadcrumbBar` is the only direct consumer, so the blast radius is small.

**Recommendation:**
```tsx
const contextValue = useMemo(() => ({ items, setItems }), [items, setItems])
<BreadcrumbContext.Provider value={contextValue}>
```
`setItems` is a `useState` setter (stable reference), so the memo only invalidates when `items` changes — correct behavior.

---

### [MEDIUM] SettingsContext.Provider inline 14-key object literal

**Severity:** Medium  
**Confidence:** High  
**Location:** `packages/web/src/app/settings-provider.tsx:224`

**Evidence:**
```tsx
// settings-provider.tsx:224
<SettingsContext.Provider
  value={{
    settings,
    setAccentColor, setPortalName, setPortalSubtitle, setPortalEmoji,
    setPortalIcon, setIconBgHidden, setEmojiOnly, setOperatorName,
    setLanguage, setEmployeeOverride, clearEmployeeOverride,
    getEmployeeDisplay, resetAll,
  }}
>
```
The inline object literal is recreated on every render of `SettingsProvider`. All 14 setter functions are individually `useCallback`-stabilized (good), but the wrapper object is new each time `settings` state changes.

**Impact:** `settings` changes on: initial hydration, `api.getOnboarding()` response, and any settings mutation. All `useSettings()` consumers (sidebar, chat page, org page, settings page) re-render on each of these. The cascaded re-renders are shallow so the actual DOM mutation cost is low.

**Recommendation:**
```tsx
const contextValue = useMemo(() => ({
  settings, setAccentColor, /* ...all stable callbacks */
}), [settings, setAccentColor, /* ... */])
```
This memoizes the wrapper object so consumers only re-render when `settings` actually changes.

---

### [MEDIUM] GET /api/sessions — no pagination, all 4,932 sessions serialized on every invalidation

**Severity:** Medium  
**Confidence:** High  
**Location:** `packages/jimmy/src/gateway/api.ts:469`; `packages/web/src/components/chat/chat-sidebar.tsx:260`

**Evidence:**
```ts
// api.ts:469
if (method === "GET" && pathname === "/api/sessions") {
  const sessions = listSessions();
  return json(res, sessions.map((session) => serializeSession(session, context)));
}
```
`serializeSession` calls `queue.getPendingCount()` and `queue.getTransportState()` for every session — O(N) in-memory work. The web sidebar (`useSessions` hook, `query-client.ts` staleTime=60s) re-fetches this list on every WebSocket `session:started/completed/error/deleted` event (debounced 500 ms via `use-query-invalidation.ts`).

**Impact:** With 4,932 sessions, every completion event triggers serialization of the full session list. Network payload ~500 KB uncompressed (estimated at ~100 bytes/session). This alone makes the sidebar slow to refresh after a cron run completes 5 sessions in sequence.

**Recommendation:** Add `?limit=200&before=<ISO_timestamp>` cursor pagination to `GET /api/sessions`. The sidebar only renders visible items; fetching the most recent 200 covers all practical use cases. Track total count separately so the sidebar can show "N total."

---

### [MEDIUM] groupMessages() called inline on every ChatMessages render

**Severity:** Medium  
**Confidence:** High  
**Location:** `packages/web/src/components/chat/chat-messages.tsx:500`

**Evidence:**
```tsx
// chat-messages.tsx:500
{groupMessages(messages).map((item) => {
```
`groupMessages` iterates the full messages array and groups consecutive tool-call messages. It is called on every render of `ChatMessages`. `ChatMessages` re-renders on every new streaming token (via `streamingText` prop) and on every session poll.

**Impact:** For long sessions with tool-heavy agents (e.g. a 50-turn investigation with 200+ messages), `groupMessages` runs on every streaming update (~20/sec). Each run is O(N) through the messages array.

**Recommendation:**
```tsx
const grouped = useMemo(() => groupMessages(messages), [messages])
// then: grouped.map((item) => { ... })
```
`streamingText` changes should not invalidate `grouped` since it derives from `messages` only.

---

### [LOW] useSessionQueue polls every 5 s unconditionally

**Severity:** Low  
**Confidence:** High  
**Location:** `packages/web/src/hooks/use-sessions.ts:41`

**Evidence:**
```ts
export function useSessionQueue(id: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions.queue(id!),
    queryFn: () => api.getSessionQueue(id!),
    enabled: !!id,
    refetchInterval: 5_000,  // always polls, regardless of session status
  })
}
```
The queue endpoint is only meaningful when a session is `running` or has `pending` queue items. Polling during `idle`/`completed`/`error` status wastes a DB query every 5 s per open tab.

**Recommendation:** Make `refetchInterval` conditional: `refetchInterval: (data) => (data?.length > 0 ? 5_000 : false)`. WebSocket events already cover queue depth changes.

---

### [LOW] SELECT * transfers unused large JSON columns

**Severity:** Low  
**Confidence:** Medium  
**Location:** `packages/jimmy/src/sessions/registry.ts:261,271,371,396`

**Evidence:**
```ts
db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
db.prepare('SELECT * FROM sessions WHERE session_key = ? ORDER BY last_activity DESC LIMIT 1').get(sessionKey)
db.prepare(`SELECT * FROM sessions ${where} ORDER BY last_activity DESC`).all()
```
`reply_context` and `transport_meta` are TEXT columns that store JSON blobs (Telegram reply contexts, WhatsApp message metadata). They are rarely needed for list views but are transferred on every `listSessions` call.

**Recommendation:** Enumerate required columns for list queries. Reserve `SELECT *` only for `getSession(id)` where the full row is needed. Example for `listSessions`: select all except `reply_context` and `transport_meta` for the list view.

---

### [LOW] chat-pane fallback polling coexists with WebSocket events

**Severity:** Low  
**Confidence:** High  
**Location:** `packages/web/src/components/chat/chat-pane.tsx:337`

**Evidence:**
```ts
// chat-pane.tsx:337
const timer = setInterval(async () => {
  const session = (await api.getSession(sessionId)) as Record<string, unknown>
  if (session.status !== 'running') {
    await loadSession(sessionId)
    setLoading(false)
  }
}, 5000)
```
This poll runs only while `loading === true`. The intent is a fallback if WebSocket delivery fails. However, `loading` is set to `true` on connection-seq change (WebSocket reconnect), which means the poll starts and continues for 5 s after every reconnect even if the session completed.

**Recommendation:** Keep the polling as a fallback but gate the interval on `loading && sessionId` — which is already the case. Consider reducing the interval to 2 s or using an exponential backoff to converge faster after a WebSocket gap.

---

## What's Done Well

- **WAL mode** enabled at `initDb()` — correct for concurrent read/write from web UI + cron
- **better-sqlite3** used throughout — synchronous API avoids Promise overhead for hot read paths; prepared statements are cached internally by the library
- **Event_handlers index** `uniq_event_handlers_kind_processor` ensures per-event handler lookup is O(log N) — not a scan
- **xyflow/dagre dynamically imported** via `next/dynamic({ ssr: false })` in `app/org/page.tsx` — these 2.7 MB + 848 KB packages do not block the chat route
- **WebSocket-driven invalidation** with 500 ms debounce in `use-query-invalidation.ts` — avoids thundering-herd refetches when cron fires many events in sequence
- **lucide-react** uses named imports (`{ X, Check, ... }`) consistently — tree-shaking eliminates unused icons; `sideEffects: false` confirmed in package.json
- **Query client `staleTime: 60_000`** prevents redundant refetches for stable data (skills, org)
- **`session_events` table** indexes well-covered: `(session_id, seq)`, `(root_session_id, id)`, `(kind, created_at)` — event queries are efficient

---

## Quick Wins

| Priority | Action | File | Effort |
|----------|--------|------|--------|
| 1 | Add `idx_sessions_last_activity` index on `sessions(last_activity DESC)` | new migration | 10 min |
| 2 | Add `idx_sessions_status` on `sessions(status, last_activity)` | new migration | 5 min |
| 3 | Fix children endpoint: replace `listSessions().filter()` with `SELECT … WHERE parent_session_id = ?` | `gateway/api.ts:927` | 5 min |
| 4 | Cache `HandlersFlagConfig` in memory; invalidate on `onConfigReload` | `events/handlers.ts` | 30 min |
| 5 | Wrap `groupMessages(messages)` in `useMemo` | `components/chat/chat-messages.tsx:500` | 2 min |
| 6 | Wrap `BreadcrumbContext.Provider` value in `useMemo` | `context/breadcrumb-context.tsx:31` | 2 min |
| 7 | Move emojilib iteration inside `useMemo` gated on picker open | `components/ui/emoji-picker.tsx:14` | 15 min |
| 8 | Add `LIMIT 200` default to `GET /api/sessions` list endpoint | `gateway/api.ts:469` | 20 min |

---

## Overall Rating & Rationale

**5 / 10**

The system works correctly and the event-driven architecture is sound. The score is dragged down by three compounding issues that all converge on the same hot path: every request to 5 different API endpoints triggers a full 4,932-row table scan with a temp B-TREE sort, while simultaneously every session event triggers a sync `readFileSync` of `config.yaml`. These are not theoretical — the DB is already 60 MB with 4,932 sessions and 33,965 events, and both issues will worsen linearly as the system accumulates history. The three Quick Wins marked priority 1–3 (one migration + one code fix) would cut the scan cost by 10–20x with minimal risk. Items 4–6 are each under 30 minutes. Items 9–15 are real but minor. No architectural rework is needed — the fixes are targeted and safe.
