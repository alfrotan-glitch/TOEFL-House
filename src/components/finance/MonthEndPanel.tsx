import React, { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { BudgetLine } from '../../types';
import { formatAFN } from '../../utils/format';

interface Props {
  budgetLines: BudgetLine[];
  isOwner: boolean;
  savingPercent: number;
  processMonthEnd: (budgetLineId: string, decision: 'return' | 'transfer', targetBudgetLineId?: string) => Promise<void>;
  updateSavingSettings: (percent: number) => Promise<void>;
  runSavingEngine: () => Promise<void>;
}

export default function MonthEndPanel({ budgetLines, isOwner, savingPercent, processMonthEnd, updateSavingSettings, runSavingEngine }: Props) {
  const [closeBudgetLineId, setCloseBudgetLineId] = useState(budgetLines[0]?.id || '');
  const [closeDecision, setCloseDecision] = useState<'return' | 'transfer'>('return');
  const [closeTargetLineId, setCloseTargetLineId] = useState('');
  const [percentDraft, setPercentDraft] = useState(savingPercent);

  const [actionError, setActionError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!closeBudgetLineId) return;
    setProcessing(true);
    setActionError(null);
    try {
      await processMonthEnd(closeBudgetLineId, closeDecision, closeDecision === 'transfer' ? closeTargetLineId : undefined);
      alert('Month-end budget adjustment processed successfully.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Month-end processing failed.');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-6">
      {actionError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs font-semibold text-rose-700" role="alert">
          {actionError}
        </div>
      )}
      <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
        <div>
          <h3 className="text-sm font-extrabold text-slate-900">Month-end budget settlement</h3>
          <p className="text-xs text-slate-500 mt-1">Unused balances return to main account or transfer to another line. Amounts from database.</p>
        </div>
        {isOwner ? (
          <form onSubmit={handleSubmit} className="space-y-4 text-xs max-w-xl">
            <div className="space-y-1">
              <label className="block text-slate-600 font-medium">Select budget line:</label>
              <select value={closeBudgetLineId} onChange={(e) => setCloseBudgetLineId(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer">
                {budgetLines.map((b) => <option key={b.id} value={b.id}>{b.name} (remaining: {formatAFN(b.currentAmount)})</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <label className="block text-slate-600 font-medium">Settlement decision:</label>
              <label className={`border rounded-xl p-3 flex items-center gap-2 cursor-pointer ${closeDecision === 'return' ? 'border-indigo-600 bg-indigo-50/10' : 'border-slate-200'}`}>
                <input type="radio" checked={closeDecision === 'return'} onChange={() => setCloseDecision('return')} />
                <div><p className="font-bold text-slate-900">Return to main account</p><p className="text-[10px] text-slate-400">Refund unused amount to central capital</p></div>
              </label>
              <label className={`border rounded-xl p-3 flex items-center gap-2 cursor-pointer ${closeDecision === 'transfer' ? 'border-indigo-600 bg-indigo-50/10' : 'border-slate-200'}`}>
                <input type="radio" checked={closeDecision === 'transfer'} onChange={() => setCloseDecision('transfer')} />
                <div><p className="font-bold text-slate-900">Transfer surplus</p><p className="text-[10px] text-slate-400">Move remaining balance to another budget line</p></div>
              </label>
            </div>
            {closeDecision === 'transfer' && (
              <div className="space-y-1">
                <label className="block text-slate-600 font-medium">Transfer target line:</label>
                <select value={closeTargetLineId} onChange={(e) => setCloseTargetLineId(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer" required>
                  <option value="">Select…</option>
                  {budgetLines.filter((b) => b.id !== closeBudgetLineId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            )}
            <button type="submit" disabled={processing} className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 px-4 rounded-lg">Execute month-end settlement</button>
          </form>
        ) : (
          <div className="flex items-center gap-1.5 text-rose-500 text-xs bg-rose-50 px-2.5 py-1.5 rounded-lg border border-rose-100">
            <ShieldAlert className="w-4 h-4 shrink-0" /><span>Month-end actions are available to owners only.</span>
          </div>
        )}
      </div>
      <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
        <div>
          <h3 className="text-sm font-extrabold text-slate-900">Daily savings engine settings</h3>
          <p className="text-xs text-slate-500 mt-1">Configured percentage of daily gross income. Stored in system_settings.</p>
        </div>
        {isOwner ? (
          <div className="space-y-3 text-xs max-w-md">
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold text-slate-600">Daily savings rate:</span>
              <div className="flex items-center gap-2">
                <input type="number" min={0} max={100} value={percentDraft} onChange={(e) => setPercentDraft(Number(e.target.value))} className="w-20 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 font-mono" />
                <span className="font-bold text-slate-500">%</span>
                <button type="button" onClick={() => updateSavingSettings(percentDraft)} className="px-3 py-1.5 bg-slate-800 text-white font-bold rounded-lg">Save</button>
              </div>
            </div>
            <button type="button" onClick={() => runSavingEngine()} className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 px-4 rounded-lg">Run savings transfer for today&apos;s income</button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-rose-500 text-xs bg-rose-50 px-2.5 py-1.5 rounded-lg border border-rose-100">
            <ShieldAlert className="w-4 h-4 shrink-0" /><span>Savings engine settings are available to owners only.</span>
          </div>
        )}
      </div>
    </div>
  );
}
