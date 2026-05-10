import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

export interface MigrationFile {
  version: string;
  upPath: string;
  downPath: string;
  checksum: string;
}

export interface MigrationStatus {
  applied: Array<{ version: string; appliedAt: string; checksum: string }>;
  pending: MigrationFile[];
  drifted: string[];
}

const DEFAULT_MIGRATIONS_DIR = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../migrations'
);

const TRACKING_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    checksum   TEXT NOT NULL
  )
`;

function ensureTrackingTable(db: Database.Database): void {
  db.exec(TRACKING_DDL);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function listMigrationFiles(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir).filter(f => f.endsWith('.up.sql')).sort();
  return entries.map(filename => {
    const version = filename.replace(/\.up\.sql$/, '');
    const upPath = path.join(dir, filename);
    const downPath = path.join(dir, `${version}.down.sql`);
    if (!fs.existsSync(downPath)) {
      throw new Error(`migration ${version}: missing companion .down.sql at ${downPath}`);
    }
    const checksum = sha256(fs.readFileSync(upPath, 'utf8'));
    return { version, upPath, downPath, checksum };
  });
}

export function applyPendingMigrations(
  db: Database.Database,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): { applied: string[] } {
  ensureTrackingTable(db);

  const all = listMigrationFiles(dir);
  const appliedRows = db
    .prepare('SELECT version FROM schema_migrations')
    .all() as Array<{ version: string }>;
  const appliedSet = new Set(appliedRows.map(r => r.version));
  const pending = all.filter(m => !appliedSet.has(m.version));

  const applied: string[] = [];
  const insertRow = db.prepare(
    'INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)'
  );

  for (const mig of pending) {
    const sql = fs.readFileSync(mig.upPath, 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      insertRow.run(mig.version, mig.checksum);
    });
    try {
      tx();
      applied.push(mig.version);
    } catch (err: any) {
      throw new Error(
        `migration ${mig.version} failed: ${err.message ?? String(err)}`
      );
    }
  }

  return { applied };
}

/**
 * Roll back to (and including) the migration AFTER targetVersion.
 * I.e. all migrations strictly newer than targetVersion are reverted.
 * Pass any unmatched string (e.g. '__ROLLBACK_ALL__') to roll back everything.
 */
export function rollbackTo(
  db: Database.Database,
  targetVersion: string,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): { rolledBack: string[] } {
  ensureTrackingTable(db);

  const appliedRows = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version DESC')
    .all() as Array<{ version: string }>;

  const rolledBack: string[] = [];
  const deleteRow = db.prepare('DELETE FROM schema_migrations WHERE version = ?');

  for (const row of appliedRows) {
    if (row.version === targetVersion) break;
    const downPath = path.join(dir, `${row.version}.down.sql`);
    if (!fs.existsSync(downPath)) {
      throw new Error(`rollback ${row.version}: missing ${downPath}`);
    }
    const sql = fs.readFileSync(downPath, 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      deleteRow.run(row.version);
    });
    tx();
    rolledBack.push(row.version);
  }

  return { rolledBack };
}

export function migrationStatus(
  db: Database.Database,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): MigrationStatus {
  ensureTrackingTable(db);
  const all = listMigrationFiles(dir);
  const appliedMap = new Map<string, { appliedAt: string; checksum: string }>();
  const rows = db
    .prepare('SELECT version, applied_at, checksum FROM schema_migrations')
    .all() as Array<{ version: string; applied_at: string; checksum: string }>;
  for (const r of rows) {
    appliedMap.set(r.version, { appliedAt: r.applied_at, checksum: r.checksum });
  }
  const drifted: string[] = [];
  for (const m of all) {
    const a = appliedMap.get(m.version);
    if (a && a.checksum !== m.checksum) drifted.push(m.version);
  }
  return {
    applied: rows.map(r => ({ version: r.version, appliedAt: r.applied_at, checksum: r.checksum })),
    pending: all.filter(m => !appliedMap.has(m.version)),
    drifted,
  };
}
