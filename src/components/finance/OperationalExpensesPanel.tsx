import React, { useState } from 'react';
import { Receipt, ShoppingCart, FileText } from 'lucide-react';
import type { BudgetLine, ExpenseRequest, ExpenseKind, FinanceCategory, OperationalPaymentInput, ExpenseReport } from '../../types';
import { formatAFN } from '../../utils/format';
import { BudgetLineCascade } from './BudgetLinePicker';
import { CLASSIFICATION_BADGE, CLASSIFICATION_LABEL, budgetLinePath } from './financeCategoryGrouping';

const EXPENSE_KIND_LABELS: Record<ExpenseKind, string> = {
  recurring_bill: 'Recurring bill (utilities)',
  one_time_purchase: 'One-time purchase',
  maintenance: 'Maintenance & repairs',
  other: 'Other / miscellaneous',
};

// The hard-coded `OPERATIONAL_PURPOSES` allow-list that used to live here is
// gone. It pinned fourteen legacy purpose strings into the browser, so:
//   · every budget line outside the list was unreachable from this screen, and
//   · every new canonical subcategory would have stayed invisible until
//     somebody remembered to edit a frontend constant.
// The picker is now driven entirely by the server's taxonomy.

interface Props {
  budgetLines: BudgetLine[];
  /** Canonical taxonomy from GET /finance/categories. */
  financeCategories: FinanceCategory[];
  expenseRequests: ExpenseRequest[];
  expenseAutoApproveThreshold: number;
  selectedYear: string;
  selectedMonth: string;
  isOwner: boolean;
  recordOperationalPayment: (input: OperationalPaymentInput) => Promise<{ id: string; status: string; autoApproved: boolean; threshold: number }>;
  getExpenseReport: (year: string, month?: string) => Promise<ExpenseReport>;
  updateExpenseAutoApproveThreshold: (threshold: number) => Promise<void>;
}

export default function OperationalExpensesPanel({
  budgetLines,
  financeCategories,
  expenseRequests,
  expenseAutoApproveThreshold,
  selectedYear,
  selectedMonth,
  isOwner,
  recordOperationalPayment,
  getExpenseReport,
  updateExpenseAutoApproveThreshold,
}: Props) {
  const [opsTitle, setOpsTitle] = useState('');
  const [opsAmount, setOpsAmount] = useState(0);
  const [opsBudgetLineId, setOpsBudgetLineId] = useState('');
  const [opsKind, setOpsKind] = useState<ExpenseKind>('recurring_bill');
  const [opsBillPeriod, setOpsBillPeriod] = useState('');
  const [opsPaymentMethod, setOpsPaymentMethod] = useState<'cash' | 'card' | 'bank_transfer'>('cash');
  const [opsNotes, setOpsNotes] = useState('');
  const [opsRequireApproval, setOpsRequireApproval] = useState(false);
  const [opsSubmitting, setOpsSubmitting] = useState(false);
  const [opsMessage, setOpsMessage] = useState<string | null>(null);
  const [report, setReport] = useState<ExpenseReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [thresholdDraft, setThresholdDraft] = useState(expenseAutoApproveThreshold);

  const handleOpsPaymentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const lineId = opsBudgetLineId;
    if (!opsTitle.trim() || opsAmount <= 0 || !lineId) {
      alert('Title, amount, and a budget line are required.');
      return;
    }
    setOpsSubmitting(true);
    setOpsMessage(null);
    try {
      const result = await recordOperationalPayment({
        title: opsTitle.trim(),
        amount: opsAmount,
        budgetLineId: lineId,
        expenseKind: opsKind,
        billPeriod: opsKind === 'recurring_bill' ? opsBillPeriod || undefined : undefined,
        paymentMethod: opsPaymentMethod,
        notes: opsNotes || undefined,
        requireApproval: opsRequireApproval,
      });
      if (result.status === 'approved') {
        setOpsMessage(`✓ Payment recorded and deducted from budget (${formatAFN(opsAmount)}).`);
      } else {
        setOpsMessage(`Submitted for approval (amount exceeds the ${formatAFN(result.threshold)} threshold).`);
      }
      setOpsTitle('');
      setOpsAmount(0);
      setOpsNotes('');
      setOpsBillPeriod('');
    } catch (err: any) {
      setOpsMessage(err?.message || 'Failed to record payment.');
    } finally {
      setOpsSubmitting(false);
    }
  };

  const loadExpenseReport = async () => {
    setReportLoading(true);
    try {
      setReport(await getExpenseReport(selectedYear, selectedMonth));
    } catch {
      setReport(null);
    } finally {
      setReportLoading(false);
    }
  };

  // Every expense request against a known budget line belongs on this screen.
  // Filtering by a browser-side purpose allow-list silently hid real spend.
  const recentOps = expenseRequests.filter((r) => budgetLines.some((b) => b.id === r.budgetLineId));

  return (
    <div className="space-y-6">
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex gap-3 items-start text-xs">
        <Receipt className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-extrabold text-amber-900">Direct operational expense payment</p>
          <p className="text-amber-800 leading-relaxed">
            Record electricity, water, gas, internet, rent, maintenance, purchases, kitchen, cleaning, and transport here.
            Amounts at or under the auto-approve threshold ({formatAFN(expenseAutoApproveThreshold)}) are paid immediately
            from the budget line; larger amounts require owner approval (unless your role is owner). All balances come from the database.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4 h-fit">
          <h3 className="text-sm font-extrabold text-slate-900 border-b border-slate-100 pb-2 flex items-center gap-2">
            <ShoppingCart className="w-4 h-4 text-indigo-600" />
            Record operational payment
          </h3>
          <form onSubmit={handleOpsPaymentSubmit} className="space-y-3.5 text-xs">
            <div className="space-y-1">
              <label className="block text-slate-600 font-medium">Title / description:</label>
              <input
                type="text"
                placeholder="e.g. July electricity bill / cleaning supplies"
                value={opsTitle}
                onChange={(e) => setOpsTitle(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="block text-slate-600 font-medium">Amount (AFN):</label>
                <input
                  type="number"
                  value={opsAmount || ''}
                  onChange={(e) => setOpsAmount(Number(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono"
                  min={1}
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="block text-slate-600 font-medium">Payment method:</label>
                <select
                  value={opsPaymentMethod}
                  onChange={(e) => setOpsPaymentMethod(e.target.value as 'cash' | 'card' | 'bank_transfer')}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer"
                >
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                  <option value="bank_transfer">Bank transfer</option>
                </select>
              </div>
            </div>
            <BudgetLineCascade
              budgetLines={budgetLines}
              financeCategories={financeCategories}
              value={opsBudgetLineId}
              onChange={setOpsBudgetLineId}
              idPrefix="ops"
            />
            <div className="space-y-1">
              <label className="block text-slate-600 font-medium">Expense type:</label>
              <select
                value={opsKind}
                onChange={(e) => setOpsKind(e.target.value as ExpenseKind)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer"
              >
                {(Object.keys(EXPENSE_KIND_LABELS) as ExpenseKind[]).map((k) => (
                  <option key={k} value={k}>{EXPENSE_KIND_LABELS[k]}</option>
                ))}
              </select>
            </div>
            {opsKind === 'recurring_bill' && (
              <div className="space-y-1">
                <label className="block text-slate-600 font-medium">Bill period (e.g. 2026-07):</label>
                <input
                  type="text"
                  placeholder="2026-07"
                  value={opsBillPeriod}
                  onChange={(e) => setOpsBillPeriod(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono"
                />
              </div>
            )}
            <div className="space-y-1">
              <label className="block text-slate-600 font-medium">Notes (optional):</label>
              <textarea
                value={opsNotes}
                onChange={(e) => setOpsNotes(e.target.value)}
                rows={2}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none"
                placeholder="Bill number, vendor, extra notes..."
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer text-slate-600">
              <input
                type="checkbox"
                checked={opsRequireApproval}
                onChange={(e) => setOpsRequireApproval(e.target.checked)}
                className="rounded"
              />
              <span>Always require approval (even under threshold)</span>
            </label>
            {opsMessage && (
              <div
                className={`rounded-lg px-3 py-2 text-[11px] font-semibold ${
                  opsMessage.startsWith('✓')
                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                    : 'bg-amber-50 text-amber-800 border border-amber-100'
                }`}
              >
                {opsMessage}
              </div>
            )}
            <button
              type="submit"
              disabled={opsSubmitting || budgetLines.length === 0}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold py-2.5 rounded-lg transition-colors cursor-pointer shadow-sm"
            >
              {opsSubmitting ? 'Saving...' : 'Record payment'}
            </button>
          </form>

          {isOwner && (
            <div className="border-t border-slate-100 pt-4 space-y-2">
              <label className="block text-[11px] font-bold text-slate-600">
                Auto-approve threshold (AFN) — owner only:
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={0}
                  value={thresholdDraft}
                  onChange={(e) => setThresholdDraft(Number(e.target.value))}
                  className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={async () => {
                    await updateExpenseAutoApproveThreshold(thresholdDraft);
                    setOpsMessage(`Auto-approve threshold updated to ${formatAFN(thresholdDraft)}.`);
                  }}
                  className="px-3 py-2 bg-slate-800 text-white text-xs font-bold rounded-lg cursor-pointer"
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="lg:col-span-7 space-y-4">
          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-600" />
                Operational expense report
              </h3>
              <button
                type="button"
                onClick={loadExpenseReport}
                className="text-xs font-bold text-indigo-600 hover:bg-indigo-50 px-3 py-1.5 rounded-lg cursor-pointer"
              >
                {reportLoading ? '...' : 'Refresh report'}
              </button>
            </div>
            {report ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between bg-slate-50 rounded-xl px-4 py-3">
                  <span className="text-xs text-slate-500 font-medium">
                    Period: {report.year}
                    {report.month !== 'all' ? ` / month ${report.month}` : ' (full year)'}
                  </span>
                  <span className="font-mono font-extrabold text-rose-700 text-sm">
                    Operating expenses: {formatAFN(report.totalExpense)}
                  </span>
                </div>
                <div className="overflow-x-auto text-xs">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-100 text-slate-500">
                        <th className="py-2 px-2 font-bold">Category → Subcategory → Budget line</th>
                        <th className="py-2 px-2 font-bold">Treatment</th>
                        <th className="py-2 px-2 font-bold text-center">Count</th>
                        <th className="py-2 px-2 font-bold text-left">Total amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {report.rows.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="py-8 text-center text-slate-400">
                            No approved expenses in this period.
                          </td>
                        </tr>
                      ) : (
                        report.rows.map((r) => (
                          <tr key={r.budgetLineId}>
                            <td className="py-2.5 px-2 font-bold text-slate-800">
                              {r.categoryName ? (
                                <span className="block text-[10px] font-semibold text-slate-400">
                                  {r.categoryName}
                                  {r.subcategoryName ? ` › ${r.subcategoryName}` : ''}
                                </span>
                              ) : null}
                              {r.budgetLineName}
                            </td>
                            <td className="py-2.5 px-2 text-slate-500 space-y-1">
                              <span
                                className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                                  CLASSIFICATION_BADGE[r.classification ?? 'operating_expense']
                                }`}
                              >
                                {CLASSIFICATION_LABEL[r.classification ?? 'operating_expense']}
                              </span>
                              <span className="block text-[10px] text-slate-400">
                                {r.costType === 'fixed' ? 'Fixed' : 'Variable'}
                              </span>
                            </td>
                            <td className="py-2.5 px-2 text-center font-mono">{r.count}</td>
                            <td className="py-2.5 px-2 text-left font-mono font-bold text-rose-600">
                              {formatAFN(r.totalAmount)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                {(!!report.totalCapitalExpenditure || !!report.totalNonExpenseCashMovement) && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
                    <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2">
                      <p className="font-bold text-sky-800">Capital expenditure</p>
                      <p className="font-mono text-sky-900">{formatAFN(report.totalCapitalExpenditure || 0)}</p>
                      <p className="text-[10px] text-sky-700 mt-0.5">Fixed assets — cash out, not operating cost.</p>
                    </div>
                    <div className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-2">
                      <p className="font-bold text-violet-800">Non-expense cash movements</p>
                      <p className="font-mono text-violet-900">{formatAFN(report.totalNonExpenseCashMovement || 0)}</p>
                      <p className="text-[10px] text-violet-700 mt-0.5">Advances, refunds, drawings, contributions.</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="font-bold text-slate-700">Total cash out</p>
                      <p className="font-mono text-slate-900">{formatAFN(report.totalCashOut || report.totalExpense)}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5">All three treatments combined.</p>
                    </div>
                  </div>
                )}
                {report.byKind && report.byKind.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
                    {report.byKind.map((k) => (
                      <span
                        key={k.kind}
                        className="text-[10px] bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-full px-2.5 py-1 font-bold"
                      >
                        {EXPENSE_KIND_LABELS[k.kind as ExpenseKind] || k.kind}: {formatAFN(k.total)} ({k.count})
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-center text-slate-400 py-8 text-xs">
                {reportLoading ? 'Loading...' : 'Click Refresh report to load data.'}
              </p>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-3">
            <h3 className="text-sm font-extrabold text-slate-900">Recent operational expenses</h3>
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {recentOps.slice(0, 15).map((r) => {
                const bl = budgetLines.find((b) => b.id === r.budgetLineId);
                return (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-2 border border-slate-100 rounded-xl px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-bold text-slate-800 break-words">{r.title}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        {bl ? budgetLinePath(bl) : '—'} · {r.date}
                        {r.billPeriod ? ` · period: ${r.billPeriod}` : ''}
                        {r.expenseKind ? ` · ${EXPENSE_KIND_LABELS[r.expenseKind] || r.expenseKind}` : ''}
                      </p>
                    </div>
                    <div className="text-left shrink-0">
                      <p className="font-mono font-bold text-slate-800">{formatAFN(r.amount)}</p>
                      <span
                        className={`text-[9px] font-black px-1.5 py-0.5 rounded-full ${
                          r.status === 'approved'
                            ? 'bg-emerald-50 text-emerald-700'
                            : r.status === 'rejected'
                              ? 'bg-rose-50 text-rose-700'
                              : 'bg-amber-50 text-amber-700'
                        }`}
                      >
                        {r.status === 'approved'
                          ? r.autoApproved
                            ? 'Auto-paid'
                            : 'Approved'
                          : r.status === 'rejected'
                            ? 'Rejected'
                            : 'Pending'}
                      </span>
                    </div>
                  </div>
                );
              })}
              {recentOps.length === 0 && (
                <p className="text-center text-slate-400 py-6 text-xs">No operational expenses recorded yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
