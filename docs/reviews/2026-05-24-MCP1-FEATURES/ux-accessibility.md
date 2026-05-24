# UX / Accessibility Review — jin (2026-05-24)

## Summary

The jin web UI is a private single-operator admin tool served at localhost, so some public-web a11y concerns (internationalisation, screen-reader-first flows) are lower stakes. Despite that context, the codebase shows solid baseline awareness: lucide-react icon-only buttons carry `aria-label` throughout, Radix Dialog is used correctly with `DialogTitle` + `DialogDescription` present, toggle switches carry `role="switch"` + `aria-checked`, and there is a global `prefers-reduced-motion` CSS rule. However, a cluster of real, fixable problems remains. Error states are partially handled — several `catch` blocks silently swallow errors and leave the UI blank rather than surfacing a message. The notification bell panel and the toast container have no `aria-live` region, so screen readers never announce new notifications or errors. Several important interactive elements (chat tab close buttons, notification panel rows, live-stream widget header buttons) lack `aria-label`, relying solely on `title`. The mobile drawer menu has no focus trap. Settings form labels are not programmatically associated with inputs via `htmlFor`/`id`. Overall rating: **5/10** — functional for the intended single-power-user, but would fail a basic assistive-technology audit.

---

## Findings Table

| # | Severity | Confidence | Finding | Location |
|---|---|---|---|---|
| 1 | HIGH | HIGH | No `aria-live` region for toast notifications or notification bell — assistive tech never announces new alerts | `toast-container.tsx`, `notification-bell.tsx` |
| 2 | HIGH | HIGH | Chat loadSession `catch {}` silently wipes messages; user sees blank pane with no error message | `chat-pane.tsx:302-306` |
| 3 | HIGH | HIGH | `window.confirm` / `window.alert` for destructive actions — no focus management, breaks keyboard flow | `chat/page.tsx:343-344,426`, `chat-sidebar.tsx:465` |
| 4 | MEDIUM | HIGH | Settings `<label>` elements have no `htmlFor`/`id` association — clicking label does not focus input | `settings/page.tsx:752,771,787,806,822` |
| 5 | MEDIUM | HIGH | Chat tab close button is a `<span onClick>` with no `role`, `tabIndex`, or `aria-label` | `chat-tabs.tsx:126-130` |
| 6 | MEDIUM | HIGH | "New Chat" button in `ChatTabBar` uses `title` only — no `aria-label`; keyboard users can tab to it but get no label from AT | `chat-tabs.tsx:137-142` |
| 7 | MEDIUM | HIGH | Live-stream widget Copy/Minimize/Close buttons use `title` only, no `aria-label` | `live-stream-widget.tsx:234-257` |
| 8 | MEDIUM | HIGH | Mobile nav drawer has no focus trap — Tab escapes the open drawer into the background | `page-layout.tsx:46-87` |
| 9 | MEDIUM | MEDIUM | `StatusDot` components (session status: running/error/read/unread) convey state by color alone — no text alternative | `chat-sidebar.tsx:193-212`, `chat-tabs.tsx:117` |
| 10 | MEDIUM | MEDIUM | `EmployeeAvatar` as button has `role="button"` but no `aria-label` — announced as just "button" | `employee-avatar.tsx:28` |
| 11 | MEDIUM | MEDIUM | Notification bell dropdown is a plain `<div>` shown/hidden with state — no `role="dialog"` or focus trap; Escape does not close it | `notification-bell.tsx:67-135` |
| 12 | MEDIUM | MEDIUM | Chat employee picker listbox: `<div role="listbox" tabIndex={0}>` receives keyboard events but focus never moves to it on mount | `chat-employee-picker.tsx:121-127` |
| 13 | LOW | HIGH | Streaming "Thinking" indicator and tool-use pulse dots have no `aria-label` / live region — sighted-only affordance | `chat-messages.tsx:617-624`, `ToolGroup` line 52 |
| 14 | LOW | HIGH | `<header>` on cron page has no `aria-label`; multiple `<header>` elements exist per page (cron + page-layout) without differentiation | `cron/page.tsx:243` |
| 15 | LOW | MEDIUM | `GlobalSearch` Dialog wraps `<Command>` which has its own focus management, but `DialogTitle`/`DialogDescription` are absent — Radix warns and screen reader is silent | `global-search.tsx:107-108` |
| 16 | LOW | MEDIUM | Kanban drag-and-drop is mouse/touch only — no keyboard move alternative; `TicketCard` has Enter/Space to _open_ but not to move between columns | `kanban-column.tsx`, `ticket-card.tsx` |
| 17 | LOW | LOW | `xyflow` org map (`org-map.tsx`) has no keyboard navigation or `aria-label` — fully inaccessible to keyboard/AT, but map is supplementary to the grid/board tabs | `org-map.tsx` |
| 18 | LOW | LOW | `toggleEnabled` in cron page swallows its catch — if PUT fails the toggle reverts visually but there is no user feedback | `cron/page.tsx:205-215` |

---

## Detailed Findings

### [HIGH] No live regions for notifications and toasts

**Severity:** High
**Confidence:** High
**Location:** `src/components/notifications/toast-container.tsx:31-66`, `src/components/notifications/notification-bell.tsx:67`

**Evidence:**
```tsx
// toast-container.tsx — outer container has no aria-live
<div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 ...">
  {toasts.map((toast) => (
    <div key={toast.id} className="animate-slide-down ...">
```
```tsx
// notification-bell.tsx — panel renders on state toggle, no live region
{open && (
  <div className="animate-scale-up absolute ...">
```
Neither the toast container nor the notification panel have `role="status"` / `aria-live="polite"` (or `assertive` for errors). New toasts silently appear visually but are never announced.

**Impact:** Screen reader users never learn about errors, successes, or new notifications. For a tool where cron failures and session errors surface through notifications, this is a real gap.

**Recommendation:** Add `role="status" aria-live="polite" aria-atomic="false"` to the toast container div. For error toasts, use `aria-live="assertive"`. The notification bell panel should use `role="dialog"` or at least `aria-live="polite"` on the list.

---

### [HIGH] Silent catch in `loadSession` leaves blank chat pane

**Severity:** High
**Confidence:** High
**Location:** `src/components/chat/chat-pane.tsx:302-306`

**Evidence:**
```tsx
} catch {
  setMessages([])
  setCurrentSession(null)
  intermediateStartRef.current = -1
}
```
When `api.getSession()` fails (e.g., gateway down after reconnect), messages are silently cleared. The `ChatMessages` component with no messages and `loading=false` renders "Start a conversation", which is misleading — the session exists but failed to load.

**Impact:** User sees an empty chat and may start typing into what they believe is a new session, losing context of the existing one.

**Recommendation:** Add a local error state to `loadSession` and render a dismissable error message (similar to the pattern used in `org/page.tsx`). At minimum, inject an error message into the messages array consistent with how `session:error` events are handled (lines 272–282 of the same file).

---

### [HIGH] `window.confirm` / `window.alert` for destructive and error paths

**Severity:** High
**Confidence:** High
**Location:** `src/app/chat/page.tsx:343-344, 426`, `src/components/chat/chat-sidebar.tsx:465`

**Evidence:**
```tsx
// chat/page.tsx:343
action: () => { if (selectedId && window.confirm('Delete this session?')) handleDeleteSession(selectedId) }
// chat/page.tsx:426
onClick={() => { setShowMoreMenu(false); if (selectedId && window.confirm('Delete this session?')) handleDeleteSession(selectedId) }}
// chat-sidebar.tsx:465
window.alert(`Duplicate failed: ${err.message || "Unknown error"}`)
```
The chat sidebar already uses a proper `Dialog`-based confirm for its own deletions (`chat-sidebar.tsx:907`). The chat page uses `window.confirm/alert` instead.

**Impact:** Blocks the entire browser thread, traps focus in browser-native UI, looks visually jarring against the polished design, cannot be styled, and fails on some embedded/mobile WebViews. The `window.alert` on duplicate failure is especially bad — it blocks until dismissed with no further action.

**Recommendation:** Reuse the existing Radix `Dialog` confirm pattern already in `chat-sidebar.tsx:907`. Replace `window.alert` with the toast/notification system.

---

### [MEDIUM] Settings labels not programmatically associated with inputs

**Severity:** Medium
**Confidence:** High
**Location:** `src/app/settings/page.tsx:752-819`

**Evidence:**
```tsx
<label className="block text-[length:var(--text-caption1)] ...">
  Portal Name
</label>
<input type="text" ... value={nameValue} />
```
`<label>` elements throughout the Branding section and the STT section lack `htmlFor` attributes, and the sibling `<input>` elements lack `id` attributes. The `<label>` is visually associated (proximity + wrapping layout), but clicking the label does not focus the input and the association is not exposed to AT.

**Impact:** Screen reader users hear no association between labels and inputs. Clicking the label text does not activate the input. The `SettingsRow` component at line 142 has the same problem — labels are rendered without `htmlFor`.

**Recommendation:** Add matching `htmlFor`/`id` pairs. For the reusable `SettingsInput`/`SettingsSelect` components, add an `id` prop threaded through.

---

### [MEDIUM] Chat tab close button has no role, tabIndex, or aria-label

**Severity:** Medium
**Confidence:** High
**Location:** `src/components/chat/chat-tabs.tsx:125-130`

**Evidence:**
```tsx
<span
  onClick={(e) => { e.stopPropagation(); onClose(i) }}
  className="ml-auto rounded-sm p-0.5 opacity-0 ... group-hover:opacity-100"
>
  <X size={12} />
</span>
```
The close (×) button on each chat tab is a `<span>` with only a mouse `onClick`. It has no `tabIndex`, no `role="button"`, and no `aria-label`. It is also `opacity-0` until hover, making it invisible to keyboard users who tab to the tab button.

**Impact:** Keyboard users cannot close individual tabs. The tab button itself can be focused and activated, but there is no keyboard path to close a tab (other than the sidebar's delete flow).

**Recommendation:** Change to a `<button>` with `aria-label={`Close ${tab.label}`}` and `tabIndex={0}`. Show it on `focus-within` as well as `hover`.

---

### [MEDIUM] "New Chat" button in tab bar has `title` but no `aria-label`

**Severity:** Medium
**Confidence:** High
**Location:** `src/components/chat/chat-tabs.tsx:136-142`

**Evidence:**
```tsx
<button
  onClick={onNew}
  className="flex size-10 shrink-0 ..."
  title="New Chat (N)"
>
  <Plus size={14} />
</button>
```
`title` is not reliably announced by all AT. The button contains only an SVG icon with no text or `aria-label`.

**Recommendation:** Add `aria-label="New Chat"`.

---

### [MEDIUM] Live-stream widget action buttons use `title` only

**Severity:** Medium
**Confidence:** High
**Location:** `src/components/live-stream-widget.tsx:234-257`

**Evidence:**
```tsx
<button onClick={handleCopy} title="Copy all logs" ...>
  <Copy size={14} />
</button>
<button onClick={() => setState("collapsed")} title="Minimize" ...>
  <Minimize2 size={14} />
</button>
<button onClick={handleClose} title="Close" ...>
  <X size={14} />
</button>
```
All three icon-only buttons in the widget header have only `title`, not `aria-label`.

**Recommendation:** Replace or supplement with `aria-label="Copy all logs"`, `aria-label="Minimize"`, `aria-label="Close"`.

---

### [MEDIUM] Mobile navigation drawer has no focus trap

**Severity:** Medium
**Confidence:** High
**Location:** `src/components/page-layout.tsx:46-87`

**Evidence:**
The mobile nav drawer is a `<nav>` absolutely positioned over the page. There is no focus-trap library call, no `inert` attribute on the background content, and no `aria-modal`. The backdrop div has an `onClick` to close, but pressing Tab while the drawer is open will move focus into background content.

```tsx
<div className="fixed inset-0 z-[120] lg:hidden">
  <div className="absolute inset-0 bg-black/50 ..." onClick={() => setOpen(false)} />
  <nav className="absolute inset-y-0 left-0 ...">
```

**Impact:** Keyboard users can tab through background content while the modal overlay is open. This also means Escape closes the overlay (via global keydown) but Tab does not stay constrained.

**Recommendation:** Either use Radix `Dialog` for the mobile drawer (which provides a focus trap automatically) or add `@radix-ui/react-focus-trap`. Alternatively, add `aria-modal="true"` to the `<nav>` and manually implement focus trapping.

---

### [MEDIUM] Status dots convey state by color alone

**Severity:** Medium
**Confidence:** Medium
**Location:** `src/components/chat/chat-sidebar.tsx:193-212`, `src/components/chat/chat-tabs.tsx:117`

**Evidence:**
```tsx
// chat-sidebar.tsx
function StatusDot({ color, pulse, className }) {
  return (
    <span className={cn("shrink-0 rounded-full", className)}
      style={{ background: color, animation: pulse ? ... : "none" }} />
  )
}
// chat-tabs.tsx:117
<span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_COLORS[tab.status] || STATUS_COLORS.idle}`} />
```
Session status (running = blue, error = red, unread = green, read = quaternary grey) is encoded purely by color. There is no text alternative on the dot.

**Impact:** Color-blind users (especially those with red-green deficiency) may not distinguish error from unread/running. Screen readers announce nothing for the dot.

**Recommendation:** Add a visually-hidden `<span className="sr-only">` inside the dot with the status text: `<span className="sr-only">{status}</span>`. Alternatively, use the `title` attribute on the dot span as a quick fix.

---

### [MEDIUM] EmployeeAvatar as button lacks `aria-label`

**Severity:** Medium
**Confidence:** Medium
**Location:** `src/components/ui/employee-avatar.tsx:25-46`

**Evidence:**
```tsx
<span
  onClick={onClick}
  role={onClick ? "button" : undefined}
  style={{ cursor: onClick ? "pointer" : undefined, ... }}
>
  {emoji}
</span>
```
When used as a button, the avatar renders an emoji (e.g., 🧞) as its only content. The `role="button"` is set but there is no `aria-label` or `tabIndex`, so the element is not keyboard-focusable and the accessible name is just the emoji character.

**Recommendation:** When `onClick` is provided, also add `tabIndex={0}`, keyboard handler (`onKeyDown` for Enter/Space), and `aria-label={name}` (the employee display name).

---

### [MEDIUM] Notification bell dropdown lacks dialog semantics and focus trap

**Severity:** Medium
**Confidence:** Medium
**Location:** `src/components/notifications/notification-bell.tsx:67-135`

**Evidence:**
```tsx
{open && (
  <div className="animate-scale-up absolute right-0 top-[calc(100%+8px)] z-[200] flex max-h-[480px] w-[360px] ...">
```
The panel is a plain `<div>` that appears on toggle. There is no `role="dialog"` or `aria-modal`, Escape does not close it (only outside click does), focus does not move into the panel on open, and there is no focus restoration on close.

**Recommendation:** Wrap in Radix `Popover` or add `role="dialog"`, `aria-label="Notifications"`, Escape key handler, and focus management. Minimum fix: add an Escape keydown listener and focus the first actionable element on open.

---

### [MEDIUM] Chat employee picker listbox: keyboard focus not moved on mount

**Severity:** Medium
**Confidence:** Medium
**Location:** `src/components/chat/chat-employee-picker.tsx:121-127`

**Evidence:**
```tsx
<div ref={listRef} role="listbox" tabIndex={0} onKeyDown={handleKeyDown} ...>
```
The listbox container is focusable and handles arrow keys, but on mount the search input (`searchRef`) is never focused programmatically and the listbox itself is never focused. Tab order goes: search input → listbox. The keyboard navigation (arrow keys in the listbox) only works once the listbox itself has focus, but there is no visual focus ring on the listbox container when it has focus.

**Recommendation:** Add `aria-activedescendant` to the listbox pointing to the highlighted option. Ensure the currently highlighted `option` div has a stable `id` attribute. Focus the search input on mount with `useEffect(() => searchRef.current?.focus(), [])`.

---

### [LOW] Streaming "Thinking" indicator has no live region

**Severity:** Low
**Confidence:** High
**Location:** `src/components/chat/chat-messages.tsx:617-624`

**Evidence:**
```tsx
{loading && !streamingText && messages.length > 0 && (
  <div className="flex items-center gap-1.5 py-1.5 px-[var(--space-4)] mt-[var(--space-1)]">
    <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-[jinn-pulse_1.4s_infinite] shrink-0" />
    <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] ...">Thinking</span>
  </div>
)}
```
The "Thinking" indicator and the streaming text appear without any `aria-live` announcement. A screen reader user would not know when the assistant has started or finished responding.

**Recommendation:** Wrap the messages region in a `<div aria-live="polite" aria-label="Chat messages">`. This single change also covers streaming text appearing.

---

### [LOW] `GlobalSearch` Dialog missing `DialogTitle`/`DialogDescription`

**Severity:** Low
**Confidence:** Medium
**Location:** `src/components/global-search.tsx:107-108`

**Evidence:**
```tsx
<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent className="p-0 gap-0 max-w-[560px]">
    <Command className="rounded-lg">
      <CommandInput placeholder={`Search ${portalName}...`} />
```
The `DialogContent` wraps a `<Command>` palette without `DialogTitle` or `DialogDescription`. Radix will emit a console warning in development and the dialog has no accessible name for screen readers.

**Recommendation:** Add a visually hidden `<DialogTitle className="sr-only">Search</DialogTitle>` inside `DialogContent`.

---

### [LOW] Kanban drag-and-drop is mouse-only

**Severity:** Low
**Confidence:** Medium
**Location:** `src/components/kanban/kanban-board.tsx`, `src/components/kanban/ticket-card.tsx`

**Evidence:**
`TicketCard` has `draggable`, `onDragStart`, `onDragEnd` only. `KanbanColumn` handles `onDragOver`, `onDrop`. The card correctly has `role="button"`, `tabIndex={0}`, Enter/Space to open the detail panel, but there is no keyboard mechanism to move a card between columns.

**Impact:** Keyboard-only users can open ticket details but cannot reorganise the board.

**Recommendation:** For a private admin tool this is Low priority. A pragmatic fix is to add a `<select>` or set of "Move to…" buttons in the `TicketDetailPanel` that changes the status directly.

---

### [LOW] XYFlow org chart is fully keyboard/AT inaccessible

**Severity:** Low
**Confidence:** Low
**Location:** `src/components/org/org-map.tsx`

**Evidence:**
ReactFlow (`@xyflow/react`) renders a canvas-like SVG. The Org page has three tabs: Map, Grid, Board. The Map tab is supplementary — grid and board provide the same data in table/card form. XYFlow does support basic keyboard focus on nodes in newer versions, but no `aria-label` is placed on the ReactFlow container.

**Impact:** Low in practice because Grid/Board tabs cover the same content. Worth a `<div aria-label="Organization chart, use Grid or Board tab for accessible view">` wrapper and adding `aria-hidden="true"` to the flow container itself to prevent AT from crawling unstructured SVG nodes.

---

### [LOW] `toggleEnabled` cron silently discards error

**Severity:** Low
**Confidence:** High
**Location:** `src/app/cron/page.tsx:205-215`

**Evidence:**
```tsx
function toggleEnabled(job: CronJob) {
  const newEnabled = !job.enabled
  api
    .updateCronJob(job.id, { enabled: newEnabled })
    .then(() => { setJobs(prev => prev.map(j => j.id === job.id ? { ...j, enabled: newEnabled } : j)) })
    .catch(() => {})  // silent
}
```
If the PUT fails, the toggle visually snaps back (state not updated), but no message is shown.

**Recommendation:** In the `.catch()`, call the notification system: `addToast({ type: 'error', title: 'Failed to update job', message: err.message })`.

---

## Quick Wins

These can be fixed in under 30 minutes total:

1. **`aria-label` on New Chat button** (`chat-tabs.tsx:138`) — one-liner.
2. **`aria-label` on Live-stream Copy/Minimize/Close** (`live-stream-widget.tsx:234-257`) — three one-liners.
3. **`aria-live="polite"` on `ToastContainer`** (`toast-container.tsx:31`) — add attribute to the outer `<div>`.
4. **`sr-only` status text in `StatusDot`** (`chat-sidebar.tsx:193`) — add `<span className="sr-only">{statusLabel}</span>` inside the dot.
5. **`htmlFor`/`id` on Branding section labels** (`settings/page.tsx:752-819`) — thread an `id` prop through `SettingsInput`/`SettingsSelect`.
6. **`aria-label` on GlobalSearch Dialog** — add `<DialogTitle className="sr-only">Search</DialogTitle>`.
7. **`tabIndex={0}` + `aria-label` on EmployeeAvatar button** — add both when `onClick` is provided.
8. **Escape key on NotificationBell panel** — add `useEffect` keydown listener mirroring the outside-click handler.

---

## Overall Rating & Rationale

**5 / 10**

The codebase shows genuine a11y intention: Radix primitives are used consistently and with proper Dialog metadata, icon buttons in the main flows have `aria-label`, ARIA roles on custom switches and listboxes are largely correct, and there is a global reduced-motion override. These are not accidental — someone cared.

The deductions come from a cluster of fixable gaps that meaningfully affect usability even for the single power-user audience: silent error states in `loadSession` and `toggleEnabled` create mysterious blank UIs; `window.confirm/alert` for destructive delete operations feel out of place in a polished admin tool and break keyboard flow; the mobile drawer has no focus trap; the notification and toast systems have no live regions so errors are sight-only; and the chat tab close button is unreachable by keyboard. None of these require major refactors — most are one-to-five line fixes using patterns already present elsewhere in the codebase.
