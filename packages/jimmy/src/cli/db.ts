import type Database from 'better-sqlite3';
import { initDb } from '../sessions/registry.js';
import {
  applyPendingMigrations,
  rollbackTo,
  migrationStatus,
} from '../sessions/migrate-runner.js';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

interface DbCmdOpts {
  db?: Database.Database;
  dir?: string;
  target?: string;
}

function getDb(opts: DbCmdOpts): Database.Database {
  return opts.db ?? initDb();
}

export async function dbApply(opts: DbCmdOpts = {}): Promise<void> {
  const db = getDb(opts);
  const result = applyPendingMigrations(db, opts.dir);
  if (result.applied.length === 0) {
    console.log(`${GREEN}Up to date.${RESET} No pending migrations.`);
    return;
  }
  console.log(`${GREEN}Applied ${result.applied.length} migration(s):${RESET}`);
  for (const v of result.applied) console.log(`  + ${v}`);
}

export async function dbRollback(opts: DbCmdOpts & { target?: string } = {}): Promise<void> {
  const db = getDb(opts);
  const target = opts.target;
  if (!target) {
    console.error(`${RED}Error:${RESET} target version required. Pass __ROLLBACK_ALL__ to revert everything.`);
    process.exitCode = 1;
    return;
  }
  const result = rollbackTo(db, target, opts.dir);
  if (result.rolledBack.length === 0) {
    console.log(`${YELLOW}Nothing to roll back.${RESET} Already at or below ${target}.`);
    return;
  }
  console.log(`${GREEN}Rolled back ${result.rolledBack.length} migration(s):${RESET}`);
  for (const v of result.rolledBack) console.log(`  - ${v}`);
}

export async function dbStatus(opts: DbCmdOpts = {}): Promise<void> {
  const db = getDb(opts);
  const status = migrationStatus(db, opts.dir);

  console.log(`${DIM}Applied (${status.applied.length}):${RESET}`);
  for (const a of status.applied) {
    const drift = status.drifted.includes(a.version) ? ` ${RED}[drifted]${RESET}` : '';
    console.log(`  ${GREEN}OK${RESET} ${a.version} ${DIM}@ ${a.appliedAt}${RESET}${drift}`);
  }

  console.log(`\n${DIM}Pending (${status.pending.length}):${RESET}`);
  for (const p of status.pending) {
    console.log(`  ${YELLOW}.${RESET} ${p.version}`);
  }

  if (status.drifted.length > 0) {
    console.log(`\n${RED}Warning:${RESET} ${status.drifted.length} applied migration(s) have edited source files.`);
  }
}
