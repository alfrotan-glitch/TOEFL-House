import { text } from '../../design-system/styles';
import React, { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import type { BudgetLine, BudgetLineInput, FinanceCategory } from '../../types';
import { formatAFN } from '../../utils/format';
import {
  CLASSIFICATION_BADGE,
  CLASSIFICATION_LABEL,
  CLASSIFICATION_SHORT,
  groupBudgetLines,
} from './financeCategoryGrouping';

interface Props {
  budgetLines: BudgetLine[];
  /** Canonical taxonomy from GET /finance/categories. Never derived locally. */
  financeCategories: FinanceCategory[];
  canView: boolean;
  canAllocate: boolean;
  onCharge: (line: BudgetLine) => void;
  createBudgetLine: (input: BudgetLineInput) => Promise<void>;
}

/**
 * Budgets, presented as the hierarchy they are.
 *
 * The taxonomy is complete and organization-wide; the BUDGET is sparse and
 * branch-specific. A fresh branch carries only the two payroll envelopes and
 * everything else is created here deliberately, so this screen lists the money
 * the branch actually manages rather than a catalogue of forty-five things
 * nobody spends on.
 */
export default function BudgetsPanel({
  budgetLines,
  financeCategories,
  canView,
  canAllocate,
  onCharge,
  createBudgetLine,
}: Props) {
  const groups = useMemo(
    () => groupBudgetLines(budgetLines, financeCategories),
    [budgetLines, financeCategories],
  );

  const [creating, setCreating] = useState(false);
  const [newCategoryId, setNewCategoryId] = useState('');
  const [newSubcategoryId, setNewSubcategoryId] = useState('');
  const [newName, setNewName] = useState('');
  const [newCostType, setNewCostType] = useState<'fixed' | 'variable'>('variable');
  const [newChannelId, setNewChannelId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orderedCategories = useMemo(
    () => [...financeCategories].sort((a, b) => a.sortOrder - b.sortOrder),
    [financeCategories],
  );
  const selectedCategory = orderedCategories.find((c) => c.id === newCategoryId) || null;
  const selectedSubcategory = selectedCategory?.subcategories.find((s) => s.id === newSubcategoryId) || null;

  const resetForm = () => {
    setNewCategoryId('');
    setNewSubcategoryId('');
    setNewName('');
    setNewCostType('variable');
    setNewChannelId('');
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubcategoryId || !newName.trim()) {
      setError('Choose a subcategory and give the budget line a name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createBudgetLine({
        subcategoryId: newSubcategoryId,
        name: newName.trim(),
        costType: newCostType,
        channelId: newChannelId || null,
      });
      resetForm();
      setCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the budget line.');
    } finally {
      setSaving(false);
    }
  };

  const field = 'w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-xs';

  return (
    <div className="space-y-4">
      {!canView && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <div className="font-extrabold text-amber-900">Budget access is not granted for this account</div>
          <p className="text-xs text-amber-800 mt-1">Ask an administrator to grant the Budget.View permission. This message reflects the current RBAC decision, not a role-name shortcut.</p>
        </div>
      )}

      {canView && (
        <div className="bg-indigo-50/40 border border-indigo-100 rounded-2xl p-4 flex items-start justify-between gap-4 flex-wrap">
          <p className="text-xs text-slate-600 max-w-3xl">
            Budget lines are branch allocations grouped by their accounting{' '}
            <strong className="text-indigo-600">Category → Subcategory</strong>. A new branch starts with the two
            payroll envelopes; add the others as the branch actually needs them. Categories, ordering and accounting
            treatment all come from the server.
          </p>
          {canAllocate && (
            <button
              type="button"
              onClick={() => { setCreating((v) => !v); setError(null); }}
              className="shrink-0 flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-3 py-2 rounded-lg cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" /> {creating ? 'Cancel' : 'New budget line'}
            </button>
          )}
        </div>
      )}

      {canView && creating && canAllocate && (
        <form onSubmit={submit} className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-3">
          <h3 className={text.value}>New budget line</h3>
          {error && (
            <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-700">
              {error}
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="bl-new-category" className="block text-slate-600 font-medium text-xs">Category:</label>
              <select
                id="bl-new-category"
                className={field}
                value={newCategoryId}
                onChange={(e) => { setNewCategoryId(e.target.value); setNewSubcategoryId(''); setNewChannelId(''); }}
              >
                <option value="">Select a category…</option>
                {orderedCategories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} — {CLASSIFICATION_SHORT[c.classification]}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor="bl-new-subcategory" className="block text-slate-600 font-medium text-xs">Subcategory:</label>
              <select
                id="bl-new-subcategory"
                className={field}
                disabled={!selectedCategory}
                value={newSubcategoryId}
                onChange={(e) => { setNewSubcategoryId(e.target.value); setNewChannelId(''); }}
              >
                <option value="">Select a subcategory…</option>
                {[...(selectedCategory?.subcategories ?? [])]
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map((sub) => <option key={sub.id} value={sub.id}>{sub.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor="bl-new-name" className="block text-slate-600 font-medium text-xs">Budget line name:</label>
              <input
                id="bl-new-name"
                className={field}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Main branch electricity"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="bl-new-cost" className="block text-slate-600 font-medium text-xs">Cost type:</label>
              <select id="bl-new-cost" className={field} value={newCostType} onChange={(e) => setNewCostType(e.target.value as 'fixed' | 'variable')}>
                <option value="variable">Variable</option>
                <option value="fixed">Fixed (recurring commitment)</option>
              </select>
            </div>
            {(selectedSubcategory?.channels.length ?? 0) > 0 && (
              <div className="space-y-1">
                <label htmlFor="bl-new-channel" className="block text-slate-600 font-medium text-xs">Channel (optional):</label>
                <select id="bl-new-channel" className={field} value={newChannelId} onChange={(e) => setNewChannelId(e.target.value)}>
                  <option value="">No specific channel</option>
                  {selectedSubcategory!.channels.map((ch) => <option key={ch.id} value={ch.id}>{ch.name}</option>)}
                </select>
              </div>
            )}
          </div>
          {selectedCategory && (
            <p className="text-[10px]">
              <span className={`font-bold px-2 py-0.5 rounded-full border ${CLASSIFICATION_BADGE[selectedCategory.classification]}`}>
                {CLASSIFICATION_LABEL[selectedCategory.classification]}
              </span>
            </p>
          )}
          <button
            type="submit"
            disabled={saving}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-bold px-4 py-2.5 rounded-lg cursor-pointer"
          >
            {saving ? 'Creating…' : 'Create budget line'}
          </button>
        </form>
      )}

      {canView && budgetLines.length === 0 && (
        <p className="text-center text-slate-400 py-12 text-xs">
          This branch has no budget lines yet.
        </p>
      )}

      {canView && groups.map((group) => (
        <section key={group.categoryId} className="space-y-3">
          <header className="flex items-center justify-between gap-3 flex-wrap border-b border-slate-100 pb-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className={text.value}>{group.categoryName}</h3>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${CLASSIFICATION_BADGE[group.classification]}`}>
                {CLASSIFICATION_LABEL[group.classification]}
              </span>
              <span className="text-[10px] text-slate-400 font-mono">{group.lineCount} line(s)</span>
            </div>
            <div className="text-[10px] font-mono text-slate-500">
              Remaining {formatAFN(group.remaining)} · allocated {formatAFN(group.allocated)}
            </div>
          </header>

          {group.groups.map((sub) => (
            <div key={sub.subcategoryId} className="space-y-2">
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">{sub.subcategoryName}</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {sub.lines.map((line) => {
                  const pct =
                    line.allocatedAmount > 0
                      ? Math.min(100, Math.round((line.currentAmount / line.allocatedAmount) * 100))
                      : 0;
                  return (
                    <div key={line.id} className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm space-y-3">
                      <div className="flex justify-between items-start gap-2">
                        <div className="min-w-0">
                          <h4 className="font-extrabold text-slate-900 text-sm break-words">{line.name}</h4>
                          <p className="text-[10px] text-slate-400 mt-0.5">
                            {line.costType}
                            {line.payrollTarget ? ` · ${line.payrollTarget} payroll` : ''}
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
                          <div className="h-full bg-indigo-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
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
