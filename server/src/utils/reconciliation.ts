/**
 * Payment ↔ ledger reconciliation — shared by GET /finance/reconciliation
 * and GET /finance/dashboard so the health check is computed from exactly
 * one code path (backend-only financials: the numbers always come from SQL).
 *
 * Scope handling: branch-scoped queries bind branch_id; organization-scoped
 * queries pass NO parameters at all. Passing `undefined` to a prepared
 * statement with zero placeholders throws "Too many parameter values" in
 * better-sqlite3, which would break the owner (branchId=all) path.
 */
import { db } from '../db/connection.js';
import { BRANCH_CASH_INCOME_SQL, OWNER_DRAWING_SQL } from '../core/finance/ledger-classification.js';
import { BUDGET_MOVEMENT_TYPE } from '../core/finance/budget-movements.js';

export interface ReconciliationResult {
  scope: 'organization' | 'branch';
  branchId: string | null;
  paymentBackedTotal: number;
  ledgerBackedTotal: number;
  paymentBackedCount: number;
  ledgerBackedCount: number;
  amountVariance: number;
  unmatchedPayments: number;
  orphanLedgerRows: number;
  mismatchedPayments: Array<{
    paymentId: string;
    paymentAmount: number;
    ledgerAmount: number;
    variance: number;
  }>;
  /** Cash-position check: do finance_accounts agree with the ledger? */
  cashVariance: number;
  savingVariance: number;
  /** Budget-position check: do budget_lines agree with charges minus spend? */
  budgetVariance: number;
  healthy: boolean;
}

/** Run a scalar query for the given scope. `branchClause` is appended when
 *  the caller is branch-scoped; when organization-scoped the statement is
 *  executed with no parameters (never bind `undefined`). */
function scalarValue(sql: string, branchClause: string, branchId: string | null): number {
  const row = branchId === null
    ? db.prepare(sql).get()
    : db.prepare(`${sql} ${branchClause}`).get(branchId);
  return Number((row as { v: number }).v || 0);
}

/**
 * Cross-checks completed payments against their ledger representation.
 * A payment is "backed" when a financial_transactions row carries its
 * payment_id; anything on one side without the other is flagged.
 */
export function computeReconciliation(opts: { branchId: string | null; isAll: boolean }): ReconciliationResult {
  const { branchId, isAll } = opts;
  const boundBranchId = isAll ? null : branchId;

  const paymentBacked = scalarValue(
    `SELECT COALESCE(SUM(p.amount),0) AS v FROM payments p WHERE p.status = 'completed' AND p.id IN (SELECT DISTINCT payment_id FROM financial_transactions WHERE payment_id IS NOT NULL)`,
    'AND p.branch_id = ?',
    boundBranchId,
  );
  const ledgerBacked = scalarValue(
    `SELECT COALESCE(SUM(ft.amount),0) AS v FROM financial_transactions ft WHERE ft.payment_id IS NOT NULL`,
    'AND ft.branch_id = ?',
    boundBranchId,
  );
  const paymentCount = scalarValue(
    `SELECT COUNT(*) AS v FROM payments p WHERE p.status = 'completed' AND p.id IN (SELECT DISTINCT payment_id FROM financial_transactions WHERE payment_id IS NOT NULL)`,
    'AND p.branch_id = ?',
    boundBranchId,
  );
  const ledgerCount = scalarValue(
    `SELECT COUNT(*) AS v FROM financial_transactions ft WHERE ft.payment_id IS NOT NULL`,
    'AND ft.branch_id = ?',
    boundBranchId,
  );
  const unmatchedPayments = scalarValue(
    `SELECT COUNT(*) AS v FROM payments p WHERE p.status = 'completed' AND NOT EXISTS (SELECT 1 FROM financial_transactions ft WHERE ft.payment_id = p.id)`,
    'AND p.branch_id = ?',
    boundBranchId,
  );
  const orphanLedgerRows = scalarValue(
    `SELECT COUNT(*) AS v FROM financial_transactions ft WHERE ft.payment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = ft.payment_id)`,
    'AND ft.branch_id = ?',
    boundBranchId,
  );

  const mismatchBase = `
    SELECT p.id AS payment_id, p.amount AS payment_amount, COALESCE(SUM(ft.amount),0) AS ledger_amount
    FROM payments p
    LEFT JOIN financial_transactions ft ON ft.payment_id = p.id
    WHERE p.status = 'completed' AND p.id IN (SELECT DISTINCT payment_id FROM financial_transactions WHERE payment_id IS NOT NULL)
  `;
  const mismatchSql = boundBranchId === null
    ? `${mismatchBase} GROUP BY p.id HAVING p.amount <> COALESCE(SUM(ft.amount),0) ORDER BY p.date DESC LIMIT 100`
    : `${mismatchBase} AND p.branch_id = ? GROUP BY p.id HAVING p.amount <> COALESCE(SUM(ft.amount),0) ORDER BY p.date DESC LIMIT 100`;
  const mismatchRows = (boundBranchId === null
    ? db.prepare(mismatchSql).all()
    : db.prepare(mismatchSql).all(boundBranchId)) as Array<{ payment_id: string; payment_amount: number; ledger_amount: number }>;

  // ── Cash position ────────────────────────────────────────────────────────
  // The payment/ledger check above compares two views of the SAME table family
  // and so cannot see a money path that updates the ledger but not the cash
  // account. That blind spot hid F-10: a book-sale refund wrote a -500 contra
  // row and never debited finance_accounts, leaving 500 AFN of phantom cash
  // that every reconciliation still reported as healthy.
  //
  // The formula must mirror how money ACTUALLY moves in this system:
  //   * every non-equity income row credits branch cash (the CASH predicate,
  //     not the trading-result predicate — a rogue row the taxonomy excludes
  //     still moved, or failed to move, real money), and the savings sweep
  //     moves a slice of it into the branch saving account;
  //   * `capital_injection` credits the ORGANIZATION treasury, not branch cash,
  //     even though the row is stamped with the operator's branch;
  //   * `budget_charge` debits the ORGANIZATION treasury into a budget line;
  //   * `expense` rows are paid FROM budget lines (payroll, utilities), so they
  //     do not debit branch cash either.
  //
  // Hence, per branch:
  //     main_balance   = SUM(saving-account movement) subtracted from income
  //     saving_balance = SUM(saving-account movement)
  //
  // `saving_transfer` means the branch SAVINGS ACCOUNT and nothing else: any
  // other movement carrying that type makes this check report a savings balance
  // the branch does not have. Budget movements carry their own type.
  //   * an OWNER DRAWING (written by `bos.routes.ts`) is the one expense path
  //     that debits BRANCH CASH directly instead of a budget line, so it has to
  //     come off expected main.
  const cashIncomeSql = `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE ${BRANCH_CASH_INCOME_SQL}`;
  const savingSql = `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE type='saving_transfer'`;
  // Owner drawings are a NON-EXPENSE CASH MOVEMENT paid straight out of branch
  // cash. Omitting them here would open a permanent cashVariance equal to every
  // withdrawal ever made and report a perfectly healthy branch as broken.
  const ownerDrawingSql =
    `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE ${OWNER_DRAWING_SQL}`;
  const cashIncome = scalarValue(cashIncomeSql, 'AND branch_id = ?', boundBranchId);
  const expectedSaving = scalarValue(savingSql, 'AND branch_id = ?', boundBranchId);
  const ownerDrawings = scalarValue(ownerDrawingSql, 'AND branch_id = ?', boundBranchId);
  // W16: clawback repayments move branch cash out through a P&L-neutral type;
  // expected main must fall with them or every post-reclaim branch shows a
  // permanent phantom-cash variance.
  const reclaimSql = `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE type='restricted_reclaim'`;
  const reclaims = scalarValue(reclaimSql, 'AND branch_id = ?', boundBranchId);
  // W20: supplier refunds are P&L-neutral cash INTO branch main.
  const supplierRefundSql = `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE type='supplier_refund'`;
  const supplierRefunds = scalarValue(supplierRefundSql, 'AND branch_id = ?', boundBranchId);
  // Whole AFN throughout (D-12/D-22): every money column is an INTEGER, so a
  // variance is either zero or a real discrepancy. A two-decimal tolerance here
  // would only hide a genuine one-afghani break.
  const expectedMain = cashIncome - expectedSaving - ownerDrawings + reclaims + supplierRefunds;

  const acctSql = `SELECT COALESCE(SUM(main_balance),0) AS main, COALESCE(SUM(saving_balance),0) AS saving FROM finance_accounts WHERE scope_type = 'branch'`;
  const acctRow = (boundBranchId === null
    ? db.prepare(acctSql).get()
    : db.prepare(`${acctSql} AND scope_id = ?`).get(boundBranchId)) as { main: number; saving: number };

  const cashVariance = Number(acctRow.main || 0) - expectedMain;
  const savingVariance = Number(acctRow.saving || 0) - expectedSaving;

  // ── Budget position ──────────────────────────────────────────────────────
  // Budget lines are the THIRD store of money in this system (after branch cash
  // and the organization treasury), and nothing reconciled them. Payroll and
  // operational expenses are paid from a budget line, so a route that writes an
  // expense row without decrementing the line — or decrements without writing
  // the row — silently misstates what the institute can still spend.
  //
  // Invariant, per branch:
  //     SUM(current_amount) = SUM(budget movement) - SUM(expense)
  //
  // A budget movement is SIGNED (see core/finance/budget-movements): funding a
  // line is positive, returning it to the treasury or moving it to another line
  // is negative, so the sum is the money currently placed in the branch's
  // envelopes. Movement rows carry the line in reference_id; expense rows are
  // matched by branch, which is the same granularity the lines are held at.
  //
  // The spend side counts only expense rows that actually CAME OUT OF a budget
  // line. Owner drawings do not: they debit branch cash, so counting them here
  // would make every withdrawal look like unexplained budget spend.
  const budgetChargedSql = `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE type='${BUDGET_MOVEMENT_TYPE}'`;
  const budgetSpentSql =
    `SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions ` +
    `WHERE type='expense' AND NOT ${OWNER_DRAWING_SQL}`;
  const budgetCharged = scalarValue(budgetChargedSql, 'AND branch_id = ?', boundBranchId);
  const budgetSpent = scalarValue(budgetSpentSql, 'AND branch_id = ?', boundBranchId);
  const expectedBudget = budgetCharged - budgetSpent;

  const lineSql = `SELECT COALESCE(SUM(current_amount),0) AS v FROM budget_lines WHERE 1=1`;
  const actualBudget = scalarValue(lineSql, 'AND branch_id = ?', boundBranchId);
  const budgetVariance = actualBudget - expectedBudget;

  return {
    scope: isAll ? 'organization' : 'branch',
    branchId: branchId || null,
    paymentBackedTotal: paymentBacked,
    ledgerBackedTotal: ledgerBacked,
    paymentBackedCount: paymentCount,
    ledgerBackedCount: ledgerCount,
    amountVariance: paymentBacked - ledgerBacked,
    unmatchedPayments,
    orphanLedgerRows,
    mismatchedPayments: mismatchRows.map((r) => ({
      paymentId: r.payment_id,
      paymentAmount: r.payment_amount,
      ledgerAmount: r.ledger_amount,
      variance: Number(r.payment_amount) - Number(r.ledger_amount),
    })),
    cashVariance,
    savingVariance,
    budgetVariance,
    healthy: paymentBacked === ledgerBacked && unmatchedPayments === 0 && orphanLedgerRows === 0 && mismatchRows.length === 0
      && cashVariance === 0 && savingVariance === 0 && budgetVariance === 0,
  };
}
