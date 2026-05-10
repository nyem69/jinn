import type Database from 'better-sqlite3';
import { applyPendingMigrations } from '../sessions/migrate-runner.js';

/**
 * @deprecated Compat shim. Schema is owned by `applyPendingMigrations`.
 */
export function initEventsSchema(database: Database.Database): void {
  applyPendingMigrations(database);
}

export interface SessionEventRow {
  id: number;
  sessionId: string;
  rootSessionId: string;
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: string;
}

export function rowToSessionEvent(row: Record<string, unknown>): SessionEventRow {
  return {
    id: row.id as number,
    sessionId: row.session_id as string,
    rootSessionId: row.root_session_id as string,
    seq: row.seq as number,
    kind: row.kind as string,
    payload: row.payload ? JSON.parse(row.payload as string) : null,
    createdAt: row.created_at as string,
  };
}
