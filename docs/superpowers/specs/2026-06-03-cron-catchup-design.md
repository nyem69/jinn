# Cron scheduler missed-fire catch-up — design

**Date:** 2026-06-03
**Repo:** nyem69/jinn · `packages/jimmy`
**Status:** approved (interactive brainstorm)

## Problem

node-cron schedules each job with a setInterval minute-tick. macOS sleep
(notably *Clamshell Sleep on battery*, which `caffeinate -s`/`-i` cannot prevent)
suspends the tick; a fire minute slept through is **never replayed**. node-cron
resumes ticking on wake but the cron expression no longer matches the passed
minute, so the fire is silently lost.

Confirmed failure: the `manamurah-cardinality-probe-rollover` one-shot
(`0 14 1 6 *` Asia/Kuala_Lumpur) never fired on 2026-06-01 — the gateway Mac was
in Maintenance/Clamshell sleep across the 14:00 MYT fire minute (FullWake at
14:11). The gateway process never restarted; the timer was simply suspended.
This is OS-sleep, **not** a regression of the 2026-05-28 watcher fix (nyem69/jinn#15).

## Goal

Replay a scheduled fire that was missed while the host slept, once, shortly
after wake — without double-firing during normal awake operation, and without
flooding after a long downtime.

## Approach

A **catch-up sweep** on the reconciler's existing `setInterval` (the first
post-wake tick runs the sweep) plus once on scheduler start. Per enabled job it
computes the most recent scheduled fire time (cron-parser v5, already a dep) and
replays it once if the run-log shows it never ran.

### New module — `packages/jimmy/src/cron/catchup.ts` (pure, injectable)

```
computeMissedFires(jobs, {
  now, lastCheck, maxLookbackMs, graceMs, dedupSlopMs, lastRunAt
}) -> { job, scheduledFor, olderFiresSkipped }[]
```

Per job, skip unless ALL hold (job eligible):
- `job.enabled === true` and `job.catchUp !== false` (opt-out flag) and
  `cron.validate(job.schedule)`.
- `prevFire = CronExpressionParser.parse(schedule, { tz: timezone, currentDate: now }).prev()`.
- `prevFire > lastCheck` — something fired since the last sweep.
- `prevFire <= now - graceMs` — old enough that node-cron has had its chance
  (avoids racing/duplicating an on-time fire).
- `lastRunAt(jobId)` is null OR `< prevFire - dedupSlopMs` — not already run
  (on-time or a prior catch-up).
- `prevFire >= now - maxLookbackMs` — within the replay window. If the most
  recent fire is older than the window AND unrun, emit a `logger.warn` skip
  (no silent drop).

`scheduledFor` is the **latest missed fire time**, not `now`.
`olderFiresSkipped` = count of additional in-window occurrences not replayed
(observability; latest-only policy means we replay exactly one).
**At most one catch-up per job per sweep** → inherently flood-safe.

Checkpoint helpers `readCheckpoint()/writeCheckpoint(ms)` persist `last_checked_at`
to a state file (`CRON_CATCHUP_STATE`, new path in `shared/paths.ts`). First-ever
run (no checkpoint): write `now`, replay nothing (no historical backfill).

`lastRunAt(jobId)`: last line of `CRON_RUNS/<jobId>.jsonl`, return its `timestamp`
as ms (any status counts as "fired").

### Wiring

- `scheduler.ts` → `export async function catchUpMissed()`: builds the real
  `runJob` closure from module-held `currentSessionManager/currentConfig/currentConnectors`,
  runs the sweep sequentially, writes the checkpoint. Called fire-and-forget once
  in `startScheduler`.
- `reconciler.ts` → `tickReconciler` calls `void catchUpMissed()` after the
  signature reconcile (the periodic + post-wake hook).
- `runner.ts` → `runCronJob(job, …, meta?)` gains optional
  `meta?: { catchUp?: boolean; scheduledFor?: string; olderFiresSkipped?: number }`,
  threaded into the `appendRunLog` entry. One-shots self-disable via their own
  prompt as before.
- `shared/types.ts` → `CronJob` gains optional `catchUp?: boolean`.

### Defaults

`maxLookbackMs = 72h`, `graceMs = 90s`, `dedupSlopMs = 60s`. Sweep cadence =
existing 5-min reconciler interval.

## Testing (TDD, no live timers)

Unit-test `computeMissedFires` with injected `now/lastCheck/lastRunAt`:
- on-time fire already logged → no replay (no double-fire)
- slept-through fire (lastRun before prevFire) → replay once, scheduledFor = prevFire
- already caught up (lastRun after prevFire) → skip
- too old (prevFire < now - maxLookback) → skip + warn
- too fresh (prevFire > now - grace) → skip
- `catchUp: false` → skip
- disabled / invalid schedule → skip
- multiple jobs mixed → only the missed eligible ones returned
- `olderFiresSkipped` counts in-window extra occurrences
Checkpoint round-trip read/write.

## Out of scope

- Preventing sleep (not reliably possible for clamshell-on-battery).
- Changing awake-operation fire semantics.
- Backfilling more than the latest occurrence (future per-job opt-in if ever needed).
