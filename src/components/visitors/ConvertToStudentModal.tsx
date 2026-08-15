/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useRef } from 'react';
import { Visitor, Class, Branch } from '../../types';
import { formatAFN } from '../../utils/format';
import { Banknote, CreditCard, Building2, Receipt, CheckCircle2, AlertCircle, Printer, Loader2, X } from 'lucide-react';

type PaymentMethod = 'cash' | 'card' | 'bank_transfer';

interface ConversionResult {
  studentId: string;
  studentCode: string;
  receiptNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  netAmount: number;
  status: string;
}

interface ConvertToStudentModalProps {
  convertingVisitor: Visitor;
  classes: Class[];
  branches: Branch[];
  activeBranchId: string;
  registerVisitorToStudent: (
    visitorId: string,
    classId: string,
    amountPaid: number,
    discountPercent: number,
    notes?: string,
    semesterFee?: number,
    branchId?: string,
    paymentMethod?: PaymentMethod
  ) => Promise<ConversionResult>;
  onClose: () => void;
  triggerToast: (msg: string, type: 'success' | 'error' | 'info') => void;
}

const PAYMENT_METHODS: { value: PaymentMethod; label: string; icon: React.ReactNode }[] = [
  { value: 'cash', label: 'Cash', icon: <Banknote size={14} /> },
  { value: 'card', label: 'Card', icon: <CreditCard size={14} /> },
  { value: 'bank_transfer', label: 'Bank', icon: <Building2 size={14} /> },
];

const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank Transfer',
};
const STATUS_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  paid: { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'FULLY PAID' },
  partial: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'PARTIAL PAYMENT' },
  issued: { bg: 'bg-indigo-100', text: 'text-indigo-700', label: 'INVOICE ISSUED' },
};

export default function ConvertToStudentModal({
  convertingVisitor,
  classes,
  branches,
  activeBranchId,
  registerVisitorToStudent,
  onClose,
  triggerToast
}: ConvertToStudentModalProps) {
  const [classId, setClassId] = useState<string>('');
  const [amountPaid, setAmountPaid] = useState<number>(0);
  const [discountPercent, setDiscountPercent] = useState<number>(0);
  const [convNotes, setConvNotes] = useState<string>('');
  const [semesterFee, setSemesterFee] = useState<number>(0);
  const [conversionBranchId, setConversionBranchId] = useState<string>(convertingVisitor.branchId || activeBranchId);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [converting, setConverting] = useState(false);
  const [result, setResult] = useState<ConversionResult | null>(null);
  const receiptRef = useRef<HTMLDivElement>(null);

  const selectedClass = classes.find((c) => c.id === classId);

  const eligibleClasses = useMemo(
    () =>
      classes.filter((c) => {
        if (c.status && c.status !== 'active') return false;
        const targetBranchId = conversionBranchId || convertingVisitor.branchId || activeBranchId;
        if (c.branchId && c.branchId !== targetBranchId) return false;
        const pol = c.genderPolicy || 'mixed';
        if (pol === 'mixed') return true;
        return pol === convertingVisitor.gender;
      }),
    [classes, conversionBranchId, convertingVisitor.gender, convertingVisitor.branchId, activeBranchId]
  );

  const recommendedLevel = convertingVisitor.placementScore?.levelRecommendation;

  const { recommendedClasses, otherClasses } = useMemo(() => {
    if (!recommendedLevel) return { recommendedClasses: [] as Class[], otherClasses: eligibleClasses };
    const recommended: Class[] = [];
    const other: Class[] = [];
    for (const c of eligibleClasses) {
      if (c.level === recommendedLevel) recommended.push(c);
      else other.push(c);
    }
    return { recommendedClasses: recommended, otherClasses: other };
  }, [eligibleClasses, recommendedLevel]);

  const netAmount = useMemo(() => {
    const safeFee = Number(semesterFee || 0);
    const safeDiscount = Math.max(0, Math.min(100, Number(discountPercent || 0)));
    return Math.max(0, Math.round(safeFee - (safeFee * safeDiscount) / 100));
  }, [semesterFee, discountPercent]);

  const safeAmountPaid = Math.max(0, Number(amountPaid || 0));
  const remainingAfterPayment = Math.max(0, netAmount - safeAmountPaid);
  const isFullyPaid = netAmount > 0 && safeAmountPaid >= netAmount;
  const isPartialPayment = safeAmountPaid > 0 && safeAmountPaid < netAmount;

  const handleConvertConfirm = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!classId) return triggerToast('Please select a class.', 'error');
    if (safeAmountPaid > netAmount && netAmount > 0) return triggerToast(`Amount paid exceeds the net fee (${formatAFN(netAmount)}).`, 'error');

    const finalBranchId = conversionBranchId || convertingVisitor.branchId || activeBranchId;
    setConverting(true);

    try {
      const conversionResult = await registerVisitorToStudent(
        convertingVisitor.id, classId, safeAmountPaid, discountPercent, convNotes, semesterFee, finalBranchId, paymentMethod
      );
      setResult(conversionResult);
      triggerToast(`Student registered successfully. ${conversionResult.status === 'paid' ? 'Fully paid.' : conversionResult.status === 'partial' ? 'Partial payment recorded.' : 'Invoice issued.'}`, 'success');
    } catch (err: any) {
      triggerToast(err?.message || err?.response?.data?.error || 'Conversion failed', 'error');
    } finally {
      setConverting(false);
    }
  };

  const handlePrintReceipt = () => {
    if (!receiptRef.current) return;
    const printWindow = window.open('', '_blank', 'width=400,height=600');
    if (!printWindow) return triggerToast('Please allow popups to print the receipt.', 'error');
    
    printWindow.document.write(`
      <!DOCTYPE html><html><head><title>Receipt ${result?.receiptNumber || ''}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Courier New', monospace; font-size: 12px; padding: 20px; max-width: 320px; margin: 0 auto; color: #1e293b; }
        .header { text-align: center; border-bottom: 2px dashed #94a3b8; padding-bottom: 12px; margin-bottom: 12px; }
        .header h1 { font-size: 16px; font-weight: 800; letter-spacing: 1px; }
        .header p { font-size: 10px; color: #64748b; margin-top: 2px; }
        .row { display: flex; justify-content: space-between; padding: 4px 0; }
        .label { color: #64748b; } .value { font-weight: 700; text-align: right; }
        .divider { border-top: 1px dashed #cbd5e1; margin: 8px 0; }
        .total-row { font-size: 14px; font-weight: 800; }
        .footer { text-align: center; margin-top: 16px; padding-top: 12px; border-top: 2px dashed #94a3b8; font-size: 10px; color: #94a3b8; }
        .status-badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 10px; font-weight: 700; }
      </style></head><body>
        <div class="header"><h1>TOEFL HOUSE</h1><p>Registration Receipt</p></div>
        <div class="row"><span class="label">Receipt #</span><span class="value">${result?.receiptNumber || '-'}</span></div>
        <div class="row"><span class="label">Date</span><span class="value">${new Date().toISOString().slice(0, 10)}</span></div>
        <div class="row"><span class="label">Student</span><span class="value">${convertingVisitor.fullName}</span></div>
        <div class="row"><span class="label">Student Code</span><span class="value">${result?.studentCode || '-'}</span></div>
        <div class="divider"></div>
        <div class="row"><span class="label">Class</span><span class="value">${selectedClass?.name || '-'}</span></div>
        <div class="row"><span class="label">Invoice #</span><span class="value">${result?.invoiceNumber || '-'}</span></div>
        ${discountPercent > 0 ? `<div class="row"><span class="label">Gross Fee</span><span class="value">${formatAFN(semesterFee)}</span></div><div class="row"><span class="label">Discount (${discountPercent}%)</span><span class="value">-${formatAFN(Number(semesterFee||0) - netAmount)}</span></div>` : ''}
        <div class="divider"></div>
        <div class="row total-row"><span class="label">Net Payable</span><span class="value">${formatAFN(result?.netAmount || netAmount)} AFN</span></div>
        <div class="divider"></div>
        <div class="row"><span class="label">Paid Today</span><span class="value">${formatAFN(safeAmountPaid)} AFN</span></div>
        <div class="row"><span class="label">Payment Method</span><span class="value">${METHOD_LABELS[paymentMethod]}</span></div>
        ${isPartialPayment ? `<div class="divider"></div><div class="row"><span class="label">Remaining</span><span class="value" style="color:#b45309;">${formatAFN(remainingAfterPayment)} AFN</span></div>` : ''}
        <div class="footer"><p>Thank you for choosing The TOEFL House!</p><p style="margin-top:4px;">This is a system-generated receipt.</p></div>
      </body></html>
    `);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 250);
  };

  // ── Success / Receipt View ──
  if (result) {
    const statusStyle = STATUS_COLORS[result.status || 'issued'] || STATUS_COLORS.issued;
    return (
      <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-200" id="convert-receipt-modal">
        <div className="bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-sm text-xs space-y-4 text-left" dir="ltr">
          <div className="flex justify-between items-center border-b border-slate-100 pb-3 px-5 pt-5">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center"><CheckCircle2 size={18} className="text-emerald-600" /></div>
              <div><h3 className="font-extrabold text-slate-900 text-sm">Enrollment Complete</h3><p className="text-[10px] text-slate-400">Student registered & invoice created</p></div>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X size={16} /></button>
          </div>

          <div ref={receiptRef} className="mx-5 bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2.5">
            <div className="text-center pb-2.5 border-b border-dashed border-slate-300">
              <p className="font-black text-slate-900 text-sm tracking-wide">TOEFL HOUSE</p>
              <p className="text-[10px] text-slate-400">Registration Receipt</p>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
              <div className="text-slate-500">Receipt #</div><div className="font-mono font-bold text-right">{result.receiptNumber}</div>
              <div className="text-slate-500">Student Code</div><div className="font-mono font-bold text-right">{result.studentCode}</div>
              <div className="text-slate-500">Invoice #</div><div className="font-mono font-bold text-right">{result.invoiceNumber}</div>
              <div className="text-slate-500">Date</div><div className="font-mono text-right">{new Date().toISOString().slice(0, 10)}</div>
            </div>
            <div className="border-t border-dashed border-slate-300 pt-2.5 space-y-1.5 text-[11px]">
              <div className="flex justify-between text-slate-500"><span>Student</span><span className="font-bold text-slate-800">{convertingVisitor.fullName}</span></div>
              <div className="flex justify-between text-slate-500"><span>Class</span><span className="font-bold text-slate-800">{selectedClass?.name || '-'}</span></div>
              <div className="flex justify-between text-slate-500"><span>Payment Method</span><span className="font-bold text-slate-800">{METHOD_LABELS[paymentMethod]}</span></div>
            </div>
            {discountPercent > 0 && (
              <div className="border-t border-dashed border-slate-300 pt-2 space-y-1 text-[11px]">
                <div className="flex justify-between text-slate-500"><span>Gross Fee</span><span className="font-mono line-through">{formatAFN(semesterFee)}</span></div>
                <div className="flex justify-between text-slate-500"><span>Discount ({discountPercent}%)</span><span className="font-mono text-rose-600">-{formatAFN(Number(semesterFee||0) - netAmount)}</span></div>
              </div>
            )}
            <div className="border-t border-dashed border-slate-300 pt-2.5 space-y-1.5">
              <div className="flex justify-between font-black text-sm text-slate-900"><span>Net Payable</span><span className="font-mono">{formatAFN(result.netAmount)} AFN</span></div>
              <div className="flex justify-between text-slate-600"><span>Paid Today</span><span className="font-mono font-bold">{formatAFN(safeAmountPaid)} AFN</span></div>
              {result.status === 'partial' && <div className="flex justify-between text-amber-700 font-bold"><span>Remaining</span><span className="font-mono">{formatAFN(Number(result.netAmount||0) - safeAmountPaid)} AFN</span></div>}
            </div>
            <div className="flex justify-center pt-1">
              <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-black ${statusStyle.bg} ${statusStyle.text}`}>{statusStyle.label}</span>
            </div>
          </div>

          <div className="flex gap-2 px-5 pb-5">
            <button onClick={handlePrintReceipt} className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 bg-slate-800 text-white rounded-xl font-semibold hover:bg-slate-900 cursor-pointer shadow-sm"><Printer size={14} /> Print Receipt</button>
            <button onClick={onClose} className="px-4 py-2.5 bg-emerald-600 text-white rounded-xl font-semibold hover:bg-emerald-700 cursor-pointer shadow-sm">Done</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Form View ──
  const inputCls = "w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono font-extrabold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";

  return (
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-200" id="convert-visitor-modal">
      <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xl w-full max-w-md text-xs space-y-4 text-left" dir="ltr">
        <div className="flex justify-between items-start border-b border-slate-100 pb-2.5">
          <div><h3 className="font-extrabold text-slate-900 text-sm">Finalize enrollment</h3><p className="text-[10px] text-slate-400 mt-0.5">Convert {convertingVisitor.fullName} to student — invoice & payment in one step</p></div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X size={16} /></button>
        </div>

        <form onSubmit={handleConvertConfirm} className="space-y-3.5">
          <div>
            <label className="block text-slate-600 font-medium mb-1">Assign to class:</label>
            <select
              value={classId}
              onChange={(e) => {
                const id = e.target.value;
                setClassId(id);
                const cls = classes.find((c) => c.id === id);
                if (cls) {
                  const fee = Number(cls.fee || 0);
                  setSemesterFee(fee);
                  setAmountPaid(fee);
                }
              }}
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 cursor-pointer font-bold text-slate-800 focus:outline-none"
              required
            >
              <option value="">Select class...</option>
              {recommendedClasses.length > 0 && (
                <optgroup label={`⭐ Recommended level: ${recommendedLevel}`}>
                  {recommendedClasses.map((c) => <option key={c.id} value={c.id}>{c.name}{c.scheduleTime ? ` (${c.scheduleTime})` : ''}{` - ${formatAFN(c.fee)}`}</option>)}
                </optgroup>
              )}
              <optgroup label={recommendedClasses.length > 0 ? 'Other classes' : 'All classes'}>
                {otherClasses.map((c) => <option key={c.id} value={c.id}>{c.name}{c.level ? ` [${c.level}]` : ''}{` - ${formatAFN(c.fee)}`}</option>)}
              </optgroup>
            </select>
          </div>

          {convertingVisitor.placementScore && (
            <div className="bg-emerald-50 border border-emerald-150 rounded-xl p-3 text-[10px] text-emerald-800">
              <span className="font-black block">Placement results attached:</span>
              Total score: {convertingVisitor.placementScore.total} (recommended: {convertingVisitor.placementScore.levelRecommendation})
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-600 font-medium mb-1">Gross tuition (AFN):</label>
              <input type="number" value={semesterFee} onChange={(e) => setSemesterFee(Number(e.target.value))} className={inputCls} min={0} required />
            </div>
            <div>
              <label className="block text-slate-600 font-medium mb-1">Discount (%):</label>
              <input type="number" value={discountPercent} onChange={(e) => setDiscountPercent(Number(e.target.value))} className={inputCls} min={0} max={100} />
            </div>
          </div>

          <div className={`rounded-xl p-3 border text-[10px] space-y-1.5 ${isFullyPaid ? 'bg-emerald-50 border-emerald-200' : isPartialPayment ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`}>
            <div className="flex justify-between font-bold text-slate-700"><span>Net payable:</span><span className="font-mono text-sm">{formatAFN(netAmount)}</span></div>
            {discountPercent > 0 && <div className="flex justify-between text-slate-500"><span>Discount ({discountPercent}%):</span><span className="font-mono line-through">-{formatAFN(Number(semesterFee||0) - netAmount)}</span></div>}
            <div className="flex justify-between text-slate-500"><span>Paid today:</span><span className="font-mono">{formatAFN(safeAmountPaid)}</span></div>
            {isPartialPayment && <div className="flex justify-between text-amber-700 font-bold"><span>Remaining balance:</span><span className="font-mono">{formatAFN(remainingAfterPayment)}</span></div>}
            {isFullyPaid && <div className="flex items-center gap-1 text-emerald-700 font-black"><CheckCircle2 size={12} /> Fully settled</div>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-600 font-medium mb-1">Amount paid today (AFN):</label>
              <input type="number" value={amountPaid} onChange={(e) => setAmountPaid(Number(e.target.value))} className={inputCls} min={0} required />
            </div>
            <div>
              <label className="block text-slate-600 font-medium mb-1">Payment method:</label>
              <div className="flex gap-1.5 mt-0.5">
                {PAYMENT_METHODS.map((pm) => (
                  <button key={pm.value} type="button" onClick={() => setPaymentMethod(pm.value)}
                    className={`flex-1 flex items-center justify-center gap-1 px-2 py-2 rounded-lg border text-[10px] font-bold transition-all cursor-pointer ${paymentMethod === pm.value ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm' : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-300'}`}>
                    {pm.icon}<span className="hidden sm:inline">{pm.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-slate-600 font-medium mb-1">Registration branch:</label>
            <select value={conversionBranchId || convertingVisitor.branchId || activeBranchId} onChange={(e) => setConversionBranchId(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 cursor-pointer text-slate-800 font-bold focus:outline-none">
              {branches && branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-slate-600 font-medium mb-1">Enrollment admin notes:</label>
            <input type="text" placeholder="e.g. Fee paid in full at reception in cash." value={convNotes} onChange={(e) => setConvNotes(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2" />
          </div>

          {safeAmountPaid > netAmount && netAmount > 0 && (
            <div className="flex items-center gap-1.5 text-rose-600 text-[10px] font-bold bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              <AlertCircle size={12} /> Amount paid exceeds net payable fee ({formatAFN(netAmount)})
            </div>
          )}

          <div className="flex gap-2 justify-end pt-3 border-t border-slate-100">
            <button type="button" onClick={onClose} className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg font-semibold hover:bg-slate-200 cursor-pointer">Cancel</button>
            <button type="submit" disabled={converting || (safeAmountPaid > netAmount && netAmount > 0)} className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-semibold hover:bg-emerald-700 cursor-pointer shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5">
              {converting ? <Loader2 size={14} className="animate-spin" /> : <Receipt size={14} />} {converting ? 'Processing...' : 'Confirm & create invoice'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}