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
 * it to a database already at this canonical shape is a no-op and startup stays
 * idempotent. It is not a migration mechanism for an incompatible predecessor
 * shape; greenfield reconstruction uses a clean database rebuild.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureOrganizationHierarchy } from './organizationHierarchy.js';
import { setFinanceAccountsDatabase } from '../utils/financeAccounts.js';
import { createLogger } from '../core/observability/logger.js';
import { assertMoney } from '../utils/money.js';
const log = createLogger('connection');

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
// A second process sharing the database file (an operator running a script
// against the live DB) would otherwise surface immediate SQLITE_BUSY 500s
// instead of waiting for the writer. Harmless in the designed
// single-instance deployment; cheap insurance everywhere else.
db.pragma('busy_timeout = 5000');

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
 * Reconciles placement-only schema objects with the current canonical state.
 *
 * SQLite keeps existing CREATE TRIGGER IF NOT EXISTS bodies, so placement
 * triggers that changed in the canonical schema are dropped here and recreated
 * from schema.sql on the same startup. Placement-only objects that are absent
 * from the canonical schema are removed so the active database has one
 * placement authority.
 */
function reconcileCanonicalPlacementState(): void {
  db.exec(`
    DROP TABLE IF EXISTS placement_rules;
    DROP TRIGGER IF EXISTS trg_placement_rule_require_branch;
    DROP TRIGGER IF EXISTS trg_placement_rule_sync_level_code;
    DROP TRIGGER IF EXISTS trg_placement_rule_code_update;
    DROP TRIGGER IF EXISTS trg_placement_test_rubric_scope_insert;
    DROP TRIGGER IF EXISTS trg_placement_test_rubric_scope_update;
    DROP TRIGGER IF EXISTS trg_placement_rubric_kind_scope_update;
    DROP TRIGGER IF EXISTS trg_placement_attempt_scope_insert;
    DROP TRIGGER IF EXISTS trg_placement_attempt_scope_update;
  `);
}

/**
 * Copies retired branch-profile fixed-fee values into the canonical fee-rule
 * registry only when a branch has no explicit rule for that fee type.
 *
 * The branch-profile columns remain storage-only; transactions and reads use
 * the canonical registry. Any non-canonical stored amount is left unresolved so
 * the live fee resolver blocks the charge instead of guessing one.
 */
function ensureInvoiceChargeKindColumn(): void {
  const columns = db.prepare(`PRAGMA table_info(invoices)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'charge_kind')) {
    db.exec(`ALTER TABLE invoices ADD COLUMN charge_kind TEXT`);
  }
}

function reconcileCanonicalFeeAuthority(): void {
  const rows = db.prepare(`
    SELECT branch_id, placement_test_fee, registration_fee, card_fee, diploma_fee
      FROM branch_academic_profiles
  `).all() as Array<{
    branch_id: string;
    placement_test_fee: unknown;
    registration_fee: unknown;
    card_fee: unknown;
    diploma_fee: unknown;
  }>;
  const hasRule = db.prepare('SELECT 1 FROM fee_rules WHERE branch_id = ? AND fee_type = ? LIMIT 1');
  const insertRule = db.prepare(`
    INSERT INTO fee_rules
      (id, branch_id, fee_type, name, amount, currency, is_optional, effective_from, effective_to, version, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, 'AFN', 0, NULL, NULL, 1, 1, datetime('now'))
  `);
  const sanitize = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
  const nameByType = {
    placement: 'Placement test fee',
    registration: 'Registration fee',
    card: 'ID card fee',
    diploma: 'Diploma fee',
  } as const;
  const tx = db.transaction(() => {
    for (const row of rows) {
      for (const [feeType, rawAmount] of [
        ['placement', row.placement_test_fee],
        ['registration', row.registration_fee],
        ['card', row.card_fee],
        ['diploma', row.diploma_fee],
      ] as const) {
        if (hasRule.get(row.branch_id, feeType)) continue;
        try {
          const amount = assertMoney(rawAmount ?? 0, `Retired ${feeType} fee storage`);
          insertRule.run(
            `legacy_fee_${sanitize(row.branch_id)}_${feeType}`,
            row.branch_id,
            feeType,
            nameByType[feeType],
            amount,
          );
        } catch {
          // Skip any non-canonical stored amount so live charge resolution must
          // stop instead of inventing a fee.
        }
      }
    }
  });
  tx();
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
    reconcileCanonicalPlacementState();
    db.exec(schema);
    ensureInvoiceChargeKindColumn();
    reconcileCanonicalFeeAuthority();
  } catch (error) {
    log.error('Failed to apply the canonical schema.');
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
