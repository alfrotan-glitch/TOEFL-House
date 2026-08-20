/**
 * @license SPDX-License-Identifier: Apache-2.0
 * Finance shell — tabs only. Panel bodies live in sibling files.
 * All balances and lists come from API / database props (no hardcoded figures).
 */
import React, { useEffect, useState } from 'react';
import { CalendarCheck } from 'lucide-react';
import type {
  BudgetLine, BudgetLineInput, FinanceCategory, ExpenseRequest, FinancialTransaction, UserRole,
  ExpenseKind, OperationalPaymentInput, ExpenseReport, Invoice, Student, FinanceConfig, FinanceDashboard,
} from '../../types';
import { formatAFN } from '../../utils/format';
import { getRoleLabel } from '../../config/roles';
import { api } from '../../api/client';
import { useInvalidate } from '../../state/serverStateFreshness';
import FinanceModals from './FinanceModals';
import BudgetsPanel from './BudgetsPanel';
import ExpenseRequestsPanel from './ExpenseRequestsPanel';
import OperationalExpensesPanel from './OperationalExpensesPanel';
import InvoicesPanel from './InvoicesPanel';
import LedgerPanel from './LedgerPanel';
import PnLPanel from './PnLPanel';
import MonthEndPanel from './MonthEndPanel';
import FinanceDashboardPanel from './FinanceDashboardPanel';
import { BRAND_NAME } from '../../config/branding';

export interface FinanceViewProps {
  budgetLines: BudgetLine[];
  financeCategories: FinanceCategory[];
  expenseRequests: ExpenseRequest[];
  transactions: FinancialTransaction[];
  mainAccountBalance: number;
  savingBalance: number;
  activeRole: UserRole;
  chargeBudget: (budgetLineId: string, amount: number) => void;
  createBudgetLine: (input: BudgetLineInput) => Promise<void>;
  createExpenseRequest: (
    title: string,
    amount: number,
    budgetLineId: string,
    meta?: { expenseKind?: ExpenseKind; billPeriod?: string; paymentMethod?: 'cash' | 'card' | 'bank_transfer'; notes?: string }
  ) => Promise<void>;
  recordOperationalPayment: (input: OperationalPaymentInput) => Promise<{ id: string; status: string; autoApproved: boolean; threshold: number }>;
  getExpenseReport: (year: string, month?: string) => Promise<ExpenseReport>;
  updateExpenseAutoApproveThreshold: (threshold: number) => Promise<void>;
  expenseAutoApproveThreshold: number;
  invoices: Invoice[];
  students: Student[];
  financeConfig: FinanceConfig | null;
  createInvoice: (payload: {
    studentId: string;
    items: { description: string; quantity?: number; unitPrice: number }[];
    discountAmount?: number;
    notes?: string;
    issue?: boolean;
  }) => Promise<Invoice>;
  issueInvoice: (id: string) => Promise<Invoice>;
  payInvoice: (
    id: string,
    amount: number,
    paymentMethod?: 'cash' | 'card' | 'bank_transfer',
    notes?: string
  ) => Promise<{ invoice: Invoice; paymentId: string; receiptNumber: string }>;
  cancelInvoice: (id: string) => Promise<void>;
  updateFinanceConfig: (patch: Partial<FinanceConfig>) => Promise<void>;
  processExpenseApproval: (requestId: string, isApproved: boolean, rejectReason?: string) => Promise<void>;
  processMonthEnd: (budgetLineId: string, decision: 'return' | 'transfer', targetBudgetLineId?: string) => Promise<void>;
  updateSavingSettings: (percent: number) => Promise<void>;
  savingPercent: number;
  runSavingEngine: () => Promise<void>;
  permissionCodes?: string[];
  financeReconciliation?: { healthy: boolean; scope: string; branchId: string | null; paymentBackedTotal: number; ledgerBackedTotal: number; amountVariance: number; unmatchedPayments: number; orphanLedgerRows: number; mismatchedPayments: Array<{ paymentId: string; paymentAmount: number; ledgerAmount: number; variance: number }> } | null;
  financeDashboard?: FinanceDashboard | null;
  isTabLoading?: boolean;
  reloadFinanceDashboard?: () => Promise<void>;
  ensureFinanceSection: (section: string) => Promise<void>;
}

type FinanceTab = 'overview' | 'budgets' | 'expenses' | 'ops' | 'invoices' | 'ledger' | 'pnl' | 'reconciliation' | 'closing';

const TABS: { id: FinanceTab; label: string; ownerOnly?: boolean }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'expenses', label: 'Expense Requests' },
  { id: 'ops', label: 'Operational Expenses' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'pnl', label: 'P&L / Cashflow' },
  { id: 'reconciliation', label: 'Reconciliation' },
  { id: 'closing', label: 'Month-End & Savings', ownerOnly: true },
];

export default function FinanceView(props: FinanceViewProps) {
  const invalidate = useInvalidate();
  const {
    budgetLines, financeCategories, expenseRequests, transactions, mainAccountBalance, savingBalance, activeRole,
    chargeBudget, createBudgetLine, createExpenseRequest, recordOperationalPayment, getExpenseReport,
    updateExpenseAutoApproveThreshold, expenseAutoApproveThreshold,
    invoices, students, financeConfig, createInvoice, issueInvoice, payInvoice, cancelInvoice, updateFinanceConfig,
    processExpenseApproval, processMonthEnd, updateSavingSettings, savingPercent, runSavingEngine,
    permissionCodes, financeReconciliation, financeDashboard, isTabLoading, reloadFinanceDashboard, ensureFinanceSection,
  } = props;

  const [financeTab, setFinanceTab] = useState<FinanceTab>('overview');
  const [timeFrame, setTimeFrame] = useState<'all' | 'daily' | 'monthly' | 'yearly'>('all');
  const [selectedYear, setSelectedYear] = useState(String(new Date().getFullYear()));
  const [selectedMonth, setSelectedMonth] = useState<string>('all');
  const [showReportModal, setShowReportModal] = useState(false);
  const [chargingBudgetLine, setChargingBudgetLine] = useState<BudgetLine | null>(null);
  const [chargeAmount, setChargeAmount] = useState(0);
  const [budgetActionError, setBudgetActionError] = useState<string | null>(null);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [depositAmount, setDepositAmount] = useState(0);
  const [depositNotes, setDepositNotes] = useState('');
  const [depositBusy, setDepositBusy] = useState(false);
  const [depositError, setDepositError] = useState<string | null>(null);

  const isOwner = activeRole === 'owner';
  const isManager = activeRole === 'general_manager' || isOwner;
  /** Budget allocation, month-end, policy — not finance clerk */
  const hasPermissionCode = (code: string) => activeRole === 'owner' || (permissionCodes?.includes(code) ?? false);
  const canViewBudget = hasPermissionCode('Budget.View');
  const canAllocateBudget = hasPermissionCode('Budget.Allocate') || hasPermissionCode('Budget.Edit');
  const canViewReports = hasPermissionCode('Finance.Report') || hasPermissionCode('Ledger.View');
  const canReconcile = hasPermissionCode('Finance.Report') || hasPermissionCode('Ledger.View');
  const canControlFinance = canAllocateBudget;
  const canSeeClosing = canAllocateBudget;

  useEffect(() => {
    void ensureFinanceSection(financeTab);
  }, [financeTab, ensureFinanceSection]);

  const handleChargeBudgetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chargingBudgetLine || chargeAmount <= 0) return;
    setBudgetActionError(null);
    try {
      await chargeBudget(chargingBudgetLine.id, chargeAmount);
      setChargingBudgetLine(null);
      setChargeAmount(0);
    } catch (err) {
      setBudgetActionError(err instanceof Error ? err.message : 'Charge failed. Please try again.');
    }
  };

  const handleDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (depositAmount <= 0) { setDepositError('Deposit amount must be greater than zero.'); return; }
    setDepositBusy(true);
    setDepositError(null);
    try {
      await api.post('/finance/treasury/deposit', { amount: depositAmount, notes: depositNotes || undefined });
      invalidate('finance');
      setShowDepositModal(false);
      setDepositAmount(0);
      setDepositNotes('');
      await ensureFinanceSection('overview');
    } catch (err) {
      setDepositError(err instanceof Error ? err.message : 'Deposit failed. Please try again.');
    } finally {
      setDepositBusy(false);
    }
  };

  return (
    <div className="space-y-6 font-sans text-left" dir="ltr" id="finance-view-root">
      <div className="flex flex-col sm:flex-row items-center justify-between border-b border-slate-200 pb-4 gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900">Central Finance &amp; Treasury ({BRAND_NAME})</h2>
          <p className="text-xs text-slate-500 mt-1">
            Budgets, operational expenses, invoices, approvals, savings, and general ledger — all figures from the database.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 bg-slate-100 p-1 rounded-xl border border-slate-200">
          {TABS.filter((t) => !t.ownerOnly || canSeeClosing).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setFinanceTab(t.id)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
                financeTab === t.id ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Financial calendar — filters ledger / P&L / ops report */}
      <div className="bg-gradient-to-l from-indigo-50/40 to-slate-50 border border-slate-200 rounded-2xl p-4 flex flex-col md:flex-row justify-between items-center gap-4 text-xs">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0">
            <CalendarCheck className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-extrabold text-slate-900">Active Financial Calendar</h3>
            <p className="text-[10px] text-slate-500 mt-0.5">Use the period filter for reports and ledger views; treasury balances are current account balances.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 w-full md:w-auto justify-end">
          <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 shadow-xs">
            <span className="text-slate-500 font-bold">Fiscal year:</span>
            <select value={selectedYear} onChange={(e) => setSelectedYear(e.target.value)} className="bg-transparent font-bold text-slate-900 font-mono focus:outline-none cursor-pointer">
              {Array.from({ length: 4 }, (_, i) => new Date().getFullYear() - 2 + i).map((y) => <option key={y} value={String(y)}>{y}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 shadow-xs">
            <span className="text-slate-500 font-bold">Fiscal month:</span>
            <select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} className="bg-transparent font-bold text-slate-900 focus:outline-none cursor-pointer">
              <option value="all">Full year</option>
              {Array.from({ length: 12 }, (_, i) => {
                const m = String(i + 1).padStart(2, '0');
                const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
                return <option key={m} value={m}>{names[i]} ({m})</option>;
              })}
            </select>
          </div>
          {(selectedYear !== String(new Date().getFullYear()) || selectedMonth !== 'all') && (
            <button type="button" onClick={() => { setSelectedYear(String(new Date().getFullYear())); setSelectedMonth('all'); }} className="px-2.5 py-1.5 text-[10px] font-bold text-indigo-600 hover:text-indigo-800">
              Reset to current
            </button>
          )}
        </div>
      </div>

      {/* Account balances from API / DB */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-slate-400">Main account balance:</p>
            {isOwner && (
              <button type="button" onClick={() => setShowDepositModal(true)} className="px-2.5 py-1 text-[10px] font-bold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 rounded-lg cursor-pointer">
                + Deposit capital
              </button>
            )}
          </div>
          <p className="text-lg font-extrabold font-mono text-slate-900 mt-1">{formatAFN(mainAccountBalance)}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
          <p className="text-[11px] text-slate-400">Savings account:</p>
          <p className="text-lg font-extrabold font-mono text-emerald-700 mt-1">{formatAFN(savingBalance)}</p>
        </div>
      </div>

      {financeTab === 'overview' && (
        <FinanceDashboardPanel
          dashboard={financeDashboard ?? null}
          canApprove={canControlFinance}
          canControl={canControlFinance}
          isOwner={isOwner}
          roleLabel={getRoleLabel(activeRole)}
          scopeLabel={isOwner && financeDashboard?.scope === 'organization' ? 'whole organization' : 'current branch'}
          loading={!!isTabLoading}
          onGo={(tab) => setFinanceTab(tab as FinanceTab)}
          onDeposit={() => setShowDepositModal(true)}
          onApprove={async (requestId, approved) => {
            try {
              await processExpenseApproval(requestId, approved);
              await reloadFinanceDashboard?.();
            } catch {
              // approval errors surface in the Expenses tab; keep the dashboard responsive
            }
          }}
          onRefresh={() => { void reloadFinanceDashboard?.(); void ensureFinanceSection('overview'); }}
        />
      )}
      {financeTab === 'budgets' && (
        <BudgetsPanel budgetLines={budgetLines} financeCategories={financeCategories} canView={canViewBudget} canAllocate={canAllocateBudget} onCharge={setChargingBudgetLine} createBudgetLine={createBudgetLine} />
      )}
      {financeTab === 'expenses' && (
        <ExpenseRequestsPanel
          budgetLines={budgetLines}
          financeCategories={financeCategories}
          expenseRequests={expenseRequests}
          isManager={isManager}
          isOwner={canControlFinance}
          createExpenseRequest={createExpenseRequest}
          processExpenseApproval={processExpenseApproval}
        />
      )}
      {financeTab === 'ops' && (
        <OperationalExpensesPanel
          budgetLines={budgetLines}
          financeCategories={financeCategories}
          expenseRequests={expenseRequests}
          expenseAutoApproveThreshold={expenseAutoApproveThreshold}
          selectedYear={selectedYear}
          selectedMonth={selectedMonth}
          isOwner={canControlFinance}
          recordOperationalPayment={recordOperationalPayment}
          getExpenseReport={getExpenseReport}
          updateExpenseAutoApproveThreshold={updateExpenseAutoApproveThreshold}
        />
      )}
      {financeTab === 'invoices' && (
        <InvoicesPanel
          invoices={invoices}
          students={students}
          financeConfig={financeConfig}
          createInvoice={createInvoice}
          issueInvoice={issueInvoice}
          payInvoice={payInvoice}
          cancelInvoice={cancelInvoice}
          updateFinanceConfig={updateFinanceConfig}
          isOwner={canControlFinance}
        />
      )}
      {financeTab === 'ledger' && (
        <LedgerPanel
          selectedYear={selectedYear}
          selectedMonth={selectedMonth}
          timeFrame={timeFrame}
          setTimeFrame={setTimeFrame}
          onOpenReport={() => setShowReportModal(true)}
        />
      )}
      {financeTab === 'pnl' && canViewReports && (
        <PnLPanel selectedYear={selectedYear} selectedMonth={selectedMonth} />
      )}
      {financeTab === 'reconciliation' && canReconcile && (
        <div className="space-y-4">
          <div className={`rounded-2xl border p-5 ${financeReconciliation?.healthy ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-extrabold text-slate-900">Payment ↔ Ledger reconciliation</div>
                <div className="text-xs text-slate-600 mt-1">Checks completed payments against their ledger representation for the current finance scope.</div>
              </div>
              <span className={`text-xs font-extrabold px-3 py-1.5 rounded-full ${financeReconciliation?.healthy ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>{financeReconciliation?.healthy ? 'Healthy' : 'Action required'}</span>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4"><div className="text-[11px] text-slate-400">Payment-backed total</div><div className="text-lg font-extrabold font-mono mt-1">{formatAFN(financeReconciliation?.paymentBackedTotal ?? 0)}</div></div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4"><div className="text-[11px] text-slate-400">Ledger-backed total</div><div className="text-lg font-extrabold font-mono mt-1">{formatAFN(financeReconciliation?.ledgerBackedTotal ?? 0)}</div></div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4"><div className="text-[11px] text-slate-400">Variance</div><div className={`text-lg font-extrabold font-mono mt-1 ${(financeReconciliation?.amountVariance ?? 0) === 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{formatAFN(financeReconciliation?.amountVariance ?? 0)}</div></div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4"><div className="text-[11px] text-slate-400">Unmatched / orphan</div><div className="text-lg font-extrabold font-mono mt-1">{(financeReconciliation?.unmatchedPayments ?? 0) + (financeReconciliation?.orphanLedgerRows ?? 0)}</div></div>
          </div>
          {(financeReconciliation?.mismatchedPayments.length ?? 0) > 0 && (
            <div className="rounded-2xl border border-rose-200 bg-white overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 font-extrabold text-slate-900">Mismatched payments</div>
              <div className="divide-y divide-slate-100">
                {financeReconciliation!.mismatchedPayments.slice(0, 20).map((row) => (
                  <div key={row.paymentId} className="grid grid-cols-4 gap-3 px-5 py-3 text-xs font-mono"><span>{row.paymentId}</span><span>{formatAFN(row.paymentAmount)}</span><span>{formatAFN(row.ledgerAmount)}</span><span className="text-rose-700">{formatAFN(row.variance)}</span></div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {financeTab === 'closing' && canSeeClosing && (
        <MonthEndPanel
          budgetLines={budgetLines}
          financeCategories={financeCategories}
          isOwner={canControlFinance}
          savingPercent={savingPercent}
          processMonthEnd={processMonthEnd}
          updateSavingSettings={updateSavingSettings}
          runSavingEngine={runSavingEngine}
        />
      )}

      {budgetActionError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs font-semibold text-rose-700" role="alert">
          {budgetActionError}
          <button type="button" onClick={() => setBudgetActionError(null)} className="ml-2 text-rose-500 hover:text-rose-700 font-bold cursor-pointer">×</button>
        </div>
      )}

      {showDepositModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xl w-full max-w-md text-xs space-y-4">
            <div className="flex justify-between items-start border-b border-slate-100 pb-2.5">
              <div>
                <h3 className="font-extrabold text-slate-900 text-sm">Deposit capital into central treasury</h3>
                <p className="text-[10px] text-slate-400 mt-0.5">Funds budgets (salary, operations) and month-end settlement.</p>
              </div>
              <button onClick={() => setShowDepositModal(false)} className="text-slate-400 hover:text-slate-600 cursor-pointer text-sm font-bold">×</button>
            </div>
            <form onSubmit={handleDepositSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block text-slate-600 font-semibold">Amount (AFN)</label>
                <input type="number" min={1} value={depositAmount || ''} onChange={(e) => setDepositAmount(Number(e.target.value))} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/10" required />
              </div>
              <div className="space-y-1.5">
                <label className="block text-slate-600 font-semibold">Notes (optional)</label>
                <input type="text" value={depositNotes} onChange={(e) => setDepositNotes(e.target.value)} placeholder="Opening balance, capital injection…" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/10" />
              </div>
              {depositError && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-700" role="alert">{depositError}</div>}
              <button type="submit" disabled={depositBusy} className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold py-2.5 rounded-lg cursor-pointer">
                {depositBusy ? 'Depositing…' : 'Deposit capital'}
              </button>
            </form>
          </div>
        </div>
      )}

      <FinanceModals
        chargingBudgetLine={chargingBudgetLine}
        setChargingBudgetLine={setChargingBudgetLine}
        chargeAmount={chargeAmount}
        setChargeAmount={setChargeAmount}
        handleChargeBudgetSubmit={handleChargeBudgetSubmit}
        mainAccountBalance={mainAccountBalance}
        showReportModal={showReportModal}
        setShowReportModal={setShowReportModal}
        timeFrame={timeFrame}
        transactions={transactions}
      />
    </div>
  );
}
