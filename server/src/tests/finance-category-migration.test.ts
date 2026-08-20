/**
 * Migrations 077 + 078 — upgrading a LEGACY production database.
 * ============================================================================
 * The dangerous half of this change is not the fresh install; it is the
 * existing database full of real money. These tests build a database with the
 * PRE-077 shape — the flat `budget_lines` table, funded envelopes, historical
 * ledger rows, an approved expense request — and then apply exactly what the
 * runtime runner applies, in exactly the same order:
 *
 *     077 (structure)  →  seedFinanceCategoryCatalog()  →  078 (mapping)
 *
 * and assert that nothing financial moved.
 *
 * Each test builds its own isolated database, so nothing here can touch the
 * shared test database or another suite.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrationSql } from '../db/migrate.js';
import { seedFinanceCategoryCatalog } from '../db/financeCategoryCatalog.js';
import { classifyExpenseCategory } from '../core/finance/ledger-classification.js';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const migrationSql = (file: string) =>
  fs.readFileSync(path.join(repoRoot, 'server/src/db/migrations', file), 'utf8');

const M077 = migrationSql('077_finance_category_hierarchy.sql');
const M078 = migrationSql('078_finance_category_legacy_mapping.sql');

/**
 * The `budget_lines` shape as it existed at commit 14b9cc8, plus the tables the
 * migrations read or reference. Deliberately hand-written rather than derived
 * from today's schema.sql: the point is to reproduce the OLD shape.
 */
function makeLegacyDb(): Database.Database {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fincat-')), 'legacy.sqlite');
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE branches (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT, is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE budget_lines (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      current_amount   REAL NOT NULL DEFAULT 0,
      allocated_amount REAL NOT NULL DEFAULT 0,
      icon             TEXT,
      cost_type        TEXT NOT NULL DEFAULT 'fixed' CHECK (cost_type IN ('fixed','variable')),
      is_marketing     INTEGER NOT NULL DEFAULT 0,
      purpose          TEXT,
      branch_id        TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT
    );
    CREATE TABLE expense_requests (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, amount REAL NOT NULL,
      budget_line_id TEXT REFERENCES budget_lines(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending', date TEXT NOT NULL,
      branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT
    );
    CREATE TABLE financial_transactions (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, category TEXT NOT NULL, amount REAL NOT NULL,
      date TEXT NOT NULL, description TEXT, reference_id TEXT, branch_id TEXT NOT NULL
    );
    INSERT INTO branches (id, name, location) VALUES ('1', 'Main Branch', 'Kabul');
  `);

  // The 17-line legacy catalogue, as `ensureBudgetLineCatalog` wrote it.
  const legacy: Array<[string, string, 'fixed' | 'variable', number]> = [
    ['teacher_salary', 'Teacher Salaries', 'fixed', 0],
    ['employee_salary', 'Employee Salaries', 'fixed', 0],
    ['rent', 'Rent', 'fixed', 0],
    ['electricity', 'Electricity', 'fixed', 0],
    ['internet', 'Internet', 'fixed', 0],
    ['marketing', 'Marketing', 'variable', 1],
    ['printing', 'Printing', 'variable', 0],
    ['equipment', 'Equipment', 'variable', 0],
    ['kitchen', 'Kitchen & Refreshments', 'variable', 0],
    ['reserve', 'Reserve', 'fixed', 0],
    ['water', 'Water', 'fixed', 0],
    ['gas', 'Gas', 'fixed', 0],
    ['maintenance', 'Maintenance & Repairs', 'variable', 0],
    ['purchases', 'General Purchases', 'variable', 0],
    ['cleaning', 'Cleaning & Hygiene', 'fixed', 0],
    ['transport', 'Transport', 'variable', 0],
    ['misc', 'Miscellaneous', 'variable', 0],
  ];
  const insert = db.prepare(
    `INSERT INTO budget_lines (id, name, current_amount, allocated_amount, icon, cost_type, is_marketing, purpose, branch_id)
     VALUES (?, ?, 0, 0, 'Circle', ?, ?, ?, '1')`,
  );
  for (const [purpose, name, costType, marketing] of legacy) {
    insert.run(`budget_${purpose}_1`, name, costType, marketing, purpose);
  }
  return db;
}

/**
 * Exactly what `runMigrations` does for these two files — including the
 * runner's tolerance for an already-satisfied ADD COLUMN, which is what makes a
 * second run a no-op instead of an error.
 */
function upgrade(db: Database.Database): void {
  applyMigrationSql(db, M077);
  seedFinanceCategoryCatalog(db);
  applyMigrationSql(db, M078);
}

const line = (db: Database.Database, purpose: string) =>
  db.prepare('SELECT * FROM budget_lines WHERE purpose = ? AND branch_id = ?').get(purpose, '1') as
    | Record<string, unknown>
    | undefined;

describe('upgrading a legacy database preserves every financial record', () => {
  it('leaves funded budget balances byte-for-byte unchanged', () => {
    const db = makeLegacyDb();
    db.prepare("UPDATE budget_lines SET allocated_amount = 50000, current_amount = 12345.67 WHERE purpose = 'rent'").run();
    db.prepare("UPDATE budget_lines SET allocated_amount = 30000, current_amount = 999.99 WHERE purpose = 'equipment'").run();

    upgrade(db);

    expect(line(db, 'rent')).toMatchObject({ allocated_amount: 50000, current_amount: 12345.67 });
    expect(line(db, 'equipment')).toMatchObject({ allocated_amount: 30000, current_amount: 999.99 });
  });

  it('does not rewrite a single historical ledger row', () => {
    const db = makeLegacyDb();
    const rows: Array<[string, string, string, number]> = [
      ['h1', 'expense', 'rent', 30000],
      ['h2', 'expense', 'equipment', 25000],
      ['h3', 'expense', 'profit_distribution', 10000],
      ['h4', 'income', 'fee', 90000],
      // A category that only ever existed in production, spelled the way the
      // operator typed it.
      ['h5', 'expense', 'facbook', 1500],
    ];
    for (const [id, type, category, amount] of rows) {
      db.prepare(
        `INSERT INTO financial_transactions (id, type, category, amount, date, branch_id)
         VALUES (?, ?, ?, ?, '2026-05-01', '1')`,
      ).run(id, type, category, amount);
    }
    const before = db.prepare('SELECT id, type, category, amount FROM financial_transactions ORDER BY id').all();

    upgrade(db);

    expect(db.prepare('SELECT id, type, category, amount FROM financial_transactions ORDER BY id').all()).toEqual(before);
  });

  it('keeps expense requests attached to their budget line (no broken foreign keys)', () => {
    const db = makeLegacyDb();
    db.prepare(
      `INSERT INTO expense_requests (id, title, amount, budget_line_id, status, date, branch_id)
       VALUES ('er1', 'May rent', 30000, 'budget_rent_1', 'approved', '2026-05-01', '1')`,
    ).run();

    upgrade(db);

    const req = db.prepare('SELECT budget_line_id, amount, status FROM expense_requests WHERE id = ?').get('er1');
    expect(req).toEqual({ budget_line_id: 'budget_rent_1', amount: 30000, status: 'approved' });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect((db.pragma('integrity_check') as Array<{ integrity_check: string }>)[0].integrity_check).toBe('ok');
  });

  it('never deletes a budget line — the legacy catalogue is still there afterwards', () => {
    const db = makeLegacyDb();
    const before = (db.prepare('SELECT COUNT(*) c FROM budget_lines').get() as { c: number }).c;
    upgrade(db);
    const survivors = db.prepare('SELECT purpose FROM budget_lines ORDER BY purpose').all() as Array<{ purpose: string }>;
    expect(survivors).toHaveLength(before);
  });
});

describe('the legacy → canonical mapping is explicit and deterministic', () => {
  it('maps each unambiguous legacy purpose to its canonical subcategory', () => {
    const db = makeLegacyDb();
    upgrade(db);

    const expected: Record<string, string> = {
      teacher_salary: 'sub_salaries_wages',
      employee_salary: 'sub_salaries_wages',
      rent: 'sub_rent',
      electricity: 'sub_utilities',
      water: 'sub_utilities',
      gas: 'sub_utilities',
      internet: 'sub_internet_communication',
      cleaning: 'sub_cleaning_sanitation',
      maintenance: 'sub_repair_maintenance',
      printing: 'sub_printing',
      kitchen: 'sub_food_catering',
      misc: 'sub_miscellaneous',
      equipment: 'sub_it_equipment',
    };
    for (const [purpose, categoryId] of Object.entries(expected)) {
      expect(line(db, purpose), purpose).toMatchObject({ category_id: categoryId, mapping_status: 'mapped' });
    }
  });

  it('does NOT merge the three utility envelopes even though they share one subcategory', () => {
    const db = makeLegacyDb();
    upgrade(db);
    const utilities = db.prepare(
      "SELECT purpose FROM budget_lines WHERE category_id = 'sub_utilities' ORDER BY purpose",
    ).all() as Array<{ purpose: string }>;
    expect(utilities.map((u) => u.purpose)).toEqual(['electricity', 'gas', 'water']);
  });

  it('flags ambiguous legacy lines instead of guessing a subcategory', () => {
    const db = makeLegacyDb();
    upgrade(db);

    // Category certain, subcategory not recorded anywhere in the data.
    expect(line(db, 'marketing')).toMatchObject({ category_id: 'cat_marketing_promotion', mapping_status: 'needs_review' });
    expect(line(db, 'transport')).toMatchObject({ category_id: 'cat_transport_logistics', mapping_status: 'needs_review' });
    // Not even the parent is decidable — nothing is asserted at all.
    expect(line(db, 'purchases')).toMatchObject({ category_id: null, mapping_status: 'needs_review' });
    // Deliberately outside the expense taxonomy.
    expect(line(db, 'reserve')).toMatchObject({ category_id: null, mapping_status: 'out_of_taxonomy' });
  });

  it('leaves an unknown production category untouched, flagged, and still usable', () => {
    const db = makeLegacyDb();
    db.prepare(
      `INSERT INTO budget_lines (id, name, current_amount, allocated_amount, icon, cost_type, is_marketing, purpose, branch_id)
       VALUES ('bl_rogue', 'Facbook', 4000, 9000, 'Megaphone', 'variable', 1, 'facbook', '1')`,
    ).run();

    upgrade(db);

    expect(line(db, 'facbook')).toMatchObject({
      name: 'Facbook',
      current_amount: 4000,
      allocated_amount: 9000,
      category_id: null,
      mapping_status: 'needs_review',
    });
    // Its accounting behaviour is exactly what it was before the upgrade.
    expect(classifyExpenseCategory('facbook')).toBe('operating_expense');
  });

  it('is idempotent and never overwrites a decision made after the upgrade', () => {
    const db = makeLegacyDb();
    upgrade(db);

    // The operator resolves the ambiguous marketing line by hand.
    db.prepare(
      "UPDATE budget_lines SET category_id = 'sub_digital_advertising', mapping_status = 'mapped' WHERE purpose = 'marketing'",
    ).run();

    // A re-run of the mapping migration must respect that.
    applyMigrationSql(db, M078);
    expect(line(db, 'marketing')).toMatchObject({
      category_id: 'sub_digital_advertising',
      mapping_status: 'mapped',
    });
  });

  it('applying the whole upgrade twice changes nothing', () => {
    const db = makeLegacyDb();
    upgrade(db);
    const snapshot = db.prepare('SELECT * FROM budget_lines ORDER BY id').all();
    const categories = db.prepare('SELECT * FROM finance_categories ORDER BY id').all();

    upgrade(db);

    expect(db.prepare('SELECT * FROM budget_lines ORDER BY id').all()).toEqual(snapshot);
    expect(db.prepare('SELECT * FROM finance_categories ORDER BY id').all().length).toBe(categories.length);
  });
});

describe('the upgraded database enforces the new invariants', () => {
  it('refuses a duplicate (branch, purpose) after the upgrade', () => {
    const db = makeLegacyDb();
    upgrade(db);
    expect(() =>
      db.prepare(
        "INSERT INTO budget_lines (id, name, purpose, branch_id) VALUES ('x', 'Rent copy', 'rent', '1')",
      ).run(),
    ).toThrow(/purpose already exists/i);
  });

  it('gives every budget line a deterministic display order', () => {
    const db = makeLegacyDb();
    upgrade(db);
    const zero = db.prepare('SELECT COUNT(*) c FROM budget_lines WHERE sort_order = 0').get() as { c: number };
    expect(zero.c).toBe(0);
  });
});
