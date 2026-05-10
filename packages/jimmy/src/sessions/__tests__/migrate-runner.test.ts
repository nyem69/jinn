import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyPendingMigrations,
  rollbackTo,
  migrationStatus,
  listMigrationFiles,
} from '../migrate-runner.js';

const MIGRATIONS_DIR = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../../migrations'
);

describe('migrate-runner', () => {
  let db: Database.Database;
  const tmpDirsToCleanup: string[] = [];

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    for (const dir of tmpDirsToCleanup.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates schema_migrations table on first call', () => {
    applyPendingMigrations(db, MIGRATIONS_DIR);
    const cols = db.prepare('PRAGMA table_info(schema_migrations)').all() as Array<{ name: string }>;
    expect(cols.map(c => c.name).sort()).toEqual(['applied_at', 'checksum', 'version']);
  });

  it('applies all pending migrations in order on a fresh db', () => {
    applyPendingMigrations(db, MIGRATIONS_DIR);
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows[0].version).toBe('0001_initial');
  });

  it('produces the expected tables after a fresh apply', () => {
    applyPendingMigrations(db, MIGRATIONS_DIR);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    for (const expected of [
      'sessions', 'messages', 'files',
      'queue_items', 'goals', 'budget_events', 'episode_candidates',
      'session_events', 'event_handlers', 'event_dlq',
      'session_checkpoints',
      'schema_migrations',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('is idempotent — second call applies zero migrations', () => {
    applyPendingMigrations(db, MIGRATIONS_DIR);
    const before = db.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as { c: number };
    applyPendingMigrations(db, MIGRATIONS_DIR);
    const after = db.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it('rolls back to a target version', () => {
    applyPendingMigrations(db, MIGRATIONS_DIR);
    rollbackTo(db, '0004_events', MIGRATIONS_DIR);
    const remaining = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: string }>;
    expect(remaining.map(r => r.version)).toEqual(['0001_initial', '0002_workspace', '0003_lineage', '0004_events']);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_checkpoints'").all();
    expect(tables.length).toBe(0);
  });

  it('up-down-up roundtrip leaves the schema identical', () => {
    applyPendingMigrations(db, MIGRATIONS_DIR);
    const before = db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    rollbackTo(db, '0001_initial', MIGRATIONS_DIR);
    applyPendingMigrations(db, MIGRATIONS_DIR);
    const after = db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    expect(after).toEqual(before);
  });

  it('migrationStatus returns applied + pending split', () => {
    const beforeStatus = migrationStatus(db, MIGRATIONS_DIR);
    expect(beforeStatus.applied.length).toBe(0);
    expect(beforeStatus.pending.length).toBeGreaterThanOrEqual(6);

    applyPendingMigrations(db, MIGRATIONS_DIR);
    const afterStatus = migrationStatus(db, MIGRATIONS_DIR);
    expect(afterStatus.pending.length).toBe(0);
    expect(afterStatus.applied.length).toBeGreaterThanOrEqual(6);
  });

  it('detects checksum drift on applied migrations', () => {
    applyPendingMigrations(db, MIGRATIONS_DIR);
    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run('TAMPERED', '0001_initial');
    const status = migrationStatus(db, MIGRATIONS_DIR);
    expect(status.drifted).toContain('0001_initial');
  });

  it('rolls back the entire transaction if a migration fails midway', () => {
    const bogusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    tmpDirsToCleanup.push(bogusDir);
    fs.writeFileSync(path.join(bogusDir, '0001_ok.up.sql'),     'CREATE TABLE ok (id INTEGER);');
    fs.writeFileSync(path.join(bogusDir, '0001_ok.down.sql'),   'DROP TABLE ok;');
    fs.writeFileSync(path.join(bogusDir, '0002_bad.up.sql'),    'CREATE TABLE bad (id INTEGER); CREATE TABLE bad (id INTEGER);');
    fs.writeFileSync(path.join(bogusDir, '0002_bad.down.sql'),  'DROP TABLE IF EXISTS bad;');

    expect(() => applyPendingMigrations(db, bogusDir)).toThrow(/0002_bad/);
    const applied = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>;
    expect(applied.map(a => a.version)).toEqual(['0001_ok']);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='bad'").all().length).toBe(0);
  });

  it('every up-file has a sibling down-file', () => {
    const all = listMigrationFiles(MIGRATIONS_DIR);
    for (const m of all) {
      expect(fs.existsSync(m.downPath)).toBe(true);
    }
  });

  it('throws on unknown target version (typo guard)', () => {
    applyPendingMigrations(db, MIGRATIONS_DIR);
    expect(() => rollbackTo(db, '0004_event', MIGRATIONS_DIR)).toThrow(/unknown target version/);
    expect(() => rollbackTo(db, 'nonexistent', MIGRATIONS_DIR)).toThrow(/unknown target version/);
    // Sentinel still works
    expect(() => rollbackTo(db, '__ROLLBACK_ALL__', MIGRATIONS_DIR)).not.toThrow();
  });

  it('full down sequence empties the schema (except tracking table)', () => {
    applyPendingMigrations(db, MIGRATIONS_DIR);
    rollbackTo(db, '__ROLLBACK_ALL__', MIGRATIONS_DIR);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    expect(tables.map(t => t.name)).toEqual(['schema_migrations']);
  });
});
