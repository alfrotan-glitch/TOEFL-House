/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { control, text } from '../../design-system/styles';
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Visitor, Class, Branch, ConversionEligibility } from '../../types';
import { formatAFN } from '../../utils/format';
import { Banknote, CreditCard, Building2, Receipt, CheckCircle2, AlertCircle, Printer, Loader2, X, Award, ShieldAlert } from 'lucide-react';
import { BRAND_NAME } from '../../config/branding';
import { printFeeBill } from '../../utils/feeBillTemplate';
import { resolveDocumentIssuer } from '../../config/documentIssuer';

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
  /** Read-only pre-flight against the server's placement authority (UX-3). */
  checkConversionEligibility: (visitorId: string, classId?: string) => Promise<ConversionEligibility>;
  /** Send the operator straight to the assessment that unblocks this lead. */
  onOpenPlacementTest?: () => void;
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
  triggerToast,
  checkConversionEligibility,
  onOpenPlacementTest
}: ConvertToStudentModalProps) {
  const [classId, setClassId] = useState<string>('');
  const [amountPaid, setAmountPaid] = useState<number>(0);
  const [discountPercent, setDiscountPercent] = useState<number>(0);
  const [convNotes, setConvNotes] = useState<string>('');
  const [semesterFee, setSemesterFee] = useState<number>(0);
  // Conversion preserves the lead's owning branch. Branch transfer is a
  // separate authorized workflow, not an admissions form option.
  const conversionBranchId = convertingVisitor.branchId || activeBranchId;
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [converting, setConverting] = useState(false);
  const [result, setResult] = useState<ConversionResult | null>(null);
  const receiptRef = useRef<HTMLDivElement>(null);

  const selectedClass = classes.find((c) => c.id === classId);

  // ── Placement pre-flight (UX-3) ───────────────────────────────────────────
  // The server refuses placement-ineligible conversions, but it could only say
  // so at Confirm — after the operator had chosen a class, entered a fee and a
  // discount, and often taken cash. We now ask the SAME authority up front:
  // once on open (lifecycle blockers) and again whenever the class changes
  // (the class's level decides which placement policy governs the seat).
  const [eligibility, setEligibility] = useState<ConversionEligibility | null>(null);
  const [checkingEligibility, setCheckingEligibility] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setCheckingEligibility(true);
    checkConversionEligibility(convertingVisitor.id, classId || undefined)
      .then((res) => { if (!cancelled) setEligibility(res); })
      .catch((err: any) => {
        // Fail CLOSED on a check failure: showing a payment form we cannot
        // vouch for is the exact dead end this feature removes.
        if (!cancelled) {
          setEligibility({
            eligible: false,
            code: 'placement_required',
            reason: err?.message || 'Could not verify enrollment eligibility. Please retry.',
            requirementMode: 'unknown',
            placementStatus: convertingVisitor.placementStatus || 'not_started',
            placementActionable: false,
          });
        }
      })
      .finally(() => { if (!cancelled) setCheckingEligibility(false); });
    return () => { cancelled = true; };
  }, [convertingVisitor.id, convertingVisitor.placementStatus, classId, checkConversionEligibility]);

  /** True when the lead can never convert in this modal (no class will help). */
  const blockedOutright = Boolean(
    eligibility && !eligibility.eligible &&
    ['already_converted', 'lead_lost', 'student_exists'].includes(eligibility.code)
  );
  const blockedForClass = Boolean(eligibility && !eligibility.eligible && !blockedOutright);

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

  const recommendedLevelId = convertingVisitor.placementScore?.recommendation?.levelId
    ?? convertingVisitor.placementScore?.recommendationLevelId
    ?? null;
  const recommendedLevel = convertingVisitor.placementScore?.recommendation?.text
    ?? convertingVisitor.placementScore?.levelRecommendation
    ?? recommendedLevelId;
  const placementTotal = convertingVisitor.placementScore?.total
    ?? convertingVisitor.placementScore?.totalScore
    ?? convertingVisitor.placementScore?.percentage
    ?? null;

  const { recommendedClasses, otherClasses } = useMemo(() => {
    if (!recommendedLevelId && !recommendedLevel) return { recommendedClasses: [] as Class[], otherClasses: eligibleClasses };
    const recommended: Class[] = [];
    const other: Class[] = [];
    for (const c of eligibleClasses) {
      if ((recommendedLevelId && c.levelId === recommendedLevelId) || (!recommendedLevelId && c.level === recommendedLevel)) recommended.push(c);
      else other.push(c);
    }
    return { recommendedClasses: recommended, otherClasses: other };
  }, [eligibleClasses, recommendedLevel, recommendedLevelId]);

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
    if (eligibility && !eligibility.eligible) return triggerToast(eligibility.reason, 'error');
    if (safeAmountPaid > netAmount) return triggerToast(`Amount paid exceeds the net fee (${formatAFN(netAmount)}).`, 'error');

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
    const opened = printFeeBill(
      {
        receiptNumber: result?.receiptNumber || null,
        studentName: convertingVisitor.fullName,
        studentCode: result?.studentCode || null,
        className: selectedClass?.name || null,
        invoiceNumber: result?.invoiceNumber || null,
        grossFee: Number(semesterFee || 0),
        discountPercent,
        netPayable: Number(result?.netAmount ?? netAmount),
        paidToday: safeAmountPaid,
        remaining: Math.max(0, Number(result?.netAmount ?? netAmount) - safeAmountPaid),
        paymentMethodLabel: METHOD_LABELS[paymentMethod],
        issueDate: new Date().toISOString().slice(0, 10),
      },
      resolveDocumentIssuer(branches.find((b) => b.id === (conversionBranchId || convertingVisitor.branchId || activeBranchId))),
      formatAFN,
    );
    if (!opened) triggerToast('Please allow popups to print the receipt.', 'error');
  };

  // ── Success / Receipt View ──
  if (result) {
    const statusStyle = STATUS_COLORS[result.status || 'issued'] || STATUS_COLORS.issued;
    return (
      <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-200" id="convert-receipt-modal">
        <div className="bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-sm text-xs space-y-4 text-start">
          <div className="flex justify-between items-center border-b border-slate-100 pb-3 px-5 pt-5">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center"><CheckCircle2 size={18} className="text-emerald-600" /></div>
              <div><h3 className="font-extrabold text-slate-900 text-sm">Enrollment Complete</h3><p className={text.meta}>Student registered & invoice created</p></div>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X size={16} /></button>
          </div>

          <div ref={receiptRef} className="mx-5 bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2.5">
            <div className="text-center pb-2.5 border-b border-dashed border-slate-300">
              <p className="font-black text-slate-900 text-sm tracking-wide">{BRAND_NAME}</p>
              <p className={text.meta}>Registration Receipt</p>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
              <div className="text-slate-500">Receipt #</div><div className="font-mono font-bold text-end">{result.receiptNumber}</div>
              <div className="text-slate-500">Student Code</div><div className="font-mono font-bold text-end">{result.studentCode}</div>
              <div className="text-slate-500">Invoice #</div><div className="font-mono font-bold text-end">{result.invoiceNumber}</div>
              <div className="text-slate-500">Date</div><div className="font-mono text-end">{new Date().toISOString().slice(0, 10)}</div>
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
              {result.status !== 'paid' && <div className="flex justify-between text-amber-700 font-bold"><span>Remaining</span><span className="font-mono">{formatAFN(Math.max(0, Number(result.netAmount || 0) - safeAmountPaid))} AFN</span></div>}
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
      <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xl w-full max-w-md text-xs space-y-4 text-start">
        <div className="flex justify-between items-start border-b border-slate-100 pb-2.5">
          <div><h3 className="font-extrabold text-slate-900 text-sm">Finalize enrollment</h3><p className="text-[10px] text-slate-400 mt-0.5">Convert {convertingVisitor.fullName} to student — invoice & payment in one step</p></div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X size={16} /></button>
        </div>

        {/* Lifecycle blockers make the whole form pointless — show the reason
            and an exit instead of a fee/payment form that cannot succeed. */}
        {blockedOutright ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-rose-900">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
              <div>
                <p className="font-bold text-[11px]">This lead cannot be enrolled</p>
                <p className="text-[10px] mt-0.5 text-rose-800">{eligibility?.reason}</p>
              </div>
            </div>
            <button type="button" onClick={onClose} className="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-2.5 rounded-xl cursor-pointer">Close</button>
          </div>
        ) : (
        <form onSubmit={handleConvertConfirm} className="space-y-3.5">
          {/* Placement verdict, shown BEFORE the fee and payment fields. */}
          {checkingEligibility ? (
            <p className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400"><Loader2 className="h-3 w-3 animate-spin" /> Checking enrollment eligibility…</p>
          ) : blockedForClass ? (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="flex-1">
                <p className="font-bold text-[11px]">Placement assessment required</p>
                <p className="text-[10px] mt-0.5 text-amber-800">{eligibility?.reason}</p>
                {eligibility?.placementActionable && onOpenPlacementTest && (
                  <button
                    type="button"
                    onClick={onOpenPlacementTest}
                    className="mt-2 inline-flex items-center gap-1.5 bg-amber-600 hover:bg-amber-700 text-white font-bold text-[10px] px-3 py-1.5 rounded-lg cursor-pointer"
                  ><Award className="h-3 w-3" /> Open assessment workspace</button>
                )}
              </div>
            </div>
          ) : eligibility?.requirementMode && eligibility.requirementMode !== 'not_required' ? (
            <p className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-700"><CheckCircle2 className="h-3 w-3" /> Placement cleared — enrollment allowed.</p>
          ) : null}

          <div>
            <label className={text.label}>Assign to class:</label>
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
              {placementTotal != null ? `Total score: ${placementTotal}. ` : ''}Recommended: {recommendedLevel || 'Not assigned'}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={text.label}>Configured class tuition (AFN):</label>
              <input type="number" value={semesterFee} className={`${inputCls} cursor-not-allowed opacity-80`} min={0} readOnly />
            </div>
            <div>
              <label className={text.label}>Discount (%):</label>
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
              <label className={text.label}>Amount paid today (AFN):</label>
              <input type="number" value={amountPaid} onChange={(e) => setAmountPaid(Number(e.target.value))} className={inputCls} min={0} required />
            </div>
            <div>
              <label className={text.label}>Payment method:</label>
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
            <label className={text.label}>Registration branch:</label>
            <div className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 font-bold">
              {branches.find((branch) => branch.id === conversionBranchId)?.name || conversionBranchId}
            </div>
          </div>

          <div>
            <label className={text.label}>Enrollment admin notes:</label>
            <input type="text" placeholder="e.g. Fee paid in full at reception in cash." value={convNotes} onChange={(e) => setConvNotes(e.target.value)} className={control.input} />
          </div>

          {safeAmountPaid > netAmount && (
            <div className="flex items-center gap-1.5 text-rose-600 text-[10px] font-bold bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
              <AlertCircle size={12} /> Amount paid exceeds net payable fee ({formatAFN(netAmount)})
            </div>
          )}

          <div className="flex gap-2 justify-end pt-3 border-t border-slate-100">
            <button type="button" onClick={onClose} className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg font-semibold hover:bg-slate-200 cursor-pointer">Cancel</button>
            <button
              type="submit"
              disabled={converting || checkingEligibility || blockedForClass || safeAmountPaid > netAmount}
              title={blockedForClass ? eligibility?.reason : undefined}
              className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-semibold hover:bg-emerald-700 cursor-pointer shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5">
              {converting ? <Loader2 size={14} className="animate-spin" /> : <Receipt size={14} />} {converting ? 'Processing...' : 'Confirm & create invoice'}
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
}