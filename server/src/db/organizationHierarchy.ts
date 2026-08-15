import { ensureFinanceAccount } from '../utils/financeAccounts.js';
// LEGACY_COMPAT_ONLY: saving_accounts remains only for migration/backward compatibility. Runtime uses finance_accounts.
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

const DEFAULT_BUDGET_LINES: Array<{
  key: string;
  name: string;
  icon: string;
  costType: 'fixed' | 'variable';
  purpose: string;
  marketing?: boolean;
}> = [
  { key: 'teacher_salary', name: 'Teacher Salaries', icon: 'GraduationCap', costType: 'fixed', purpose: 'teacher_salary' },
  { key: 'employee_salary', name: 'Employee Salaries', icon: 'Users', costType: 'fixed', purpose: 'employee_salary' },
  { key: 'rent', name: 'Rent', icon: 'Building2', costType: 'fixed', purpose: 'rent' },
  { key: 'electricity', name: 'Electricity', icon: 'Zap', costType: 'fixed', purpose: 'electricity' },
  { key: 'internet', name: 'Internet', icon: 'Wifi', costType: 'fixed', purpose: 'internet' },
  { key: 'marketing', name: 'Marketing', icon: 'Megaphone', costType: 'variable', purpose: 'marketing', marketing: true },
  { key: 'printing', name: 'Printing', icon: 'Printer', costType: 'variable', purpose: 'printing' },
  { key: 'equipment', name: 'Equipment', icon: 'Monitor', costType: 'variable', purpose: 'equipment' },
  { key: 'kitchen', name: 'Kitchen & Refreshments', icon: 'Coffee', costType: 'variable', purpose: 'kitchen' },
  { key: 'reserve', name: 'Reserve', icon: 'ShieldCheck', costType: 'fixed', purpose: 'reserve' },
  { key: 'water', name: 'Water', icon: 'Droplets', costType: 'fixed', purpose: 'water' },
  { key: 'gas', name: 'Gas', icon: 'Flame', costType: 'fixed', purpose: 'gas' },
  { key: 'maintenance', name: 'Maintenance & Repairs', icon: 'Wrench', costType: 'variable', purpose: 'maintenance' },
  { key: 'purchases', name: 'General Purchases', icon: 'ShoppingCart', costType: 'variable', purpose: 'purchases' },
  { key: 'cleaning', name: 'Cleaning & Hygiene', icon: 'Sparkles', costType: 'fixed', purpose: 'cleaning' },
  { key: 'transport', name: 'Transport', icon: 'Car', costType: 'variable', purpose: 'transport' },
  { key: 'misc', name: 'Miscellaneous', icon: 'MoreHorizontal', costType: 'variable', purpose: 'misc' },
];

function ensureBudgetLineCatalog(db: Database.Database): void {
  if (!tableExists(db, 'budget_lines') || !tableExists(db, 'branches')) return;
  const insert = db.prepare(`
    INSERT INTO budget_lines
      (id, name, current_amount, allocated_amount, icon, cost_type, is_marketing, purpose, branch_id)
    SELECT ?, ?, 0, 0, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM budget_lines WHERE branch_id = ? AND purpose = ?
    )
  `);
  const branches = db.prepare(`SELECT id FROM branches WHERE is_active = 1`).all() as Array<{ id: string }>;
  const seed = db.transaction(() => {
    for (const branch of branches) {
      for (const line of DEFAULT_BUDGET_LINES) {
        insert.run(
          `budget_${line.key}_${branch.id}`,
          line.name,
          line.icon,
          line.costType,
          line.marketing ? 1 : 0,
          line.purpose,
          branch.id,
          branch.id,
          line.purpose,
        );
      }
    }
  });
  seed();
}

/**
 * Idempotent: creates missing hierarchy rows and backfills campus linkage.
 * Wrapped in a transaction to ensure database integrity.
 */
export function ensureOrganizationHierarchy(db: Database.Database): void {
  if (!tableExists(db, 'organizations') || !tableExists(db, 'campuses') || !tableExists(db, 'branches')) {
    // schema.sql must run first; if tables are still missing something is wrong upstream
    console.warn('⚠️ Core hierarchy tables (organizations, campuses, branches) are missing. Skipping hierarchy setup.');
    return;
  }

  console.log('🔄 Ensuring organization hierarchy exists...');

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
    if (tableExists(db, 'saving_accounts')) {
      db.prepare(
        `INSERT OR IGNORE INTO saving_accounts (branch_id, balance) VALUES (?, 0)`
      ).run(DEFAULT_BRANCH_ID);
      ensureFinanceAccount('branch', DEFAULT_BRANCH_ID);
    }

    // Budget catalog must be seeded after branches exist because migration 003 runs before hierarchy creation on fresh databases.
    ensureBudgetLineCatalog(db);
  });

  // Execute the transaction safely
  try {
    migrate();
    console.log('✅ Organization hierarchy ensured successfully.');
  } catch (error) {
    console.error('❌ Failed to ensure organization hierarchy:', error);
    throw error; // Re-throw to halt startup if hierarchy fails
  }
}