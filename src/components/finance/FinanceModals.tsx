import React, { useCallback, useState } from 'react';
import { FileText, Check } from 'lucide-react';
import { BudgetLine, FinancialTransaction } from '../../types';
import { formatAFN } from '../../utils/format';
import { api } from '../../api/client';

interface FinanceModalsProps {
  chargingBudgetLine: BudgetLine | null;
  setChargingBudgetLine: (b: BudgetLine | null) => void;
  chargeAmount: number;
  setChargeAmount: (v: number) => void;
  handleChargeBudgetSubmit: (e: React.FormEvent) => void;
  mainAccountBalance: number;

  showReportModal: boolean;
  setShowReportModal: (v: boolean) => void;
  timeFrame: 'all' | 'daily' | 'monthly' | 'yearly';
  transactions: FinancialTransaction[];
}

/** Bundles the "charge budget line" modal and the printable official financial report modal. */
interface PeriodTotals { income: number; expense: number; count: number }

export default function FinanceModals({
  chargingBudgetLine, setChargingBudgetLine, chargeAmount, setChargeAmount,
  handleChargeBudgetSubmit, mainAccountBalance,
  showReportModal, setShowReportModal, timeFrame, transactions,
}: FinanceModalsProps) {
  // Authoritative period totals, summed server-side over the whole range.
  const [totals, setTotals] = useState<PeriodTotals | null>(null);
  const [totalsError, setTotalsError] = useState<string | null>(null);

  const loadTotals = useCallback(async () => {
    setTotalsError(null);
    setTotals(null);
    const todayStr = new Date().toISOString().split('T')[0];
    const query: Record<string, string> =
      timeFrame === 'daily' ? { period: 'range', from: todayStr, to: todayStr }
      : timeFrame === 'monthly' ? { period: 'month', month: todayStr.slice(0, 7) }
      : timeFrame === 'yearly' ? { period: 'year', year: todayStr.slice(0, 4) }
      : { period: 'year', year: todayStr.slice(0, 4) };
    try {
      const report = await api.get<{
        financial: { income: { total: number }; expense: { total: number } };
      }>('/reports/overview', query);
      setTotals({
        income: Number(report.financial?.income?.total ?? 0),
        expense: Number(report.financial?.expense?.total ?? 0),
        count: Number.POSITIVE_INFINITY,
      });
    } catch (err) {
      setTotalsError(err instanceof Error ? err.message : 'Could not load period totals.');
    }
  }, [timeFrame]);

  // Fetch on open / timeframe change without a prop-mirroring effect
  // (react-hooks/set-state-in-effect): derive the "needs a fetch" condition
  // during render and kick the request off once per distinct key.
  const totalsKey = showReportModal ? `${timeFrame}` : '';
  const [loadedKey, setLoadedKey] = useState<string>('');
  if (totalsKey && totalsKey !== loadedKey) {
    setLoadedKey(totalsKey);
    void loadTotals();
  }
  if (!totalsKey && loadedKey) setLoadedKey('');

  return (
    <>
      {chargingBudgetLine && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xl w-full max-w-md text-xs space-y-4">
            <div className="flex justify-between items-start border-b border-slate-100 pb-2.5">
              <div>
                <h3 className="font-extrabold text-slate-900 text-sm">Charge budget from main account</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">Target budget line: {chargingBudgetLine.name}</p>
              </div>
              <button onClick={() => setChargingBudgetLine(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer text-sm font-bold">×</button>
            </div>

            <form onSubmit={handleChargeBudgetSubmit} className="space-y-4">
              <div className="bg-slate-50 p-3 rounded-xl border space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-500">Current line balance:</span>
                  <span className="font-mono font-bold text-slate-900">{formatAFN(chargingBudgetLine.currentAmount)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Main account available:</span>
                  <span className="font-mono font-bold text-indigo-600">{formatAFN(mainAccountBalance)}</span>
                </div>
              </div>

              <div>
                <label className="block text-slate-600 font-medium mb-1">Amount to transfer from main account (AFN):</label>
                <input
                  type="number"
                  value={chargeAmount}
                  onChange={(e) => setChargeAmount(Number(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono"
                  min={1000}
                  required
                />
              </div>

              <div className="flex gap-2 justify-end pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setChargingBudgetLine(null)}
                  className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg font-semibold hover:bg-slate-200 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 cursor-pointer shadow-sm"
                >
                  Confirm charge
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Official Financial Report Modal (Print Friendly) */}
      {showReportModal && (() => {
        const todayStr = new Date().toISOString().split('T')[0];
        const currentMonth = todayStr.substring(0, 7);
        const currentYear = todayStr.substring(0, 4);

        // The visible line items come from the loaded page of transactions.
        const reportTransactions = transactions.filter(t => {
          if (timeFrame === 'daily') return t.date === todayStr;
          if (timeFrame === 'monthly') return t.date.startsWith(currentMonth);
          if (timeFrame === 'yearly') return t.date.startsWith(currentYear);
          return true;
        });

        // ...but the TOTALS must come from the server, which sums the whole
        // period in SQL. Summing the loaded page understated an official
        // statement by 99,311 AFN once the day exceeded one page: the client
        // holds at most 500 rows, and there were 700.
        const reportIncome = totals ? totals.income : null;
        const reportExpense = totals ? totals.expense : null;
        const reportNet = totals ? totals.income - totals.expense : null;

        return (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-250">
            <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-2xl w-full max-w-2xl text-xs space-y-6 flex flex-col max-h-[90vh] overflow-hidden">
              
              {/* Report Header */}
              <div className="flex justify-between items-start border-b border-slate-100 pb-4">
                <div className="space-y-1">
                  <h3 className="font-black text-slate-900 text-base flex items-center gap-2">
                    <FileText className="w-5 h-5 text-indigo-600" />
                    Official statement of income & expenses
                  </h3>
                  <p className="text-[10px] text-slate-400">The TOEFL House ERP Treasury • Financial report</p>
                </div>
                <button 
                  onClick={() => setShowReportModal(false)} 
                  className="p-1.5 bg-slate-50 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600 transition-colors cursor-pointer text-base font-bold"
                >
                  ×
                </button>
              </div>

              {/* Printable Area content */}
              <div className="flex-1 overflow-y-auto space-y-6 pr-1 pl-2 scrollbar-thin">
                {/* Info Fields */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 bg-slate-50 p-4 rounded-2xl border border-slate-100">
                  <div>
                    <span className="block text-[10px] text-slate-400">Report period:</span>
                    <span className="font-bold text-slate-800">
                      {timeFrame === 'all' ? 'All periods' : timeFrame === 'daily' ? 'Today' : timeFrame === 'monthly' ? 'This month' : 'Current fiscal year'}
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400">Printed on:</span>
                    <span className="font-mono font-bold text-slate-800">{todayStr}</span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400">Currency:</span>
                    <span className="font-bold text-indigo-600">Afghani (AFN)</span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400">Status:</span>
                    <span className="inline-flex items-center gap-1 text-[10px] font-extrabold text-emerald-600">
                      <Check className="w-3 h-3" /> Balanced
                    </span>
                  </div>
                </div>

                {/* Main Metrics Summary */}
                {totalsError ? (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800 flex items-center justify-between gap-3">
                    <span className="font-semibold">Totals unavailable: {totalsError}. This statement must not be issued from a partial figure.</span>
                    <button type="button" onClick={() => void loadTotals()} className="shrink-0 font-bold underline hover:no-underline">Retry</button>
                  </div>
                ) : reportIncome === null || reportExpense === null || reportNet === null ? (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500 font-semibold">
                    Calculating period totals…
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="border border-slate-200/80 rounded-2xl p-4 bg-emerald-50/20 text-left space-y-1">
                      <p className="text-[10px] text-emerald-600 font-bold">Total income (credit)</p>
                      <p className="text-base font-black text-emerald-700 font-mono">+{formatAFN(reportIncome)}</p>
                    </div>

                    <div className="border border-slate-200/80 rounded-2xl p-4 bg-rose-50/20 text-left space-y-1">
                      <p className="text-[10px] text-rose-500 font-bold">Total expenses (debit)</p>
                      <p className="text-base font-black text-rose-600 font-mono">-{formatAFN(reportExpense)}</p>
                    </div>

                    <div className="border border-indigo-100 rounded-2xl p-4 bg-indigo-50/30 text-left space-y-1">
                      <p className="text-[10px] text-indigo-600 font-bold">Net profit / surplus</p>
                      <p className={`text-base font-black font-mono ${reportNet >= 0 ? 'text-indigo-700' : 'text-rose-600'}`}>
                        {formatAFN(reportNet)}
                      </p>
                    </div>
                  </div>
                )}

                {/* Ledger Listing inside Report */}
                <div className="space-y-2">
                  <h4 className="font-bold text-slate-900 border-b border-slate-100 pb-1.5 text-xs">
                    Period line items
                    <span className="ml-1.5 font-semibold text-slate-400">
                      (most recent {reportTransactions.length}; totals above cover the full period)
                    </span>
                  </h4>
                  <div className="border border-slate-150 rounded-xl overflow-hidden">
                    <table className="w-full text-left border-collapse text-[11px]">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-150 text-slate-500">
                          <th className="py-2 px-3 font-bold text-slate-700">Description</th>
                          <th className="py-2 px-3 font-bold text-slate-700">Type</th>
                          <th className="py-2 px-3 font-bold text-slate-700">Amount</th>
                          <th className="py-2 px-3 font-bold text-slate-700">Date</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-slate-600">
                        {reportTransactions.map((tx) => (
                          <tr key={tx.id} className="hover:bg-slate-50/50">
                            <td className="py-2 px-3 font-medium text-slate-800">{tx.description}</td>
                            <td className="py-2 px-3">
                              <span className={`text-[9px] font-bold ${tx.type === 'income' ? 'text-emerald-600' : 'text-rose-500'}`}>
                                {tx.type === 'income' ? 'Income' : 'Expense'}
                              </span>
                            </td>
                            <td className={`py-2 px-3 font-mono font-bold ${tx.type === 'income' ? 'text-emerald-600' : 'text-rose-500'}`}>
                              {tx.type === 'income' ? '+' : '-'}{formatAFN(tx.amount)}
                            </td>
                            <td className="py-2 px-3 font-mono text-slate-400">{tx.date}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Report Signatures (Treasury standards) */}
                <div className="grid grid-cols-2 gap-4 pt-4 border-t border-dashed border-slate-200">
                  <div className="text-center p-3 border border-slate-100 rounded-xl">
                    <p className="text-[10px] text-slate-400">Finance approval</p>
                    <div className="h-10 flex items-center justify-center">
                      <span className="font-mono text-[10px] text-slate-300">Finance Manager</span>
                    </div>
                  </div>
                  <div className="text-center p-3 border border-slate-100 rounded-xl">
                    <p className="text-[10px] text-slate-400">Owner endorsement</p>
                    <div className="h-10 flex items-center justify-center">
                      <span className="font-mono text-[10px] text-slate-300">Authorized Owner Signatory</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Actions Footer */}
              <div className="flex gap-2 justify-end pt-3 border-t border-slate-100 shrink-0">
                <button
                  type="button"
                  onClick={() => setShowReportModal(false)}
                  className="px-4 py-2 bg-slate-100 text-slate-600 rounded-xl font-bold hover:bg-slate-200 cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => {
                    window.print();
                  }}
                  className="px-5 py-2 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 cursor-pointer shadow-sm flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" />
                  Print statement
                </button>
              </div>

            </div>
          </div>
        );
      })()}
    </>
  );
}
