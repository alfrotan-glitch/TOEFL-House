/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { control, text } from '../../design-system/styles';
import React, { useEffect, useMemo, useState } from 'react';
import { Visitor, Class, Branch, ConversionEligibility } from '../../types';
import { formatAFN } from '../../utils/format';
import { AlertCircle, ArrowRight, Award, CheckCircle2, Loader2, ShieldAlert, UserCheck } from 'lucide-react';

interface ConversionResult {
  studentId: string;
  studentCode: string;
  invoices: Array<{ id: string; invoiceNumber: string | null; chargeKind: 'registration' | 'placement'; amount: number; status: string }>;
  nextStep: string;
}

interface ConvertToStudentModalProps {
  convertingVisitor: Visitor;
  classes: Class[];
  branches: Branch[];
  activeBranchId: string;
  registerVisitorToStudent: (
    visitorId: string,
    payload: { classId?: string; notes?: string; branchId?: string; programVersionId?: string; levelId?: string }
  ) => Promise<ConversionResult>;
  onClose: () => void;
  triggerToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  checkConversionEligibility: (visitorId: string, classId?: string) => Promise<ConversionEligibility>;
  onOpenPlacementTest?: () => void;
}

function fallbackEligibility(message: string, placementStatus: Visitor['placementStatus']): ConversionEligibility {
  return {
    eligible: false,
    code: 'placement_required',
    reason: message,
    requirementMode: 'unknown',
    placementStatus: placementStatus || 'not_started',
    placementActionable: false,
  };
}

export default function ConvertToStudentModal({
  convertingVisitor,
  classes,
  branches,
  activeBranchId,
  registerVisitorToStudent,
  onClose,
  triggerToast,
  checkConversionEligibility,
  onOpenPlacementTest,
}: ConvertToStudentModalProps) {
  const [classId, setClassId] = useState('');
  const [convNotes, setConvNotes] = useState('');
  const [converting, setConverting] = useState(false);
  const [checkingAdmissionEligibility, setCheckingAdmissionEligibility] = useState(true);
  const [admissionEligibility, setAdmissionEligibility] = useState<ConversionEligibility | null>(null);
  const [checkingClassEligibility, setCheckingClassEligibility] = useState(false);
  const [classEligibility, setClassEligibility] = useState<ConversionEligibility | null>(null);
  const [result, setResult] = useState<ConversionResult | null>(null);

  const conversionBranchId = convertingVisitor.branchId || activeBranchId;
  const selectedBranch = branches.find((branch) => branch.id === conversionBranchId);
  const selectedClass = classes.find((candidate) => candidate.id === classId) || null;
  const recommendedLevelId = convertingVisitor.placementScore?.recommendation?.levelId
    ?? convertingVisitor.placementScore?.recommendationLevelId
    ?? null;
  const recommendedLevelLabel = convertingVisitor.placementScore?.recommendation?.text
    ?? convertingVisitor.placementScore?.levelRecommendation
    ?? null;
  const overallCefr = convertingVisitor.placementScore?.overallCefr ?? null;
  const placementTotal = convertingVisitor.placementScore?.percentage
    ?? convertingVisitor.placementScore?.total
    ?? convertingVisitor.placementScore?.totalScore
    ?? null;
  const admissionBannerText = admissionEligibility?.eligible
    ? (classId
        ? 'Admission can proceed. The selected class is validated separately below and will not enroll the student yet.'
        : 'Admission can proceed. Leave the class blank, or choose one to save the intended academic track on the admission record.')
    : admissionEligibility?.reason ?? null;

  useEffect(() => {
    let cancelled = false;
    checkConversionEligibility(convertingVisitor.id)
      .then((res) => { if (!cancelled) setAdmissionEligibility(res); })
      .catch((err: any) => {
        if (!cancelled) {
          setAdmissionEligibility(fallbackEligibility(
            err?.message || 'Could not verify admission readiness. Please retry.',
            convertingVisitor.placementStatus,
          ));
        }
      })
      .finally(() => { if (!cancelled) setCheckingAdmissionEligibility(false); });
    return () => { cancelled = true; };
  }, [checkConversionEligibility, convertingVisitor.id, convertingVisitor.placementStatus]);

  useEffect(() => {
    if (!classId) return;
    let cancelled = false;
    checkConversionEligibility(convertingVisitor.id, classId)
      .then((res) => { if (!cancelled) setClassEligibility(res); })
      .catch((err: any) => {
        if (!cancelled) {
          setClassEligibility(fallbackEligibility(
            err?.message || 'Could not verify the selected class. Please retry.',
            convertingVisitor.placementStatus,
          ));
        }
      })
      .finally(() => { if (!cancelled) setCheckingClassEligibility(false); });
    return () => { cancelled = true; };
  }, [checkConversionEligibility, convertingVisitor.id, convertingVisitor.placementStatus, classId]);

  const availableClasses = useMemo(
    () => classes.filter((candidate) => {
      if (candidate.status && candidate.status !== 'active') return false;
      if (candidate.branchId && candidate.branchId !== conversionBranchId) return false;
      const policy = candidate.genderPolicy || 'mixed';
      return policy === 'mixed' || policy === convertingVisitor.gender;
    }),
    [classes, conversionBranchId, convertingVisitor.gender],
  );

  const { recommendedClasses, otherClasses } = useMemo(() => {
    if (!recommendedLevelId && !recommendedLevelLabel) {
      return { recommendedClasses: [] as Class[], otherClasses: availableClasses };
    }
    const recommended: Class[] = [];
    const other: Class[] = [];
    for (const candidate of availableClasses) {
      if ((recommendedLevelId && candidate.levelId === recommendedLevelId)
        || (!recommendedLevelId && recommendedLevelLabel && candidate.level === recommendedLevelLabel)) {
        recommended.push(candidate);
      } else {
        other.push(candidate);
      }
    }
    return { recommendedClasses: recommended, otherClasses: other };
  }, [availableClasses, recommendedLevelId, recommendedLevelLabel]);

  const blockedOutright = Boolean(
    admissionEligibility && !admissionEligibility.eligible && ['already_converted', 'lead_lost', 'student_exists'].includes(admissionEligibility.code),
  );
  const selectedClassInvalid = Boolean(
    classEligibility && ['class_not_found', 'class_wrong_branch', 'class_inactive', 'placement_policy_unconfigured'].includes(classEligibility.code),
  );
  const placementActionability = classId ? classEligibility : admissionEligibility;
  const classValidationTone = !classEligibility
    ? null
    : selectedClassInvalid
      ? 'error'
      : classEligibility.code === 'placement_required'
        ? 'warning'
        : 'success';

  const handleConvertConfirm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (checkingAdmissionEligibility || checkingClassEligibility) {
      triggerToast('Please wait for the admission checks to finish.', 'info');
      return;
    }
    if (admissionEligibility && !admissionEligibility.eligible && blockedOutright) {
      triggerToast(admissionEligibility.reason, 'error');
      return;
    }
    if (selectedClassInvalid && classEligibility) {
      triggerToast(classEligibility.reason, 'error');
      return;
    }
    setConverting(true);
    try {
      const conversionResult = await registerVisitorToStudent(convertingVisitor.id, {
        classId: classId || undefined,
        notes: convNotes.trim() || undefined,
        branchId: conversionBranchId,
      });
      setResult(conversionResult);
      triggerToast('Student admitted successfully. Continue with placement, invoices, and enrollment from the student workspace.', 'success');
    } catch (err: any) {
      triggerToast(err?.message || err?.response?.data?.error || 'Admission failed.', 'error');
    } finally {
      setConverting(false);
    }
  };

  if (result) {
    return (
      <div className="space-y-5 text-start">
        <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-emerald-100 p-2.5"><CheckCircle2 className="h-5 w-5 text-emerald-700" /></div>
            <div className="flex-1">
              <h3 className="text-sm font-extrabold text-emerald-900">Student admission created</h3>
              <p className="mt-1 text-xs font-semibold text-emerald-800">
                {convertingVisitor.fullName} is now student <span className="font-black">{result.studentCode}</span>.
              </p>
              <p className="mt-2 text-[11px] text-emerald-700">{result.nextStep}</p>
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xs">
          <h4 className="mb-3 text-xs font-extrabold text-slate-900">Issued invoices</h4>
          {result.invoices.length === 0 ? (
            <p className="text-xs text-slate-500">No invoice was issued at admission.</p>
          ) : (
            <div className="space-y-2">
              {result.invoices.map((invoice) => (
                <div key={invoice.id} className="flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50 px-3 py-2.5 text-xs">
                  <div>
                    <p className="font-black text-slate-800">{invoice.chargeKind === 'registration' ? 'Registration fee' : 'Placement fee'}</p>
                    <p className="text-[11px] text-slate-500">{invoice.invoiceNumber || invoice.id}</p>
                  </div>
                  <div className="text-end">
                    <p className="font-mono font-black text-slate-900">{formatAFN(invoice.amount)}</p>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-indigo-600">{invoice.status}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">
            Done
          </button>
          {onOpenPlacementTest && (
            <button onClick={onOpenPlacementTest} className="rounded-2xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-700">
              Start placement for {convertingVisitor.fullName.split(' ')[0]} now
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 text-start">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div>
          <h3 className="text-sm font-extrabold text-slate-900">Admit visitor to student workspace</h3>
          <p className="mt-1 text-[11px] text-slate-500">
            This step creates the student identity and canonical invoices. Placement, payment, and enrollment happen after admission.
          </p>
        </div>
        <div className="rounded-2xl bg-indigo-50 px-3 py-2 text-end">
          <p className="text-[10px] font-bold uppercase tracking-wide text-indigo-500">Branch</p>
          <p className="text-xs font-black text-indigo-900">{selectedBranch?.name || 'Current branch'}</p>
        </div>
      </div>

      {checkingAdmissionEligibility ? (
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
          <Loader2 className="h-4 w-4 animate-spin text-indigo-600" /> Checking admission readiness…
        </div>
      ) : admissionEligibility ? (
        <div className={`rounded-2xl border px-4 py-3 text-xs ${admissionEligibility.eligible ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
          <div className="flex items-start gap-2">
            {admissionEligibility.eligible ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" /> : <AlertCircle className="mt-0.5 h-4 w-4 text-amber-600" />}
            <div>
              <p className="font-black">{admissionEligibility.eligible ? 'Admission is allowed' : 'Attention required'}</p>
              <p className="mt-1">{admissionBannerText}</p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-xs">
          <h4 className="mb-3 text-xs font-extrabold text-slate-900">Placement evidence</h4>
          {convertingVisitor.placementScore ? (
            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-2 rounded-2xl bg-emerald-50 px-3 py-2.5 text-emerald-900">
                <Award className="h-4 w-4 text-emerald-600" />
                <div>
                  <p className="font-black">{convertingVisitor.placementStatus === 'completed' ? 'Placement completed' : 'Placement result recorded'}</p>
                  <p className="text-[11px] text-emerald-700">
                    {recommendedLevelLabel || 'Recommendation recorded'}
                    {overallCefr ? ` · CEFR ${overallCefr}` : ''}
                    {placementTotal != null ? ` · ${placementTotal}%` : ''}
                  </p>
                </div>
              </div>
              {convertingVisitor.placementScore.componentEvidence?.length ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {convertingVisitor.placementScore.componentEvidence.map((component) => (
                    <div key={component.componentKey} className="rounded-2xl border border-slate-100 bg-slate-50 px-3 py-2">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{component.componentKey}</p>
                      <p className="font-black text-slate-800">
                        {component.cefrLevel || '—'}
                        {component.score != null ? ` · ${component.score}` : ''}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
              <div className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 h-4 w-4 text-amber-600" />
                <div>
                  <p className="font-black">No placement result yet</p>
                  <p className="mt-1 text-[11px] text-amber-800">
                    Admit the student first. The placement workspace will then create any required placement invoice against the student balance.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-xs">
          <h4 className="mb-3 text-xs font-extrabold text-slate-900">Optional target class</h4>
          <p className="mb-3 text-[11px] text-slate-500">
            If you choose a valid class, admission saves it on the registration record as the intended class. This does not enroll the student; placement, payment, and enrollment still happen later.
          </p>
          <select
            value={classId}
            onChange={(event) => {
              const nextClassId = event.target.value;
              setClassId(nextClassId);
              setClassEligibility(null);
              setCheckingClassEligibility(Boolean(nextClassId));
            }}
            className={control.select}
          >
            <option value="">Do not record a target class yet</option>
            {recommendedClasses.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.name} — recommended</option>
            ))}
            {otherClasses.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
            ))}
          </select>
          {selectedClass && (
            <>
              <p className="mt-2 text-[11px] font-semibold text-indigo-700">
                Intended class: {selectedClass.name}{selectedClass.level ? ` · ${selectedClass.level}` : ''}
              </p>
              {checkingClassEligibility ? (
                <div className="mt-3 flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] text-slate-600">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-600" /> Checking target class…
                </div>
              ) : classEligibility ? (
                <div className={`mt-3 rounded-2xl border px-3 py-2.5 text-[11px] ${classValidationTone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : classValidationTone === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-rose-200 bg-rose-50 text-rose-900'}`}>
                  <p className="font-black">
                    {classValidationTone === 'success'
                      ? 'Target class validated'
                      : classValidationTone === 'warning'
                        ? 'Target class saved; placement still required later'
                        : 'This class cannot be saved'}
                  </p>
                  <p className="mt-1">
                    {classValidationTone === 'success'
                      ? 'This class will be saved on the admission registration record.'
                      : classValidationTone === 'warning'
                        ? 'This class will be saved as the intended class, but the student must still clear placement before later enrollment.'
                        : 'Choose another active class, or clear this field and admit without a target class.'}
                  </p>
                  <p className="mt-1 text-[10px] opacity-90">{classEligibility.reason}</p>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      <form onSubmit={handleConvertConfirm} className="space-y-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-xs">
        <div>
          <label className={text.label}>Admission note</label>
          <textarea
            value={convNotes}
            onChange={(event) => setConvNotes(event.target.value)}
            rows={3}
            className={`${control.input} mt-1 min-h-[96px]`}
            placeholder="Optional note for the student record"
          />
        </div>

        <div className="rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-xs text-indigo-900">
          <p className="font-black">What happens next</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-indigo-700">
            <span className="rounded-full bg-white px-3 py-1">Admission</span>
            <ArrowRight className="h-3.5 w-3.5" />
            <span className="rounded-full bg-white px-3 py-1">Placement</span>
            <ArrowRight className="h-3.5 w-3.5" />
            <span className="rounded-full bg-white px-3 py-1">Invoice & payment</span>
            <ArrowRight className="h-3.5 w-3.5" />
            <span className="rounded-full bg-white px-3 py-1">Enrollment</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <button type="button" onClick={onClose} className="rounded-2xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50">
            Cancel
          </button>
          <div className="flex items-center gap-2">
            {placementActionability && !placementActionability.eligible && placementActionability.placementActionable && onOpenPlacementTest && (
              <button type="button" onClick={onOpenPlacementTest} className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-bold text-amber-800 hover:bg-amber-100">
                Open placement
              </button>
            )}
            <button
              type="submit"
              disabled={converting || checkingAdmissionEligibility || checkingClassEligibility || blockedOutright || selectedClassInvalid}
              className="inline-flex items-center gap-2 rounded-2xl bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {converting ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserCheck className="h-4 w-4" />}
              Admit student
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
