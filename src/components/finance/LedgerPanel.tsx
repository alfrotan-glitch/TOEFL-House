/**
 * General ledger — server-paginated, server-totalled.
 *
 * The backend is the single source of financial truth. This panel fetches
 * ROWS from GET /api/finance/transactions (limit/offset) and takes the PERIOD
 * TOTALS from GET /api/finance/pnl, which sums the whole period in SQL.
 *
 * It must never add the visible rows together to produce a total. It did
 * exactly that until 2026-08-16: the header read "Period income" but summed
 * only the current page, so with 90 transactions and a 50-row page the ledger
 * reported 0 AFN income against a true 700 AFN. The number was wrong in the
 * safe-looking direction — understated, plausible, and silently drifting
 * further from reality with every transaction added.
 */
import { text } from '../../design-system/styles';
import React, { useEffect, useState, useCallback } from 'react';
import { Printer } from 'lucide-react';
import type { FinancialTransaction } from '../../types';
import { api } from '../../api/client';
import { useDatasetVersion } from '../../state/serverStateFreshness';
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
  const [totals, setTotals] = useState<{ income: number; expense: number; net: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(async (offset: number, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const bounds = periodBounds(selectedYear, selectedMonth, timeFrame);
      const page = await api.get<{ rows: FinancialTransaction[]; total: number }>('/finance/transactions', {
        from: bounds.from, to: bounds.to, limit: String(PAGE_SIZE), offset: String(offset),
        includeTotal: '1',
      });
      setRows((prev) => (append ? [...prev, ...page.rows] : page.rows));
      setTotal(page.total);

      // Authoritative period totals, summed in SQL over the WHOLE period.
      if (!append) {
        const pnl = await api.get<{ income: number; expense: number; net: number }>('/finance/pnl', {
          from: bounds.from, to: bounds.to,
        });
        setTotals({ income: pnl.income, expense: pnl.expense, net: pnl.net });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the ledger.');
    } finally {
      setLoading(false);
    }
  }, [selectedYear, selectedMonth, timeFrame]);

  // Fetch page 0 whenever the period filter changes; load-more appends.
  // Ledger rows and the P&L summary are derived from payments, invoices and
  // expenses that other views mutate; subscribing keeps them server-accurate.
  const financeVersion = useDatasetVersion('finance', 'payments', 'invoices');
  useEffect(() => {
    void (async () => {
      setRows([]);
      setTotal(null);
      await fetchPage(0, false);
    })();
  }, [fetchPage, financeVersion]);

  const loadMore = () => { void fetchPage(rows.length, true); };

  // Deliberately NOT derived from `rows` — see the note at the top of the file.
  const income = totals?.income ?? null;
  const expense = totals?.expense ?? null;
  const net = totals?.net ?? null;

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
          <h3 className={text.value}>General ledger</h3>
          <button type="button" onClick={() => { window.print(); }} className="text-[10px] font-bold text-slate-500 hover:text-slate-700 flex items-center gap-1 cursor-pointer"><Printer className="w-3 h-3" /> Print</button>
        </div>
        <p className={text.meta}>
          Data from the database only. {total !== null ? `Showing ${rows.length} of ${total} transactions in this period.` : ''}
        </p>
        <div className="flex flex-wrap gap-4 text-xs">
          {totals === null ? (
            // Show nothing rather than a page-derived guess: a plausible wrong
            // total is more dangerous than a visibly pending one.
            <span className="text-slate-400">Period totals loading…</span>
          ) : (
            <>
              <span>Period income: <strong className="text-emerald-600 font-mono">+{formatAFN(income!)}</strong></span>
              <span>Period expenses: <strong className="text-rose-500 font-mono">−{formatAFN(expense!)}</strong></span>
              <span>Net: <strong className={`${net! >= 0 ? 'text-emerald-600' : 'text-rose-500'} font-mono`}>{net! >= 0 ? '+' : ''}{formatAFN(net!)}</strong></span>
            </>
          )}
        </div>
        {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-700">{error}</div>}
        <div className="overflow-x-auto text-xs">
          <table className="w-full text-start border-collapse">
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
