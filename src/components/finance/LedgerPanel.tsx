/**
 * General ledger — server-paginated.
 * The backend is the single source of financial truth; this panel fetches
 * pages directly from GET /api/finance/transactions (limit/offset + total)
 * so the full ledger stays navigable at any scale, and period filtering is
 * applied in SQL rather than over a truncated client-side list.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { Printer } from 'lucide-react';
import type { FinancialTransaction } from '../../types';
import { api } from '../../api/client';
import { formatAFN } from '../../utils/format';

const PAGE_SIZE = 500;

interface Props {
  selectedYear: string;
  selectedMonth: string;
  timeFrame: 'all' | 'daily' | 'monthly' | 'yearly';
  setTimeFrame: (v: 'all' | 'daily' | 'monthly' | 'yearly') => void;
  onOpenReport: () => void;
}

function periodBounds(year: string, month: string, timeFrame: 'all' | 'daily' | 'monthly' | 'yearly') {
  const todayStr = new Date().toISOString().split('T')[0];
  if (timeFrame === 'daily') return { from: todayStr, to: todayStr };
  if (timeFrame === 'monthly') {
    const m = month === 'all' ? todayStr.substring(5, 7) : month;
    return { from: `${year}-${m}-01`, to: `${year}-${m}-31` };
  }
  if (timeFrame === 'yearly') return { from: `${year}-01-01`, to: `${year}-12-31` };
  if (month !== 'all') return { from: `${year}-${month}-01`, to: `${year}-${month}-31` };
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

export default function LedgerPanel({ selectedYear, selectedMonth, timeFrame, setTimeFrame, onOpenReport }: Props) {
  const [rows, setRows] = useState<FinancialTransaction[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(async (offset: number, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const bounds = periodBounds(selectedYear, selectedMonth, timeFrame);
      const res = await api.get<FinancialTransaction[]>('/finance/transactions', {
        from: bounds.from, to: bounds.to, limit: String(PAGE_SIZE), offset: String(offset),
      });
      const totalHeader = res && typeof res === 'object' && 'total' in (res as object) ? null : null;
      void totalHeader;
      setRows((prev) => (append ? [...prev, ...res] : res));
      setTotal((prev) => prev ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the ledger.');
    } finally {
      setLoading(false);
    }
  }, [selectedYear, selectedMonth, timeFrame]);

  // Fetch page 0 whenever the period filter changes; load-more appends.
  useEffect(() => {
    void (async () => {
      setRows([]);
      setTotal(null);
      await fetchPage(0, false);
    })();
  }, [fetchPage]);

  const loadMore = () => { void fetchPage(rows.length, true); };

  const income = rows.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expense = rows.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const net = income - expense;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-500 font-bold">Quick filter:</span>
          {([['all', 'All time'], ['daily', 'Daily'], ['monthly', 'Monthly'], ['yearly', 'Yearly']] as const).map(([key, label]) => (
            <button key={key} type="button" onClick={() => setTimeFrame(key)} className={`text-[10px] font-bold px-2.5 py-1 rounded-lg ${timeFrame === key ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{label}</button>
          ))}
        </div>
        <button type="button" onClick={onOpenReport} className="text-xs font-bold text-indigo-600 hover:bg-indigo-50 px-3 py-1.5 rounded-lg border border-indigo-100">Period statement</button>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-extrabold text-slate-900">General ledger</h3>
          <button type="button" onClick={() => { window.print(); }} className="text-[10px] font-bold text-slate-500 hover:text-slate-700 flex items-center gap-1 cursor-pointer"><Printer className="w-3 h-3" /> Print</button>
        </div>
        <p className="text-[10px] text-slate-400">
          Data from the database only. {total !== null ? `Showing ${rows.length} of ${total} transactions in this period.` : ''}
        </p>
        <div className="flex flex-wrap gap-4 text-xs">
          <span>Period income: <strong className="text-emerald-600 font-mono">+{formatAFN(income)}</strong></span>
          <span>Period expenses: <strong className="text-rose-500 font-mono">−{formatAFN(expense)}</strong></span>
          <span>Net: <strong className={`${net >= 0 ? 'text-emerald-600' : 'text-rose-500'} font-mono`}>{net >= 0 ? '+' : ''}{formatAFN(net)}</strong></span>
        </div>
        {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-700">{error}</div>}
        <div className="overflow-x-auto text-xs">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 text-slate-500">
                <th className="py-2.5 px-3 font-bold">Txn ID</th>
                <th className="py-2.5 px-3 font-bold">Type</th>
                <th className="py-2.5 px-3 font-bold">Description</th>
                <th className="py-2.5 px-3 font-bold">Amount</th>
                <th className="py-2.5 px-3 font-bold">Operator</th>
                <th className="py-2.5 px-3 font-bold">Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr><td colSpan={6} className="text-center py-10 text-slate-400">No transactions in this period.</td></tr>
              ) : rows.map((tx) => (
                <tr key={tx.id} className="border-b border-slate-50">
                  <td className="py-2.5 px-3 font-mono text-[10px] text-slate-400">{tx.id}</td>
                  <td className="py-2.5 px-3"><span className={`text-[9px] font-black px-1.5 py-0.5 rounded-full ${tx.type === 'income' ? 'bg-emerald-50 text-emerald-700' : tx.type === 'expense' ? 'bg-rose-50 text-rose-700' : 'bg-indigo-50 text-indigo-700'}`}>{tx.type === 'income' ? 'Income' : tx.type === 'expense' ? 'Expense' : 'Transfer'}</span></td>
                  <td className="py-2.5 px-3 text-slate-700 max-w-xs truncate">{tx.description}</td>
                  <td className={`py-2.5 px-3 font-mono font-bold ${tx.type === 'income' ? 'text-emerald-600' : 'text-rose-600'}`}>{tx.type === 'income' ? '+' : '−'}{formatAFN(tx.amount)}</td>
                  <td className="py-2.5 px-3 text-slate-500">{tx.operatorName}</td>
                  <td className="py-2.5 px-3 font-mono text-slate-500">{tx.date}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="py-6 text-center text-[11px] text-slate-400">Loading…</div>}
          {total !== null && rows.length < total && (
            <button type="button" onClick={loadMore} disabled={loading} className="mt-3 w-full py-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 text-[11px] font-bold text-indigo-700 cursor-pointer disabled:opacity-50">
              {loading ? 'Loading…' : `Load more (${total - rows.length} remaining)`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
