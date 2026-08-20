/**
 * Reconciliation must check the CASH POSITION, not only payments vs ledger.
 * ============================================================================
 * Why this exists (2026-08-16 release-candidate audit):
 *
 *   GET /finance/reconciliation compared payment rows against their ledger
 *   rows. Both live in the same table family, so the check was structurally
 *   incapable of seeing a money path that updated the ledger but not the cash
 *   account.
 *
 *   That blind spot is what let F-10 survive: a book-sale refund wrote a -500
 *   contra row and never debited finance_accounts. The branch was reporting
 *   500 AFN of cash it did not have, and reconciliation still said "healthy".
 *   Fixing the refund closes that instance; this check closes the CLASS, so
 *   the next money path that forgets to move cash is caught by the system
 *   rather than by an auditor.
 *
 * Invariant, per branch — mirroring how money actually moves here:
 *     main_balance   = SUM(operating income) - SUM(saving_transfer)
 *     saving_balance = SUM(saving_transfer)
 *
 * `capital_injection` credits the ORGANIZATION treasury (not branch cash) and
 * `budget_charge` debits it into a budget line; `expense` rows are paid FROM
 * budget lines, so none of the three touch branch cash. An earlier draft of
 * this check subtracted expenses from branch cash and reported a false -69,500
 * variance on a perfectly healthy branch — a reconciliation that cries wolf is
 * worse than none, because it trains operators to ignore it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { computeReconciliation } from '../utils/reconciliation.js';
import { recordIncome } from '../utils/income.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';
import { setSetting } from '../utils/settings.js';
import { id } from '../utils/ids.js';

const BRANCH = 'cash_recon_branch';

const income = (amount: number, category = 'fee') =>
  db.transaction(() =>
    recordIncome({
      category, amount, date: '2026-06-01', description: `${category} ${amount}`,
      operatorName: 'Test', operatorRole: 'owner', branchId: BRANCH,
    }),
  )();

beforeEach(() => {
  initSchema();
  db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'Loc')`).run(BRANCH, BRANCH);
  db.prepare(`DELETE FROM financial_transactions WHERE branch_id = ?`).run(BRANCH);
  db.prepare(`DELETE FROM finance_accounts WHERE scope_type='branch' AND scope_id = ?`).run(BRANCH);
  db.prepare(`DELETE FROM budget_lines WHERE branch_id = ?`).run(BRANCH);
  setSetting('daily_saving_percent', '5');
});

describe('cash-position reconciliation', () => {
  it('a clean branch reconciles with zero variance', () => {
    income(1000);
    income(-200, 'refund');
    const r = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(r.cashVariance).toBe(0);
    expect(r.savingVariance).toBe(0);
  });

  it('budget-funded expenses do NOT count against branch cash (no false alarm)', () => {
    income(1000);
    const clean = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(clean.cashVariance).toBe(0);

    // Payroll and utilities are paid from budget lines, and capital movements
    // belong to the organization treasury. None may perturb the branch check.
    db.prepare(
      `INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
       VALUES (?, 'expense', 'salary', 30000, '2026-06-02', 'salary from budget line', 'Test', ?)`,
    ).run(id('tx'), BRANCH);
    db.prepare(
      `INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
       VALUES (?, 'income', 'capital_injection', 100000, '2026-06-02', 'owner capital', 'Test', ?)`,
    ).run(id('tx'), BRANCH);
    db.prepare(
      `INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
       VALUES (?, 'budget_charge', 'utility', 60000, '2026-06-02', 'fund a budget line', 'Test', ?)`,
    ).run(id('tx'), BRANCH);

    const after = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(after.cashVariance, 'branch cash must be unaffected by treasury/budget flows').toBe(0);
    expect(after.savingVariance).toBe(0);
  });

  it('DETECTS phantom cash: a ledger row written without debiting the account', () => {
    income(500, 'book');
    const before = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(before.cashVariance).toBe(0);

    // Exactly what F-10 did: a contra-revenue row straight into the ledger,
    // bypassing recordIncome() and therefore never touching finance_accounts.
    db.prepare(
      `INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
       VALUES (?, 'income', 'book_refund', -500, '2026-06-02', 'hand-rolled contra row', 'Test', ?)`,
    ).run(id('tx'), BRANCH);

    const after = computeReconciliation({ branchId: BRANCH, isAll: false });
    // The account still holds cash the ledger says was returned.
    expect(after.cashVariance).toBe(500);
    expect(after.healthy).toBe(false);

    // The OLD check could not see this — proving the new dimension is load-bearing.
    expect(after.amountVariance).toBe(0);
  });

  it('DETECTS the inverse: cash moved without a ledger row', () => {
    income(300);
    db.prepare(
      `UPDATE finance_accounts SET main_balance = main_balance + 750 WHERE scope_type='branch' AND scope_id = ?`,
    ).run(BRANCH);

    const r = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(r.cashVariance).toBe(750);
    expect(r.healthy).toBe(false);
  });

  it('DETECTS a savings balance that drifts from the transfer ledger', () => {
    income(1000);
    db.prepare(
      `UPDATE finance_accounts SET saving_balance = saving_balance + 40 WHERE scope_type='branch' AND scope_id = ?`,
    ).run(BRANCH);

    const r = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(r.savingVariance).toBe(40);
    expect(r.healthy).toBe(false);
  });

  it('DETECTS budget drift: an expense paid without decrementing the line', () => {
    // Budget lines are the third store of money (after branch cash and the
    // organization treasury) and nothing reconciled them until now. Payroll and
    // operational expenses are paid FROM a line, so an expense row written
    // without decrementing it overstates what the institute can still spend.
    db.prepare(
      `INSERT OR REPLACE INTO budget_lines (id, name, category_id, allocated_amount, current_amount, branch_id, cost_type)
       VALUES ('br_line', 'Test Line', 'sub_rent', 0, 10000, ?, 'fixed')`,
    ).run(BRANCH);
    db.prepare(
      `INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, operator_name, branch_id)
       VALUES (?, 'budget_charge', 'rent', 10000, '2026-06-01', 'fund the line', 'br_line', 'Test', ?)`,
    ).run(id('tx'), BRANCH);

    const clean = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(clean.budgetVariance).toBe(0);

    // Spend from the line in the ledger only — the line itself is untouched.
    db.prepare(
      `INSERT INTO financial_transactions (id, type, category, amount, date, description, operator_name, branch_id)
       VALUES (?, 'expense', 'rent', 4000, '2026-06-02', 'rent paid, line not decremented', 'Test', ?)`,
    ).run(id('tx'), BRANCH);

    const after = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(after.budgetVariance).toBe(4000);
    expect(after.healthy).toBe(false);
    // The cash dimensions cannot see this — budget spend never touches branch cash.
    expect(after.cashVariance).toBe(0);
  });

  it('DETECTS the inverse: a line decremented with no expense recorded', () => {
    db.prepare(
      `INSERT OR REPLACE INTO budget_lines (id, name, category_id, allocated_amount, current_amount, branch_id, cost_type)
       VALUES ('br_line2', 'Test Line 2', 'sub_rent', 0, 3000, ?, 'fixed')`,
    ).run(BRANCH);
    db.prepare(
      `INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, operator_name, branch_id)
       VALUES (?, 'budget_charge', 'rent', 10000, '2026-06-01', 'fund the line', 'br_line2', 'Test', ?)`,
    ).run(id('tx'), BRANCH);

    const r = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(r.budgetVariance).toBe(-7000);
    expect(r.healthy).toBe(false);
  });

  it('a real refund through recordIncome keeps the position healthy', () => {
    income(500, 'book');
    income(-500, 'book_refund');
    const acct = getFinanceAccount('branch', BRANCH);
    expect(acct).toEqual({ mainBalance: 0, savingBalance: 0 });

    const r = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(r.cashVariance).toBe(0);
    expect(r.savingVariance).toBe(0);
  });
});
