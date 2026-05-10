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

/**
 * Frozen list of migrations that comprise the T1A close baseline.
 * The bootstrap detector only fires when at least one of these is missing
 * from schema_migrations on a DB that was previously populated by the
 * legacy in-code DDL path (detected via the T1A.PR1 marker column
 * `sessions.root_session_id`).
 *
 * Future migrations (T1B 0007+) MUST NOT be added here — they should always
 * flow through the normal pending-loop apply path so their up.sql actually
 * runs against the DB.
 */
const BASELINE_VERSIONS = [
  '0001_initial',
  '0002_workspace',
  '0003_lineage',
  '0004_events',
  '0005_checkpoints',
  '0006_handlers_seed',
];

function ensureTrackingTable(db: Database.Database): void {
  db.exec(TRACKING_DDL);
}

/**
 * Detects a DB that was populated by the legacy in-code initDb path:
 * sessions table exists with the T1A.PR1 lineage column (`root_session_id`)
 * AND at least one baseline migration version is missing from schema_migrations.
 *
 * Captures both:
 *   (a) fully untracked legacy DB (zero schema_migrations rows)
 *   (b) partially-tracked legacy DB (some rows from accidental dev runs)
 */
function isLegacyInCodeBootstrap(db: Database.Database): boolean {
  const sessionsExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
    .get();
  if (!sessionsExists) return false;
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));
  // T1A.PR1 marker: present means the lineage migration's ALTERs already happened in-code.
  if (!colNames.has('root_session_id')) return false;

  const trackedRows = db
    .prepare('SELECT version FROM schema_migrations')
    .all() as Array<{ version: string }>;
  const trackedSet = new Set(trackedRows.map(r => r.version));
  const allBaselineTracked = BASELINE_VERSIONS.every(v => trackedSet.has(v));
  if (allBaselineTracked) return false;

  return true;
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

  // Bootstrap path: existing in-code-DDL DB needs all baseline migrations
  // marked applied without re-running them — their ALTERs would fail with
  // duplicate-column errors. INSERT OR IGNORE preserves any already-tracked
  // rows (and their original applied_at timestamps).
  if (isLegacyInCodeBootstrap(db)) {
    const insertRow = db.prepare(
      'INSERT OR IGNORE INTO schema_migrations (version, checksum) VALUES (?, ?)'
    );
    const baselineMigs = all.filter(m => BASELINE_VERSIONS.includes(m.version));
    const tx = db.transaction(() => {
      for (const m of baselineMigs) insertRow.run(m.version, m.checksum);
    });
    tx();
    return { applied: [] };
  }

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
 * Pass the sentinel '__ROLLBACK_ALL__' to roll back everything.
 *
 * Throws if targetVersion is neither the sentinel nor a currently-applied
 * version — guards against typos that would otherwise revert the whole DB.
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

  if (targetVersion !== '__ROLLBACK_ALL__') {
    const appliedSet = new Set(appliedRows.map(r => r.version));
    if (!appliedSet.has(targetVersion)) {
      throw new Error(
        `rollbackTo: unknown target version '${targetVersion}'. ` +
        `Applied: [${[...appliedSet].sort().join(', ')}]. ` +
        `Pass '__ROLLBACK_ALL__' to revert everything.`
      );
    }
  }

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
