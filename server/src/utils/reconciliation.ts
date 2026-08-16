/**
 * Payment ↔ ledger reconciliation — shared by GET /finance/reconciliation
 * and GET /finance/dashboard so the health check is computed from exactly
 * one code path (backend-only financials: the numbers always come from SQL).
 *
 * Scope handling: branch-scoped queries bind branch_id; organization-scoped
 * queries pass NO parameters at all. Passing `undefined` to a prepared
 * statement with zero placeholders throws "Too many parameter values" in
 * better-sqlite3 — this used to break the owner (branchId=all) path.
 */
import { db } from '../db/connection.js';

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
    ? `${mismatchBase} GROUP BY p.id HAVING ABS(p.amount - COALESCE(SUM(ft.amount),0)) >= 0.01 ORDER BY p.date DESC LIMIT 100`
    : `${mismatchBase} AND p.branch_id = ? GROUP BY p.id HAVING ABS(p.amount - COALESCE(SUM(ft.amount),0)) >= 0.01 ORDER BY p.date DESC LIMIT 100`;
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
  // Invariant, per branch:
  //     main_balance   = income - expense - saving_transfer
  //     saving_balance = saving_transfer
  const cashSql = `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount WHEN type='expense' THEN -amount WHEN type='saving_transfer' THEN -amount ELSE 0 END),0) AS v FROM financial_transactions WHERE 1=1`;
  const savingSql = `SELECT COALESCE(SUM(CASE WHEN type='saving_transfer' THEN amount ELSE 0 END),0) AS v FROM financial_transactions WHERE 1=1`;
  const expectedMain = scalarValue(cashSql, 'AND branch_id = ?', boundBranchId);
  const expectedSaving = scalarValue(savingSql, 'AND branch_id = ?', boundBranchId);

  const acctSql = `SELECT COALESCE(SUM(main_balance),0) AS main, COALESCE(SUM(saving_balance),0) AS saving FROM finance_accounts WHERE scope_type = 'branch'`;
  const acctRow = (boundBranchId === null
    ? db.prepare(acctSql).get()
    : db.prepare(`${acctSql} AND scope_id = ?`).get(boundBranchId)) as { main: number; saving: number };

  const cashVariance = Math.round((Number(acctRow.main || 0) - expectedMain) * 100) / 100;
  const savingVariance = Math.round((Number(acctRow.saving || 0) - expectedSaving) * 100) / 100;

  return {
    scope: isAll ? 'organization' : 'branch',
    branchId: branchId || null,
    paymentBackedTotal: paymentBacked,
    ledgerBackedTotal: ledgerBacked,
    paymentBackedCount: paymentCount,
    ledgerBackedCount: ledgerCount,
    amountVariance: Math.round((paymentBacked - ledgerBacked) * 100) / 100,
    unmatchedPayments,
    orphanLedgerRows,
    mismatchedPayments: mismatchRows.map((r) => ({
      paymentId: r.payment_id,
      paymentAmount: r.payment_amount,
      ledgerAmount: r.ledger_amount,
      variance: Math.round((Number(r.payment_amount) - Number(r.ledger_amount)) * 100) / 100,
    })),
    cashVariance,
    savingVariance,
    healthy: Math.abs(paymentBacked - ledgerBacked) < 0.01 && unmatchedPayments === 0 && orphanLedgerRows === 0 && mismatchRows.length === 0
      && Math.abs(cashVariance) < 0.01 && Math.abs(savingVariance) < 0.01,
  };
}
