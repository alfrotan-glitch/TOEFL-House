import type BetterSqlite3 from 'better-sqlite3';
/**
 * SQLite connection and schema bootstrap for TOEFL House ERP.
 *
 * Boot order:
 *   1. schema.sql — CREATE TABLE IF NOT EXISTS (full current shape)
 *   2. migrations — additive changes for legacy databases
 *   3. organization hierarchy defaults
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrate.js';
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
 * Applies schema.sql idempotently, then migrations, then hierarchy seed.
 * Safe on every process start (fresh or existing database).
 */
export function initSchema(): void {
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`schema.sql not found at ${schemaPath}`);
  }

  const schema = fs.readFileSync(schemaPath, 'utf-8');

  // PRAGMA foreign_keys must be set OUTSIDE a transaction in SQLite
  db.pragma('foreign_keys = OFF');
  
  try {
    console.log('Applying schema.sql...');
    // Since schema.sql uses "IF NOT EXISTS" everywhere, we don't need a custom parser 
    // or benign error checking.
    db.exec(schema);
    console.log('✅ Schema.sql applied successfully.');
    
  } catch (error) {
    console.error('❌ Failed to apply schema.sql.');
    throw error;
  } finally {
    // Always re-enable foreign keys after schema application
    db.pragma('foreign_keys = ON');
  }

  // Run additive migrations for legacy databases
  runMigrations(db);
  
  // Ensure default organization/campus/branch hierarchy exists
  setFinanceAccountsDatabase(db);
  ensureOrganizationHierarchy(db);
}

// ============================================================================
// ============================================================================
// This ensures that tables exist BEFORE any other module (like settings.ts)
// tries to run db.prepare() at the module level during import hoisting.
initSchema();