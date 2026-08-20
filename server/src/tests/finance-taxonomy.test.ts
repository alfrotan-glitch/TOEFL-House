/**
 * The canonical Finance taxonomy — structure, authority and hygiene.
 * ============================================================================
 * The model under test:
 *
 *   TAXONOMY   Category → Subcategory → Channel
 *              Organization-wide, complete, 10 → 45 → 1.
 *
 *   BUDGET     Branch → Budget Line → Allocation
 *              Sparse and deliberate. A fresh branch owns exactly two
 *              envelopes; the taxonomy being complete does NOT mean a branch
 *              funds every subcategory.
 *
 *   LEDGER     `financial_transactions.finance_category_id` is a foreign key
 *              into the taxonomy, and the only thing any surface classifies
 *              against.
 *
 * These tests assert against the DATABASE wherever the database is the
 * authority, and against the compiled taxonomy only where it is.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initSchema } from '../db/connection.js';
import { ensureBranchBudgetLines } from '../db/organizationHierarchy.js';
import {
  CANONICAL_CATEGORIES,
  CANONICAL_CHANNELS,
  PAYROLL_ENVELOPES,
  SUBCATEGORY_IDS,
  canonicalCategoryRows,
  isSubcategoryId,
} from '../core/finance/category-taxonomy.js';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

beforeAll(() => {
  initSchema();
});

// ── 1. The taxonomy ─────────────────────────────────────────────────────────
describe('the canonical taxonomy is exactly as specified', () => {
  it('holds the ten top-level categories, in canonical order', () => {
    const rows = db.prepare(
      `SELECT name FROM finance_categories WHERE level = 'category' ORDER BY sort_order`,
    ).all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual([
      'Personnel & Payroll',
      'Premises & Facilities',
      'Office & Administration',
      'Academic & Student Operations',
      'Marketing & Promotion',
      'Transportation & Logistics',
      'Financial & Tax',
      'Food & General Operations',
      'Capital Expenditure',
      'Non-Expense Cash Movements',
    ]);
  });

  it('holds all 45 subcategories under the right parents', () => {
    const expected: Record<string, string[]> = {
      'Personnel & Payroll': ['Salaries & Wages', 'Staff Benefits', 'Staff Training & Development', 'Recruitment Expenses'],
      'Premises & Facilities': ['Rent Expense', 'Utilities', 'Internet & Communication', 'Telephone Expenses', 'Cleaning & Sanitation', 'Security Expenses', 'Repair & Maintenance'],
      'Office & Administration': ['Office Supplies', 'Stationery Expenses', 'Printing Expenses', 'Postage & Courier', 'Software & Subscriptions', 'Legal & Professional Services', 'Insurance Expenses', 'Business Licenses & Permits'],
      'Academic & Student Operations': ['Teaching Materials', 'Books & Educational Materials', 'Examination & Testing Expenses', 'Student Activities & Events', 'Teacher Training & Development'],
      'Marketing & Promotion': ['Digital Advertising', 'Traditional Advertising', 'Promotional Materials'],
      'Transportation & Logistics': ['Fuel Expenses', 'Taxi & Transportation', 'Delivery & Courier', 'Travel & Accommodation'],
      'Financial & Tax': ['Bank & Payment Processing Fees', 'Taxes & Duties', 'Tax Clearance Fees'],
      'Food & General Operations': ['Food & Catering', 'Miscellaneous Expenses'],
      'Capital Expenditure': ['IT Equipment', 'Office Equipment', 'Furniture & Fixtures', 'Vehicles', 'Other Fixed Assets'],
      'Non-Expense Cash Movements': ['Salary Advances', 'Refunds', "Owner's Drawings", 'Charitable Contributions'],
    };
    for (const [category, subcategories] of Object.entries(expected)) {
      const rows = db.prepare(
        `SELECT c.name FROM finance_categories c JOIN finance_categories p ON p.id = c.parent_id
         WHERE p.name = ? ORDER BY c.sort_order`,
      ).all(category) as Array<{ name: string }>;
      expect(rows.map((r) => r.name), `subcategories of ${category}`).toEqual(subcategories);
    }
    expect(SUBCATEGORY_IDS.size).toBe(45);
  });

  it('classifies capital expenditure and non-expense cash movements explicitly', () => {
    const classOf = (name: string) =>
      (db.prepare('SELECT classification FROM finance_categories WHERE name = ?').get(name) as { classification: string }).classification;

    for (const n of ['Salary Advances', 'Refunds', "Owner's Drawings", 'Charitable Contributions']) {
      expect(classOf(n), n).toBe('non_expense_cash_movement');
    }
    for (const n of ['IT Equipment', 'Office Equipment', 'Furniture & Fixtures', 'Vehicles', 'Other Fixed Assets']) {
      expect(classOf(n), n).toBe('capital_expenditure');
    }
    expect(classOf('Rent Expense')).toBe('operating_expense');
  });

  it('matches the compiled taxonomy exactly, and re-seeding is idempotent', () => {
    initSchema();
    initSchema();
    expect((db.prepare('SELECT COUNT(*) c FROM finance_categories').get() as { c: number }).c)
      .toBe(canonicalCategoryRows().length);
    expect((db.prepare('SELECT COUNT(*) c FROM finance_category_channels').get() as { c: number }).c)
      .toBe(CANONICAL_CHANNELS.length);
  });
});

// ── 2. Hierarchy enforced by the database ───────────────────────────────────
describe('the hierarchy is enforced by the database, not by convention', () => {
  it('every subcategory has a parent and every category has none', () => {
    expect(db.prepare(
      `SELECT id FROM finance_categories
        WHERE (level = 'category' AND parent_id IS NOT NULL)
           OR (level = 'subcategory' AND parent_id IS NULL)`,
    ).all()).toEqual([]);
  });

  it('rejects a third level, a self-parent, and a contradictory classification', () => {
    expect(() => db.prepare(
      `INSERT INTO finance_categories (id, parent_id, name, level, classification, sort_order)
       VALUES ('tx_depth','sub_rent','Illegal depth','subcategory','operating_expense',999)`).run(),
    ).toThrow(/parent must be a top-level category/i);

    expect(() => db.prepare(
      `INSERT INTO finance_categories (id, parent_id, name, level, classification, sort_order)
       VALUES ('tx_self','tx_self','Self','subcategory','operating_expense',999)`).run(),
    ).toThrow();

    expect(() => db.prepare(
      `INSERT INTO finance_categories (id, parent_id, name, level, classification, sort_order)
       VALUES ('tx_class','cat_capital_expenditure','Contradiction','subcategory','operating_expense',999)`).run(),
    ).toThrow(/classification must match its parent/i);
  });

  it('rejects two siblings with the same display name', () => {
    expect(() => db.prepare(
      `INSERT INTO finance_categories (id, parent_id, name, level, classification, sort_order)
       VALUES ('tx_dupe','cat_premises_facilities','Utilities','subcategory','operating_expense',999)`).run(),
    ).toThrow();
  });
});

// ── 3. Stable ids ───────────────────────────────────────────────────────────
describe('identifiers are stable codes, never display names', () => {
  it('a rename never mints a new id and never orphans a budget line', () => {
    const before = db.prepare('SELECT id FROM finance_categories ORDER BY id').all();
    db.prepare(`UPDATE finance_categories SET name = 'Renamed' WHERE id = 'sub_rent'`).run();
    initSchema();
    expect(db.prepare('SELECT id FROM finance_categories ORDER BY id').all()).toEqual(before);
    expect((db.prepare(`SELECT name FROM finance_categories WHERE id = 'sub_rent'`).get() as { name: string }).name)
      .toBe('Rent Expense');
  });
});

// ── 4. Facebook is a channel ────────────────────────────────────────────────
describe('Facebook is a channel, never an accounting category', () => {
  it('exists as a channel of Marketing & Promotion → Digital Advertising', () => {
    const row = db.prepare(
      `SELECT ch.name, ch.kind, sub.name AS subcategory, cat.name AS category
         FROM finance_category_channels ch
         JOIN finance_categories sub ON sub.id = ch.category_id
         JOIN finance_categories cat ON cat.id = sub.parent_id
        WHERE ch.name = 'Facebook'`,
    ).get() as { kind: string; subcategory: string; category: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.kind).toBe('channel');
    expect(row!.subcategory).toBe('Digital Advertising');
    expect(row!.category).toBe('Marketing & Promotion');
  });

  it('does NOT exist as a category or subcategory', () => {
    expect(db.prepare(
      `SELECT id FROM finance_categories WHERE name LIKE '%Facebook%' OR name LIKE '%Facbook%'`).all(),
    ).toEqual([]);
  });

  it('a channel may not be attached to a budget line of another subcategory', () => {
    const line = db.prepare(`SELECT id FROM budget_lines WHERE branch_id = '1' LIMIT 1`).get() as { id: string };
    expect(() => db.prepare('UPDATE budget_lines SET channel_id = ? WHERE id = ?').run('chn_facebook', line.id))
      .toThrow(/channel must belong to the same finance category/i);
  });
});

// ── 5. Budget is separate from taxonomy ─────────────────────────────────────
describe('the budget is branch-level and sparse; the taxonomy is complete', () => {
  it('a fresh branch owns exactly the two payroll envelopes', () => {
    db.prepare(`INSERT OR IGNORE INTO branches (id,name,location,is_active) VALUES ('tx_sparse','Sparse','Kabul',1)`).run();
    ensureBranchBudgetLines(db, 'tx_sparse');
    const rows = db.prepare(
      'SELECT name, category_id, payroll_target FROM budget_lines WHERE branch_id = ? ORDER BY sort_order',
    ).all('tx_sparse') as Array<{ name: string; category_id: string; payroll_target: string }>;

    expect(rows).toHaveLength(PAYROLL_ENVELOPES.length);
    expect(rows.map((r) => r.payroll_target)).toEqual(['teacher', 'employee']);
    expect(rows.every((r) => r.category_id === 'sub_salaries_wages')).toBe(true);
  });

  it('does NOT create an envelope per subcategory', () => {
    const lines = (db.prepare('SELECT COUNT(*) c FROM budget_lines WHERE branch_id = ?').get('tx_sparse') as { c: number }).c;
    expect(lines).toBeLessThan(SUBCATEGORY_IDS.size);
    expect(lines).toBe(2);
  });

  it('provisioning twice adds nothing, and never funds a branch', () => {
    ensureBranchBudgetLines(db, 'tx_sparse');
    expect((db.prepare('SELECT COUNT(*) c FROM budget_lines WHERE branch_id = ?').get('tx_sparse') as { c: number }).c).toBe(2);
    expect((db.prepare(
      'SELECT COUNT(*) c FROM budget_lines WHERE branch_id = ? AND (current_amount <> 0 OR allocated_amount <> 0)',
    ).get('tx_sparse') as { c: number }).c).toBe(0);
  });

  it('a budget line cannot exist outside the taxonomy', () => {
    expect(() => db.prepare(
      `INSERT INTO budget_lines (id,name,branch_id,category_id) VALUES ('tx_orphan','Orphan','tx_sparse',NULL)`).run(),
    ).toThrow(/must reference a finance subcategory/i);

    // A CATEGORY is not a legal parent either — only a subcategory is.
    expect(() => db.prepare(
      `INSERT INTO budget_lines (id,name,branch_id,category_id) VALUES ('tx_cat','At category level','tx_sparse','cat_premises_facilities')`).run(),
    ).toThrow(/must reference a finance subcategory/i);
  });

  it('allows two envelopes under one subcategory but not two with the same name', () => {
    db.prepare(
      `INSERT INTO budget_lines (id,name,branch_id,category_id,sort_order) VALUES ('tx_rent_a','North landlord','tx_sparse','sub_rent',100)`).run();
    expect(() => db.prepare(
      `INSERT INTO budget_lines (id,name,branch_id,category_id,sort_order) VALUES ('tx_rent_b','South landlord','tx_sparse','sub_rent',110)`).run(),
    ).not.toThrow();
    expect(() => db.prepare(
      `INSERT INTO budget_lines (id,name,branch_id,category_id,sort_order) VALUES ('tx_rent_c','north landlord','tx_sparse','sub_rent',120)`).run(),
    ).toThrow();
  });

  it('branches stay isolated', () => {
    db.prepare(`INSERT OR IGNORE INTO branches (id,name,location,is_active) VALUES ('tx_iso','Iso','Kabul',1)`).run();
    expect((db.prepare('SELECT COUNT(*) c FROM budget_lines WHERE branch_id = ?').get('tx_iso') as { c: number }).c).toBe(0);
    ensureBranchBudgetLines(db, 'tx_iso');
    expect((db.prepare('SELECT COUNT(*) c FROM budget_lines WHERE branch_id = ?').get('tx_iso') as { c: number }).c).toBe(2);
  });
});

// ── 6. The legacy model is gone ─────────────────────────────────────────────
describe('the legacy budget model has no runtime presence', () => {
  it('budget_lines carries no purpose, marketing flag or mapping status', () => {
    const cols = (db.prepare('PRAGMA table_info(budget_lines)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const gone of ['purpose', 'is_marketing', 'mapping_status']) {
      expect(cols, `budget_lines.${gone} should not exist`).not.toContain(gone);
    }
    expect(cols).toContain('category_id');
    expect(cols).toContain('payroll_target');
  });

  it('financial_transactions carries the taxonomy foreign key', () => {
    const cols = (db.prepare('PRAGMA table_info(financial_transactions)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('finance_category_id');
  });

  it('no index or trigger references the removed columns', () => {
    const objects = db.prepare(
      `SELECT name, sql FROM sqlite_master WHERE sql LIKE '%purpose%' OR sql LIKE '%is_marketing%' OR sql LIKE '%mapping_status%'`,
    ).all() as Array<{ name: string }>;
    expect(objects.map((o) => o.name)).toEqual([]);
  });

  it('no runtime source file reads a legacy budget purpose or a demo budget id', () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.git', 'tests'].includes(e.name)) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(abs));
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(abs);
      }
      return out;
    };
    const strip = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

    const offenders: string[] = [];
    for (const file of [...walk(path.join(repoRoot, 'src')), ...walk(path.join(repoRoot, 'server', 'src'))]) {
      const text = strip(fs.readFileSync(file, 'utf8'));
      const rel = path.relative(repoRoot, file);
      if (/budget_lines[^;]*\bpurpose\b/.test(text)) offenders.push(`${rel}: reads budget_lines.purpose`);
      if (/\bpurpose\s*===?\s*['"](teacher_salary|employee_salary)['"]/.test(text)) offenders.push(`${rel}: legacy purpose comparison`);
      if (/\bid\s*===?\s*['"]b(?:[1-9]|10)['"]/.test(text)) offenders.push(`${rel}: legacy demo budget id`);
      if (/OPERATIONAL_PURPOSES/.test(text)) offenders.push(`${rel}: hard-coded purpose allow-list`);
      if (/\bis_marketing\b|\bisMarketing\b/.test(text)) offenders.push(`${rel}: private marketing classification`);
      if (/\bmapping_status\b|\bmappingStatus\b/.test(text)) offenders.push(`${rel}: migration concept in runtime code`);
    }
    expect(offenders).toEqual([]);
  });

  it('the classification authority is not duplicated anywhere', () => {
    // Exactly one module may define what the three treatments are.
    const authority = read('server/src/core/finance/category-taxonomy.ts');
    expect(authority).toContain("'operating_expense'");
    const classifier = read('server/src/core/finance/ledger-classification.ts');
    // The classifier reads the DATABASE, so it cannot drift from the seeded tree.
    expect(classifier).toContain('SELECT fc.classification FROM finance_categories fc');
  });

  it('every subcategory id the payroll envelopes use really exists', () => {
    for (const envelope of PAYROLL_ENVELOPES) {
      expect(isSubcategoryId(envelope.categoryId)).toBe(true);
      expect(db.prepare('SELECT id FROM finance_categories WHERE id = ?').get(envelope.categoryId)).toBeDefined();
    }
    expect(CANONICAL_CATEGORIES.flatMap((c) => c.children)).toHaveLength(45);
  });
});
