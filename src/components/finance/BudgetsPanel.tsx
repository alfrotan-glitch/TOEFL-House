import React from 'react';
import type { BudgetLine } from '../../types';
import { formatAFN } from '../../utils/format';

interface Props {
  budgetLines: BudgetLine[];
  canView: boolean;
  canAllocate: boolean;
  onCharge: (line: BudgetLine) => void;
}

export default function BudgetsPanel({ budgetLines, canView, canAllocate, onCharge }: Props) {
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
          Owners and general managers can click <strong className="text-indigo-600">Charge budget</strong> to top up teacher
          salaries, rent, utilities, and other lines from the main account. Balances are loaded from the database.
        </span>
      </div>}
      {canView && <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {budgetLines.length === 0 ? (
          <p className="col-span-full text-center text-slate-400 py-12 text-xs">
            No budget lines are configured for this branch yet. The standard finance budget catalog is created automatically during organization setup; refresh Finance or run setup again if this workspace was created from an older database.
          </p>
        ) : (
          budgetLines.map((line) => {
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
                  <div>
                    <h4 className="font-extrabold text-slate-900 text-sm">{line.name}</h4>
                    <p className="text-[10px] text-slate-400 mt-0.5 font-mono">
                      {line.purpose || '—'} · {line.costType}
                      {line.isMarketing ? ' · marketing' : ''}
                    </p>
                  </div>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
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
                    Charge & allocate budget
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>}
    </div>
  );
}
