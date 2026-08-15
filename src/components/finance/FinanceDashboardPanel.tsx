/**
 * Finance command center — the finance manager's landing view.
 * Renders the server-computed GET /api/finance/dashboard payload: cash
 * position, today/month movement, budget utilization, receivables, pending
 * approvals, reconciliation health, a 14-day trend and a role-aware
 * "how to work" playbook. No figures are computed client-side.
 */
import React from 'react';
import {
  Wallet, PiggyBank, TrendingUp, TrendingDown, Receipt, AlertTriangle,
  CheckCircle2, XCircle, Clock, ArrowRight, FileText, Scale, Landmark,
  ListChecks, RefreshCw, CalendarCheck, Activity, Sparkles,
} from 'lucide-react';
import type { FinanceDashboard } from '../../types';
import { formatAFN } from '../../utils/format';

export interface FinanceDashboardPanelProps {
  dashboard: FinanceDashboard | null;
  /** Approve/reject pending expense requests (manager + owner). */
  canApprove: boolean;
  /** Allocate budget / month-end (manager + owner). */
  canControl: boolean;
  isOwner: boolean;
  roleLabel: string;
  scopeLabel: string;
  loading: boolean;
  onGo: (tab: string) => void;
  onDeposit: () => void;
  onApprove: (requestId: string, approved: boolean) => void;
  onRefresh: () => void;
}

function KpiCard(props: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: 'default' | 'emerald' | 'rose' | 'indigo' | 'amber' }) {
  const valueColor = props.tone === 'emerald' ? 'text-emerald-600' : props.tone === 'rose' ? 'text-rose-600' : props.tone === 'indigo' ? 'text-indigo-700' : props.tone === 'amber' ? 'text-amber-600' : 'text-slate-900';
  const iconBg = props.tone === 'emerald' ? 'bg-emerald-50 text-emerald-600' : props.tone === 'rose' ? 'bg-rose-50 text-rose-600' : props.tone === 'indigo' ? 'bg-indigo-50 text-indigo-600' : props.tone === 'amber' ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-600';
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-slate-400 font-semibold uppercase tracking-wide">{props.label}</p>
        <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${iconBg}`}>{props.icon}</div>
      </div>
      <p className={`text-xl font-extrabold font-mono mt-1.5 ${valueColor}`}>{props.value}</p>
      {props.sub && <p className="text-[10px] text-slate-400 mt-0.5">{props.sub}</p>}
    </div>
  );
}

export default function FinanceDashboardPanel(props: FinanceDashboardPanelProps) {
  const { dashboard, canApprove, canControl, isOwner, roleLabel, scopeLabel, loading, onGo, onDeposit, onApprove, onRefresh } = props;

  if (loading && !dashboard) {
    return (
      <div className="flex items-center justify-center py-16 text-xs text-slate-400 font-semibold">
        <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Loading the finance command center…
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
        The finance dashboard could not be loaded. <button type="button" onClick={onRefresh} className="text-indigo-600 font-bold cursor-pointer ml-1">Retry</button>
      </div>
    );
  }

  const d = dashboard;
  const maxTrend = Math.max(1, ...d.trend.map((t) => Math.max(t.income, t.expense)));
  const attentionItems: React.ReactNode[] = [];
  const isFinanceRole = !canControl; // finance desk (not manager/owner)

  if (d.approvals.pendingCount > 0) {
    attentionItems.push(
      <div key="approvals" className={`rounded-2xl border p-4 ${canApprove ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50'}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-600 shrink-0" />
            <div>
              <div className="text-xs font-extrabold text-slate-900">{d.approvals.pendingCount} expense request{d.approvals.pendingCount === 1 ? '' : 's'} awaiting approval</div>
              <div className="text-[10px] text-slate-500 mt-0.5">Total {formatAFN(d.approvals.pendingValue)} — {canApprove ? 'review below or open Expense Requests' : 'a manager or the course owner must approve them'}</div>
            </div>
          </div>
          {canApprove && (
            <button type="button" onClick={() => onGo('expenses')} className="px-3 py-1.5 text-[10px] font-bold text-amber-700 bg-amber-100 hover:bg-amber-200 rounded-lg cursor-pointer flex items-center gap-1">
              Review all <ArrowRight className="w-3 h-3" />
            </button>
          )}
        </div>
        {canApprove && (
          <div className="mt-3 space-y-1.5">
            {d.approvals.items.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3 bg-white border border-amber-100 rounded-xl px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-bold text-slate-800 truncate">{item.title}</div>
                  <div className="text-[10px] text-slate-400">{item.requester} · {item.date}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-mono font-extrabold text-slate-900">{formatAFN(item.amount)}</span>
                  <button type="button" onClick={() => onApprove(item.id, true)} className="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold cursor-pointer flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Approve</button>
                  <button type="button" onClick={() => onApprove(item.id, false)} className="px-2.5 py-1.5 rounded-lg bg-white border border-rose-200 text-rose-600 hover:bg-rose-50 text-[10px] font-bold cursor-pointer flex items-center gap-1"><XCircle className="w-3 h-3" /> Reject</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>,
    );
  }

  if (d.receivables.overdueInvoices > 0) {
    attentionItems.push(
      <div key="overdue" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
          <div>
            <div className="text-xs font-extrabold text-slate-900">{d.receivables.overdueInvoices} overdue invoice{d.receivables.overdueInvoices === 1 ? '' : 's'}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">{formatAFN(d.receivables.overdueValue)} past due — follow up with students</div>
          </div>
        </div>
        <button type="button" onClick={() => onGo('invoices')} className="px-3 py-1.5 text-[10px] font-bold text-rose-700 bg-rose-100 hover:bg-rose-200 rounded-lg cursor-pointer flex items-center gap-1">Open invoices <ArrowRight className="w-3 h-3" /></button>
      </div>,
    );
  }

  if (d.budget.exhausted.length > 0 || d.budget.atRisk.length > 0) {
    const risky = [...d.budget.exhausted.map((b) => ({ name: b.name, pct: 100, exhausted: true })), ...d.budget.atRisk.map((b) => ({ name: b.name, pct: b.usedPercent, exhausted: false }))];
    attentionItems.push(
      <div key="budget" className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <div className="flex items-center gap-2">
          <TrendingDown className="w-4 h-4 text-amber-600 shrink-0" />
          <div className="text-xs font-extrabold text-slate-900">Budget lines need attention</div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {risky.slice(0, 6).map((b) => (
            <span key={b.name} className={`px-2 py-1 rounded-lg text-[10px] font-bold ${b.exhausted ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>
              {b.name} — {b.exhausted ? 'exhausted' : `${b.pct}% used`}
            </span>
          ))}
        </div>
        {canControl && (
          <button type="button" onClick={() => onGo('budgets')} className="mt-2 text-[10px] font-bold text-amber-700 hover:text-amber-900 cursor-pointer flex items-center gap-1">
            Review budget allocation <ArrowRight className="w-3 h-3" />
          </button>
        )}
      </div>,
    );
  }

  if (!d.reconciliation.healthy) {
    attentionItems.push(
      <div key="recon" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Scale className="w-4 h-4 text-rose-600 shrink-0" />
          <div>
            <div className="text-xs font-extrabold text-slate-900">Reconciliation needs attention</div>
            <div className="text-[10px] text-slate-500 mt-0.5">Variance {formatAFN(d.reconciliation.amountVariance)} · {d.reconciliation.unmatchedPayments} unmatched · {d.reconciliation.orphanLedgerRows} orphan ledger rows</div>
          </div>
        </div>
        <button type="button" onClick={() => onGo('reconciliation')} className="px-3 py-1.5 text-[10px] font-bold text-rose-700 bg-rose-100 hover:bg-rose-200 rounded-lg cursor-pointer flex items-center gap-1">Inspect <ArrowRight className="w-3 h-3" /></button>
      </div>,
    );
  }

  return (
    <div className="space-y-5">
      {/* Scope + quick actions */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <Landmark className="w-4 h-4 text-indigo-600" />
          <span className="font-bold text-slate-700">{roleLabel}</span> — viewing <span className="font-bold text-indigo-700">{scopeLabel}</span>
          <button type="button" onClick={onRefresh} className="ml-1 px-2 py-1 rounded-lg bg-white border border-slate-200 hover:border-indigo-300 text-[10px] font-bold text-slate-500 hover:text-indigo-700 cursor-pointer flex items-center gap-1"><RefreshCw className="w-3 h-3" /> Refresh</button>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => onGo('invoices')} className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold cursor-pointer flex items-center gap-1.5"><Receipt className="w-3.5 h-3.5" /> Record payment</button>
          <button type="button" onClick={() => onGo('ops')} className="px-3 py-2 rounded-xl bg-white border border-slate-200 hover:border-indigo-300 text-slate-700 text-[11px] font-bold cursor-pointer flex items-center gap-1.5"><FileText className="w-3.5 h-3.5" /> Submit expense</button>
          {canControl && (
            <>
              <button type="button" onClick={() => onGo('budgets')} className="px-3 py-2 rounded-xl bg-white border border-slate-200 hover:border-indigo-300 text-slate-700 text-[11px] font-bold cursor-pointer flex items-center gap-1.5"><Wallet className="w-3.5 h-3.5" /> Fund budgets</button>
              <button type="button" onClick={() => onGo('closing')} className="px-3 py-2 rounded-xl bg-white border border-slate-200 hover:border-indigo-300 text-slate-700 text-[11px] font-bold cursor-pointer flex items-center gap-1.5"><CalendarCheck className="w-3.5 h-3.5" /> Month-end</button>
            </>
          )}
          {isOwner && (
            <button type="button" onClick={onDeposit} className="px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-bold cursor-pointer flex items-center gap-1.5"><PiggyBank className="w-3.5 h-3.5" /> Deposit capital</button>
          )}
        </div>
      </div>

      {/* Cash position */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard icon={<Wallet className="w-4 h-4" />} label="Main account" value={formatAFN(d.balances.main)} sub="Operating cash" />
        <KpiCard icon={<PiggyBank className="w-4 h-4" />} label="Savings reserve" value={formatAFN(d.balances.saving)} sub={`${d.settings.dailySavingPercent}% of income skimmed automatically`} tone="emerald" />
        <KpiCard icon={<Activity className="w-4 h-4" />} label="Budget remaining" value={formatAFN(d.budget.remaining)} sub={`${d.budget.utilizationPercent}% of ${formatAFN(d.budget.allocated)} used`} tone="indigo" />
        <KpiCard icon={<Receipt className="w-4 h-4" />} label="Open receivables" value={formatAFN(d.receivables.openValue)} sub={`${d.receivables.openInvoices} open · ${d.receivables.overdueInvoices} overdue`} tone={d.receivables.overdueInvoices > 0 ? 'rose' : 'default'} />
      </div>

      {/* Needs attention */}
      {attentionItems.length > 0 ? (
        <div className="space-y-3">{attentionItems}</div>
      ) : (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <div className="text-xs font-bold text-emerald-800">All clear — no overdue invoices, no pending approvals, healthy reconciliation.</div>
        </div>
      )}

      {/* Movement + trend */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-extrabold text-slate-900 flex items-center gap-1.5"><TrendingUp className="w-4 h-4 text-indigo-600" /> Cash flow — last 14 days</h3>
            <div className="flex items-center gap-3 text-[10px] font-semibold text-slate-400">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500 inline-block" /> Income</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-rose-400 inline-block" /> Expense</span>
            </div>
          </div>
          <div className="mt-4 flex items-end gap-1.5 h-28">
            {d.trend.map((t) => (
              <div key={t.date} className="flex-1 flex flex-col items-center gap-1 group relative" title={`${t.date}: +${formatAFN(t.income)} / -${formatAFN(t.expense)}`}>
                <div className="w-full flex flex-col items-center justify-end gap-[2px] h-20">
                  <div className="w-full rounded-sm bg-emerald-500/80 group-hover:bg-emerald-500 transition-colors" style={{ height: `${Math.max(2, (t.income / maxTrend) * 100)}%` }} />
                  <div className="w-full rounded-sm bg-rose-400/70 group-hover:bg-rose-400 transition-colors" style={{ height: `${Math.max(2, (t.expense / maxTrend) * 100)}%` }} />
                </div>
                <span className="text-[8px] font-mono text-slate-400">{t.date.slice(8)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
          <h3 className="text-xs font-extrabold text-slate-900 flex items-center gap-1.5"><Activity className="w-4 h-4 text-indigo-600" /> Period movement</h3>
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl bg-slate-50 border border-slate-100 p-2.5"><div className="text-[9px] text-slate-400 font-bold uppercase">Today net</div><div className={`text-sm font-extrabold font-mono mt-0.5 ${d.today.net >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{formatAFN(d.today.net)}</div></div>
              <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-2.5"><div className="text-[9px] text-emerald-500 font-bold uppercase">Today in</div><div className="text-sm font-extrabold font-mono text-emerald-700 mt-0.5">{formatAFN(d.today.income)}</div></div>
              <div className="rounded-xl bg-rose-50 border border-rose-100 p-2.5"><div className="text-[9px] text-rose-500 font-bold uppercase">Today out</div><div className="text-sm font-extrabold font-mono text-rose-700 mt-0.5">{formatAFN(d.today.expense)}</div></div>
            </div>
            <div className="border-t border-slate-100 pt-3 space-y-1.5">
              {[
                ['Month income', d.month.income, 'text-emerald-700'],
                ['Month expense', d.month.expense, 'text-rose-700'],
                ['Collected this month', d.receivables.collectedThisMonth, 'text-indigo-700'],
              ].map(([label, value, cls]) => (
                <div key={label as string} className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-500 font-semibold">{label}</span>
                  <span className={`font-mono font-extrabold ${cls}`}>{formatAFN(Number(value))}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Receivables + recent activity */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
          <h3 className="text-xs font-extrabold text-slate-900 flex items-center gap-1.5"><Receipt className="w-4 h-4 text-indigo-600" /> Receivables</h3>
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            {[
              ['Open invoices', d.receivables.openInvoices, 'text-slate-900'],
              ['Overdue', d.receivables.overdueInvoices, d.receivables.overdueInvoices > 0 ? 'text-rose-600' : 'text-slate-900'],
              ['Draft invoices', d.receivables.drafts, 'text-slate-900'],
              ['Collected this month', formatAFN(d.receivables.collectedThisMonth), 'text-emerald-700'],
            ].map(([label, value, cls]) => (
              <div key={label as string} className="rounded-xl bg-slate-50 border border-slate-100 p-3">
                <div className="text-[9px] text-slate-400 font-bold uppercase">{label}</div>
                <div className={`text-base font-extrabold font-mono mt-1 ${cls}`}>{value}</div>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => onGo('invoices')} className="mt-3 text-[10px] font-bold text-indigo-600 hover:text-indigo-800 cursor-pointer flex items-center gap-1">Manage invoices & payments <ArrowRight className="w-3 h-3" /></button>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
          <h3 className="text-xs font-extrabold text-slate-900 flex items-center gap-1.5"><ListChecks className="w-4 h-4 text-indigo-600" /> Recent ledger activity</h3>
          <div className="mt-3 space-y-1">
            {d.ledger.recent.length === 0 && <p className="text-[11px] text-slate-400 italic">No transactions recorded yet.</p>}
            {d.ledger.recent.slice(0, 8).map((tx) => (
              <div key={tx.id} className="flex items-center justify-between gap-3 border-b border-slate-50 pb-1.5 last:border-0">
                <div className="min-w-0">
                  <div className="text-[11px] font-bold text-slate-800 truncate">{tx.description || tx.category}</div>
                  <div className="text-[9px] text-slate-400 font-mono">{tx.date} · {tx.category} · {tx.operatorName}</div>
                </div>
                <span className={`text-[11px] font-mono font-extrabold shrink-0 ${tx.type === 'income' ? 'text-emerald-600' : tx.type === 'expense' || tx.type === 'budget_charge' ? 'text-rose-600' : 'text-slate-500'}`}>
                  {tx.type === 'income' ? '+' : tx.type === 'expense' || tx.type === 'budget_charge' ? '−' : ''}{formatAFN(tx.amount)}
                </span>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => onGo('ledger')} className="mt-2 text-[10px] font-bold text-indigo-600 hover:text-indigo-800 cursor-pointer flex items-center gap-1">Open full ledger <ArrowRight className="w-3 h-3" /></button>
        </div>
      </div>

      {/* How to work — role-aware playbook */}
      <div className="rounded-2xl border border-indigo-100 bg-gradient-to-r from-indigo-50/60 to-slate-50 p-5">
        <h3 className="text-xs font-extrabold text-slate-900 flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-indigo-600" /> {isFinanceRole ? 'Finance desk — how to work' : 'Budget controller — how to work'}</h3>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
          {(isFinanceRole ? [
            ['1 · Collect', 'Record student payments and issue receipts from the Invoices tab. Income is booked to the ledger and savings are skimmed automatically.'],
            ['2 · Pay', 'Submit operational expenses against funded budget lines (Ops). Amounts above the auto-approve threshold wait for a manager.'],
            ['3 · Follow receivables', 'Watch overdue invoices in this dashboard and follow up with students so cash keeps flowing.'],
            ['4 · Report', 'Review the ledger, P&L and expense report. Every number here comes from the database — nothing is estimated.'],
            ['5 · Verify', 'Check the reconciliation health badge; if it is red, inspect mismatches before the month closes.'],
          ] : [
            ['1 · Fund', 'Deposit capital into the central treasury (owner), then allocate funds to budget lines so the desk can pay.'],
            ['2 · Approve', 'Review pending expense requests; approving pays the amount from the budget line and books the expense.'],
            ['3 · Monitor', 'Watch utilization: fund lines before they run out and keep an eye on at-risk budgets in this dashboard.'],
            ['4 · Close the month', 'In Month-End, return unused budget to the treasury or transfer it to another line.'],
            ['5 · Verify', 'Confirm the reconciliation is healthy and the P&L matches the ledger before signing off.'],
          ]).map(([title, body]) => (
            <div key={title as string} className="rounded-xl bg-white border border-slate-200 p-3">
              <div className="text-[11px] font-extrabold text-indigo-700">{title}</div>
              <div className="text-[10px] text-slate-500 mt-1 leading-relaxed">{body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
