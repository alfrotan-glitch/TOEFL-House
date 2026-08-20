import React from 'react';
import type { BudgetLine, FinanceCategory } from '../../types';
import { formatAFN } from '../../utils/format';
import {
  CLASSIFICATION_BADGE,
  CLASSIFICATION_LABEL,
  CLASSIFICATION_SHORT,
  groupBudgetLines,
} from './financeCategoryGrouping';

interface CascadeProps {
  budgetLines: BudgetLine[];
  financeCategories: FinanceCategory[];
  value: string;
  onChange: (budgetLineId: string) => void;
  /** Rendered under the picker when a line is selected. */
  showBalance?: boolean;
  disabled?: boolean;
  idPrefix?: string;
}

/**
 * Category → Subcategory → Budget Line, in that order.
 *
 * WHY A CASCADE RATHER THAN ONE LONG LIST
 * ---------------------------------------
 * A branch can hold many envelopes across ten categories, and picking the wrong
 * one misstates the accounts rather than merely looking untidy. Narrowing by
 * category and then by subcategory makes the accounting destination an explicit
 * choice instead of a scroll. Every option comes from the server, so the browser
 * cannot invent, omit or misfile a category.
 *
 * The selected line's accounting treatment is displayed, not inferred: an
 * operator about to book a laptop must be able to see that it will not land in
 * operating expenses.
 */
export function BudgetLineCascade({
  budgetLines,
  financeCategories,
  value,
  onChange,
  showBalance = true,
  disabled = false,
  idPrefix = 'bl',
}: CascadeProps) {
  const groups = React.useMemo(
    () => groupBudgetLines(budgetLines, financeCategories),
    [budgetLines, financeCategories],
  );

  const selected = budgetLines.find((b) => b.id === value) || null;

  // The two upper levels follow the selection rather than holding their own
  // state, so the control has ONE source of truth (the chosen budget line id)
  // and cannot drift out of sync with the form it feeds.
  const activeCategory =
    groups.find((g) => g.groups.some((s) => s.lines.some((l) => l.id === value))) || null;
  const activeSubcategory =
    activeCategory?.groups.find((s) => s.lines.some((l) => l.id === value)) || null;

  const selectCategoryFirstLine = (categoryId: string) => {
    const group = groups.find((g) => g.categoryId === categoryId);
    onChange(group?.groups[0]?.lines[0]?.id ?? '');
  };

  const selectSubcategoryFirstLine = (subcategoryId: string) => {
    const sub = activeCategory?.groups.find((s) => s.subcategoryId === subcategoryId);
    onChange(sub?.lines[0]?.id ?? '');
  };

  const selectClass =
    'w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer disabled:opacity-50';

  if (groups.length === 0) {
    return (
      <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
        This branch has no budget lines yet. Create one from the Budgets tab.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-category`} className="block text-slate-600 font-medium">Category:</label>
        <select
          id={`${idPrefix}-category`}
          className={selectClass}
          disabled={disabled}
          value={activeCategory?.categoryId ?? ''}
          onChange={(e) => selectCategoryFirstLine(e.target.value)}
        >
          <option value="" disabled>Select a category…</option>
          {groups.map((g) => (
            <option key={g.categoryId} value={g.categoryId}>
              {g.categoryName} — {CLASSIFICATION_SHORT[g.classification]}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-subcategory`} className="block text-slate-600 font-medium">Subcategory:</label>
        <select
          id={`${idPrefix}-subcategory`}
          className={selectClass}
          disabled={disabled || !activeCategory}
          value={activeSubcategory?.subcategoryId ?? ''}
          onChange={(e) => selectSubcategoryFirstLine(e.target.value)}
        >
          <option value="" disabled>Select a subcategory…</option>
          {(activeCategory?.groups ?? []).map((s) => (
            <option key={s.subcategoryId} value={s.subcategoryId}>
              {s.subcategoryName}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-line`} className="block text-slate-600 font-medium">Budget line:</label>
        <select
          id={`${idPrefix}-line`}
          className={selectClass}
          disabled={disabled || !activeSubcategory}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="" disabled>Select a budget line…</option>
          {(activeSubcategory?.lines ?? []).map((line) => (
            <option key={line.id} value={line.id}>
              {line.name}{showBalance ? ` — remaining: ${formatAFN(line.currentAmount)}` : ''}
            </option>
          ))}
        </select>
      </div>

      {selected && selected.classification && (
        <div className="flex items-center gap-2 flex-wrap text-[10px]">
          <span className={`font-bold px-2 py-0.5 rounded-full border ${CLASSIFICATION_BADGE[selected.classification]}`}>
            {CLASSIFICATION_LABEL[selected.classification]}
          </span>
          {selected.classification !== 'operating_expense' && (
            <span className="text-slate-500">
              This spend is recorded as cash out but is <strong>not</strong> an operating expense in the P&amp;L.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

interface GroupedSelectProps {
  budgetLines: BudgetLine[];
  financeCategories: FinanceCategory[];
  value: string;
  onChange: (budgetLineId: string) => void;
  id?: string;
  placeholder?: string;
  excludeId?: string;
  required?: boolean;
}

/**
 * A single `<select>` whose `<optgroup>`s ARE the hierarchy.
 *
 * Used where a three-step cascade would be heavier than the task deserves
 * (month-end settlement), while still making the category structure and the
 * canonical ordering visible.
 */
export function GroupedBudgetLineSelect({
  budgetLines,
  financeCategories,
  value,
  onChange,
  id,
  placeholder = 'Select…',
  excludeId,
  required,
}: GroupedSelectProps) {
  const groups = React.useMemo(
    () => groupBudgetLines(budgetLines, financeCategories),
    [budgetLines, financeCategories],
  );

  return (
    <select
      id={id}
      value={value}
      required={required}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer"
    >
      <option value="">{placeholder}</option>
      {groups.map((group) =>
        group.groups.map((sub) => {
          const lines = sub.lines.filter((l) => l.id !== excludeId);
          if (!lines.length) return null;
          return (
            <optgroup
              key={`${group.categoryId}-${sub.subcategoryId}`}
              label={`${group.categoryName} › ${sub.subcategoryName}`}
            >
              {lines.map((line) => (
                <option key={line.id} value={line.id}>
                  {line.name} — {formatAFN(line.currentAmount)}
                </option>
              ))}
            </optgroup>
          );
        }),
      )}
    </select>
  );
}
