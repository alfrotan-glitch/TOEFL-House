import React, { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { BudgetLine, ExpenseRequest, FinanceCategory } from '../../types';
import { formatAFN } from '../../utils/format';
import { BudgetLineCascade } from './BudgetLinePicker';

interface Props {
  budgetLines: BudgetLine[];
  financeCategories: FinanceCategory[];
  expenseRequests: ExpenseRequest[];
  isManager: boolean;
  isOwner: boolean;
  createExpenseRequest: (title: string, amount: number, budgetLineId: string) => Promise<void>;
  processExpenseApproval: (requestId: string, isApproved: boolean, rejectReason?: string) => Promise<void>;
}

export default function ExpenseRequestsPanel({
  budgetLines,
  financeCategories,
  expenseRequests,
  isManager,
  isOwner,
  createExpenseRequest,
  processExpenseApproval,
}: Props) {
  const [reqTitle, setReqTitle] = useState('');
  const [reqAmount, setReqAmount] = useState(0);
  // Starts EMPTY. Defaulting to `budgetLines[0]` meant the first line in an
  // arbitrary sort order was pre-selected, so a distracted user could file an
  // expense against whichever category happened to sort first.
  const [reqBudgetLineId, setReqBudgetLineId] = useState('');

  const [reqError, setReqError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reqTitle || reqAmount <= 0 || !reqBudgetLineId) {
      alert('Please enter a valid expense title and amount.');
      return;
    }
    setSubmitting(true);
    setReqError(null);
    try {
      await createExpenseRequest(reqTitle, reqAmount, reqBudgetLineId);
      setReqTitle('');
      setReqAmount(0);
    } catch (err) {
      setReqError(err instanceof Error ? err.message : 'Could not create expense request.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {isManager && (
        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4 h-fit">
          <h3 className="text-sm font-extrabold text-slate-900 border-b border-slate-100 pb-2">
            New expense request
          </h3>
          <form onSubmit={handleSubmit} className="space-y-4 text-xs">
            {reqError && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] font-semibold text-rose-700" role="alert">{reqError}</div>}
            <div className="space-y-1">
              <label className="block text-slate-600 font-medium">Expense title:</label>
              <input
                type="text"
                placeholder="e.g. Classroom cleaning supplies"
                value={reqTitle}
                onChange={(e) => setReqTitle(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none"
                required
              />
            </div>
            <div className="space-y-1">
              <label className="block text-slate-600 font-medium">Estimated amount (AFN):</label>
              <input
                type="number"
                value={reqAmount || ''}
                onChange={(e) => setReqAmount(Number(e.target.value))}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono"
                min={1}
                required
              />
            </div>
            <BudgetLineCascade
              budgetLines={budgetLines}
              financeCategories={financeCategories}
              value={reqBudgetLineId}
              onChange={setReqBudgetLineId}
              idPrefix="req"
            />
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold py-2.5 rounded-lg transition-colors cursor-pointer shadow-sm"
            >
              {submitting ? 'Submitting…' : 'Submit request to owners'}
            </button>
          </form>
        </div>
      )}

      <div
        className={`${isManager ? 'lg:col-span-8' : 'lg:col-span-12'} bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4`}
      >
        <h3 className="text-sm font-extrabold text-slate-900">Expense requests & approval outcomes</h3>
        <div className="overflow-x-auto text-xs">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 text-slate-500">
                <th className="py-2.5 px-3 font-bold text-slate-700">Title</th>
                <th className="py-2.5 px-3 font-bold text-slate-700">Amount</th>
                <th className="py-2.5 px-3 font-bold text-slate-700">Category → Subcategory → Budget line</th>
                <th className="py-2.5 px-3 font-bold text-slate-700">Requester</th>
                <th className="py-2.5 px-3 font-bold text-slate-700 text-center">Status</th>
                {isOwner && <th className="py-2.5 px-3 font-bold text-slate-700 text-left">Action</th>}
              </tr>
            </thead>
            <tbody>
              {expenseRequests.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-10 text-slate-400">
                    No expense requests yet.
                  </td>
                </tr>
              ) : (
                expenseRequests.map((req) => {
                  const bl = budgetLines.find((b) => b.id === req.budgetLineId);
                  return (
                    <tr key={req.id} className="border-b border-slate-50">
                      <td className="py-3 px-3 font-bold text-slate-800">{req.title}</td>
                      <td className="py-3 px-3 font-mono">{formatAFN(req.amount)}</td>
                      <td className="py-3 px-3 text-indigo-600 font-medium">
                        {bl ? (
                          <>
                            <span className="block text-[10px] font-semibold text-slate-400">
                              {[bl.parentCategoryName, bl.subcategoryName].filter(Boolean).join(' › ') || '—'}
                            </span>
                            {bl.name}
                          </>
                        ) : 'Unknown'}
                      </td>
                      <td className="py-3 px-3 text-slate-500">{req.requester}</td>
                      <td className="py-3 px-3 text-center">
                        <span
                          className={`text-[9px] font-black px-1.5 py-0.5 rounded-full ${
                            req.status === 'approved'
                              ? 'bg-emerald-50 text-emerald-700'
                              : req.status === 'rejected'
                                ? 'bg-rose-50 text-rose-700'
                                : 'bg-amber-50 text-amber-700'
                          }`}
                        >
                          {req.status === 'approved'
                            ? 'Paid'
                            : req.status === 'rejected'
                              ? 'Rejected'
                              : 'Pending'}
                        </span>
                      </td>
                      {isOwner && (
                        <td className="py-3 px-3 text-left">
                          {req.status === 'pending' && (
                            <div className="flex gap-1 justify-end">
                              <button
                                type="button"
                                onClick={async () => { try { await processExpenseApproval(req.id, true); } catch (err) { setReqError(err instanceof Error ? err.message : 'Approval failed.'); } }}
                                className="p-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-600 rounded cursor-pointer"
                                title="Approve & pay"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  const reason = prompt('Enter rejection reason:');
                                  if (reason != null) { try { await processExpenseApproval(req.id, false, reason); } catch (err) { setReqError(err instanceof Error ? err.message : 'Rejection failed.'); } }
                                }}
                                className="p-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded cursor-pointer"
                                title="Reject request"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
