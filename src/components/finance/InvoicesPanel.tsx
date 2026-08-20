/**
 * Student invoices — create, issue, collect payment.
 * All figures come from the API / database (no hardcoded balances).
 */
import React, { useMemo, useState } from 'react';
import { FileText, Plus, Check, X, Banknote } from 'lucide-react';
import type { Invoice, Student, FinanceConfig } from '../../types';
import { formatAFN } from '../../utils/format';

interface Props {
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
  isOwner: boolean;
}

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  issued: 'bg-amber-50 text-amber-700',
  partial: 'bg-sky-50 text-sky-700',
  paid: 'bg-emerald-50 text-emerald-700',
  overdue: 'bg-rose-50 text-rose-700',
  cancelled: 'bg-slate-100 text-slate-400',
};

export default function InvoicesPanel({
  invoices,
  students,
  financeConfig,
  createInvoice,
  issueInvoice,
  payInvoice,
  cancelInvoice,
  updateFinanceConfig,
  isOwner,
}: Props) {
  const [studentId, setStudentId] = useState('');
  const [description, setDescription] = useState('Tuition fee');
  const [unitPrice, setUnitPrice] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [discount, setDiscount] = useState(0);
  const [notes, setNotes] = useState('');
  const [issueNow, setIssueNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState<Record<string, number>>({});
  const [dueDaysDraft, setDueDaysDraft] = useState(financeConfig?.invoiceDueDays ?? 30);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const activeStudents = useMemo(
    () => students.filter((s) => s.status === 'active' || s.status === 'inactive'),
    [students]
  );

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return invoices;
    return invoices.filter((i) => i.status === statusFilter);
  }, [invoices, statusFilter]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!studentId || unitPrice < 0 || !description.trim()) {
      setMessage('Student, description, and a valid unit price are required.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const inv = await createInvoice({
        studentId,
        items: [{ description: description.trim(), quantity, unitPrice }],
        discountAmount: discount,
        notes: notes || undefined,
        issue: issueNow,
      });
      setMessage(
        inv.status === 'issued'
          ? `Invoice ${inv.invoiceNumber} issued — net ${formatAFN(inv.netAmount)}.`
          : `Draft invoice saved — net ${formatAFN(inv.netAmount)}.`
      );
      setUnitPrice(0);
      setDiscount(0);
      setNotes('');
    } catch (err: any) {
      setMessage(err?.message || 'Failed to create invoice.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-xs text-slate-600">
        <p className="font-extrabold text-slate-900 mb-1">Student invoices</p>
        <p>
          Create fee invoices from live student records. Payments update the ledger and account balances
          stored in the database (not hardcoded UI values). Due date uses the configurable
          <span className="font-mono font-bold"> invoice_due_days </span>
          setting ({financeConfig?.invoiceDueDays ?? '—'} days).
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-3 h-fit">
          <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-2 border-b border-slate-100 pb-2">
            <Plus className="w-4 h-4 text-indigo-600" /> New invoice
          </h3>
          <form onSubmit={handleCreate} className="space-y-3 text-xs">
            <div className="space-y-1">
              <label className="block text-slate-600 font-medium">Student</label>
              <select
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer"
                required
              >
                <option value="">Select student…</option>
                {activeStudents.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName} ({s.studentCode})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="block text-slate-600 font-medium">Line description</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="block text-slate-600 font-medium">Qty</label>
                <input
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-slate-600 font-medium">Unit price (AFN)</label>
                <input
                  type="number"
                  min={0}
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(Number(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono"
                  required
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="block text-slate-600 font-medium">Discount (AFN)</label>
              <input
                type="number"
                min={0}
                value={discount}
                onChange={(e) => setDiscount(Number(e.target.value))}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-slate-600 font-medium">Notes</label>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5"
                placeholder="Optional"
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer text-slate-600">
              <input type="checkbox" checked={issueNow} onChange={(e) => setIssueNow(e.target.checked)} />
              Issue immediately (otherwise save as draft)
            </label>
            {message && (
              <div className="rounded-lg px-3 py-2 text-[11px] font-semibold bg-slate-50 border border-slate-200 text-slate-700">
                {message}
              </div>
            )}
            <button
              type="submit"
              disabled={busy || activeStudents.length === 0}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold py-2.5 rounded-lg"
            >
              {busy ? 'Saving…' : issueNow ? 'Create & issue invoice' : 'Save draft'}
            </button>
          </form>

          {isOwner && (
            <div className="border-t border-slate-100 pt-4 space-y-2">
              <label className="block text-[11px] font-bold text-slate-600">Invoice due days (config)</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={0}
                  value={dueDaysDraft}
                  onChange={(e) => setDueDaysDraft(Number(e.target.value))}
                  className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono text-xs"
                />
                <button
                  type="button"
                  className="px-3 py-2 bg-slate-800 text-white text-xs font-bold rounded-lg"
                  onClick={async () => {
                    await updateFinanceConfig({ invoiceDueDays: dueDaysDraft });
                    setMessage(`invoice_due_days set to ${dueDaysDraft}.`);
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-2">
              <FileText className="w-4 h-4 text-indigo-600" /> Invoices ({filtered.length})
            </h3>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 cursor-pointer"
            >
              <option value="all">All statuses</option>
              <option value="draft">Draft</option>
              <option value="issued">Issued</option>
              <option value="partial">Partial</option>
              <option value="paid">Paid</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>

          {filtered.length === 0 ? (
            <p className="text-center text-slate-400 py-12 text-xs">No invoices in the database for this filter.</p>
          ) : (
            <div className="space-y-3 max-h-[560px] overflow-y-auto">
              {filtered.map((inv) => (
                <div key={inv.id} className="border border-slate-100 rounded-xl p-3.5 space-y-2 text-xs">
                  <div className="flex flex-wrap justify-between gap-2">
                    <div>
                      <p className="font-extrabold text-slate-900">
                        {inv.invoiceNumber || inv.id}{' '}
                        <span className="text-slate-400 font-medium">— {inv.studentName || inv.studentId}</span>
                      </p>
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        {inv.studentCode ? `${inv.studentCode} · ` : ''}
                        issued {inv.issueDate}
                        {inv.dueDate ? ` · due ${inv.dueDate}` : ''}
                      </p>
                    </div>
                    <div className="text-start">
                      <p className="font-mono font-extrabold text-slate-900">{formatAFN(inv.netAmount)}</p>
                      <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-full ${STATUS_STYLE[inv.status] || ''}`}>
                        {inv.status}
                      </span>
                    </div>
                  </div>
                  {inv.items?.length > 0 && (
                    <ul className="text-[10px] text-slate-500 space-y-0.5">
                      {inv.items.map((it, idx) => (
                        <li key={it.id || idx}>
                          {it.description} × {it.quantity} @ {formatAFN(it.unitPrice)} = {formatAFN(it.amount)}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex flex-wrap gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
                    {inv.status === 'draft' && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 font-bold border border-amber-100"
                        onClick={async () => {
                          try {
                            const r = await issueInvoice(inv.id);
                            setMessage(`Issued ${r.invoiceNumber}.`);
                          } catch (err: any) {
                            setMessage(err?.message || 'Issue failed.');
                          }
                        }}
                      >
                        <Check className="w-3 h-3" /> Issue
                      </button>
                    )}
                    {['issued', 'partial', 'overdue'].includes(inv.status) && (
                      <>
                        <input
                          type="number"
                          min={1}
                          placeholder="Amount"
                          value={payAmount[inv.id] ?? inv.netAmount}
                          onChange={(e) => setPayAmount((prev) => ({ ...prev, [inv.id]: Number(e.target.value) }))}
                          className="w-28 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 font-mono"
                        />
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 font-bold border border-emerald-100"
                          onClick={async () => {
                            try {
                              const amt = payAmount[inv.id] ?? inv.netAmount;
                              const r = await payInvoice(inv.id, amt, 'cash');
                              setMessage(`Payment recorded. Receipt ${r.receiptNumber}.`);
                            } catch (err: any) {
                              setMessage(err?.message || 'Payment failed.');
                            }
                          }}
                        >
                          <Banknote className="w-3 h-3" /> Record payment
                        </button>
                      </>
                    )}
                    {!['paid', 'cancelled'].includes(inv.status) && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-50 text-rose-600 font-bold border border-rose-100"
                        onClick={async () => {
                          try {
                            await cancelInvoice(inv.id);
                            setMessage('Invoice cancelled.');
                          } catch (err: any) {
                            setMessage(err?.message || 'Cancel failed.');
                          }
                        }}
                      >
                        <X className="w-3 h-3" /> Cancel
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
