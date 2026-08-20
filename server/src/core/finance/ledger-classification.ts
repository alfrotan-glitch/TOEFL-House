/**
 * Ledger classification — THE authority for "is this row operating activity?".
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `financial_transactions.type` is CHECK-constrained to four values
 * (income | expense | saving_transfer | budget_charge), but the `category`
 * column is free text and several categories inside `income`/`expense` are not
 * trading activity at all:
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
 * WHAT CHANGED WITH THE CANONICAL TAXONOMY (migration 077)
 * --------------------------------------------------------
 * "Not operating cost" used to mean exactly one thing: owner drawings. The
 * canonical taxonomy (`core/finance/category-taxonomy.ts`) makes the business
 * distinguish THREE treatments, and two of them must stay out of operating
 * expense:
 *
 *   capital_expenditure         fixed asset purchases (IT equipment, vehicles,
 *                               furniture…) — cash out, not trading cost
 *   non_expense_cash_movement   salary advances, refunds, owner drawings,
 *                               charitable contributions
 *
 * KNOWN LIMIT — read this before trusting the non-expense total.
 * `POST /employees/:id/pay-salary` and the teacher payroll path write
 * `payment_type='advance'` rows as `expense` / category `salary`, so a PAYROLL
 * advance is still an operating expense and is NOT counted here. Only spend
 * booked against a Non-Expense Cash Movement BUDGET LINE reaches this bucket.
 * Changing the payroll write path restates payroll and moves the budget
 * reconciler, so it is deliberately out of scope for the taxonomy migration and
 * is tracked in docs/finance-category-followups.md (FU-1).
 *
 * Those sets are DERIVED from the taxonomy rather than typed out again here,
 * so adding a subcategory to `cat_capital_expenditure` automatically keeps it
 * out of operating expense in the P&L, the cash-flow series, `/reports/overview`
 * and the expense report — with no second edit and no chance of the four
 * surfaces disagreeing.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * -----------------------------------------
 * It does not decide whether a movement should be VISIBLE. `/reports/overview`
 * rightly surfaces capital injections and drawings under a separate
 * `transfers` block, and `/finance/pnl` reports capital expenditure and
 * non-expense movements as their own lines. They matter — they simply are not
 * revenue or operating cost. This module only answers "does this row belong in
 * the trading result?".
 *
 * It also does not rewrite history: `financial_transactions.category` is
 * immutable text and is classified by LOOKUP, never by UPDATE.
 */
import {
  CANONICAL_CATEGORIES,
  LEGACY_PURPOSE_MAP,
  classificationOf,
  type FinanceCategoryClassification,
} from './category-taxonomy.js';

/** Income rows in this category are owner capital, not revenue. */
export const CAPITAL_INJECTION_CATEGORY = 'capital_injection';

/** Expense rows in this category are owner drawings, not operating cost. */
export const PROFIT_DISTRIBUTION_CATEGORY = 'profit_distribution';

/**
 * Build the ledger-category → classification index.
 *
 * A ledger row's `category` is whatever `payFromBudgetLine` copied out of
 * `budget_lines.purpose`, so the index has to cover BOTH vocabularies:
 *
 *   · legacy purposes            'equipment', 'rent', 'misc', …
 *   · canonical node ids          'sub_it_equipment', 'sub_owner_drawings', …
 *
 * Both are resolved through the taxonomy, so there is exactly one definition
 * of "IT equipment is capex" in the codebase.
 */
function buildLedgerCategoryIndex(): Map<string, FinanceCategoryClassification> {
  const index = new Map<string, FinanceCategoryClassification>();

  // Canonical vocabulary: every category and subcategory id may appear as a
  // budget line purpose and therefore as a ledger category.
  for (const category of CANONICAL_CATEGORIES) {
    index.set(category.id, category.classification);
    for (const sub of category.children) index.set(sub.id, category.classification);
  }

  // Legacy vocabulary: resolve each historical purpose through its canonical
  // mapping. Unmapped/ambiguous purposes deliberately resolve to
  // `operating_expense`, i.e. exactly the behaviour they had before — an
  // undecided category must never vanish from the cost side of the P&L.
  for (const [purpose, mapping] of Object.entries(LEGACY_PURPOSE_MAP)) {
    index.set(purpose, classificationOf(mapping.categoryId));
  }

  // Owner drawings predate the taxonomy and are written by `bos.routes.ts`
  // under their own historical category name. They are the canonical
  // "Owner's Drawings" node in every respect that matters.
  index.set(PROFIT_DISTRIBUTION_CATEGORY, 'non_expense_cash_movement');

  return index;
}

const LEDGER_CATEGORY_CLASSIFICATION = buildLedgerCategoryIndex();

/** Ledger categories whose expense rows are FIXED ASSET purchases. */
export const CAPITAL_EXPENDITURE_CATEGORIES: ReadonlySet<string> = new Set(
  [...LEDGER_CATEGORY_CLASSIFICATION.entries()]
    .filter(([, c]) => c === 'capital_expenditure')
    .map(([k]) => k),
);

/** Ledger categories whose expense rows move cash without incurring cost. */
export const NON_EXPENSE_CASH_MOVEMENT_CATEGORIES: ReadonlySet<string> = new Set(
  [...LEDGER_CATEGORY_CLASSIFICATION.entries()]
    .filter(([, c]) => c === 'non_expense_cash_movement')
    .map(([k]) => k),
);

/** Every expense-side category that must be kept OUT of operating expense. */
export const NON_OPERATING_EXPENSE_CATEGORIES: ReadonlySet<string> = new Set([
  ...CAPITAL_EXPENDITURE_CATEGORIES,
  ...NON_EXPENSE_CASH_MOVEMENT_CATEGORIES,
]);

/**
 * Classify the ledger category of an EXPENSE row.
 * Unknown categories are operating expense — see the note in
 * `buildLedgerCategoryIndex`.
 */
export function classifyExpenseCategory(category: string | null | undefined): FinanceCategoryClassification {
  if (!category) return 'operating_expense';
  return LEDGER_CATEGORY_CLASSIFICATION.get(category) ?? 'operating_expense';
}

/** SQL list literal, e.g. `'a','b'`. Values come from the compiled taxonomy. */
function sqlList(values: Iterable<string>): string {
  const items = [...values];
  // A NOT IN () against an empty list is a syntax error in SQLite; the sentinel
  // keeps the predicate valid and matches nothing.
  if (items.length === 0) return `''`;
  return items.map((v) => `'${v.replace(/'/g, "''")}'`).join(',');
}

const NON_OPERATING_EXPENSE_SQL_LIST = sqlList(NON_OPERATING_EXPENSE_CATEGORIES);

/**
 * SQL predicate: the row is OPERATING income.
 *
 * Written as a full predicate rather than a bare category test so a caller
 * cannot accidentally apply it to the wrong `type` and silently include
 * expenses in a revenue figure.
 */
export const OPERATING_INCOME_SQL = `(type = 'income' AND category <> '${CAPITAL_INJECTION_CATEGORY}')`;

/**
 * SQL predicate: the row is OPERATING expense.
 * Excludes owner drawings, every capital expenditure category and every
 * non-expense cash movement category.
 */
export const OPERATING_EXPENSE_SQL =
  `(type = 'expense' AND category NOT IN (${NON_OPERATING_EXPENSE_SQL_LIST}))`;

/** SQL predicate: the expense row is a FIXED ASSET purchase. */
export const CAPITAL_EXPENDITURE_SQL =
  `(type = 'expense' AND category IN (${sqlList(CAPITAL_EXPENDITURE_CATEGORIES)}))`;

/** SQL predicate: the expense row moves cash without incurring operating cost. */
export const NON_EXPENSE_CASH_MOVEMENT_SQL =
  `(type = 'expense' AND category IN (${sqlList(NON_EXPENSE_CASH_MOVEMENT_CATEGORIES)}))`;

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
  return row.type === 'expense' && classifyExpenseCategory(row.category) === 'operating_expense';
}

/** True when the expense row buys a fixed asset. */
export function isCapitalExpenditure(row: { type?: string | null; category?: string | null }): boolean {
  return row.type === 'expense' && classifyExpenseCategory(row.category) === 'capital_expenditure';
}

/** True when the expense row moves cash without incurring an operating cost. */
export function isNonExpenseCashMovement(row: { type?: string | null; category?: string | null }): boolean {
  return row.type === 'expense' && classifyExpenseCategory(row.category) === 'non_expense_cash_movement';
}

/** True when the row moves owner equity rather than trading value. */
export function isEquityTransfer(row: { type?: string | null; category?: string | null }): boolean {
  return (
    (row.type === 'income' && row.category === CAPITAL_INJECTION_CATEGORY) ||
    (row.type === 'expense' && row.category === PROFIT_DISTRIBUTION_CATEGORY)
  );
}
