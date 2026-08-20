/**
 * Finance UI — hierarchy grouping and category-source regression coverage.
 * ============================================================================
 * The Finance panels used to contain accounting knowledge of their own:
 *
 *   OperationalExpensesPanel.tsx
 *     const OPERATIONAL_PURPOSES = new Set(['rent','electricity', … 14 strings])
 *     → every budget line outside those fourteen was UNREACHABLE from the UI,
 *       and any new canonical subcategory would stay invisible until somebody
 *       remembered to edit a frontend constant.
 *
 *   TeachersView.tsx
 *     budgetLines.find(b => b.id === <legacy demo primary key>)
 *     → a hard-coded identifier that migration 002 superseded years ago.
 *
 * These tests exercise the real grouping module the panels now use, and pin the
 * source-level rules that stop the knowledge creeping back into the browser.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLASSIFICATION_BADGE,
  CLASSIFICATION_LABEL,
  budgetLinePath,
  groupBudgetLines,
} from '../../../src/components/finance/financeCategoryGrouping';
import type { BudgetLine, FinanceCategory } from '../../../src/types';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * Comments are stripped before scanning. Several of these files DISCUSS the
 * removed allow-list in prose so a future reader knows why it is gone; a
 * blanket text ban would punish the documentation and reward silence. What must
 * not exist is an allow-list in a CODE position.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const categories: FinanceCategory[] = [
  {
    id: 'cat_premises_facilities',
    name: 'Premises & Facilities',
    classification: 'operating_expense',
    sortOrder: 20,
    isActive: true,
    channels: [],
    subcategories: [
      { id: 'sub_rent', name: 'Rent Expense', parentId: 'cat_premises_facilities', classification: 'operating_expense', sortOrder: 10, isActive: true, channels: [] },
      { id: 'sub_utilities', name: 'Utilities', parentId: 'cat_premises_facilities', classification: 'operating_expense', sortOrder: 20, isActive: true, channels: [] },
    ],
  },
  {
    id: 'cat_marketing_promotion',
    name: 'Marketing & Promotion',
    classification: 'operating_expense',
    sortOrder: 50,
    isActive: true,
    channels: [],
    subcategories: [
      {
        id: 'sub_digital_advertising',
        name: 'Digital Advertising',
        parentId: 'cat_marketing_promotion',
        classification: 'operating_expense',
        sortOrder: 10,
        isActive: true,
        channels: [{ id: 'chn_facebook', name: 'Facebook', kind: 'channel' }],
      },
    ],
  },
  {
    id: 'cat_capital_expenditure',
    name: 'Capital Expenditure',
    classification: 'capital_expenditure',
    sortOrder: 90,
    isActive: true,
    channels: [],
    subcategories: [
      { id: 'sub_it_equipment', name: 'IT Equipment', parentId: 'cat_capital_expenditure', classification: 'capital_expenditure', sortOrder: 10, isActive: true, channels: [] },
    ],
  },
];

const line = (over: Partial<BudgetLine> & { id: string; name: string }): BudgetLine => ({
  currentAmount: 0,
  allocatedAmount: 0,
  icon: 'Circle',
  costType: 'variable',
  isMarketing: false,
  branchId: '1',
  sortOrder: 0,
  isActive: true,
  mappingStatus: 'mapped',
  ...over,
});

const lines: BudgetLine[] = [
  line({ id: 'l_water', name: 'Water', purpose: 'water', categoryId: 'sub_utilities', subcategoryId: 'sub_utilities', subcategoryName: 'Utilities', parentCategoryId: 'cat_premises_facilities', parentCategoryName: 'Premises & Facilities', classification: 'operating_expense', sortOrder: 50, currentAmount: 500 }),
  line({ id: 'l_elec', name: 'Electricity', purpose: 'electricity', categoryId: 'sub_utilities', subcategoryId: 'sub_utilities', subcategoryName: 'Utilities', parentCategoryId: 'cat_premises_facilities', parentCategoryName: 'Premises & Facilities', classification: 'operating_expense', sortOrder: 40, currentAmount: 300 }),
  line({ id: 'l_rent', name: 'Rent', purpose: 'rent', categoryId: 'sub_rent', subcategoryId: 'sub_rent', subcategoryName: 'Rent Expense', parentCategoryId: 'cat_premises_facilities', parentCategoryName: 'Premises & Facilities', classification: 'operating_expense', sortOrder: 30, allocatedAmount: 1000, currentAmount: 400 }),
  line({ id: 'l_it', name: 'IT Equipment', purpose: 'sub_it_equipment', categoryId: 'sub_it_equipment', subcategoryId: 'sub_it_equipment', subcategoryName: 'IT Equipment', parentCategoryId: 'cat_capital_expenditure', parentCategoryName: 'Capital Expenditure', classification: 'capital_expenditure', sortOrder: 130 }),
  // Ambiguous legacy line: category known, subcategory not.
  line({ id: 'l_mkt', name: 'Marketing', purpose: 'marketing', categoryId: 'cat_marketing_promotion', subcategoryId: null, parentCategoryId: 'cat_marketing_promotion', parentCategoryName: 'Marketing & Promotion', classification: 'operating_expense', mappingStatus: 'needs_review', sortOrder: 140 }),
  // Not mappable at all.
  line({ id: 'l_purch', name: 'General Purchases', purpose: 'purchases', categoryId: null, classification: 'operating_expense', mappingStatus: 'needs_review', sortOrder: 160 }),
  // Retired line — must not appear in a picker.
  line({ id: 'l_dead', name: 'Retired line', purpose: 'dead', categoryId: 'sub_rent', subcategoryId: 'sub_rent', isActive: false, sortOrder: 999 }),
];

describe('groupBudgetLines arranges the hierarchy without inventing anything', () => {
  const groups = groupBudgetLines(lines, categories);

  it('groups Category → Subcategory → Budget Line', () => {
    const premises = groups.find((g) => g.categoryId === 'cat_premises_facilities')!;
    expect(premises.groups.map((s) => s.subcategoryName)).toEqual(['Rent Expense', 'Utilities']);
    expect(premises.groups[1].lines.map((l) => l.name)).toEqual(['Electricity', 'Water']);
  });

  it('orders categories, subcategories and lines by the server-supplied sort order', () => {
    expect(groups.filter((g) => !g.isUnclassified).map((g) => g.categoryName)).toEqual([
      'Premises & Facilities',
      'Marketing & Promotion',
      'Capital Expenditure',
    ]);
    // 40 before 50 — NOT alphabetical, which would put Electricity after Water
    // only by luck and Water before Electricity in another locale.
    const utilities = groups[0].groups.find((s) => s.subcategoryId === 'sub_utilities')!;
    expect(utilities.lines.map((l) => l.sortOrder)).toEqual([40, 50]);
  });

  it('carries the accounting treatment through to the group', () => {
    expect(groups.find((g) => g.categoryId === 'cat_capital_expenditure')!.classification).toBe('capital_expenditure');
    expect(groups.find((g) => g.categoryId === 'cat_premises_facilities')!.classification).toBe('operating_expense');
  });

  it('shows a category-level legacy line under its category, flagged, not filed into a guess', () => {
    const marketing = groups.find((g) => g.categoryId === 'cat_marketing_promotion')!;
    expect(marketing.groups).toHaveLength(1);
    expect(marketing.groups[0].subcategoryId).toBeNull();
    expect(marketing.groups[0].lines.map((l) => l.id)).toEqual(['l_mkt']);
    // It must NOT have been dropped into Digital Advertising.
    expect(marketing.groups[0].subcategoryName).not.toBe('Digital Advertising');
  });

  it('puts a completely unmapped line in an explicit unclassified bucket', () => {
    const unclassified = groups.find((g) => g.isUnclassified)!;
    expect(unclassified.groups[0].lines.map((l) => l.id)).toEqual(['l_purch']);
    expect(unclassified.categoryName).toMatch(/needs an owner decision/i);
  });

  it('omits inactive budget lines entirely', () => {
    const allIds = groups.flatMap((g) => g.groups.flatMap((s) => s.lines.map((l) => l.id)));
    expect(allIds).not.toContain('l_dead');
  });

  it('accounts for every active line exactly once', () => {
    const allIds = groups.flatMap((g) => g.groups.flatMap((s) => s.lines.map((l) => l.id)));
    const active = lines.filter((l) => l.isActive !== false).map((l) => l.id);
    expect([...allIds].sort()).toEqual([...active].sort());
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('totals allocation and remaining per category', () => {
    const premises = groups.find((g) => g.categoryId === 'cat_premises_facilities')!;
    expect(premises.allocated).toBe(1000);
    expect(premises.remaining).toBe(1200);
  });

  it('renders a readable Category › Subcategory › Line path', () => {
    expect(budgetLinePath(lines[2])).toBe('Premises & Facilities › Rent Expense › Rent');
    // A line with no resolved category degrades to its own name rather than
    // fabricating a parent.
    expect(budgetLinePath(lines[5])).toBe('General Purchases');
  });

  it('labels and colours all three treatments distinctly', () => {
    const labels = Object.values(CLASSIFICATION_LABEL);
    expect(new Set(labels).size).toBe(3);
    expect(new Set(Object.values(CLASSIFICATION_BADGE)).size).toBe(3);
  });
});

describe('the Finance UI takes its categories from the server only', () => {
  it('no Finance component hard-codes a purpose or category allow-list', () => {
    const financeDir = path.join(repoRoot, 'src', 'components', 'finance');
    const offenders: string[] = [];
    for (const file of fs.readdirSync(financeDir)) {
      if (!/\.tsx?$/.test(file)) continue;
      const text = stripComments(fs.readFileSync(path.join(financeDir, file), 'utf8'));
      // A Set/array literal of lowercase snake_case strings is what an
      // accounting allow-list looks like in this codebase.
      if (/new Set\(\s*\[\s*'(?:rent|electricity|internet|water|gas|kitchen|equipment|marketing|misc)'/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the store fetches the taxonomy from the API instead of shipping a copy', () => {
    const store = read('src/apiStore.ts');
    expect(store).toContain("'/finance/categories'");
    expect(store).toContain('reloadFinanceCategories');
  });

  it('the taxonomy is refetched with each Finance section, so the cache cannot go stale', () => {
    const store = read('src/apiStore.ts');
    // Every Finance section that renders a category picker must refresh it.
    for (const section of ["case 'budgets':", "case 'expenses':", "case 'ops':", "case 'closing':"]) {
      const index = store.indexOf(section);
      expect(index, section).toBeGreaterThan(-1);
      const block = store.slice(index, index + 260);
      expect(block, `${section} must reload the taxonomy`).toContain('reloadFinanceCategories()');
    }
  });

  it('every budget-line picker goes through the shared hierarchy control', () => {
    for (const file of ['OperationalExpensesPanel.tsx', 'ExpenseRequestsPanel.tsx']) {
      expect(read(`src/components/finance/${file}`), file).toContain('BudgetLineCascade');
    }
    expect(read('src/components/finance/MonthEndPanel.tsx')).toContain('GroupedBudgetLineSelect');
    expect(read('src/components/finance/BudgetsPanel.tsx')).toContain('groupBudgetLines');
  });

  it('the P&L panel separates operating cost from capex and non-expense movements', () => {
    const pnl = read('src/components/finance/PnLPanel.tsx');
    expect(pnl).toContain("classification === 'capital_expenditure'");
    expect(pnl).toContain("classification === 'non_expense_cash_movement'");
    // The operating list must filter, not show everything.
    expect(pnl).toContain("(r.classification ?? 'operating_expense') === 'operating_expense'");
  });
});
