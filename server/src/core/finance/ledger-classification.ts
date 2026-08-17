/**
 * Ledger classification — THE authority for "is this row operating activity?".
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `financial_transactions.type` is CHECK-constrained to four values
 * (income | expense | saving_transfer | budget_charge), but two CATEGORIES
 * inside `income`/`expense` are not trading activity at all:
 *
 *   income  / capital_injection    owner capital paid INTO the treasury
 *   expense / profit_distribution  owner drawings paid OUT of it
 *
 * Both are movements of OWNER EQUITY. Counting them as revenue or cost
 * overstates the trading result and, in the case of capital injection, invents
 * revenue that no student ever paid.
 *
 * Three places already knew this and each implemented it privately:
 *
 *   reports.routes.ts      `category != 'capital_injection'` / `!= 'profit_distribution'`
 *   finance.routes.ts      branches them into separate `capitalInjection` / `profitDistribution` buckets
 *   utils/reconciliation   `category <> 'capital_injection'` for expected branch cash
 *
 * `core/dashboard/dashboard-summary.ts` did NOT. Its cash-flow series summed
 * every `type='income'` and `type='expense'` row, so on a day with a 100,000
 * owner capital injection and a 50,000 owner drawing the Dashboard reported
 * income 100,000 / expense 50,000 while `/finance/pnl` and `/reports/overview`
 * both reported 0 / 0 for the same day and branch — verified live.
 *
 * A fourth private copy would have made that worse, so the rule lives here and
 * every consumer imports it.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * -----------------------------------------
 * It does not decide whether a transfer should be VISIBLE. `/reports/overview`
 * rightly surfaces capital injections and drawings under a separate
 * `transfers` block, and `/finance/pnl` reports them as their own lines. Owner
 * equity movements matter — they simply are not revenue or cost. This module
 * only answers "does this row belong in the trading result?".
 */

/** Income rows in this category are owner capital, not revenue. */
export const CAPITAL_INJECTION_CATEGORY = 'capital_injection';

/** Expense rows in this category are owner drawings, not operating cost. */
export const PROFIT_DISTRIBUTION_CATEGORY = 'profit_distribution';

/**
 * SQL predicate: the row is OPERATING income.
 *
 * Written as a full predicate rather than a bare category test so a caller
 * cannot accidentally apply it to the wrong `type` and silently include
 * expenses in a revenue figure.
 */
export const OPERATING_INCOME_SQL = `(type = 'income' AND category <> '${CAPITAL_INJECTION_CATEGORY}')`;

/** SQL predicate: the row is OPERATING expense. */
export const OPERATING_EXPENSE_SQL = `(type = 'expense' AND category <> '${PROFIT_DISTRIBUTION_CATEGORY}')`;

/**
 * SQL predicate: the row is an owner-equity movement, not trading activity.
 * Useful for surfaces that want to REPORT transfers separately rather than
 * exclude them entirely.
 */
export const EQUITY_TRANSFER_SQL =
  `((type = 'income' AND category = '${CAPITAL_INJECTION_CATEGORY}')` +
  ` OR (type = 'expense' AND category = '${PROFIT_DISTRIBUTION_CATEGORY}'))`;

/** In-memory counterpart, for callers that already hold a row. */
export function isOperatingIncome(row: { type?: string | null; category?: string | null }): boolean {
  return row.type === 'income' && row.category !== CAPITAL_INJECTION_CATEGORY;
}

/** In-memory counterpart, for callers that already hold a row. */
export function isOperatingExpense(row: { type?: string | null; category?: string | null }): boolean {
  return row.type === 'expense' && row.category !== PROFIT_DISTRIBUTION_CATEGORY;
}

/** True when the row moves owner equity rather than trading value. */
export function isEquityTransfer(row: { type?: string | null; category?: string | null }): boolean {
  return (
    (row.type === 'income' && row.category === CAPITAL_INJECTION_CATEGORY) ||
    (row.type === 'expense' && row.category === PROFIT_DISTRIBUTION_CATEGORY)
  );
}
