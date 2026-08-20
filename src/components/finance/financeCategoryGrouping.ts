/**
 * Grouping helpers for the canonical finance hierarchy.
 * ============================================================================
 * These functions ARRANGE data the server already resolved. They deliberately
 * contain no accounting knowledge whatsoever:
 *
 *   · they never map a budget line to a category — the server sends
 *     `categoryId` / `subcategoryId` and the browser is not allowed to guess;
 *   · they never decide a classification — the server sends `classification`;
 *   · they never invent a bucket. A line the upgrade could not classify lands
 *     in an explicit "Unclassified" group so the operator can SEE that a
 *     decision is outstanding, instead of it hiding inside a plausible-looking
 *     category.
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
  subcategoryId: string | null;
  subcategoryName: string;
  lines: BudgetLine[];
}

export interface BudgetCategoryGroup {
  categoryId: string | null;
  categoryName: string;
  classification: FinanceCategoryClassification;
  /** True for the synthetic "Unclassified" bucket — never a real category. */
  isUnclassified: boolean;
  /**
   * True for the synthetic bucket holding lines that are DELIBERATELY outside
   * the expense taxonomy (the contingency Reserve). A settled decision, not an
   * open one — the distinction matters, see `groupBudgetLines`.
   */
  isOutOfTaxonomy: boolean;
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
 * Every category in the taxonomy is emitted only when it actually holds a
 * budget line, so the picker never offers an empty branch. Lines whose category
 * the server left NULL are collected into a single, clearly-labelled
 * unclassified group at the end.
 */
export function groupBudgetLines(
  budgetLines: BudgetLine[],
  categories: FinanceCategory[],
): BudgetCategoryGroup[] {
  const active = budgetLines.filter((line) => line.isActive !== false);
  const consumed = new Set<string>();
  const result: BudgetCategoryGroup[] = [];

  const orderedCategories = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);

  for (const category of orderedCategories) {
    const groups: BudgetLineGroup[] = [];

    const orderedSubs = [...category.subcategories].sort((a, b) => a.sortOrder - b.sortOrder);
    for (const sub of orderedSubs) {
      const lines = active.filter((line) => line.subcategoryId === sub.id).sort(bySortOrder);
      if (!lines.length) continue;
      lines.forEach((line) => consumed.add(line.id));
      groups.push({ subcategoryId: sub.id, subcategoryName: sub.name, lines });
    }

    // Lines attached at CATEGORY level: the upgrade proved the accounting
    // treatment but not the subcategory. Shown under the category, flagged.
    const categoryLevel = active
      .filter((line) => line.categoryId === category.id && !line.subcategoryId)
      .sort(bySortOrder);
    if (categoryLevel.length) {
      categoryLevel.forEach((line) => consumed.add(line.id));
      groups.push({ subcategoryId: null, subcategoryName: 'Subcategory not yet assigned', lines: categoryLevel });
    }

    if (!groups.length) continue;

    const lines = groups.flatMap((g) => g.lines);
    result.push({
      categoryId: category.id,
      categoryName: category.name,
      classification: category.classification,
      isUnclassified: false,
      isOutOfTaxonomy: false,
      groups,
      lineCount: lines.length,
      allocated: lines.reduce((sum, l) => sum + (l.allocatedAmount || 0), 0),
      remaining: lines.reduce((sum, l) => sum + (l.currentAmount || 0), 0),
    });
  }

  // Lines with no canonical node fall into ONE OF TWO buckets, and conflating
  // them is a real misrepresentation:
  //
  //   out_of_taxonomy  a SETTLED decision — the contingency Reserve is not an
  //                    expense classification and deliberately has no node.
  //   everything else  an OPEN decision the upgrade refused to guess.
  //
  // These were previously merged into a single "needs an owner decision" group,
  // which told the owner that Reserve was waiting on them when it was not.
  const orphans = active.filter((line) => !consumed.has(line.id)).sort(bySortOrder);
  const outOfTaxonomy = orphans.filter((line) => line.mappingStatus === 'out_of_taxonomy');
  const undecided = orphans.filter((line) => line.mappingStatus !== 'out_of_taxonomy');

  const syntheticGroup = (
    lines: BudgetLine[],
    categoryName: string,
    subcategoryName: string,
    flags: { isUnclassified: boolean; isOutOfTaxonomy: boolean },
  ): BudgetCategoryGroup => ({
    categoryId: null,
    categoryName,
    // Behaviour is unchanged from before the upgrade: still operating expense.
    // The LABEL is what carries the meaning, not a reclassification.
    classification: 'operating_expense',
    ...flags,
    groups: [{ subcategoryId: null, subcategoryName, lines }],
    lineCount: lines.length,
    allocated: lines.reduce((sum, l) => sum + (l.allocatedAmount || 0), 0),
    remaining: lines.reduce((sum, l) => sum + (l.currentAmount || 0), 0),
  });

  if (undecided.length) {
    result.push(
      syntheticGroup(
        undecided,
        'Unclassified — needs an owner decision',
        'Not mapped to the canonical taxonomy',
        { isUnclassified: true, isOutOfTaxonomy: false },
      ),
    );
  }
  if (outOfTaxonomy.length) {
    result.push(
      syntheticGroup(
        outOfTaxonomy,
        'Outside the expense taxonomy',
        'Financial planning / contingency — not an expense category',
        { isUnclassified: false, isOutOfTaxonomy: true },
      ),
    );
  }

  return result;
}

/** Human path for one budget line: "Category › Subcategory › Line". */
export function budgetLinePath(line: BudgetLine): string {
  const parts = [line.parentCategoryName, line.subcategoryName, line.name].filter(Boolean);
  return parts.join(' › ');
}
