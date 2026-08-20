import React from 'react';
import type { BudgetLine, FinanceCategory } from '../../types';
import { formatAFN } from '../../utils/format';
import {
  CLASSIFICATION_BADGE,
  CLASSIFICATION_LABEL,
  groupBudgetLines,
} from './financeCategoryGrouping';

interface Props {
  budgetLines: BudgetLine[];
  /** Canonical taxonomy from GET /finance/categories. Never derived locally. */
  financeCategories: FinanceCategory[];
  canView: boolean;
  canAllocate: boolean;
  onCharge: (line: BudgetLine) => void;
}

/**
 * Budgets, presented as the hierarchy they now are.
 *
 * Before this, every budget line was a card in one flat alphabetical grid, so
 * "Rent", "Reserve" and a laptop purchase looked like the same kind of thing.
 * The grid is now grouped Category → Subcategory → Budget Line, and each
 * category states its accounting treatment, because the difference between an
 * operating expense, a capital expenditure and a non-expense cash movement is
 * the whole point of the model.
 */
export default function BudgetsPanel({ budgetLines, financeCategories, canView, canAllocate, onCharge }: Props) {
  const groups = React.useMemo(
    () => groupBudgetLines(budgetLines, financeCategories),
    [budgetLines, financeCategories],
  );

  return (
    <div className="space-y-4">
      {!canView && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <div className="font-extrabold text-amber-900">Budget access is not granted for this account</div>
          <p className="text-xs text-amber-800 mt-1">Ask an administrator to grant the Budget.View permission. This message reflects the current RBAC decision, not a role-name shortcut.</p>
        </div>
      )}
      {canView && <div className="bg-indigo-50/40 border border-indigo-100 rounded-2xl p-4 text-xs text-slate-600">
        <span>
          Budget lines are grouped by their accounting <strong className="text-indigo-600">Category → Subcategory</strong>.
          Owners and general managers can click <strong className="text-indigo-600">Charge budget</strong> to top up a line
          from the main account. Categories, ordering and classification all come from the server.
        </span>
      </div>}

      {canView && budgetLines.length === 0 && (
        <p className="text-center text-slate-400 py-12 text-xs">
          No budget lines are configured for this branch yet. The canonical finance catalogue is created automatically during
          organization setup; refresh Finance or run setup again if this workspace was created from an older database.
        </p>
      )}

      {canView && groups.map((group) => (
        <section key={group.categoryId ?? '__unclassified__'} className="space-y-3">
          <header className="flex items-center justify-between gap-3 flex-wrap border-b border-slate-100 pb-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className={`text-sm font-extrabold ${group.isUnclassified ? 'text-amber-800' : 'text-slate-900'}`}>
                {group.categoryName}
              </h3>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${CLASSIFICATION_BADGE[group.classification]}`}>
                {CLASSIFICATION_LABEL[group.classification]}
              </span>
              <span className="text-[10px] text-slate-400 font-mono">{group.lineCount} line(s)</span>
            </div>
            <div className="text-[10px] font-mono text-slate-500">
              Remaining {formatAFN(group.remaining)} · allocated {formatAFN(group.allocated)}
            </div>
          </header>

          {group.isUnclassified && (
            <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              These lines could not be attached to the canonical taxonomy without guessing, so nothing was assumed.
              They still behave exactly as before (operating expense) and are waiting for an owner decision.
            </p>
          )}

          {group.groups.map((sub) => (
            <div key={`${group.categoryId}-${sub.subcategoryId ?? 'none'}`} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">{sub.subcategoryName}</span>
                {sub.subcategoryId === null && !group.isUnclassified && (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                    needs review
                  </span>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {sub.lines.map((line) => {
                  const pct =
                    line.allocatedAmount > 0
                      ? Math.min(100, Math.round((line.currentAmount / line.allocatedAmount) * 100))
                      : 0;
                  return (
                    <div
                      key={line.id}
                      className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm space-y-3"
                    >
                      <div className="flex justify-between items-start gap-2">
                        <div className="min-w-0">
                          <h4 className="font-extrabold text-slate-900 text-sm break-words">{line.name}</h4>
                          <p className="text-[10px] text-slate-400 mt-0.5">
                            {line.costType}
                            {line.isMarketing ? ' · marketing' : ''}
                            {line.mappingStatus === 'out_of_taxonomy' ? ' · outside the expense taxonomy' : ''}
                          </p>
                        </div>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
                            pct > 40 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                          }`}
                        >
                          {pct}% remaining
                        </span>
                      </div>
                      <div className="space-y-1">
                        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-indigo-500 rounded-full transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                          <span>Remaining: {formatAFN(line.currentAmount)}</span>
                          <span>Total allocated: {formatAFN(line.allocatedAmount)}</span>
                        </div>
                      </div>
                      {canAllocate && (
                        <button
                          type="button"
                          onClick={() => onCharge(line)}
                          className="w-full bg-indigo-50 hover:bg-indigo-100 text-indigo-600 font-semibold py-2 rounded-lg text-xs mt-1 transition-colors cursor-pointer text-center"
                        >
                          Charge &amp; allocate budget
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
