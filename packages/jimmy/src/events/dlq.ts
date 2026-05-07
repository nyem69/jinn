import type Database from 'better-sqlite3';

// T1A.PR2.D: dead-letter queue helpers.
//
// recordDlqFailure inserts a failure row and triggers auto-disable when
// the same handler has produced 5 consecutive same-error DLQ entries.
// "Same-error" is exact string equality on the error column — coarse
// but sufficient for catching deterministic faults (typos, missing
// columns, misconfigured paths). Transient errors (network blips) drop
// out of the window naturally as later runs differ.

export interface DlqInsertResult {
  dlqId: number;
  autoDisabled: boolean;
}

export function recordDlqFailure(
  db: Database.Database,
  handlerId: number,
  eventId: number,
  error: string,
): DlqInsertResult {
  const info = db
    .prepare('INSERT INTO event_dlq (event_id, handler_id, error) VALUES (?, ?, ?)')
    .run(eventId, handlerId, error);
  const dlqId = Number(info.lastInsertRowid);

  const recent = db
    .prepare('SELECT error FROM event_dlq WHERE handler_id = ? ORDER BY id DESC LIMIT 5')
    .all(handlerId) as Array<{ error: string }>;

  let autoDisabled = false;
  if (recent.length === 5 && recent.every((r) => r.error === error)) {
    db.prepare("UPDATE event_handlers SET status = 'disabled' WHERE id = ?").run(handlerId);
    autoDisabled = true;
  }

  return { dlqId, autoDisabled };
}

// Active DLQ depth = unretried failures currently queued. dlq_alert
// uses this to decide whether to fire.
export function activeDlqDepth(db: Database.Database): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM event_dlq WHERE retried_at IS NULL')
    .get() as { n: number };
  return row.n;
}

// Mark a DLQ row as retried (caller is responsible for actually
// re-running the handler logic; this just stamps the row so
// activeDlqDepth excludes it).
export function markDlqRetried(db: Database.Database, dlqId: number): void {
  db.prepare("UPDATE event_dlq SET retried_at = datetime('now') WHERE id = ?").run(dlqId);
}
