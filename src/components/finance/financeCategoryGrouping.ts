/**
 * Grouping helpers for the canonical finance hierarchy.
 * ============================================================================
 * These functions ARRANGE data the server already resolved. They contain no
 * accounting knowledge whatsoever:
 *
 *   · they never map a budget line to a category — the server sends
 *     `subcategoryId` / `categoryId` and the browser is not allowed to guess;
 *   · they never decide a classification — the server sends `classification`;
 *   · they never invent a bucket.
 *
 * Ordering comes from `sortOrder`, which the server writes from the canonical
 * taxonomy — never from alphabetical accident.
 */
import type {
  BudgetLine,
  FinanceCategory,
  FinanceCategoryClassification,
} from '../../types';

export const CLASSIFICATION_LABEL: Record<FinanceCategoryClassification, string> = {
  operating_expense: 'Operating expense',
  capital_expenditure: 'Capital expenditure',
  non_expense_cash_movement: 'Non-expense cash movement',
};

export const CLASSIFICATION_SHORT: Record<FinanceCategoryClassification, string> = {
  operating_expense: 'Opex',
  capital_expenditure: 'CapEx',
  non_expense_cash_movement: 'Non-expense',
};

/** Tailwind classes per treatment, so the three are never visually confusable. */
export const CLASSIFICATION_BADGE: Record<FinanceCategoryClassification, string> = {
  operating_expense: 'bg-slate-100 text-slate-700 border-slate-200',
  capital_expenditure: 'bg-sky-50 text-sky-700 border-sky-200',
  non_expense_cash_movement: 'bg-violet-50 text-violet-700 border-violet-200',
};

export interface BudgetLineGroup {
  subcategoryId: string;
  subcategoryName: string;
  lines: BudgetLine[];
}

export interface BudgetCategoryGroup {
  categoryId: string;
  categoryName: string;
  classification: FinanceCategoryClassification;
  groups: BudgetLineGroup[];
  lineCount: number;
  allocated: number;
  remaining: number;
}

const bySortOrder = (a: BudgetLine, b: BudgetLine) =>
  (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name);

/**
 * Arrange budget lines under the canonical taxonomy.
 *
 * A category is emitted only when it actually holds a budget line, so the
 * picker never offers an empty branch — which is the whole point of keeping the
 * budget sparse while the taxonomy stays complete.
 */
export function groupBudgetLines(
  budgetLines: BudgetLine[],
  categories: FinanceCategory[],
): BudgetCategoryGroup[] {
  const active = budgetLines.filter((line) => line.isActive !== false);
  const result: BudgetCategoryGroup[] = [];

  for (const category of [...categories].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const groups: BudgetLineGroup[] = [];

    for (const sub of [...category.subcategories].sort((a, b) => a.sortOrder - b.sortOrder)) {
      const lines = active.filter((line) => line.subcategoryId === sub.id).sort(bySortOrder);
      if (!lines.length) continue;
      groups.push({ subcategoryId: sub.id, subcategoryName: sub.name, lines });
    }
    if (!groups.length) continue;

    const lines = groups.flatMap((g) => g.lines);
    result.push({
      categoryId: category.id,
      categoryName: category.name,
      classification: category.classification,
      groups,
      lineCount: lines.length,
      allocated: lines.reduce((sum, l) => sum + (l.allocatedAmount || 0), 0),
      remaining: lines.reduce((sum, l) => sum + (l.currentAmount || 0), 0),
    });
  }

  return result;
}

/** Human path for one budget line: "Category › Subcategory › Line". */
export function budgetLinePath(line: BudgetLine): string {
  return [line.categoryName, line.subcategoryName, line.name].filter(Boolean).join(' › ');
}
