/**
 * Profit & Loss — server-authoritative.
 * Renders GET /api/finance/pnl (backend-computed operating P&L with the
 * capital/transfer semantics). The frontend never recomputes financial
 * truth from partial store data; the server is the single source.
 */
import { text } from '../../design-system/styles';
import React, { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Printer } from 'lucide-react';
import { api } from '../../api/client';
import { useDatasetVersion } from '../../state/serverStateFreshness';
import { formatAFN } from '../../utils/format';
import { formatJalaliDateTime } from '../../utils/jalali';
import { brandPrintHeaderHtml } from '../../config/branding';
import { openPrintDocument, escapeHtml } from '../../design-system/print';
import type { FinanceCategoryClassification } from '../../types';
import { CLASSIFICATION_BADGE, CLASSIFICATION_LABEL } from './financeCategoryGrouping';

interface PnlPayload {
  from: string | null;
  to: string | null;
  scope: string;
  branchId: string | null;
  income: number;
  expense: number;
  net: number;
  byCategory: { type: string; category: string; total: number; classification: FinanceCategoryClassification | null }[];
  /** Cash out that is NOT trading cost. Resolved by the server, never here. */
  nonOperating?: { capitalExpenditure: number; nonExpenseCashMovement: number };
  transfers: { capitalInjection: number; profitDistribution: number; budgetCharged: number; budgetReturned: number; budgetTransferred: number; savingTransferred: number };
}

interface Props {
  selectedYear: string;
  selectedMonth: string;
}

export default function PnLPanel({ selectedYear, selectedMonth }: Props) {
  const [pnl, setPnl] = useState<PnlPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const financeVersion = useDatasetVersion('finance', 'payments', 'invoices');
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
  }, [selectedYear, selectedMonth, financeVersion]);

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
  // Only OPERATING expense rows belong in the expense statement. Capital
  // expenditure and non-expense cash movements are real money leaving the
  // business, but they are not trading cost — they get their own block below so
  // the reader can see both facts at once.
  const expenseRows = pnl.byCategory.filter(
    (r) => r.type === 'expense' && (r.classification ?? 'operating_expense') === 'operating_expense',
  );
  const capexRows = pnl.byCategory.filter((r) => r.type === 'expense' && r.classification === 'capital_expenditure');
  const nonExpenseRows = pnl.byCategory.filter(
    (r) => r.type === 'expense' && r.classification === 'non_expense_cash_movement',
  );
  const capexTotal = pnl.nonOperating?.capitalExpenditure ?? capexRows.reduce((s2, r) => s2 + r.total, 0);
  const nonExpenseTotal = pnl.nonOperating?.nonExpenseCashMovement ?? nonExpenseRows.reduce((s2, r) => s2 + r.total, 0);
  const periodLabel = selectedMonth === 'all' ? selectedYear : `${selectedYear}-${selectedMonth}`;
  const hasTransfers = Object.values(pnl.transfers).some((v) => Number(v) !== 0);

  const printReport = () => {
    const rows = (list: { category: string; total: number }[]) => list
      .map((r) => `<tr><td>${escapeHtml(r.category.replace(/_/g, ' '))}</td><td class="num">${escapeHtml(formatAFN(r.total))}</td></tr>`).join('');
    const section = (heading: string, list: { category: string; total: number }[], totalLabel: string, total: number) =>
      `<h2>${heading}</h2><table><thead><tr><th>Category</th><th class="num">Amount</th></tr></thead>
       <tbody>${rows(list)}</tbody>
       <tfoot><tr class="total"><td>${totalLabel}</td><td class="num">${escapeHtml(formatAFN(total))}</td></tr></tfoot></table>`;

    const opened = openPrintDocument({
      title: `P&L ${periodLabel}`,
      footerNote: `Profit & Loss · ${periodLabel} · ${pnl.scope}`,
      signatures: [{ role: 'Prepared by' }, { role: 'Approved by' }],
      bodyHtml: `
        ${brandPrintHeaderHtml('Profit &amp; Loss (operating)')}
        <div class="th-meta">Period: <b>${escapeHtml(periodLabel)}</b> · Scope: <b>${escapeHtml(pnl.scope)}</b> · Generated: <b>${escapeHtml(formatJalaliDateTime(new Date().toISOString()))}</b> · Source: server ledger</div>
        ${section('Income', incomeRows, 'Total income', pnl.income)}
        ${section('Operating expenses', expenseRows, 'Total operating expenses', pnl.expense)}
        <p class="kpi th-keep">Net (operating): ${escapeHtml(formatAFN(pnl.net))}</p>
        ${capexRows.length ? section('Capital expenditure (not an operating expense)', capexRows, 'Total capital expenditure', capexTotal) : ''}
        ${nonExpenseRows.length ? section('Non-expense cash movements (not an operating expense)', nonExpenseRows, 'Total non-expense cash movements', nonExpenseTotal) : ''}
        ${hasTransfers ? `<h2>Capital &amp; transfers (not operating)</h2><table><tbody>
          ${pnl.transfers.capitalInjection ? `<tr><td>Capital injected</td><td class="num">${escapeHtml(formatAFN(pnl.transfers.capitalInjection))}</td></tr>` : ''}
          ${pnl.transfers.profitDistribution ? `<tr><td>Profit distributions</td><td class="num">${escapeHtml(formatAFN(pnl.transfers.profitDistribution))}</td></tr>` : ''}
          ${pnl.transfers.budgetCharged ? `<tr><td>Budget funded</td><td class="num">${escapeHtml(formatAFN(pnl.transfers.budgetCharged))}</td></tr>` : ''}
          ${pnl.transfers.budgetReturned ? `<tr><td>Budget returned to treasury</td><td class="num">${escapeHtml(formatAFN(pnl.transfers.budgetReturned))}</td></tr>` : ''}
          ${pnl.transfers.budgetTransferred ? `<tr><td>Budget reassigned between lines</td><td class="num">${escapeHtml(formatAFN(pnl.transfers.budgetTransferred))}</td></tr>` : ''}
          ${pnl.transfers.savingTransferred ? `<tr><td>Savings transferred</td><td class="num">${escapeHtml(formatAFN(pnl.transfers.savingTransferred))}</td></tr>` : ''}
        </tbody></table>` : ''}
      `,
    });
    if (!opened) window.alert('The print window was blocked by the browser. Allow pop-ups for this site and try again.');
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
          <h4 className="text-sm font-extrabold text-slate-900 flex items-center gap-2"><TrendingDown className="w-4 h-4 text-rose-600" /> Operating expenses by category</h4>
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

      {(capexRows.length > 0 || nonExpenseRows.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {capexRows.length > 0 && (
            <div className="bg-white border border-sky-200 rounded-2xl p-5 shadow-sm space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <h4 className={text.value}>Capital expenditure</h4>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${CLASSIFICATION_BADGE.capital_expenditure}`}>
                  {CLASSIFICATION_LABEL.capital_expenditure}
                </span>
              </div>
              <p className="text-[10px] text-slate-500">Fixed assets bought in this period. Cash out — deliberately excluded from operating expenses.</p>
              <div className="space-y-2">{capexRows.map((r) => (
                <div key={r.category} className="flex justify-between items-center text-xs border-b border-slate-50 pb-2">
                  <span className="font-bold text-slate-700 capitalize">{r.category.replace(/_/g, ' ')}</span>
                  <span className="font-mono font-bold text-sky-700">{formatAFN(r.total)}</span>
                </div>
              ))}</div>
              <div className="flex justify-between text-xs font-extrabold pt-1">
                <span>Total</span><span className="font-mono text-sky-700">{formatAFN(capexTotal)}</span>
              </div>
            </div>
          )}
          {nonExpenseRows.length > 0 && (
            <div className="bg-white border border-violet-200 rounded-2xl p-5 shadow-sm space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <h4 className={text.value}>Non-expense cash movements</h4>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${CLASSIFICATION_BADGE.non_expense_cash_movement}`}>
                  {CLASSIFICATION_LABEL.non_expense_cash_movement}
                </span>
              </div>
              <p className="text-[10px] text-slate-500">
                Cash moves; no operating cost is incurred. Covers spend booked to the Non-Expense Cash Movement
                budget lines and owner&apos;s drawings.
                {' '}
                <strong className="text-slate-600">
                  Payroll advances recorded through the Payroll screen are still posted as salary expense and appear above,
                  not here.
                </strong>
              </p>
              <div className="space-y-2">{nonExpenseRows.map((r) => (
                <div key={r.category} className="flex justify-between items-center text-xs border-b border-slate-50 pb-2">
                  <span className="font-bold text-slate-700 capitalize">{r.category.replace(/_/g, ' ')}</span>
                  <span className="font-mono font-bold text-violet-700">{formatAFN(r.total)}</span>
                </div>
              ))}</div>
              <div className="flex justify-between text-xs font-extrabold pt-1">
                <span>Total</span><span className="font-mono text-violet-700">{formatAFN(nonExpenseTotal)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {hasTransfers && (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
          <h4 className="text-sm font-extrabold text-slate-900 mb-3">Capital &amp; transfers (not operating income/expense)</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            {[
              ['Capital injected', pnl.transfers.capitalInjection],
              ['Profit distributions', pnl.transfers.profitDistribution],
              ['Budget funded', pnl.transfers.budgetCharged],
              ['Budget returned', pnl.transfers.budgetReturned],
              ['Budget reassigned', pnl.transfers.budgetTransferred],
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
