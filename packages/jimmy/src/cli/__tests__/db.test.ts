import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { dbApply, dbRollback, dbStatus } from '../db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../../migrations'
);

describe('cli/db', () => {
  let db: Database.Database;
  let logs: string[];

  beforeEach(() => {
    db = new Database(':memory:');
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  it('dbApply applies pending migrations and reports count', async () => {
    await dbApply({ db, dir: MIGRATIONS_DIR });
    expect(logs.some(l => l.includes('Applied'))).toBe(true);
    const count = (db.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as { c: number }).c;
    expect(count).toBeGreaterThanOrEqual(6);
  });

  it('dbStatus prints applied and pending sections', async () => {
    await dbStatus({ db, dir: MIGRATIONS_DIR });
    const joined = logs.join('\n');
    expect(joined).toMatch(/Applied/);
    expect(joined).toMatch(/Pending/);
  });

  it('dbRollback reverts to the target version', async () => {
    await dbApply({ db, dir: MIGRATIONS_DIR });
    await dbRollback({ db, dir: MIGRATIONS_DIR, target: '0004_events' });
    const remaining = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: string }>;
    expect(remaining.map(r => r.version)).toEqual(['0001_initial', '0002_workspace', '0003_lineage', '0004_events']);
  });
});
