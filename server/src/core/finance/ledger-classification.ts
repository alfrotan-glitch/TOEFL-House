/**
 * Ledger classification — THE authority for "how does this row affect the books?".
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `financial_transactions.type` is CHECK-constrained to four values
 * (income | expense | saving_transfer | budget_charge), but `type` alone does
 * not say whether a row belongs in the trading result. Three treatments must be
 * told apart, and the difference is worth real money:
 *
 *   operating_expense          hits the trading result
 *   capital_expenditure        buys a fixed asset — cash out, not a P&L cost
 *   non_expense_cash_movement  salary advances, refunds, owner drawings,
 *                              charitable contributions — cash moves, no cost
 *
 * The rule lives here and every consumer imports it, because the failure mode
 * of a duplicated rule is silent and expensive: a surface that keeps its own
 * copy will one day report a different profit for the same day and branch than
 * the P&L does, and nothing will fail to tell anybody.
 *
 * HOW IT WORKS NOW
 * ----------------
 * Classification is resolved through `financial_transactions.finance_category_id`,
 * a FOREIGN KEY into `finance_categories`. There is no string table, no name
 * matching and no second vocabulary to keep in step: the predicates below read
 * `finance_categories.classification` directly, so adding a subcategory to
 * Capital Expenditure automatically keeps it out of operating expense in the
 * P&L, the cash-flow series, `/reports/overview`, the expense report and the
 * reconciler, with no second edit anywhere.
 *
 * A NULL `finance_category_id` on an expense row resolves to `operating_expense`.
 * That is the conservative default: an uncategorised cost must never vanish
 * from the cost side of the P&L.
 *
 * INCOME IS NOT IN THE TAXONOMY
 * -----------------------------
 * The canonical taxonomy models the EXPENSE side. Income rows carry the billing
 * vocabulary (`fee`, `book`, `exam`, `placement`, `donation`, `card`, …) in
 * `category` and leave `finance_category_id` NULL. The single income rule that
 * matters — owner capital is not revenue — stays a named constant.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * -----------------------------------------
 * It does not decide whether a movement should be VISIBLE. Capital expenditure,
 * non-expense cash movements and equity transfers are all REPORTED, each on its
 * own line. They simply are not revenue or operating cost. This module only
 * answers "does this row belong in the trading result?".
 */
import {
  CANONICAL_CATEGORIES,
  classificationOf,
  type FinanceCategoryClassification,
} from './category-taxonomy.js';

/** Income rows in this category are owner capital, not revenue. */
export const CAPITAL_INJECTION_CATEGORY = 'capital_injection';

/**
 * The canonical node for owner drawings.
 *
 * Singled out because it is the one expense path that debits BRANCH CASH
 * directly instead of a budget line, which the reconciler has to know about.
 */
export const OWNER_DRAWINGS_CATEGORY_ID = 'sub_owner_drawings';

/** Canonical node for a genuine salary advance (a receivable, not a cost). */
export const SALARY_ADVANCE_CATEGORY_ID = 'sub_salary_advances';

/** Canonical node for salary that has already accrued (a wage cost). */
export const SALARIES_WAGES_CATEGORY_ID = 'sub_salaries_wages';

/** Qualify a column with an optional table alias. */
const col = (name: string, alias?: string) => (alias ? `${alias}.${name}` : name);

/**
 * SQL predicate: an EXPENSE row with the given accounting treatment.
 *
 * The classification is read from `finance_categories` rather than from a list
 * compiled into this file, so the database and the application can never hold
 * two different opinions about the same node.
 */
export function expenseClassificationSql(
  classification: FinanceCategoryClassification,
  alias?: string,
): string {
  const type = col('type', alias);
  const fk = col('finance_category_id', alias);
  const lookup = `(SELECT fc.classification FROM finance_categories fc WHERE fc.id = ${fk})`;
  return classification === 'operating_expense'
    // NULL → operating expense: an uncategorised cost must never disappear.
    ? `(${type} = 'expense' AND COALESCE(${lookup}, 'operating_expense') = 'operating_expense')`
    : `(${type} = 'expense' AND ${lookup} = '${classification}')`;
}

/** SQL predicate: the row is OPERATING income. */
export function operatingIncomeSql(alias?: string): string {
  return `(${col('type', alias)} = 'income' AND ${col('category', alias)} <> '${CAPITAL_INJECTION_CATEGORY}')`;
}

/** SQL predicate: the row is OPERATING expense. */
export function operatingExpenseSql(alias?: string): string {
  return expenseClassificationSql('operating_expense', alias);
}

/** SQL predicate: the expense row is a FIXED ASSET purchase. */
export function capitalExpenditureSql(alias?: string): string {
  return expenseClassificationSql('capital_expenditure', alias);
}

/** SQL predicate: the expense row moves cash without incurring operating cost. */
export function nonExpenseCashMovementSql(alias?: string): string {
  return expenseClassificationSql('non_expense_cash_movement', alias);
}

/**
 * SQL predicate: an owner-equity movement, not trading activity.
 * Capital IN is an income category; drawings OUT are a taxonomy node.
 */
export function equityTransferSql(alias?: string): string {
  return (
    `((${col('type', alias)} = 'income' AND ${col('category', alias)} = '${CAPITAL_INJECTION_CATEGORY}')` +
    ` OR (${col('type', alias)} = 'expense' AND ${col('finance_category_id', alias)} IS '${OWNER_DRAWINGS_CATEGORY_ID}'))`
  );
}

/**
 * SQL predicate: an owner drawing — the only expense paid straight from branch
 * cash rather than out of a budget line.
 *
 * `IS` rather than `=` is load-bearing. The reconciler needs the NEGATION of
 * this predicate, and `NOT (fk = 'x')` evaluates to NULL — not TRUE — when `fk`
 * is NULL, which silently dropped every uncategorised expense row out of the
 * budget-spend total and hid real budget drift. `IS` is null-safe, so the
 * negation behaves.
 */
export function ownerDrawingSql(alias?: string): string {
  return `(${col('type', alias)} = 'expense' AND ${col('finance_category_id', alias)} IS '${OWNER_DRAWINGS_CATEGORY_ID}')`;
}

// Unaliased forms, for the many statements that query the table directly.
export const OPERATING_INCOME_SQL = operatingIncomeSql();
export const OPERATING_EXPENSE_SQL = operatingExpenseSql();
export const CAPITAL_EXPENDITURE_SQL = capitalExpenditureSql();
export const NON_EXPENSE_CASH_MOVEMENT_SQL = nonExpenseCashMovementSql();
export const EQUITY_TRANSFER_SQL = equityTransferSql();
export const OWNER_DRAWING_SQL = ownerDrawingSql();

/** A ledger row as the in-memory helpers below need to see it. */
export interface ClassifiableRow {
  type?: string | null;
  category?: string | null;
  financeCategoryId?: string | null;
  finance_category_id?: string | null;
}

const nodeOf = (row: ClassifiableRow): string | null =>
  row.financeCategoryId ?? row.finance_category_id ?? null;

/**
 * Classify an expense row in memory.
 * Mirrors `expenseClassificationSql` exactly, including the NULL default.
 */
export function classifyExpenseRow(row: ClassifiableRow): FinanceCategoryClassification {
  return classificationOf(nodeOf(row));
}

/** In-memory counterpart, for callers that already hold a row. */
export function isOperatingIncome(row: ClassifiableRow): boolean {
  return row.type === 'income' && row.category !== CAPITAL_INJECTION_CATEGORY;
}

/** In-memory counterpart, for callers that already hold a row. */
export function isOperatingExpense(row: ClassifiableRow): boolean {
  return row.type === 'expense' && classifyExpenseRow(row) === 'operating_expense';
}

/** True when the expense row buys a fixed asset. */
export function isCapitalExpenditure(row: ClassifiableRow): boolean {
  return row.type === 'expense' && classifyExpenseRow(row) === 'capital_expenditure';
}

/** True when the expense row moves cash without incurring an operating cost. */
export function isNonExpenseCashMovement(row: ClassifiableRow): boolean {
  return row.type === 'expense' && classifyExpenseRow(row) === 'non_expense_cash_movement';
}

/** True when the row moves owner equity rather than trading value. */
export function isEquityTransfer(row: ClassifiableRow): boolean {
  return (
    (row.type === 'income' && row.category === CAPITAL_INJECTION_CATEGORY) ||
    (row.type === 'expense' && nodeOf(row) === OWNER_DRAWINGS_CATEGORY_ID)
  );
}

/** Every canonical node with the given treatment. Used by reports and tests. */
export function nodesWithClassification(
  classification: FinanceCategoryClassification,
): string[] {
  return CANONICAL_CATEGORIES.filter((c) => c.classification === classification).flatMap((c) => [
    c.id,
    ...c.children.map((s) => s.id),
  ]);
}
