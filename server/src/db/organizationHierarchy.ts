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
import {
  CANONICAL_CATEGORIES,
  LEGACY_PURPOSE_MAP,
  type BudgetLineMappingStatus,
} from '../core/finance/category-taxonomy.js';
import { seedFinanceCategoryCatalog } from './financeCategoryCatalog.js';

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

interface BudgetLineSeed {
  key: string;
  name: string;
  icon: string;
  costType: 'fixed' | 'variable';
  purpose: string;
  marketing?: boolean;
  /** Canonical node this envelope belongs to. NULL = could not be decided. */
  categoryId: string | null;
  mappingStatus: BudgetLineMappingStatus;
  sortOrder: number;
}

/**
 * The legacy catalogue, preserved verbatim.
 *
 * These 17 purposes are load-bearing: payroll looks up `teacher_salary` and
 * `employee_salary` by purpose, and every historical ledger row carries one of
 * these strings as its category. They are NOT renamed, NOT merged and NOT
 * deleted — the upgrade attaches each one to the canonical taxonomy instead.
 *
 * `categoryId` / `mappingStatus` are read from the single legacy map so a
 * branch created through the API after the upgrade gets exactly the mapping
 * migration 077 applied to the branches that already existed.
 */
const LEGACY_BUDGET_LINE_ORDER = [
  'teacher_salary', 'employee_salary', 'rent', 'electricity', 'water', 'gas', 'internet',
  'cleaning', 'maintenance', 'printing', 'kitchen', 'misc', 'equipment',
  'marketing', 'transport', 'purchases', 'reserve',
] as const;

const LEGACY_BUDGET_LINE_PRESENTATION: Record<
  (typeof LEGACY_BUDGET_LINE_ORDER)[number],
  { name: string; icon: string; costType: 'fixed' | 'variable'; marketing?: boolean }
> = {
  teacher_salary: { name: 'Teacher Salaries', icon: 'GraduationCap', costType: 'fixed' },
  employee_salary: { name: 'Employee Salaries', icon: 'Users', costType: 'fixed' },
  rent: { name: 'Rent', icon: 'Building2', costType: 'fixed' },
  electricity: { name: 'Electricity', icon: 'Zap', costType: 'fixed' },
  water: { name: 'Water', icon: 'Droplets', costType: 'fixed' },
  gas: { name: 'Gas', icon: 'Flame', costType: 'fixed' },
  internet: { name: 'Internet', icon: 'Wifi', costType: 'fixed' },
  cleaning: { name: 'Cleaning & Hygiene', icon: 'Sparkles', costType: 'fixed' },
  maintenance: { name: 'Maintenance & Repairs', icon: 'Wrench', costType: 'variable' },
  printing: { name: 'Printing', icon: 'Printer', costType: 'variable' },
  kitchen: { name: 'Kitchen & Refreshments', icon: 'Coffee', costType: 'variable' },
  misc: { name: 'Miscellaneous', icon: 'MoreHorizontal', costType: 'variable' },
  equipment: { name: 'Equipment', icon: 'Monitor', costType: 'variable' },
  marketing: { name: 'Marketing', icon: 'Megaphone', costType: 'variable', marketing: true },
  transport: { name: 'Transport', icon: 'Car', costType: 'variable' },
  purchases: { name: 'General Purchases', icon: 'ShoppingCart', costType: 'variable' },
  reserve: { name: 'Reserve', icon: 'ShieldCheck', costType: 'fixed' },
};

const DEFAULT_BUDGET_LINES: BudgetLineSeed[] = LEGACY_BUDGET_LINE_ORDER.map((purpose, index) => {
  const presentation = LEGACY_BUDGET_LINE_PRESENTATION[purpose];
  const mapping = LEGACY_PURPOSE_MAP[purpose];
  return {
    key: purpose,
    name: presentation.name,
    icon: presentation.icon,
    costType: presentation.costType,
    purpose,
    marketing: presentation.marketing,
    categoryId: mapping.categoryId,
    mappingStatus: mapping.status,
    sortOrder: (index + 1) * 10,
  };
});

/**
 * Presentation for the canonical subcategories that have no legacy counterpart.
 *
 * `fixed` here means a contractual, recurring commitment (a lease, a licence, a
 * subscription); `variable` means discretionary or usage-driven. The
 * distinction only feeds the BOS break-even display and is operator-editable
 * through `PUT /finance/budget-lines/:id/classify`, so nothing depends on it
 * being right on day one — but leaving it uniformly wrong would be sloppy.
 */
const CANONICAL_LINE_PRESENTATION: Record<string, { icon: string; costType: 'fixed' | 'variable'; marketing?: boolean }> = {
  sub_staff_benefits: { icon: 'HeartHandshake', costType: 'fixed' },
  sub_staff_training: { icon: 'BookOpenCheck', costType: 'variable' },
  sub_recruitment: { icon: 'UserPlus', costType: 'variable' },
  sub_telephone: { icon: 'Phone', costType: 'fixed' },
  sub_security: { icon: 'ShieldCheck', costType: 'fixed' },
  sub_office_supplies: { icon: 'Package', costType: 'variable' },
  sub_stationery: { icon: 'PenLine', costType: 'variable' },
  sub_postage_courier: { icon: 'Mail', costType: 'variable' },
  sub_software_subscriptions: { icon: 'AppWindow', costType: 'fixed' },
  sub_legal_professional: { icon: 'Scale', costType: 'variable' },
  sub_insurance: { icon: 'ShieldPlus', costType: 'fixed' },
  sub_licenses_permits: { icon: 'BadgeCheck', costType: 'fixed' },
  sub_teaching_materials: { icon: 'NotebookPen', costType: 'variable' },
  sub_books_educational: { icon: 'BookMarked', costType: 'variable' },
  sub_examination_testing: { icon: 'ClipboardCheck', costType: 'variable' },
  sub_student_activities: { icon: 'PartyPopper', costType: 'variable' },
  sub_teacher_training: { icon: 'GraduationCap', costType: 'variable' },
  sub_digital_advertising: { icon: 'MousePointerClick', costType: 'variable', marketing: true },
  sub_traditional_advertising: { icon: 'Newspaper', costType: 'variable', marketing: true },
  sub_promotional_materials: { icon: 'Gift', costType: 'variable', marketing: true },
  sub_fuel: { icon: 'Fuel', costType: 'variable' },
  sub_taxi_transportation: { icon: 'Car', costType: 'variable' },
  sub_delivery_courier: { icon: 'Truck', costType: 'variable' },
  sub_travel_accommodation: { icon: 'Plane', costType: 'variable' },
  sub_bank_payment_fees: { icon: 'Landmark', costType: 'variable' },
  sub_taxes_duties: { icon: 'Receipt', costType: 'fixed' },
  sub_tax_clearance: { icon: 'FileCheck', costType: 'variable' },
  sub_it_equipment: { icon: 'Monitor', costType: 'variable' },
  sub_office_equipment: { icon: 'Printer', costType: 'variable' },
  sub_furniture_fixtures: { icon: 'Armchair', costType: 'variable' },
  sub_vehicles: { icon: 'CarFront', costType: 'variable' },
  sub_other_fixed_assets: { icon: 'Boxes', costType: 'variable' },
  sub_salary_advances: { icon: 'HandCoins', costType: 'variable' },
  sub_refunds: { icon: 'Undo2', costType: 'variable' },
  sub_owner_drawings: { icon: 'Wallet', costType: 'variable' },
  sub_charitable_contributions: { icon: 'HeartHandshake', costType: 'variable' },
};

/** Subcategories already served by a legacy budget line — never duplicated. */
const SUBCATEGORIES_COVERED_BY_LEGACY: ReadonlySet<string> = new Set(
  Object.values(LEGACY_PURPOSE_MAP)
    .filter((m) => m.status === 'mapped' && m.categoryId)
    .map((m) => m.categoryId as string),
);

/**
 * One default budget line per canonical subcategory that the legacy catalogue
 * does not already cover.
 *
 * Without these the taxonomy would be decorative: there would be no envelope to
 * book "Tax Clearance Fees" or "Vehicles" against, so the operator could not
 * record the very spend the model was created to classify. They are created
 * with zero allocation, so they change no balance, no reconciliation figure and
 * no report total until somebody funds one.
 *
 * The purpose IS the canonical subcategory id, so a ledger row written from one
 * of these lines carries a category string the classification authority can
 * resolve directly.
 */
const CANONICAL_BUDGET_LINES: BudgetLineSeed[] = CANONICAL_CATEGORIES.flatMap((category, categoryIndex) =>
  category.children
    .filter((sub) => !SUBCATEGORIES_COVERED_BY_LEGACY.has(sub.id))
    .map((sub, subIndex) => {
      const presentation = CANONICAL_LINE_PRESENTATION[sub.id] ?? { icon: 'Circle', costType: 'variable' as const };
      return {
        key: sub.id,
        name: sub.name,
        icon: presentation.icon,
        costType: presentation.costType,
        purpose: sub.id,
        marketing: presentation.marketing,
        categoryId: sub.id,
        mappingStatus: 'mapped' as BudgetLineMappingStatus,
        // Legacy lines occupy 10..170; canonical lines sort after them, grouped
        // by their category's canonical position.
        sortOrder: 1000 + (categoryIndex + 1) * 100 + (subIndex + 1),
      };
    }),
);

/** The full per-branch catalogue: legacy envelopes plus canonical coverage. */
const BRANCH_BUDGET_LINE_CATALOG: BudgetLineSeed[] = [...DEFAULT_BUDGET_LINES, ...CANONICAL_BUDGET_LINES];

/**
 * Provision the default budget lines for ONE branch.
 *
 * This used to run only as part of the boot-time catalogue sweep, so a branch
 * created through the API had no budget lines until the next restart. The
 * branch looked fine — it had a finance account and accepted students — but
 * payroll failed with "Teacher salary budget line is not configured." and no
 * expense could be charged. Branch creation now calls this directly, so a new
 * branch is fully operational the moment it exists.
 *
 * Idempotent: each insert is guarded by NOT EXISTS on (branch_id, purpose),
 * so calling it for an already-provisioned branch is a no-op.
 */
export function ensureBranchBudgetLines(db: Database.Database, branchId: string): void {
  if (!tableExists(db, 'budget_lines') || !tableExists(db, 'branches')) return;
  // The taxonomy is a foreign key target for `budget_lines.category_id`, so it
  // must exist before any line is written.
  seedFinanceCategoryCatalog(db);
  const insert = budgetLineInsert(db);
  const seed = db.transaction(() => {
    for (const line of BRANCH_BUDGET_LINE_CATALOG) {
      insert.run(
        `budget_${line.key}_${branchId}`,
        line.name,
        line.icon,
        line.costType,
        line.marketing ? 1 : 0,
        line.purpose,
        branchId,
        line.categoryId,
        line.sortOrder,
        line.mappingStatus,
        branchId,
        line.purpose,
      );
    }
  });
  seed();
}

function budgetLineInsert(db: Database.Database) {
  return db.prepare(`
    INSERT INTO budget_lines
      (id, name, current_amount, allocated_amount, icon, cost_type, is_marketing, purpose, branch_id,
       category_id, sort_order, mapping_status, is_active)
    SELECT ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, 1
    WHERE NOT EXISTS (
      SELECT 1 FROM budget_lines WHERE branch_id = ? AND purpose = ?
    )
  `);
}

function ensureBudgetLineCatalog(db: Database.Database): void {
  if (!tableExists(db, 'budget_lines') || !tableExists(db, 'branches')) return;
  seedFinanceCategoryCatalog(db);
  const insert = budgetLineInsert(db);
  const branches = db.prepare(`SELECT id FROM branches WHERE is_active = 1`).all() as Array<{ id: string }>;
  const seed = db.transaction(() => {
    for (const branch of branches) {
      for (const line of BRANCH_BUDGET_LINE_CATALOG) {
        insert.run(
          `budget_${line.key}_${branch.id}`,
          line.name,
          line.icon,
          line.costType,
          line.marketing ? 1 : 0,
          line.purpose,
          branch.id,
          line.categoryId,
          line.sortOrder,
          line.mappingStatus,
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
    // `ensureBudgetLineCatalog` seeds the canonical taxonomy first — budget
    // lines carry a foreign key into it.
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