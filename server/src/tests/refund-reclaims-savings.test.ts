/**
 * A reversal must be able to undo exactly what the original income did.
 * ============================================================================
 * F-9 (proven live over HTTP, 2026-08-16 release-candidate audit):
 *
 *   A student pays 200 AFN. recordIncome() credits 200 to the branch main
 *   account and then immediately sweeps `daily_saving_percent` (5%) into the
 *   saving account, leaving main at 190.
 *
 *   Refunding that same 200 AFN then FAILED:
 *
 *     POST /api/students/:id/refund { amount: 200 }
 *       -> 500 "Insufficient branch operating cash for this reversal/refund."
 *
 *   The institute could not return money a customer had actually paid. The
 *   funds were not missing — they were in the saving account, one row away —
 *   but the reversal only ever debited main. Every payment was silently
 *   partially unrefundable, by exactly the savings percentage, forever.
 *
 *   Two defects, one symptom:
 *     1. The reversal ignored the savings half of its own income path.
 *     2. It threw a plain Error, so a business condition surfaced as HTTP 500.
 *        (money.ts carries a comment about this exact mistake being fixed
 *        there previously — the same trap, a second time.)
 *
 * Fix: a negative recordIncome() takes what main can cover and reclaims the
 * remainder from savings, writing a compensating negative saving_transfer row
 * so the ledger still explains both balances. Genuine shortfalls now return
 * 409, not 500.
 *
 * These tests assert the ACCOUNTING, not just the status code: a 201 that
 * leaves the books unbalanced is not a fix.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initSchema } from '../db/connection.js';
import { recordIncome } from '../utils/income.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';
import { setSetting } from '../utils/settings.js';
import { HttpError } from '../middleware/errorHandler.js';

const BRANCH = 'f9_branch';

/** main and saving must always equal what the ledger says they should be. */
function reconcile(branchId: string) {
  const sum = (sql: string) =>
    (db.prepare(sql).get(branchId) as { t: number }).t;
  const income = sum(`SELECT COALESCE(SUM(amount),0) t FROM financial_transactions WHERE type='income' AND branch_id = ?`);
  const expense = sum(`SELECT COALESCE(SUM(amount),0) t FROM financial_transactions WHERE type='expense' AND branch_id = ?`);
  const saving = sum(`SELECT COALESCE(SUM(amount),0) t FROM financial_transactions WHERE type='saving_transfer' AND branch_id = ?`);
  const acct = getFinanceAccount('branch', branchId);
  return {
    expectedMain: Math.round((income - expense - saving) * 100) / 100,
    actualMain: acct.mainBalance,
    expectedSaving: Math.round(saving * 100) / 100,
    actualSaving: acct.savingBalance,
  };
}

const income = (amount: number, description: string) =>
  db.transaction(() =>
    recordIncome({
      category: amount < 0 ? 'refund' : 'fee',
      amount, date: '2026-05-01', description,
      operatorName: 'Test', operatorRole: 'owner', branchId: BRANCH,
    }),
  )();

beforeEach(() => {
  initSchema();
  db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'Loc')`).run(BRANCH, BRANCH);
  db.prepare(`DELETE FROM financial_transactions WHERE branch_id = ?`).run(BRANCH);
  db.prepare(`DELETE FROM finance_accounts WHERE scope_type='branch' AND scope_id = ?`).run(BRANCH);
  setSetting('daily_saving_percent', '5');
});

describe('F-9: a full refund of a fully-paid amount', () => {
  it('THE DEFECT: 200 in, 200 back out — previously impossible', () => {
    income(200, 'tuition');
    // 5% swept away: main 190, saving 10. The old code debited main only.
    expect(getFinanceAccount('branch', BRANCH)).toEqual({ mainBalance: 190, savingBalance: 10 });

    expect(() => income(-200, 'full refund')).not.toThrow();

    const acct = getFinanceAccount('branch', BRANCH);
    expect(acct.mainBalance).toBe(0);
    expect(acct.savingBalance).toBe(0);
  });

  it('the books still balance after the reclaim', () => {
    income(200, 'tuition');
    income(-200, 'full refund');
    const r = reconcile(BRANCH);
    expect(r.actualMain).toBe(r.expectedMain);
    expect(r.actualSaving).toBe(r.expectedSaving);
  });

  it('a refund that main alone covers does NOT touch savings', () => {
    income(1000, 'tuition');   // main 950, saving 50
    income(-100, 'small refund');
    const acct = getFinanceAccount('branch', BRANCH);
    expect(acct.mainBalance).toBe(850);
    expect(acct.savingBalance, 'savings must be reclaimed only when needed').toBe(50);
    const r = reconcile(BRANCH);
    expect(r.actualMain).toBe(r.expectedMain);
    expect(r.actualSaving).toBe(r.expectedSaving);
  });

  it('a genuine shortfall is refused as 409, not 500, and changes nothing', () => {
    income(100, 'tuition'); // total funds 100
    const before = getFinanceAccount('branch', BRANCH);

    let thrown: unknown;
    try { income(-5000, 'refund far beyond all funds'); } catch (err) { thrown = err; }

    expect(thrown).toBeInstanceOf(HttpError);
    // A business condition is a client-correctable 409, never a server fault.
    expect((thrown as HttpError).status).toBe(409);

    // The whole reversal rolls back — no partial debit, no orphan ledger row.
    expect(getFinanceAccount('branch', BRANCH)).toEqual(before);
    const r = reconcile(BRANCH);
    expect(r.actualMain).toBe(r.expectedMain);
    expect(r.actualSaving).toBe(r.expectedSaving);
  });

  it('repeated pay/refund cycles never drift and never mint money', () => {
    for (let i = 0; i < 12; i++) {
      income(350, `tuition ${i}`);
      income(-350, `refund ${i}`);
    }
    const acct = getFinanceAccount('branch', BRANCH);
    expect(acct.mainBalance).toBe(0);
    expect(acct.savingBalance).toBe(0);
    const r = reconcile(BRANCH);
    expect(r.actualMain).toBe(r.expectedMain);
    expect(r.actualSaving).toBe(r.expectedSaving);
  });

  it('works when the savings percentage is zero (no sweep to reclaim)', () => {
    setSetting('daily_saving_percent', '0');
    income(500, 'tuition');
    expect(getFinanceAccount('branch', BRANCH)).toEqual({ mainBalance: 500, savingBalance: 0 });
    income(-500, 'full refund');
    expect(getFinanceAccount('branch', BRANCH)).toEqual({ mainBalance: 0, savingBalance: 0 });
  });
});

/**
 * F-10 (CRITICAL, proven live over HTTP):
 *
 *   POST /api/books/sales/:saleId/refund wrote its contra-revenue row STRAIGHT
 *   into financial_transactions instead of going through recordIncome(). The
 *   sale credited the branch cash account; the refund did not debit it.
 *
 *   Measured on a clean database: after one 500 AFN sale and its refund the
 *   ledger said -500 while finance_accounts still held the 500. That is 500 AFN
 *   of cash that exists in one source of truth and not the other, per refund,
 *   accumulating forever — the exact "duplicate business truth" this system is
 *   supposed to forbid.
 *
 * The asymmetry WAS the bug: one direction of the same transaction used the
 * shared money path and the other hand-rolled a SQL INSERT.
 */
describe('F-10: every money path debits cash through recordIncome', () => {
  it('a book-sale refund returns cash and savings to their pre-sale state', () => {
    income(500, 'book sale');
    expect(getFinanceAccount('branch', BRANCH)).toEqual({ mainBalance: 475, savingBalance: 25 });

    // What the refund route now does.
    db.transaction(() =>
      recordIncome({
        category: 'book_refund', amount: -500, date: '2026-05-01',
        description: 'Contra-revenue refund for book sale',
        operatorName: 'Test', operatorRole: 'owner', branchId: BRANCH,
      }),
    )();

    expect(getFinanceAccount('branch', BRANCH)).toEqual({ mainBalance: 0, savingBalance: 0 });
    const r = reconcile(BRANCH);
    expect(r.actualMain).toBe(r.expectedMain);
    expect(r.actualSaving).toBe(r.expectedSaving);
  });

  it('no route bypasses recordIncome to write a negative income row', () => {
    // Structural guard. A hand-rolled INSERT of a negative income row is how
    // F-10 happened, and it is invisible in review because the SQL looks fine
    // on its own — the defect is only in what it OMITS (the cash debit).
    const routesDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'routes');
    const offenders: string[] = [];
    for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
      // An INSERT into financial_transactions that hardcodes type 'income'.
      if (/INSERT INTO financial_transactions[^`]*'income'/.test(src)) offenders.push(file);
    }
    expect(offenders, 'use recordIncome() so cash and ledger move together').toEqual([]);
  });
});
