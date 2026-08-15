/**
 * Profit & Loss — server-authoritative.
 * Renders GET /api/finance/pnl (backend-computed operating P&L with the
 * capital/transfer semantics). The frontend never recomputes financial
 * truth from partial store data; the server is the single source.
 */
import React, { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Printer } from 'lucide-react';
import { api } from '../../api/client';
import { formatAFN } from '../../utils/format';
import { formatJalaliDateTime } from '../../utils/jalali';

interface PnlPayload {
  from: string | null;
  to: string | null;
  scope: string;
  branchId: string | null;
  income: number;
  expense: number;
  net: number;
  byCategory: { type: string; category: string; total: number }[];
  transfers: { capitalInjection: number; profitDistribution: number; budgetCharged: number; savingTransferred: number };
}

interface Props {
  selectedYear: string;
  selectedMonth: string;
}

export default function PnLPanel({ selectedYear, selectedMonth }: Props) {
  const [pnl, setPnl] = useState<PnlPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const from = `${selectedYear}-01-01`;
        const to = selectedMonth === 'all'
          ? `${selectedYear}-12-31`
          : `${selectedYear}-${selectedMonth}-31`;
        const data = await api.get<PnlPayload>('/finance/pnl', { from, to });
        setPnl(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load the P&L report.');
      } finally {
        setLoading(false);
      }
    })();
  }, [selectedYear, selectedMonth]);

  if (loading && !pnl) {
    return <div className="py-16 text-center text-xs text-slate-400 font-semibold">Loading the P&L report…</div>;
  }
  if (error || !pnl) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-xs text-rose-700 font-semibold">
        {error || 'P&L unavailable.'}
      </div>
    );
  }

  const incomeRows = pnl.byCategory.filter((r) => r.type === 'income');
  const expenseRows = pnl.byCategory.filter((r) => r.type === 'expense');
  const periodLabel = selectedMonth === 'all' ? selectedYear : `${selectedYear}-${selectedMonth}`;
  const hasTransfers = pnl.transfers.capitalInjection + pnl.transfers.profitDistribution + pnl.transfers.budgetCharged + pnl.transfers.savingTransferred > 0;

  const printReport = () => {
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return;
    const rows = (list: { category: string; total: number }[]) => list
      .map((r) => `<tr><td class="cat">${r.category.replace(/_/g, ' ')}</td><td class="num">${formatAFN(r.total)}</td></tr>`).join('');
    w.document.write(`<!doctype html><html><head><title>P&amp;L ${periodLabel}</title>
      <style>
        body{font-family:Inter,Arial,sans-serif;color:#0f172a;margin:40px}
        h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;color:#64748b;font-weight:600;margin:24px 0 8px}
        .meta{font-size:11px;color:#64748b;margin-bottom:24px}
        table{width:100%;border-collapse:collapse;font-size:12px}
        td,th{padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:left}
        .num{text-align:right;font-variant-numeric:tabular-nums}
        .total{font-weight:800;background:#f8fafc}
        .net{font-size:16px;font-weight:800}
        @media print{body{margin:20px}}
      </style></head><body>
      <h1>The TOEFL House — Profit &amp; Loss (operating)</h1>
      <div class="meta">Period: <b>${periodLabel}</b> · Scope: <b>${pnl.scope}</b> · Generated: <b>${formatJalaliDateTime(new Date().toISOString())}</b> · Source: server ledger</div>
      <h2>Income</h2><table>${rows(incomeRows)}<tr class="total"><td>Total income</td><td class="num">${formatAFN(pnl.income)}</td></tr></table>
      <h2>Expenses</h2><table>${rows(expenseRows)}<tr class="total"><td>Total expenses</td><td class="num">${formatAFN(pnl.expense)}</td></tr></table>
      <p class="net">Net (operating): ${formatAFN(pnl.net)}</p>
      ${hasTransfers ? `<h2>Capital &amp; transfers (not operating)</h2><table>
        ${pnl.transfers.capitalInjection ? `<tr><td>Capital injected</td><td class="num">${formatAFN(pnl.transfers.capitalInjection)}</td></tr>` : ''}
        ${pnl.transfers.profitDistribution ? `<tr><td>Profit distributions</td><td class="num">${formatAFN(pnl.transfers.profitDistribution)}</td></tr>` : ''}
        ${pnl.transfers.budgetCharged ? `<tr><td>Budget charged</td><td class="num">${formatAFN(pnl.transfers.budgetCharged)}</td></tr>` : ''}
        ${pnl.transfers.savingTransferred ? `<tr><td>Savings transferred</td><td class="num">${formatAFN(pnl.transfers.savingTransferred)}</td></tr>` : ''}
      </table>` : ''}
      <script>window.print()</script></body></html>`);
    w.document.close();
  };

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-l from-indigo-50/40 to-slate-50 border border-slate-200 rounded-2xl p-4 flex flex-col sm:flex-row justify-between gap-3 items-start sm:items-center">
        <div>
          <h3 className="font-extrabold text-slate-900 text-sm">Profit &amp; Loss / Cash overview</h3>
          <p className="text-[10px] text-slate-500 mt-0.5">
            Period <span className="font-mono font-bold">{periodLabel}</span> — computed server-side from the ledger. Operating only; capital and transfers are reported separately.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`text-sm font-extrabold font-mono px-3 py-1.5 rounded-xl border ${pnl.net >= 0 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
            Net: {pnl.net >= 0 ? '+' : ''}{formatAFN(pnl.net)}
          </div>
          <button type="button" onClick={printReport} className="px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-bold cursor-pointer flex items-center gap-1.5">
            <Printer className="w-3.5 h-3.5" /> Print
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
          <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Total income (operating)</p>
          <p className="text-xl font-extrabold font-mono text-emerald-600 mt-1">+{formatAFN(pnl.income)}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
          <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Total expenses (operating)</p>
          <p className="text-xl font-extrabold font-mono text-rose-600 mt-1">−{formatAFN(pnl.expense)}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
          <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Cash net</p>
          <p className={`text-xl font-extrabold font-mono mt-1 ${pnl.net >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{pnl.net >= 0 ? '+' : ''}{formatAFN(pnl.net)}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-3">
          <h4 className="text-sm font-extrabold text-slate-900 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-emerald-600" /> Income by category</h4>
          {incomeRows.length === 0 ? <p className="text-xs text-slate-400 py-6 text-center">No income in this period.</p> : (
            <div className="space-y-2">{incomeRows.map((r) => (
              <div key={r.category} className="flex justify-between items-center text-xs border-b border-slate-50 pb-2">
                <span className="font-bold text-slate-700 capitalize">{r.category.replace(/_/g, ' ')}</span>
                <span className="font-mono font-bold text-emerald-600">+{formatAFN(r.total)}</span>
              </div>
            ))}</div>
          )}
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-3">
          <h4 className="text-sm font-extrabold text-slate-900 flex items-center gap-2"><TrendingDown className="w-4 h-4 text-rose-600" /> Expenses by category</h4>
          {expenseRows.length === 0 ? <p className="text-xs text-slate-400 py-6 text-center">No expenses in this period.</p> : (
            <div className="space-y-2">{expenseRows.map((r) => (
              <div key={r.category} className="flex justify-between items-center text-xs border-b border-slate-50 pb-2">
                <span className="font-bold text-slate-700 capitalize">{r.category.replace(/_/g, ' ')}</span>
                <span className="font-mono font-bold text-rose-600">−{formatAFN(r.total)}</span>
              </div>
            ))}</div>
          )}
        </div>
      </div>

      {hasTransfers && (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
          <h4 className="text-sm font-extrabold text-slate-900 mb-3">Capital &amp; transfers (not operating income/expense)</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            {[
              ['Capital injected', pnl.transfers.capitalInjection],
              ['Profit distributions', pnl.transfers.profitDistribution],
              ['Budget charged', pnl.transfers.budgetCharged],
              ['Savings transferred', pnl.transfers.savingTransferred],
            ].map(([label, value]) => (
              <div key={label as string} className="bg-slate-50 rounded-xl p-3">
                <p className="text-slate-500 font-medium">{label}</p>
                <p className="font-mono font-extrabold text-slate-800 mt-1">{formatAFN(Number(value))}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
