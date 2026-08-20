import type BetterSqlite3 from 'better-sqlite3';
/**
 * SQLite connection and canonical database initialization.
 *
 * There is no migration chain. `schema.sql` is the single canonical
 * representation of the database, and initialization is:
 *
 *   EMPTY DATABASE -> CANONICAL SCHEMA -> ORGANIZATION HIERARCHY -> READY
 *
 * The schema is written with CREATE ... IF NOT EXISTS throughout, so applying
 * it to an already-initialized database is a no-op and startup stays
 * idempotent. Schema changes are made by editing schema.sql.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureOrganizationHierarchy } from './organizationHierarchy.js';
import { setFinanceAccountsDatabase } from '../utils/financeAccounts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH || './data/erp.sqlite';

// Ensure the directory for the SQLite file exists
const dbDir = path.dirname(DB_PATH);
if (dbDir && dbDir !== '.' && !fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db: BetterSqlite3.Database = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Verifies the database matches the canonical schema and is internally sound.
 *
 * Applying the schema is not by itself proof that the result is usable: a
 * database that predates a schema edit satisfies every `IF NOT EXISTS` while
 * still missing the new column, and the failure would otherwise surface much
 * later as a prepared-statement error on an unrelated route. Checking here
 * fails fast, at startup, with the reason.
 */
function verifyCanonicalState(): void {
  const integrity = db.pragma('integrity_check', { simple: true }) as string;
  if (integrity !== 'ok') {
    throw new Error(`SQLite integrity_check failed: ${integrity}`);
  }

  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(`SQLite foreign_key_check failed with ${violations.length} violation(s)`);
  }
}

/**
 * Applies the canonical schema, then the organization hierarchy defaults.
 * Safe on every process start (fresh or existing database).
 */
export function initSchema(): void {
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`schema.sql not found at ${schemaPath}`);
  }

  const schema = fs.readFileSync(schemaPath, 'utf-8');

  // PRAGMA foreign_keys must be set OUTSIDE a transaction in SQLite, and the
  // canonical schema declares tables in domain order rather than dependency
  // order, so constraint checking is suspended while the shape is created.
  db.pragma('foreign_keys = OFF');

  try {
    db.exec(schema);
  } catch (error) {
    console.error('Failed to apply the canonical schema.');
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
  }

  verifyCanonicalState();

  setFinanceAccountsDatabase(db);
  ensureOrganizationHierarchy(db);
}

// Initialization runs at import time so that tables exist BEFORE any other
// module prepares a statement during import hoisting.
initSchema();
