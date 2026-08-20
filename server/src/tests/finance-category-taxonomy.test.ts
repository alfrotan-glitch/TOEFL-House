/**
 * Canonical Finance Category taxonomy — structure, stability and hygiene.
 * ============================================================================
 * Before migration 077 this ERP had NO finance category entity. "Category" was
 * (a) a flat per-branch `budget_lines` row keyed by `purpose` and (b) a free
 * TEXT column on `financial_transactions` with no CHECK and no foreign key.
 * There was no parent, no ordering, no active flag, no accounting
 * classification and no channel concept — so a marketing platform such as
 * Facebook could only be modelled by inventing a bogus "Facebook Advertising"
 * ACCOUNTING category.
 *
 * These tests pin the properties that make the replacement safe. They assert
 * against the DATABASE wherever the database is the authority, and against the
 * compiled taxonomy only where the taxonomy is the authority.
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
  LEGACY_PURPOSE_MAP,
  canonicalCategoryRows,
  classificationOf,
} from '../core/finance/category-taxonomy.js';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const readSource = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * Strip comments before scanning for banned strings.
 *
 * Phase 8 of the brief is explicit that a search match is not automatically a
 * defect. Every one of these files DISCUSSES the legacy names in prose so a
 * future reader knows why they are gone; banning the words outright would
 * punish the documentation and reward silence. What must not exist is a legacy
 * name or id in a CODE position.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/** Every .ts/.tsx file under a directory, excluding build output. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

beforeAll(() => {
  initSchema();
});

// ── 1. Canonical taxonomy ───────────────────────────────────────────────────
describe('the canonical taxonomy exists in the database exactly as specified', () => {
  const EXPECTED_CATEGORIES = [
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
  ];

  it('holds the ten top-level categories, in the specified order', () => {
    const rows = db.prepare(
      `SELECT name FROM finance_categories WHERE level = 'category' ORDER BY sort_order`,
    ).all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(EXPECTED_CATEGORIES);
  });

  it('holds every specified subcategory under the right parent', () => {
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
        `SELECT c.name FROM finance_categories c
         JOIN finance_categories p ON p.id = c.parent_id
         WHERE p.name = ? ORDER BY c.sort_order`,
      ).all(category) as Array<{ name: string }>;
      expect(rows.map((r) => r.name), `subcategories of ${category}`).toEqual(subcategories);
    }
  });

  it('classifies capital expenditure and non-expense cash movements explicitly', () => {
    const classificationOfName = (name: string) =>
      (db.prepare('SELECT classification FROM finance_categories WHERE name = ?').get(name) as { classification: string }).classification;

    // The four items the brief singles out as NOT ordinary operating expenses.
    expect(classificationOfName('Salary Advances')).toBe('non_expense_cash_movement');
    expect(classificationOfName('Refunds')).toBe('non_expense_cash_movement');
    expect(classificationOfName("Owner's Drawings")).toBe('non_expense_cash_movement');
    // Charitable contributions must carry an EXPLICIT treatment rather than
    // defaulting into operating cost.
    expect(classificationOfName('Charitable Contributions')).toBe('non_expense_cash_movement');

    for (const asset of ['IT Equipment', 'Office Equipment', 'Furniture & Fixtures', 'Vehicles', 'Other Fixed Assets']) {
      expect(classificationOfName(asset), asset).toBe('capital_expenditure');
    }

    expect(classificationOfName('Rent Expense')).toBe('operating_expense');
  });
});

// ── 2. Parent-child hierarchy ───────────────────────────────────────────────
describe('parent-child hierarchy is enforced by the database, not by convention', () => {
  it('every subcategory has a parent and every category has none', () => {
    const bad = db.prepare(
      `SELECT id FROM finance_categories
       WHERE (level = 'category' AND parent_id IS NOT NULL)
          OR (level = 'subcategory' AND parent_id IS NULL)`,
    ).all();
    expect(bad).toEqual([]);
  });

  it('rejects a subcategory whose parent is another subcategory (no third level, no cycles)', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO finance_categories (id, parent_id, name, level, classification, sort_order)
         VALUES ('tax_bad_depth', 'sub_rent', 'Illegal depth', 'subcategory', 'operating_expense', 999)`,
      ).run(),
    ).toThrow(/parent must be a top-level category/i);
  });

  it('rejects a node that is its own parent', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO finance_categories (id, parent_id, name, level, classification, sort_order)
         VALUES ('tax_self', 'tax_self', 'Self parent', 'subcategory', 'operating_expense', 999)`,
      ).run(),
    ).toThrow();
  });

  it('rejects a subcategory whose classification contradicts its parent', () => {
    // Without this a "Vehicles" node could sit under Capital Expenditure and
    // still be classified as an operating expense — the exact defect the
    // taxonomy exists to remove.
    expect(() =>
      db.prepare(
        `INSERT INTO finance_categories (id, parent_id, name, level, classification, sort_order)
         VALUES ('tax_bad_class', 'cat_capital_expenditure', 'Contradiction', 'subcategory', 'operating_expense', 999)`,
      ).run(),
    ).toThrow(/classification must match its parent/i);
  });

  it('rejects two siblings with the same display name', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO finance_categories (id, parent_id, name, level, classification, sort_order)
         VALUES ('tax_dup_name', 'cat_premises_facilities', 'Utilities', 'subcategory', 'operating_expense', 999)`,
      ).run(),
    ).toThrow();
  });
});

// ── 3. Stable IDs ───────────────────────────────────────────────────────────
describe('identifiers are stable codes, never display names', () => {
  it('re-seeding never changes an id, and a renamed node keeps its id', () => {
    const before = db.prepare('SELECT id FROM finance_categories ORDER BY id').all();
    db.prepare(`UPDATE finance_categories SET name = 'Renamed for the test' WHERE id = 'sub_rent'`).run();
    // The seeder restores the canonical name but must never mint a new id.
    initSchema();
    const after = db.prepare('SELECT id FROM finance_categories ORDER BY id').all();
    expect(after).toEqual(before);
    expect(
      (db.prepare(`SELECT name FROM finance_categories WHERE id = 'sub_rent'`).get() as { name: string }).name,
    ).toBe('Rent Expense');
  });

  it('a budget line references its category by id, so a rename cannot orphan it', () => {
    const line = db.prepare(
      `SELECT category_id FROM budget_lines WHERE purpose = 'rent' AND branch_id = '1'`,
    ).get() as { category_id: string };
    expect(line.category_id).toBe('sub_rent');

    db.prepare(`UPDATE finance_categories SET name = 'Premises Rent' WHERE id = 'sub_rent'`).run();
    const stillLinked = db.prepare(
      `SELECT c.id FROM budget_lines b JOIN finance_categories c ON c.id = b.category_id
       WHERE b.purpose = 'rent' AND b.branch_id = '1'`,
    ).get() as { id: string } | undefined;
    expect(stillLinked?.id).toBe('sub_rent');
    db.prepare(`UPDATE finance_categories SET name = 'Rent Expense' WHERE id = 'sub_rent'`).run();
  });
});

// ── 4. Facebook is a channel, never an accounting category ──────────────────
describe('Facebook is modelled as a channel under Digital Advertising', () => {
  it('exists as a channel of Marketing & Promotion → Digital Advertising', () => {
    const row = db.prepare(
      `SELECT ch.name, ch.kind, sub.name AS subcategory, cat.name AS category
       FROM finance_category_channels ch
       JOIN finance_categories sub ON sub.id = ch.category_id
       JOIN finance_categories cat ON cat.id = sub.parent_id
       WHERE ch.name = 'Facebook'`,
    ).get() as { name: string; kind: string; subcategory: string; category: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.kind).toBe('channel');
    expect(row!.subcategory).toBe('Digital Advertising');
    expect(row!.category).toBe('Marketing & Promotion');
  });

  it('does NOT exist as a finance category or subcategory', () => {
    const offenders = db.prepare(
      `SELECT id, name FROM finance_categories WHERE name LIKE '%Facebook%' OR name LIKE '%Facbook%'`,
    ).all();
    expect(offenders).toEqual([]);
  });

  it('a channel may not be attached to a budget line of a different category', () => {
    const rentLine = db.prepare(
      `SELECT id FROM budget_lines WHERE purpose = 'rent' AND branch_id = '1'`,
    ).get() as { id: string };
    expect(() =>
      db.prepare('UPDATE budget_lines SET channel_id = ? WHERE id = ?').run('chn_facebook', rentLine.id),
    ).toThrow(/channel must belong to the same finance category/i);
  });
});

// ── 5. Duplicate prevention ─────────────────────────────────────────────────
describe('duplicate prevention', () => {
  it('refuses a second budget line with the same purpose in the same branch', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO budget_lines (id, name, purpose, branch_id) VALUES ('dup_rent_1', 'Rent again', 'rent', '1')`,
      ).run(),
    ).toThrow(/purpose already exists for this branch/i);
  });

  it('still allows the same purpose in a DIFFERENT branch', () => {
    db.prepare(
      `INSERT OR IGNORE INTO branches (id, name, location, is_active) VALUES ('fc_dup_branch', 'Dup branch', 'Kabul', 1)`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO budget_lines (id, name, purpose, branch_id) VALUES ('dup_rent_2', 'Rent', 'rent', 'fc_dup_branch')`,
      ).run(),
    ).not.toThrow();
    db.prepare(`DELETE FROM budget_lines WHERE id = 'dup_rent_2'`).run();
  });

  it('an upsert of the SAME row is still allowed (the guard is not a foot-gun)', () => {
    const id = 'budget_rent_1';
    expect(() =>
      db.prepare(
        `INSERT OR IGNORE INTO budget_lines (id, name, purpose, branch_id) VALUES (?, 'Rent', 'rent', '1')`,
      ).run(id),
    ).not.toThrow();
  });

  it('Utilities owns three separate budget lines — folding them under one parent did not merge them', () => {
    const lines = db.prepare(
      `SELECT purpose FROM budget_lines WHERE branch_id = '1' AND category_id = 'sub_utilities' ORDER BY purpose`,
    ).all() as Array<{ purpose: string }>;
    expect(lines.map((l) => l.purpose)).toEqual(['electricity', 'gas', 'water']);
  });
});

// ── 6. Branch / organization scoping ────────────────────────────────────────
describe('scoping follows the existing authority model', () => {
  it('the taxonomy is organization-level, not duplicated per branch', () => {
    const orgs = db.prepare('SELECT DISTINCT organization_id FROM finance_categories').all() as Array<{ organization_id: string }>;
    expect(orgs).toHaveLength(1);
    expect(orgs[0].organization_id).toBe('org_toefl_house');
  });

  it('budget lines stay branch-isolated and every branch gets the same catalogue', () => {
    db.prepare(
      `INSERT OR IGNORE INTO branches (id, name, location, is_active) VALUES ('fc_iso_a', 'Iso A', 'Kabul', 1)`,
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO branches (id, name, location, is_active) VALUES ('fc_iso_b', 'Iso B', 'Kabul', 1)`,
    ).run();
    ensureBranchBudgetLines(db, 'fc_iso_a');

    const count = (branch: string) =>
      (db.prepare('SELECT COUNT(*) c FROM budget_lines WHERE branch_id = ?').get(branch) as { c: number }).c;

    expect(count('fc_iso_b')).toBe(0);
    ensureBranchBudgetLines(db, 'fc_iso_b');
    expect(count('fc_iso_b')).toBe(count('fc_iso_a'));

    // Provisioning a branch never funds it.
    const funded = db.prepare(
      'SELECT COUNT(*) c FROM budget_lines WHERE branch_id = ? AND (current_amount <> 0 OR allocated_amount <> 0)',
    ).get('fc_iso_a') as { c: number };
    expect(funded.c).toBe(0);
  });

  it('every canonical subcategory is reachable through at least one budget line per branch', () => {
    // Without this the taxonomy would be decorative: an operator could not book
    // "Tax Clearance Fees" because no envelope would exist to book it against.
    const covered = new Set(
      (db.prepare(
        `SELECT DISTINCT category_id FROM budget_lines WHERE branch_id = 'fc_iso_a' AND category_id IS NOT NULL`,
      ).all() as Array<{ category_id: string }>).map((r) => r.category_id),
    );
    const missing = CANONICAL_CATEGORIES.flatMap((c) => c.children)
      .map((s) => s.id)
      .filter((id) => !covered.has(id));
    expect(missing).toEqual([]);
  });
});

// ── 7. Fresh database seed ──────────────────────────────────────────────────
describe('fresh database seed', () => {
  it('re-running the bootstrap is idempotent — no duplicate nodes, no duplicate lines', () => {
    // Settle first: earlier tests in this file create branches, and the very
    // next bootstrap legitimately provisions their catalogues. Idempotency is a
    // claim about the SECOND run onwards, not about the one that does the work.
    initSchema();
    const before = {
      categories: (db.prepare('SELECT COUNT(*) c FROM finance_categories').get() as { c: number }).c,
      channels: (db.prepare('SELECT COUNT(*) c FROM finance_category_channels').get() as { c: number }).c,
      lines: (db.prepare('SELECT COUNT(*) c FROM budget_lines').get() as { c: number }).c,
    };
    initSchema();
    initSchema();
    expect((db.prepare('SELECT COUNT(*) c FROM finance_categories').get() as { c: number }).c).toBe(before.categories);
    expect((db.prepare('SELECT COUNT(*) c FROM finance_category_channels').get() as { c: number }).c).toBe(before.channels);
    expect((db.prepare('SELECT COUNT(*) c FROM budget_lines').get() as { c: number }).c).toBe(before.lines);
  });

  it('the seeded node count matches the compiled taxonomy exactly', () => {
    expect((db.prepare('SELECT COUNT(*) c FROM finance_categories').get() as { c: number }).c)
      .toBe(canonicalCategoryRows().length);
    expect((db.prepare('SELECT COUNT(*) c FROM finance_category_channels').get() as { c: number }).c)
      .toBe(CANONICAL_CHANNELS.length);
  });
});

// ── 8. The SQL migration and the TypeScript map cannot drift ────────────────
describe('the explicit SQL mapping and the compiled legacy map agree', () => {
  const migration = readSource('server/src/db/migrations/078_finance_category_legacy_mapping.sql');

  it('every purpose the SQL maps resolves to the same node in TypeScript', () => {
    // Parse `SET category_id = 'X' ... WHERE purpose = 'y'` and
    // `WHERE purpose IN ('a','b')` out of the migration itself, so the test
    // reads the shipped artefact rather than a copy of it.
    const statements = migration
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('UPDATE budget_lines'));
    let checked = 0;
    for (const statement of statements) {
      const target = /category_id\s*=\s*'([^']+)'/.exec(statement)?.[1] ?? null;
      const single = /purpose\s*=\s*'([^']+)'/.exec(statement)?.[1];
      const list = /purpose\s+IN\s*\(([^)]+)\)/i.exec(statement)?.[1];
      const purposes = single
        ? [single]
        : list
          ? list.split(',').map((p) => p.trim().replace(/^'|'$/g, ''))
          : [];
      for (const purpose of purposes) {
        const mapping = LEGACY_PURPOSE_MAP[purpose];
        expect(mapping, `legacy map is missing "${purpose}" that migration 078 writes`).toBeDefined();
        if (target !== null) {
          expect(mapping.categoryId, `mapping for "${purpose}"`).toBe(target);
        }
        checked += 1;
      }
    }
    // Guards against the parser silently matching nothing and passing.
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  it('every mapped legacy purpose points at a REAL node that exists in the database', () => {
    for (const [purpose, mapping] of Object.entries(LEGACY_PURPOSE_MAP)) {
      if (!mapping.categoryId) continue;
      const node = db.prepare('SELECT id FROM finance_categories WHERE id = ?').get(mapping.categoryId);
      expect(node, `${purpose} → ${mapping.categoryId}`).toBeDefined();
    }
  });

  it('ambiguous legacy purposes are reported, never guessed', () => {
    // These three could not be resolved from the data without inventing a
    // meaning, and one is deliberately outside the taxonomy.
    expect(LEGACY_PURPOSE_MAP.marketing.status).toBe('needs_review');
    expect(LEGACY_PURPOSE_MAP.transport.status).toBe('needs_review');
    expect(LEGACY_PURPOSE_MAP.purchases.status).toBe('needs_review');
    expect(LEGACY_PURPOSE_MAP.purchases.categoryId).toBeNull();
    expect(LEGACY_PURPOSE_MAP.equipment.status).toBe('needs_review');
    expect(LEGACY_PURPOSE_MAP.reserve.status).toBe('out_of_taxonomy');

    // Every ambiguous line keeps the treatment it had before the upgrade...
    for (const purpose of ['marketing', 'transport', 'purchases', 'reserve']) {
      expect(classificationOf(LEGACY_PURPOSE_MAP[purpose].categoryId)).toBe('operating_expense');
    }
    // ...except `equipment`, whose TREATMENT is settled even though its
    // subcategory is not: both candidates sit under Capital Expenditure.
    expect(classificationOf(LEGACY_PURPOSE_MAP.equipment.categoryId)).toBe('capital_expenditure');
  });

  it('marks the review-needed lines in the database so the UI can surface them', () => {
    const rows = db.prepare(
      `SELECT purpose, mapping_status FROM budget_lines
       WHERE branch_id = '1' AND mapping_status <> 'mapped' ORDER BY purpose`,
    ).all() as Array<{ purpose: string; mapping_status: string }>;
    expect(rows).toEqual([
      { purpose: 'equipment', mapping_status: 'needs_review' },
      { purpose: 'marketing', mapping_status: 'needs_review' },
      { purpose: 'purchases', mapping_status: 'needs_review' },
      { purpose: 'reserve', mapping_status: 'out_of_taxonomy' },
      { purpose: 'transport', mapping_status: 'needs_review' },
    ]);
  });
});

// ── 9. No hard-coded legacy ids or names anywhere ───────────────────────────
describe('no hard-coded legacy category ids or names survive', () => {
  const sourceFiles = [
    ...walk(path.join(repoRoot, 'src')),
    ...walk(path.join(repoRoot, 'server', 'src')),
  ].filter((f) => !f.includes(`${path.sep}tests${path.sep}`));

  it('nothing falls back to the original demo budget-line ids b1..b10', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      // The payroll screen used to compare a budget line's primary key against a
      // demo-seed identifier that migration 002 superseded with `purpose`.
      if (/\bid\s*===?\s*['"]b(?:[1-9]|10)['"]/.test(text)) offenders.push(path.relative(repoRoot, file));
    }
    expect(offenders).toEqual([]);
  });

  it('the Finance UI no longer carries a hard-coded purpose allow-list', () => {
    const panel = readSource('src/components/finance/OperationalExpensesPanel.tsx');
    // The old constant made every budget line outside fourteen strings
    // unreachable from the operational-payment screen.
    expect(panel).not.toMatch(/const\s+OPERATIONAL_PURPOSES\s*=\s*new\s+Set/);
    expect(panel).toContain('BudgetLineCascade');
  });

  it('no source file invents a "Facebook Advertising" accounting category', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      if (/Facebook\s+Advertis/i.test(text) || /Facbook/i.test(text)) offenders.push(path.relative(repoRoot, file));
    }
    expect(offenders).toEqual([]);
  });

  it('the classification authority derives its sets from the taxonomy, not from typed-out strings', () => {
    const source = readSource('server/src/core/finance/ledger-classification.ts');
    expect(source).toContain("from './category-taxonomy.js'");
    // A literal list of capex categories here would drift the moment the
    // taxonomy gained a subcategory.
    expect(source).not.toMatch(/CAPITAL_EXPENDITURE_CATEGORIES[^=]*=\s*new Set\(\s*\[\s*'/);
  });
});
