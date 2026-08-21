/**
 * Finance UI — hierarchy grouping and the absence of browser-side accounting.
 * ============================================================================
 * The browser renders the taxonomy; it does not know it. These tests exercise
 * the real grouping module the panels use, and pin the source-level rules that
 * stop accounting knowledge creeping back into the client.
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

const strip = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

const categories: FinanceCategory[] = [
  {
    id: 'cat_premises_facilities', name: 'Premises & Facilities', classification: 'operating_expense',
    sortOrder: 20, isActive: true, channels: [],
    subcategories: [
      { id: 'sub_rent', name: 'Rent Expense', parentId: 'cat_premises_facilities', classification: 'operating_expense', sortOrder: 10, isActive: true, channels: [] },
      { id: 'sub_utilities', name: 'Utilities', parentId: 'cat_premises_facilities', classification: 'operating_expense', sortOrder: 20, isActive: true, channels: [] },
    ],
  },
  {
    id: 'cat_marketing_promotion', name: 'Marketing & Promotion', classification: 'operating_expense',
    sortOrder: 50, isActive: true, channels: [],
    subcategories: [
      {
        id: 'sub_digital_advertising', name: 'Digital Advertising', parentId: 'cat_marketing_promotion',
        classification: 'operating_expense', sortOrder: 10, isActive: true,
        channels: [{ id: 'chn_facebook', name: 'Facebook', kind: 'channel' }],
      },
    ],
  },
  {
    id: 'cat_capital_expenditure', name: 'Capital Expenditure', classification: 'capital_expenditure',
    sortOrder: 90, isActive: true, channels: [],
    subcategories: [
      { id: 'sub_it_equipment', name: 'IT Equipment', parentId: 'cat_capital_expenditure', classification: 'capital_expenditure', sortOrder: 10, isActive: true, channels: [] },
    ],
  },
];

const line = (over: Partial<BudgetLine> & { id: string; name: string }): BudgetLine => ({
  currentAmount: 0, allocatedAmount: 0, costType: 'variable', branchId: '1',
  subcategoryId: null, subcategoryName: null, categoryId: null, categoryName: null,
  classification: 'operating_expense', sortOrder: 0, isActive: true,
  ...over,
});

const lines: BudgetLine[] = [
  line({ id: 'l_water', name: 'Water', subcategoryId: 'sub_utilities', subcategoryName: 'Utilities', categoryId: 'cat_premises_facilities', categoryName: 'Premises & Facilities', sortOrder: 50, currentAmount: 500 }),
  line({ id: 'l_elec', name: 'Electricity', subcategoryId: 'sub_utilities', subcategoryName: 'Utilities', categoryId: 'cat_premises_facilities', categoryName: 'Premises & Facilities', sortOrder: 40, currentAmount: 300 }),
  line({ id: 'l_rent', name: 'Rent', subcategoryId: 'sub_rent', subcategoryName: 'Rent Expense', categoryId: 'cat_premises_facilities', categoryName: 'Premises & Facilities', sortOrder: 30, allocatedAmount: 1000, currentAmount: 400 }),
  line({ id: 'l_it', name: 'Lab laptops', subcategoryId: 'sub_it_equipment', subcategoryName: 'IT Equipment', categoryId: 'cat_capital_expenditure', categoryName: 'Capital Expenditure', classification: 'capital_expenditure', sortOrder: 130 }),
  line({ id: 'l_dead', name: 'Retired line', subcategoryId: 'sub_rent', subcategoryName: 'Rent Expense', categoryId: 'cat_premises_facilities', categoryName: 'Premises & Facilities', isActive: false, sortOrder: 999 }),
];

describe('groupBudgetLines arranges the hierarchy without inventing anything', () => {
  const groups = groupBudgetLines(lines, categories);

  it('groups Category → Subcategory → Budget Line', () => {
    const premises = groups.find((g) => g.categoryId === 'cat_premises_facilities')!;
    expect(premises.groups.map((s) => s.subcategoryName)).toEqual(['Rent Expense', 'Utilities']);
    expect(premises.groups[1].lines.map((l) => l.name)).toEqual(['Electricity', 'Water']);
  });

  it('orders everything by the server-supplied sort order', () => {
    expect(groups.map((g) => g.categoryName)).toEqual(['Premises & Facilities', 'Capital Expenditure']);
    const utilities = groups[0].groups.find((s) => s.subcategoryId === 'sub_utilities')!;
    expect(utilities.lines.map((l) => l.sortOrder)).toEqual([40, 50]);
  });

  it('omits a category the branch has no budget line for', () => {
    // Marketing exists in the taxonomy but this branch funds nothing under it:
    // the picker must not offer an empty branch.
    expect(groups.find((g) => g.categoryId === 'cat_marketing_promotion')).toBeUndefined();
  });

  it('carries the server-resolved treatment through to the group', () => {
    expect(groups.find((g) => g.categoryId === 'cat_capital_expenditure')!.classification).toBe('capital_expenditure');
    expect(groups.find((g) => g.categoryId === 'cat_premises_facilities')!.classification).toBe('operating_expense');
  });

  it('omits inactive lines and accounts for every active one exactly once', () => {
    const ids = groups.flatMap((g) => g.groups.flatMap((s) => s.lines.map((l) => l.id)));
    expect(ids).not.toContain('l_dead');
    expect([...ids].sort()).toEqual(lines.filter((l) => l.isActive).map((l) => l.id).sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('totals allocation and remaining per category', () => {
    const premises = groups.find((g) => g.categoryId === 'cat_premises_facilities')!;
    expect(premises.allocated).toBe(1000);
    expect(premises.remaining).toBe(1200);
  });

  it('renders a readable Category › Subcategory › Line path', () => {
    expect(budgetLinePath(lines[2])).toBe('Premises & Facilities › Rent Expense › Rent');
  });

  it('labels and colours all three treatments distinctly', () => {
    expect(new Set(Object.values(CLASSIFICATION_LABEL)).size).toBe(3);
    expect(new Set(Object.values(CLASSIFICATION_BADGE)).size).toBe(3);
  });
});

describe('the browser holds no accounting knowledge', () => {
  const financeDir = path.join(repoRoot, 'src', 'components', 'finance');
  const financeFiles = fs.readdirSync(financeDir).filter((f) => /\.tsx?$/.test(f));

  it('no Finance component hard-codes a category, purpose or id allow-list', () => {
    const offenders: string[] = [];
    for (const file of financeFiles) {
      const text = strip(fs.readFileSync(path.join(financeDir, file), 'utf8'));
      if (/new Set\(\s*\[\s*'(?:rent|electricity|internet|water|gas|kitchen|equipment|marketing|misc|purchases|transport)'/.test(text)) {
        offenders.push(`${file}: purpose allow-list`);
      }
      // Scoped to the RETIRED BUDGET purpose. `invoice.purpose` is a live
      // server-authored field — what a document bills (owner decision D-118) —
      // and a bare word match condemns rendering it. What must stay out of the
      // browser is budget-line accounting knowledge, which is what these two
      // patterns look for: a purpose read off a budget object, and a comparison
      // against one of the retired operational purpose strings.
      if (/budget[A-Za-z]*[^;\n]{0,40}\bpurpose\b/i.test(text)) offenders.push(`${file}: reads a budget purpose`);
      if (/\bpurpose\s*===?\s*['"](?:teacher_salary|employee_salary|rent|electricity|internet|water|gas|kitchen|equipment|marketing|misc|purchases|transport)['"]/.test(text)) {
        offenders.push(`${file}: legacy purpose comparison`);
      }
      if (/\bmappingStatus\b|\bisMarketing\b/.test(text)) offenders.push(`${file}: retired concept`);
      // A classification must never be DERIVED in the browser, only rendered.
      if (/classification\s*=\s*['"]/.test(text)) offenders.push(`${file}: assigns a classification`);
    }
    expect(offenders).toEqual([]);
  });

  it('the payroll screen resolves its envelope through the business relationship', () => {
    const teachers = strip(read('src/components/teachers/TeachersView.tsx'));
    expect(teachers).toContain("payrollTarget === 'teacher'");
    expect(teachers).toContain("payrollTarget === 'employee'");
    expect(teachers).not.toMatch(/\bpurpose\b/);
    expect(teachers).not.toMatch(/\bid\s*===?\s*['"]b[0-9]+['"]/);
  });

  it('the store fetches the taxonomy from the API and refetches it per section', () => {
    const store = read('src/apiStore.ts');
    expect(store).toContain("'/finance/categories'");
    for (const section of ["case 'budgets':", "case 'expenses':", "case 'ops':", "case 'closing':"]) {
      const i = store.indexOf(section);
      expect(i, section).toBeGreaterThan(-1);
      expect(store.slice(i, i + 300), `${section} must reload the taxonomy`).toContain('reloadFinanceCategories()');
    }
  });

  it('creating a budget line refreshes the budget without a hard refresh', () => {
    const store = read('src/apiStore.ts');
    const block = store.slice(store.indexOf('const createBudgetLine'), store.indexOf('const createBudgetLine') + 320);
    expect(block).toContain('reloadBudgetLines()');
    expect(block).toContain("invalidate('finance')");
  });

  it('every budget-line picker goes through the shared hierarchy control', () => {
    for (const file of ['OperationalExpensesPanel.tsx', 'ExpenseRequestsPanel.tsx']) {
      expect(read(`src/components/finance/${file}`), file).toContain('BudgetLineCascade');
    }
    expect(read('src/components/finance/MonthEndPanel.tsx')).toContain('GroupedBudgetLineSelect');
    expect(read('src/components/finance/BudgetsPanel.tsx')).toContain('groupBudgetLines');
  });

  it('the Budgets screen can create an envelope under a canonical subcategory', () => {
    const panel = read('src/components/finance/BudgetsPanel.tsx');
    expect(panel).toContain('createBudgetLine');
    expect(panel).toContain('subcategoryId');
  });

  it('the P&L panel separates operating cost from capex and non-expense movements', () => {
    const pnl = read('src/components/finance/PnLPanel.tsx');
    expect(pnl).toContain("classification === 'capital_expenditure'");
    expect(pnl).toContain("classification === 'non_expense_cash_movement'");
    expect(pnl).toContain("(r.classification ?? 'operating_expense') === 'operating_expense'");
  });
});
