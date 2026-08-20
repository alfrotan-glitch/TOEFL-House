import { ensureFinanceAccount } from '../utils/financeAccounts.js';
/**
 * Ensures the fixed Organization → Campus → Branch hierarchy exists.
 *
 * This runs after schema.sql and migrations so it works for:
 *   - fresh databases (seed may also insert the same rows via INSERT OR IGNORE)
 *   - legacy databases upgraded by migration 007
 *   - databases that partially applied hierarchy DDL
 *
 * Fixed constants (product requirement):
 *   Organization: The TOEFL House
 *   Campus:       Kabul Campus / KBL
 *   Branch:       Main Branch / TH-MB-001 / id "1" (FK compatibility)
 */
import type Database from 'better-sqlite3';
import { PAYROLL_ENVELOPES, payrollEnvelopeId } from '../core/finance/category-taxonomy.js';
import { seedFinanceCategoryCatalog } from './financeCategoryCatalog.js';
import { createLogger } from '../core/observability/logger.js';
const log = createLogger('organizationHierarchy');

export const FIXED_ORG_ID = 'org_toefl_house';
export const FIXED_ORG_NAME = 'The TOEFL House';
export const DEFAULT_CAMPUS_ID = 'campus_kbl';
export const DEFAULT_CAMPUS_CODE = 'KBL';
export const DEFAULT_CAMPUS_NAME = 'Kabul Campus';
export const DEFAULT_BRANCH_ID = '1';
export const DEFAULT_BRANCH_CODE = 'TH-MB-001';
export const DEFAULT_BRANCH_NAME = 'Main Branch';
export const DEFAULT_BRANCH_ADDRESS =
  'Dasht-e Barchi, Opposite Jalili Center, Kabul, Afghanistan';
export const DEFAULT_BRANCH_POSTAL = '1016';

/**
 * Safely checks if a table exists in the SQLite database.
 */
function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { ok: number } | undefined;
  return !!row;
}

/**
 * Safely checks if a column exists in a specific table.
 */
function columnExists(db: Database.Database, table: string, column: string): boolean {
  // PRAGMA table_info doesn't support parameterized table names directly,
  // so we validate the table name strictly to prevent SQL injection in DDL.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(`Invalid table name format: ${table}`);
  }
  
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/**
 * Dynamically adds missing columns to the 'branches' table for legacy databases.
 */
function ensureBranchColumns(db: Database.Database): void {
  if (!tableExists(db, 'branches')) return;

  const additions: Array<[string, string]> = [
    ['campus_id', 'TEXT'],
    ['code', 'TEXT'],
    ['address', 'TEXT'],
    ['postal_code', 'TEXT'],
    ['phone', 'TEXT'],
    ['email', 'TEXT'],
    ['description', 'TEXT'],
    ['created_at', "TEXT DEFAULT (datetime('now'))"],
    ['updated_at', "TEXT DEFAULT (datetime('now'))"],
  ];

  for (const [col, typeSql] of additions) {
    if (columnExists(db, 'branches', col)) continue;
    db.exec(`ALTER TABLE branches ADD COLUMN ${col} ${typeSql}`);
  }

  // Create necessary indexes if they don't exist
  db.exec(`CREATE INDEX IF NOT EXISTS idx_branches_campus ON branches(campus_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_branches_active ON branches(is_active)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_branches_code ON branches(code)`);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_code_unique ON branches(code) WHERE code IS NOT NULL`
  );
}

/**
 * Provision the budget lines a branch STRUCTURALLY REQUIRES — nothing more.
 *
 * That is exactly two: the teacher and employee payroll envelopes. Payroll
 * cannot run without one to debit (`pay-salary` answers 500 "…budget line is
 * not configured"), so their absence is a broken branch, not an empty budget.
 *
 * Everything else is created deliberately through `POST /finance/budget-lines`.
 * The taxonomy is complete and organization-wide; the budget is sparse and
 * branch-specific. A branch that never pays a taxi fare should not carry a
 * Taxi & Transportation envelope, and forty-five zero-value rows would make the
 * Budgets screen a catalogue of things nobody spends money on.
 *
 * Idempotent: guarded by NOT EXISTS on (branch_id, payroll_target), so calling
 * it for an already-provisioned branch is a no-op and never disturbs an
 * envelope an operator has renamed or funded.
 */
export function ensureBranchBudgetLines(db: Database.Database, branchId: string): void {
  if (!tableExists(db, 'budget_lines') || !tableExists(db, 'branches')) return;
  // The taxonomy is the foreign-key target for `category_id`, so it must exist
  // before any budget line is written.
  seedFinanceCategoryCatalog(db);

  const columns = new Set(
    (db.prepare('PRAGMA table_info(budget_lines)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  // Migration 079 is what introduces `payroll_target`. On the very first boot of
  // an older database this function can run (through the branch-creation route)
  // before that migration has been applied; provisioning is simply deferred to
  // the post-migration sweep rather than crashing the request.
  if (!columns.has('payroll_target') || !columns.has('category_id')) return;

  const insert = db.prepare(`
    INSERT INTO budget_lines
      (id, name, current_amount, allocated_amount, icon, cost_type, branch_id,
       category_id, sort_order, is_active, payroll_target)
    SELECT ?, ?, 0, 0, ?, ?, ?, ?, ?, 1, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM budget_lines WHERE branch_id = ? AND payroll_target = ?
    )
  `);

  const seed = db.transaction(() => {
    for (const envelope of PAYROLL_ENVELOPES) {
      insert.run(
        payrollEnvelopeId(envelope.target, branchId),
        envelope.name,
        envelope.icon,
        envelope.costType,
        branchId,
        envelope.categoryId,
        envelope.sortOrder,
        envelope.target,
        branchId,
        envelope.target,
      );
    }
  });
  seed();
}

/** Provision every active branch. Runs on boot; idempotent. */
function ensureBudgetLineCatalog(db: Database.Database): void {
  if (!tableExists(db, 'budget_lines') || !tableExists(db, 'branches')) return;
  const branches = db.prepare(`SELECT id FROM branches WHERE is_active = 1`).all() as Array<{ id: string }>;
  for (const branch of branches) ensureBranchBudgetLines(db, branch.id);
}

/**
 * Idempotent: creates missing hierarchy rows and backfills campus linkage.
 * Wrapped in a transaction to ensure database integrity.
 */
export function ensureOrganizationHierarchy(db: Database.Database): void {
  if (!tableExists(db, 'organizations') || !tableExists(db, 'campuses') || !tableExists(db, 'branches')) {
    // schema.sql must run first; if tables are still missing something is wrong upstream
    log.warn('⚠️ Core hierarchy tables (organizations, campuses, branches) are missing. Skipping hierarchy setup.');
    return;
  }

  log.info('🔄 Ensuring organization hierarchy exists...');

  // Wrap the entire operation in a transaction.
  // If any step fails, all changes are rolled back, preventing partial updates.
  const migrate = db.transaction(() => {
    // 1. Ensure columns exist before attempting to insert/update them
    ensureBranchColumns(db);

    // 2. Ensure Organization exists
    db.prepare(
      `INSERT OR IGNORE INTO organizations (id, name) VALUES (?, ?)`
    ).run(FIXED_ORG_ID, FIXED_ORG_NAME);

    db.prepare(`UPDATE organizations SET name = ? WHERE id = ?`).run(FIXED_ORG_NAME, FIXED_ORG_ID);

    // 3. Ensure Campus exists
    db.prepare(
      `INSERT OR IGNORE INTO campuses (
         id, organization_id, name, code, address, postal_code, phone, email, description, is_active
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1)`
    ).run(
      DEFAULT_CAMPUS_ID,
      FIXED_ORG_ID,
      DEFAULT_CAMPUS_NAME,
      DEFAULT_CAMPUS_CODE,
      DEFAULT_BRANCH_ADDRESS,
      DEFAULT_BRANCH_POSTAL,
      'Primary campus of The TOEFL House in Kabul'
    );

    // 4. Ensure Branch exists
    db.prepare(
      `INSERT OR IGNORE INTO branches (
         id, campus_id, name, code, location, address, postal_code, phone, email, description, is_active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1)`
    ).run(
      DEFAULT_BRANCH_ID,
      DEFAULT_CAMPUS_ID,
      DEFAULT_BRANCH_NAME,
      DEFAULT_BRANCH_CODE,
      DEFAULT_BRANCH_ADDRESS,
      DEFAULT_BRANCH_ADDRESS,
      DEFAULT_BRANCH_POSTAL,
      'Main operational branch under Kabul Campus'
    );

    // 5. Backfill / normalize main branch and any branch missing campus/code
    db.prepare(
      `UPDATE branches SET
         campus_id   = COALESCE(campus_id, ?),
         name        = CASE WHEN id = ? THEN ? ELSE name END,
         code        = CASE
                         WHEN id = ? THEN ?
                         WHEN code IS NULL OR TRIM(code) = '' THEN 'TH-BR-' || id
                         ELSE code
                       END,
         address     = CASE
                         WHEN id = ? THEN ?
                         ELSE COALESCE(NULLIF(TRIM(address), ''), location)
                       END,
         location    = CASE
                         WHEN id = ? THEN ?
                         ELSE COALESCE(NULLIF(TRIM(location), ''), address, '')
                       END,
         postal_code = CASE WHEN id = ? THEN ? ELSE postal_code END,
         description = CASE
                         WHEN id = ? THEN COALESCE(description, 'Main operational branch under Kabul Campus')
                         ELSE description
                       END,
         is_active   = COALESCE(is_active, 1),
         updated_at  = datetime('now')
       WHERE id = ? OR campus_id IS NULL OR code IS NULL OR TRIM(COALESCE(code, '')) = ''`
    ).run(
      DEFAULT_CAMPUS_ID,
      DEFAULT_BRANCH_ID,
      DEFAULT_BRANCH_NAME,
      DEFAULT_BRANCH_ID,
      DEFAULT_BRANCH_CODE,
      DEFAULT_BRANCH_ID,
      DEFAULT_BRANCH_ADDRESS,
      DEFAULT_BRANCH_ID,
      DEFAULT_BRANCH_ADDRESS,
      DEFAULT_BRANCH_ID,
      DEFAULT_BRANCH_POSTAL,
      DEFAULT_BRANCH_ID,
      DEFAULT_BRANCH_ID
    );

    // 6. Ensure default branch has a saving account

    // Budget catalog must be seeded after branches exist because migration 003 runs before hierarchy creation on fresh databases.
    // `ensureBudgetLineCatalog` seeds the canonical taxonomy first — budget
    // lines carry a foreign key into it.
    ensureBudgetLineCatalog(db);
  });

  // Execute the transaction safely
  try {
    migrate();
    log.info('✅ Organization hierarchy ensured successfully.');
  } catch (error) {
    log.error('❌ Failed to ensure organization hierarchy:', error);
    throw error; // Re-throw to halt startup if hierarchy fails
  }
}