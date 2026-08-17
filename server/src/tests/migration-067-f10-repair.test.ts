/**
 * Migration 067 — F-10 phantom-cash repair
 * ============================================================================
 * F-10 (fixed in code): the book-sale refund wrote a contra-revenue row
 * straight into financial_transactions and never debited finance_accounts, so
 * every legacy refund left money in the accounts that the ledger says is gone.
 * The forward path is fixed; databases created before the fix still carry the
 * divergence.
 *
 * A data-repair migration touching live balances is the single most dangerous
 * thing in this codebase, so its properties are pinned here rather than
 * trusted:
 *
 *   1. it corrects a diverged branch to the ledger,
 *   2. it leaves a HEALTHY database completely untouched,
 *   3. running it twice changes nothing after the first run,
 *   4. it repairs each branch from that branch's OWN ledger,
 *   5. it writes an auditable, zero-amount trail row,
 *   6. it does not touch payments, invoices, audit_logs, or any history table.
 *
 * Each test builds its own isolated database, so nothing here can affect the
 * shared test database or another suite.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const MIGRATION = fs.readFileSync(
  path.join(repoRoot, 'server/src/db/migrations/067_repair_f10_phantom_cash.sql'),
  'utf8',
);

/** Minimal schema carrying only what the migration reads and writes. */
function makeDb(): Database.Database {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'f10-')), 'db.sqlite');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE finance_accounts (
      scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
      main_balance REAL NOT NULL DEFAULT 0 CHECK (main_balance >= 0),
      saving_balance REAL NOT NULL DEFAULT 0 CHECK (saving_balance >= 0),
      UNIQUE (scope_type, scope_id)
    );
    CREATE TABLE financial_transactions (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, category TEXT,
      amount REAL NOT NULL, date TEXT, description TEXT, reference_id TEXT,
      operator_name TEXT, operator_role TEXT, branch_id TEXT NOT NULL
    );
    CREATE TABLE payments (id TEXT PRIMARY KEY, amount REAL);
    CREATE TABLE audit_logs (id TEXT PRIMARY KEY, action TEXT);
  `);
  return db;
}

const income = (db: Database.Database, id: string, branch: string, amount: number, type = 'income') =>
  db.prepare(
    `INSERT INTO financial_transactions (id, type, category, amount, date, branch_id)
     VALUES (?, ?, 'book', ?, date('now'), ?)`
  ).run(id, type, amount, branch);

const account = (db: Database.Database, branch: string) =>
  db.prepare("SELECT main_balance, saving_balance FROM finance_accounts WHERE scope_type='branch' AND scope_id=?").get(branch) as
    { main_balance: number; saving_balance: number };

describe('migration 067 repairs F-10 phantom cash', () => {
  it('realigns a diverged branch to its ledger', () => {
    const db = makeDb();
    db.prepare("INSERT INTO finance_accounts VALUES ('branch','1',4750,250)").run();
    income(db, 't1', '1', 3500);
    income(db, 't2', '1', 250, 'saving_transfer');
    // ledger main = 3500 - 250 = 3250, saving = 250; account holds 4750 (phantom 1500)
    db.exec(MIGRATION);

    const a = account(db, '1');
    expect(a.main_balance).toBe(3250);
    expect(a.saving_balance).toBe(250);
    db.close();
  });

  it('leaves a HEALTHY database completely untouched', () => {
    const db = makeDb();
    db.prepare("INSERT INTO finance_accounts VALUES ('branch','1',3250,250)").run();
    income(db, 't1', '1', 3500);
    income(db, 't2', '1', 250, 'saving_transfer');
    const txBefore = (db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c;

    db.exec(MIGRATION);

    expect(account(db, '1')).toEqual({ main_balance: 3250, saving_balance: 250 });
    // No audit row is written when there is nothing to correct.
    expect((db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c).toBe(txBefore);
    db.close();
  });

  it('is idempotent — a second run changes nothing', () => {
    const db = makeDb();
    db.prepare("INSERT INTO finance_accounts VALUES ('branch','1',9999,0)").run();
    income(db, 't1', '1', 1000);

    db.exec(MIGRATION);
    const first = { acct: account(db, '1'), tx: (db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c };
    db.exec(MIGRATION);
    const second = { acct: account(db, '1'), tx: (db.prepare('SELECT COUNT(*) c FROM financial_transactions').get() as { c: number }).c };

    expect(second).toEqual(first);
    db.close();
  });

  it('does not write a duplicate audit row if a branch diverges a second time', () => {
    // The `WHERE divergence` clause is what makes a plain re-run a no-op. This
    // pins the separate NOT EXISTS backstop: if the same branch somehow drifts
    // again later, the repair must not stack a second tx_f10_1 row (its id is
    // deterministic, so a duplicate would also violate the primary key).
    const db = makeDb();
    db.prepare("INSERT INTO finance_accounts VALUES ('branch','1',5000,0)").run();
    income(db, 'a1', '1', 1000);
    db.exec(MIGRATION);
    expect(account(db, '1').main_balance).toBe(1000);

    // Simulate a fresh, unrelated divergence on the same branch.
    db.prepare("UPDATE finance_accounts SET main_balance = 7777 WHERE scope_id='1'").run();
    expect(() => db.exec(MIGRATION)).not.toThrow();

    const rows = db.prepare("SELECT COUNT(*) c FROM financial_transactions WHERE id LIKE 'tx_f10_%'").get() as { c: number };
    expect(rows.c).toBe(1);
    db.close();
  });

  it('repairs each branch from its OWN ledger, never another branch', () => {
    const db = makeDb();
    db.prepare("INSERT INTO finance_accounts VALUES ('branch','1',5000,0)").run();
    db.prepare("INSERT INTO finance_accounts VALUES ('branch','2',700,0)").run();
    income(db, 'a1', '1', 1000);
    income(db, 'b1', '2', 700); // branch 2 is already correct

    db.exec(MIGRATION);

    expect(account(db, '1').main_balance).toBe(1000);
    // Branch 2 was healthy and must be untouched — no cross-branch bleed.
    expect(account(db, '2').main_balance).toBe(700);
    db.close();
  });

  it('writes a zero-amount audit row naming the before and after values', () => {
    const db = makeDb();
    db.prepare("INSERT INTO finance_accounts VALUES ('branch','1',4750,250)").run();
    income(db, 't1', '1', 3500);
    income(db, 't2', '1', 250, 'saving_transfer');

    db.exec(MIGRATION);

    const row = db.prepare("SELECT amount, description, operator_name FROM financial_transactions WHERE id='tx_f10_1'")
      .get() as { amount: number; description: string; operator_name: string };
    expect(row).toBeDefined();
    // Zero, so the trail row cannot itself move the ledger it documents.
    expect(row.amount).toBe(0);
    expect(row.description).toContain('4750');
    expect(row.description).toContain('3250');
    expect(row.operator_name).toContain('migration 067');
    db.close();
  });

  it('excludes capital_injection from branch cash', () => {
    // A capital_injection row is stamped with the operator's branch_id but
    // credits the ORGANIZATION treasury, not branch cash — exactly as
    // computeReconciliation() defines it. An earlier draft of this migration
    // counted it as branch income and INVENTED 50,000 of phantom cash on a
    // perfectly healthy branch, which is the opposite of the repair's purpose.
    const db = makeDb();
    db.prepare("INSERT INTO finance_accounts VALUES ('branch','1',1000,0)").run();
    income(db, 't1', '1', 1000);
    db.prepare(
      `INSERT INTO financial_transactions (id, type, category, amount, date, branch_id)
       VALUES ('t2','income','capital_injection',50000,date('now'),'1')`
    ).run();

    db.exec(MIGRATION);

    expect(account(db, '1').main_balance).toBe(1000);
    // Healthy branch => nothing to repair => no audit row.
    expect((db.prepare("SELECT COUNT(*) c FROM financial_transactions WHERE id LIKE 'tx_f10_%'").get() as { c: number }).c).toBe(0);
    db.close();
  });

  it('does not touch the organization treasury scope', () => {
    const db = makeDb();
    db.prepare("INSERT INTO finance_accounts VALUES ('organization','global',12345,600)").run();
    db.prepare("INSERT INTO finance_accounts VALUES ('branch','1',5000,0)").run();
    income(db, 'a1', '1', 1000);

    db.exec(MIGRATION);

    const org = db.prepare("SELECT main_balance, saving_balance FROM finance_accounts WHERE scope_type='organization'")
      .get() as { main_balance: number; saving_balance: number };
    // The treasury is funded by capital_injection, not branch income — its
    // balance is not derived from this formula and must be left alone.
    expect(org).toEqual({ main_balance: 12345, saving_balance: 600 });
    db.close();
  });

  it('does not modify payments or audit_logs', () => {
    const db = makeDb();
    db.prepare("INSERT INTO finance_accounts VALUES ('branch','1',5000,0)").run();
    income(db, 'a1', '1', 1000);
    db.prepare("INSERT INTO payments VALUES ('p1', 500)").run();
    db.prepare("INSERT INTO audit_logs VALUES ('l1', 'existing entry')").run();

    db.exec(MIGRATION);

    expect((db.prepare('SELECT COUNT(*) c FROM payments').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM audit_logs').get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT amount FROM payments WHERE id='p1'").get() as { amount: number }).amount).toBe(500);
    db.close();
  });
});
