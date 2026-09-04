/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type {CourseOption} from '../../utils/academicOptions';
import React, { useEffect, useState } from 'react';
import {X, Award, Copy, UserCog, PhoneCall, CheckCircle2, Plus, User, UserCheck, ChevronRight, CreditCard, GraduationCap, Ban, ArrowRight, Phone, MessageCircle} from 'lucide-react';
import {Visitor, VisitorWorkflowState} from '../../types';
import { BRAND_NAME } from '../../config/branding';
import { SOURCE_LABELS } from '../../config/visitorSources';
import { formatAFN } from '../../utils/format';

interface VisitorDeskPanelProps {
  visitor: Visitor;
  onClose: () => void;
  updateVisitorCRM: (
    visitorId: string,
    interestedCourse: string,
    followUpStatus: 'high_interest' | 'medium_interest' | 'low_interest' | 'not_answering' | 'no_interest',
    nextContactDate: string,
    notes?: string
  ) => Promise<void>;
  addVisitorFollowUp: (visitorId: string, notes: string, outcome?: string, nextContactDate?: string) => Promise<void>;
  updateVisitor: (visitorId: string, updatedFields: Partial<Visitor>) => Promise<void>;
  onOpenPlacementTest: () => void;
  onOpenConvert: () => void;
  onOpenStudentWorkspace?: (studentId: string) => void;
  /** Server-derived reception state — the workspace renders it, never derives it. */
  workflow?: VisitorWorkflowState | null;
  courseOptions?: CourseOption[];
  triggerToast: (message: string, type: 'success' | 'error' | 'info') => void;
  /** True when the workflow read failed — the desk still works, minus the live state card. */
  workflowUnavailable?: boolean;
  /** The backend requires these permissions; the UI mirrors them so no button is a guaranteed 403. */
  canConvertLead?: boolean;
  canEditLead?: boolean;
}

const STAGE_LADDER: Array<{ key: VisitorWorkflowState['stage']; label: string }> = [
  { key: 'lead', label: 'Lead' },
  { key: 'follow_up', label: 'Follow-up' },
  { key: 'admission', label: 'Admission' },
  { key: 'placement', label: 'Placement' },
  { key: 'financial_clearance', label: 'Fees' },
  { key: 'enrollment', label: 'Enroll' },
  { key: 'enrolled', label: 'Enrolled' },
];

const STAGE_TONE: Record<VisitorWorkflowState['stage'], string> = {
  lead: 'bg-slate-100 text-slate-700 border-slate-200',
  follow_up: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  admission: 'bg-sky-50 text-sky-700 border-sky-200',
  placement: 'bg-violet-50 text-violet-700 border-violet-200',
  financial_clearance: 'bg-amber-50 text-amber-800 border-amber-200',
  enrollment: 'bg-teal-50 text-teal-700 border-teal-200',
  enrolled: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

export default function VisitorDeskPanel({
  visitor, courseOptions = [], onClose, updateVisitorCRM, addVisitorFollowUp, updateVisitor, onOpenPlacementTest, onOpenConvert, onOpenStudentWorkspace,
  workflow, workflowUnavailable = false, triggerToast,
  canConvertLead = true, canEditLead = true,
}: VisitorDeskPanelProps) {
  const [deskTab, setDeskTab] = useState<'details' | 'logs'>('details');
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [followUpInput, setFollowUpInput] = useState<string>('');
  const [followUpOutcome, setFollowUpOutcome] = useState<string>('');
  const [followUpDate, setFollowUpDate] = useState<string>('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [crmCourse, setCrmCourse] = useState(visitor.interestedCourse || '');
  const [crmStatus, setCrmStatus] = useState(visitor.followUpStatus || 'medium_interest');
  const [crmDate, setCrmDate] = useState(visitor.nextContactDate || '');
  const [crmNotes, setCrmNotes] = useState(visitor.notes || '');
  const profileFromVisitor = (value: Visitor) => ({
    fatherName: value.fatherName || '',
    tazkiraNo: value.tazkiraNo || '',
    dob: value.dob || '',
    whatsapp: value.whatsapp || '',
    email: value.email || '',
    schoolOrUniversity: value.schoolOrUniversity || '',
    addressRegion: value.addressRegion || '',
    emergencyContactName: value.emergencyContactName || '',
    emergencyContactPhone: value.emergencyContactPhone || '',
  });
  const [profileDraft, setProfileDraft] = useState(() => profileFromVisitor(visitor));
  const setProfileField = (field: keyof typeof profileDraft, value: string) =>
    setProfileDraft((current) => ({ ...current, [field]: value }));

  // The server's local calendar date is the authority; the date pickers honour
  // it as a courtesy and the API rejects anything older regardless.
  const todayIso = new Date().toLocaleDateString('en-CA');
  const dialDigits = visitor.phone.replace(/\D/g, '');
  const whatsappTarget = dialDigits.startsWith('0') ? `93${dialDigits.slice(1)}` : dialDigits;
  const copyPhone = () => {
    navigator.clipboard.writeText(visitor.phone);
    triggerToast('Phone number copied.', 'success');
  };
  const followUpOverdue = Boolean(visitor.nextContactDate) && visitor.nextContactDate! < todayIso && workflow?.admission.admitted !== true;


  const [prevVisitorId, setPrevVisitorId] = useState(visitor.id);
  if (prevVisitorId !== visitor.id) {
    setPrevVisitorId(visitor.id);
    setDeskTab('details');
    setCrmCourse(visitor.interestedCourse || '');
    setCrmStatus(visitor.followUpStatus || 'medium_interest');
    setCrmDate(visitor.nextContactDate || '');
    setCrmNotes(visitor.notes || '');
    setProfileDraft(profileFromVisitor(visitor));
    setFollowUpInput('');
    setFollowUpOutcome('');
    setFollowUpDate('');
  }

  const assertFutureDate = (value: string): boolean => {
    if (value && value < todayIso) {
      triggerToast('Next contact date must be today or a future date.', 'error');
      return false;
    }
    return true;
  };

  const handleSaveCRM = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assertFutureDate(crmDate)) return;
    try {
      await updateVisitorCRM(visitor.id, crmCourse || courseOptions[0]?.value || '', crmStatus as any, crmDate, crmNotes);
      triggerToast('Visitor CRM info updated successfully.', 'success');
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Could not save CRM info. Please try again.', 'error');
    }
  };

  const handleSaveProfile = async () => {
    try {
      await updateVisitor(visitor.id, profileDraft);
      triggerToast('Visitor profile updated successfully.', 'success');
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Could not save visitor profile.', 'error');
    }
  };

  const handleAddFollowUpNoteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!followUpInput.trim()) return;
    if (followUpOutcome === 'callback' && !followUpDate) {
      triggerToast('Choose a next contact date for a callback.', 'error');
      return;
    }
    if (!assertFutureDate(followUpDate)) return;
    try {
      await addVisitorFollowUp(visitor.id, followUpInput, followUpOutcome || undefined, followUpDate || undefined);
      setFollowUpInput('');
      setFollowUpOutcome('');
      setFollowUpDate('');
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Could not add follow-up note.', 'error');
    }
  };

  const sourceLabel = SOURCE_LABELS[visitor.source] || visitor.source;

  const templates = [
    { title: 'Welcome message 👋 (Dari)', text: `محترم ${visitor.gender === 'male' ? 'آقای' : 'خانم'} ${visitor.fullName}، سلام!\nاز مراجعه شما به ${BRAND_NAME} تشکر می‌کنیم. مشوره امروز شما ثبت گردید.\nدوره مورد علاقه: ${visitor.interestedCourse || 'the selected program'}\nمنتظر حضور شما در صنف استیم.\n— ${BRAND_NAME}` },
    { title: 'New class reminder 🔔', text: `Dear ${visitor.gender === 'male' ? 'Mr' : 'Ms'} ${visitor.fullName},\nFollowing our conversation, seats are limited for ${visitor.interestedCourse || 'the selected program'}. Please visit reception to finalize enrollment.\n— ${BRAND_NAME}` },
  ];

  if (visitor.fatherName || visitor.emergencyContactName) {
    templates.push({ title: 'Parent notice 👪 (Dari)', text: `محترم ${visitor.fatherName || visitor.emergencyContactName} صاحب، سلام!\nبه اطلاع شما رسانیده می‌شود که ${visitor.fullName} امروز به مرکز ${BRAND_NAME} مراجعه نموده و برای دوره ثبت اولیه صورت گرفت.\nبا احترام\n— ${BRAND_NAME}` });
  }

  const copyText = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const placementTotal = visitor.placementScore?.total
    ?? visitor.placementScore?.totalScore
    ?? visitor.placementScore?.percentage
    ?? null;
  const placementRecommendation = visitor.placementScore?.levelRecommendation
    ?? visitor.placementScore?.recommendation?.text
    ?? visitor.placementScore?.recommendation?.levelId
    ?? workflow?.placement.recommendedLevelName
    ?? 'Not assigned';
  const placementOverallCefr = visitor.placementScore?.overallCefr ?? null;
  const placementOutcome = visitor.placementScore?.outcome ?? null;

  // ── The one primary action ────────────────────────────────────────────────
  // Derived from the server's nextAction, gated by the same permissions the
  // API enforces, and labelled with the business operation — never "Next".
  const stage = workflow?.stage;
  const nextAction = workflow?.nextAction;
  const capabilities = workflow?.capabilities ?? { canFollowUp: canEditLead, canAdmit: canConvertLead, canAssess: canEditLead, canEnroll: false, canSettleInvoices: false };
  const primary = (() => {
    switch (nextAction) {
      case 'log_follow_up':
        return canEditLead
          ? { label: workflow?.closed ? 'Reopen lead before working it' : 'Record follow-up', icon: <PhoneCall className="w-4 h-4" />, run: () => setDeskTab('logs'), disabled: workflow?.closed }
          : null;
      case 'admit':
        return canConvertLead
          ? { label: 'Admit student', icon: <UserCheck className="w-4 h-4" />, run: onOpenConvert, disabled: false }
          : null;
      case 'start_placement':
        return capabilities.canAssess
          ? { label: placementTotal != null || visitor.placementStatus === 'completed' ? 'Re-run placement' : 'Start placement', icon: <Award className="w-4 h-4" />, run: onOpenPlacementTest, disabled: false }
          : null;
      case 'settle_admission_fees':
        // Invoice settlement is the finance desk's authority. The workspace
        // states what is owed and who acts — it never offers a 403 button.
        return null;
      case 'enroll':
      case 'view_enrollment': {
        const studentId = workflow?.admission.studentId;
        if (!studentId || !onOpenStudentWorkspace) return null;
        return nextAction === 'enroll' && capabilities.canEnroll
          ? { label: 'Enroll in class', icon: <GraduationCap className="w-4 h-4" />, run: () => onOpenStudentWorkspace(studentId), disabled: false }
          : { label: 'Open student profile', icon: <GraduationCap className="w-4 h-4" />, run: () => onOpenStudentWorkspace(studentId), disabled: false };
      }
      default:
        return null;
    }
  })();

  const afterEffect: Record<string, string> = {
    log_follow_up: 'The follow-up history updates and the next action moves forward with the lead.',
    admit: 'A student record and the admission invoices are created; placement starts immediately after.',
    start_placement: 'The placement result will determine the recommended level for enrollment.',
    settle_admission_fees: 'Enrollment unlocks once the admission invoices are settled.',
    enroll: 'The student takes a seat in the selected class and tuition is billed on its own invoice.',
    view_enrollment: 'The student profile shows the class, balance and academic history.',
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={`${visitor.fullName} — reception workspace`} className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto animate-in fade-in duration-200" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white border border-slate-200 rounded-3xl shadow-2xl w-full max-w-2xl my-auto animate-in zoom-in-95 duration-200 max-h-[92vh] flex flex-col">

        {/* Header — who this person is */}
        <div className="flex justify-between items-start border-b border-slate-100 px-6 py-4 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-700 font-black text-base flex items-center justify-center border border-indigo-100">{visitor.fullName.substring(0, 1)}</div>
            <div>
              <h3 className="font-extrabold text-slate-900 text-sm flex items-center gap-2 flex-wrap">
                {visitor.fullName}
                {visitor.serialNo && <span className="text-[10px] text-slate-400 font-mono font-semibold">#{visitor.serialNo}</span>}
                {stage && <span className={`text-[9px] px-2 py-0.5 rounded-full font-black border uppercase tracking-wide ${STAGE_TONE[stage]}`}>{STAGE_LADDER.find((s) => s.key === stage)?.label}</span>}
                {workflow?.admission.admitted && workflow.admission.studentCode && <span className="text-[9px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-black">Student {workflow.admission.studentCode}</span>}
              </h3>
              <div className="flex items-center gap-1.5 mt-0.5">
                <p className="text-[11px] text-slate-500 font-mono font-bold">{visitor.phone}{visitor.whatsapp && visitor.whatsapp !== visitor.phone && <span className="text-slate-400"> · WA: {visitor.whatsapp}</span>}</p>
                <button onClick={copyPhone} title="Copy phone number" className="p-1 bg-slate-50 hover:bg-slate-100 text-slate-400 hover:text-indigo-600 rounded-lg cursor-pointer"><Copy className="w-3 h-3" /></button>
                <a href={`tel:${visitor.phone}`} title="Call now" className="p-1 bg-slate-50 hover:bg-slate-100 text-slate-400 hover:text-emerald-600 rounded-lg"><Phone className="w-3 h-3" /></a>
                {whatsappTarget && <a href={`https://wa.me/${whatsappTarget}`} target="_blank" rel="noreferrer" title="Message on WhatsApp" className="p-1 bg-slate-50 hover:bg-slate-100 text-slate-400 hover:text-green-600 rounded-lg"><MessageCircle className="w-3 h-3" /></a>}
                {followUpOverdue && <span className="ms-1 px-1.5 py-0.5 rounded-md bg-rose-50 border border-rose-200 text-rose-700 text-[9px] font-black uppercase tracking-wide" title={`Next contact was due ${visitor.nextContactDate}`}>Follow-up overdue</span>}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 bg-slate-50 hover:bg-slate-100 text-slate-400 hover:text-slate-600 rounded-xl cursor-pointer"><X className="w-4 h-4" /></button>
        </div>

        {/* Stage ladder + next action — where they are, what to do, what blocks it */}
        <div className="bg-gradient-to-r from-indigo-50/60 to-purple-50/40 border-b border-slate-100 px-6 py-3.5 shrink-0 space-y-3">
          <div className="flex items-center gap-1">
            {STAGE_LADDER.map((step, i) => {
              const current = stage === step.key;
              const done = stage != null && STAGE_LADDER.findIndex((s) => s.key === stage) > i;
              return (
                <React.Fragment key={step.key}>
                  <div className="flex flex-col items-center gap-1 flex-1 min-w-0">
                    <div className={`w-2.5 h-2.5 rounded-full border-2 transition-all ${done ? 'bg-emerald-500 border-emerald-500' : current ? 'bg-indigo-600 border-indigo-600 ring-4 ring-indigo-100' : 'bg-white border-slate-200'}`} />
                    <span className={`text-[9px] font-extrabold text-center leading-tight ${current ? 'text-indigo-700' : done ? 'text-emerald-700' : 'text-slate-400'}`}>{step.label}</span>
                  </div>
                  {i < STAGE_LADDER.length - 1 && <div className={`h-0.5 w-4 rounded-full ${done ? 'bg-emerald-400' : 'bg-slate-200'}`} />}
                </React.Fragment>
              );
            })}
          </div>

          {!workflow && workflowUnavailable && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50/80 px-3.5 py-2.5 text-[10px] font-semibold text-amber-900">
              Live reception state is unavailable right now. The profile, follow-up history and contact tools below still work — reopen this workspace to retry.
            </div>
          )}
          {!workflow && !workflowUnavailable && (
            <div className="rounded-2xl border border-indigo-100 bg-white/90 px-3.5 py-3 space-y-2 animate-pulse" aria-label="Loading reception state">
              <div className="h-2 w-20 rounded bg-indigo-100" />
              <div className="h-3 w-40 rounded bg-slate-100" />
              <div className="h-2 w-64 rounded bg-slate-100" />
            </div>
          )}
          {workflow && (
            <div className="rounded-2xl border border-indigo-100 bg-white/90 px-3.5 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[9px] font-black uppercase tracking-[0.14em] text-indigo-500">Next action</p>
                  <p className="text-xs font-extrabold text-slate-900 mt-0.5 flex items-center gap-1.5">
                    {primary ? primary.label : nextAction === 'settle_admission_fees' ? 'Settle admission fees' : 'No action available'}
                    {workflow.closed && <Ban className="w-3.5 h-3.5 text-rose-500" />}
                  </p>
                  <p className="text-[10px] text-slate-600 font-semibold mt-0.5 leading-snug">{workflow.nextActionReason}</p>
                  {nextAction && <p className="text-[10px] text-slate-400 font-medium mt-1 flex items-center gap-1"><ArrowRight className="w-3 h-3 shrink-0" /> {afterEffect[nextAction]}</p>}
                </div>
                {primary && (
                  <button
                    onClick={primary.run}
                    disabled={primary.disabled}
                    className="shrink-0 inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-extrabold text-xs px-4 py-2.5 shadow-md transition-colors cursor-pointer"
                  >
                    {primary.icon} {primary.label}
                  </button>
                )}
              </div>

              {nextAction === 'settle_admission_fees' && (
                <div className="mt-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 flex items-start gap-2">
                  <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <div className="text-[10px] font-semibold text-amber-900 leading-snug">
                    <p className="font-black">
                      {workflow.financial.totalOutstanding > 0
                        ? `${formatAFN(workflow.financial.totalOutstanding)} AFN in admission fees must be settled before enrollment`
                        : 'Admission fees must be settled before enrollment'}
                      {workflow.financial.registrationOutstanding > 0 && ` · registration ${formatAFN(workflow.financial.registrationOutstanding)}`}
                      {workflow.financial.placementOutstanding > 0 && ` · placement ${formatAFN(workflow.financial.placementOutstanding)}`}.
                    </p>
                    <p className="mt-0.5">
                      {capabilities.canSettleInvoices
                        ? 'Open the Finance desk, find this student\u2019s invoices and record the payment.'
                        : 'Payment requires Finance access — the finance desk settles these invoices.'}
                    </p>
                  </div>
                </div>
              )}

              {workflow.blockers.filter((b) => b.code !== 'admission_fees_outstanding').length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {workflow.blockers.filter((b) => b.code !== 'admission_fees_outstanding').map((blocker) => (
                    <p key={blocker.code} className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[10px] font-semibold text-amber-900">
                      <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />
                      <span>{blocker.reason}{blocker.ownerRole ? <span className="text-amber-700 font-black"> ({blocker.ownerRole.replace('_', ' ')})</span> : null}</span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Secondary actions — never competing with the primary button */}
        <div className="px-6 py-2.5 border-b border-slate-100 flex gap-2 shrink-0">
          {canEditLead && !workflow?.closed && (
            <button onClick={() => setDeskTab('logs')} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl font-bold text-xs cursor-pointer transition-colors shadow-sm bg-slate-100 hover:bg-slate-200 text-slate-700"><PhoneCall className="w-3.5 h-3.5" /> Call History</button>
          )}
          {capabilities.canAssess && (
            <button onClick={onOpenPlacementTest} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl font-bold text-xs cursor-pointer transition-colors shadow-sm bg-slate-100 hover:bg-slate-200 text-slate-700"><Award className="w-3.5 h-3.5" /> {visitor.placementStatus === 'completed' ? 'Re-assess' : 'Assessment Workspace'}</button>
          )}
          {canConvertLead && !workflow?.admission.admitted && !workflow?.closed && (
            <button onClick={onOpenConvert} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl font-bold text-xs cursor-pointer transition-colors shadow-sm bg-slate-100 hover:bg-slate-200 text-slate-700"><UserCheck className="w-3.5 h-3.5" /> Admit student</button>
          )}
        </div>

        {/* Inner Tabs */}
        <div className="flex border-b border-slate-150 text-[11px] font-extrabold px-6 shrink-0">
          <button onClick={() => setDeskTab('details')} className={`pb-2.5 pe-4 transition-all cursor-pointer ${deskTab === 'details' ? 'border-b-2 border-indigo-600 text-indigo-600' : 'text-slate-500'}`}>Profile & Follow-up</button>
          <button onClick={() => setDeskTab('logs')} className={`pb-2.5 px-4 transition-all cursor-pointer flex items-center gap-1 ${deskTab === 'logs' ? 'border-b-2 border-indigo-600 text-indigo-600' : 'text-slate-500'}`}><PhoneCall className="w-3.5 h-3.5" /> Call History ({visitor.followUpHistory?.length || 0})</button>
        </div>

        {/* Tab Content */}
        <div className="overflow-y-auto px-6 py-4 flex-1">
          {deskTab === 'details' ? (
            <div className="space-y-4 text-xs">
              {visitor.placementScore && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-3.5 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-emerald-100 flex items-center justify-center shrink-0"><Award className="w-4 h-4 text-emerald-700" /></div>
                  <div className="flex-1">
                    <p className="font-extrabold text-emerald-900 text-[11px]">Placement completed{placementTotal != null ? ` — ${placementTotal}/100` : ''}</p>
                    <p className="text-[10px] text-emerald-700 mt-0.5">Recommended: <span className="font-black">{placementRecommendation}</span>{placementOverallCefr ? <> · CEFR <span className="font-black">{placementOverallCefr}</span></> : null}{placementOutcome ? <> · <span className="font-black uppercase">{placementOutcome}</span></> : null}{visitor.placementScore.examiner ? <> · by {visitor.placementScore.examiner}</> : null}</p>
                  </div>
                  {capabilities.canAssess && (
                    <button onClick={onOpenPlacementTest} className="px-2.5 py-1.5 bg-white border border-emerald-200 text-emerald-700 rounded-lg text-[10px] font-bold hover:bg-emerald-50 cursor-pointer">Re-test</button>
                  )}
                </div>
              )}

              <form onSubmit={handleSaveCRM}>
                <fieldset disabled={!canEditLead} className="bg-slate-50/60 border border-slate-150 rounded-2xl p-4 space-y-3 text-xs disabled:opacity-75">
                <h5 className="font-extrabold text-slate-800 text-[11px] flex items-center gap-1.5 border-b border-slate-200 pb-2"><UserCog className="w-4 h-4 text-indigo-600" /> Conversion & interest settings</h5>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <div>
                    <label className="block text-slate-500 font-bold mb-1">Target course:</label>
                    <select value={crmCourse} onChange={(e) => setCrmCourse(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-2 cursor-pointer focus:outline-none font-bold text-slate-800">
                      {courseOptions.length > 0 ? courseOptions.map(opt => <option key={opt.value + opt.source} value={opt.value}>{opt.label}</option>) : <option value={crmCourse || ''}>{crmCourse || 'No catalog programs'}</option>}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-500 font-bold mb-1">Class interest level:</label>
                    <select value={crmStatus} onChange={(e) => setCrmStatus(e.target.value as any)} className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-2 cursor-pointer focus:outline-none font-bold text-slate-800">
                      <option value="high_interest">High interest 🔥</option><option value="medium_interest">Medium interest ⚡</option><option value="low_interest">Low interest ❄️</option><option value="not_answering">No response 📞</option><option value="no_interest">Dropped ❌</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-500 font-bold mb-1">Next follow-up date:</label>
                    <input type="date" min={todayIso} value={crmDate} onChange={(e) => setCrmDate(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-2 focus:outline-none font-bold text-indigo-600 font-mono text-center" />
                  </div>
                  <div>
                    <label className="block text-slate-500 font-bold mb-1">Initial source:</label>
                    <div className="bg-slate-100 border border-slate-150 rounded-xl px-2.5 py-2 font-bold text-slate-700 text-center">{sourceLabel}</div>
                  </div>
                </div>

                <div className="border-t border-dashed border-slate-200 pt-3 mt-1">
                  <span className="block text-[10px] font-extrabold text-indigo-700 mb-2">Additional identity details:</span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">Father's name:</label><input type="text" value={profileDraft.fatherName} onChange={(e) => setProfileField('fatherName', e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px]" placeholder="e.g. Abdul Khaliq" /></div>
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">Tazkira no.:</label><input type="text" value={profileDraft.tazkiraNo} onChange={(e) => setProfileField('tazkiraNo', e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 font-mono text-[11px]" placeholder="Tazkira no." /></div>
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">Date of birth:</label><input type="date" value={profileDraft.dob} onChange={(e) => setProfileField('dob', e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px]" /></div>
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">WhatsApp:</label><input type="tel" value={profileDraft.whatsapp} onChange={(e) => setProfileField('whatsapp', e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-start" placeholder="07xxxxxxx" /></div>
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">Email:</label><input type="email" value={profileDraft.email} onChange={(e) => setProfileField('email', e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-start" placeholder="name@example.com" /></div>
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">School / university:</label><input type="text" value={profileDraft.schoolOrUniversity} onChange={(e) => setProfileField('schoolOrUniversity', e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px]" placeholder="School or university" /></div>
                    <div className="sm:col-span-2"><label className="block text-slate-500 font-bold text-[10px] mb-0.5">Home address:</label><input type="text" value={profileDraft.addressRegion} onChange={(e) => setProfileField('addressRegion', e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px]" placeholder="Full address" /></div>
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">Emergency contact name:</label><input type="text" value={profileDraft.emergencyContactName} onChange={(e) => setProfileField('emergencyContactName', e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px]" placeholder="Father or brother name" /></div>
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">Emergency phone:</label><input type="tel" value={profileDraft.emergencyContactPhone} onChange={(e) => setProfileField('emergencyContactPhone', e.target.value)} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-start" placeholder="07xxxxxxx" /></div>
                  </div>
                  {canEditLead && <div className="flex justify-end mt-2">
                    <button type="button" onClick={() => void handleSaveProfile()} className="bg-white border border-indigo-200 text-indigo-700 hover:bg-indigo-50 px-3 py-1.5 rounded-lg text-[10px] font-bold cursor-pointer">Save identity details</button>
                  </div>}
                </div>

                <div><label className="block text-slate-500 font-bold mb-1">Reception notes:</label><textarea value={crmNotes} onChange={(e) => setCrmNotes(e.target.value)} rows={2} className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-2 focus:outline-none font-semibold text-slate-800" /></div>
                {canEditLead && <div className="flex justify-end"><button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl font-bold cursor-pointer">Save CRM Changes</button></div>}
                </fieldset>
              </form>

              <div className="space-y-3.5 border-t border-slate-100 pt-4">
                <h5 className="font-extrabold text-slate-900 text-xs flex items-center gap-1.5"><PhoneCall className="w-4 h-4 text-indigo-600" /> SMS & WhatsApp templates</h5>
                <div className="space-y-3">
                  {templates.map((tmpl, idx) => (
                    <div key={idx} className="border border-slate-200 rounded-2xl p-3 bg-indigo-50/10 space-y-2">
                      <div className="flex justify-between items-center border-b border-indigo-100/50 pb-1.5">
                        <span className="font-black text-indigo-950 text-[10px]">{tmpl.title}</span>
                        <button onClick={() => copyText(tmpl.text, idx)} className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[9px] font-black cursor-pointer shadow-xs transition-all ${copiedIndex === idx ? 'bg-emerald-600 text-white' : 'bg-white text-indigo-700 hover:bg-indigo-50 border border-indigo-200'}`}>
                          {copiedIndex === idx ? <><CheckCircle2 className="w-3 h-3 stroke-[2.5]" /> Copied!</> : <><Copy className="w-3 h-3" /> Copy text</>}
                        </button>
                      </div>
                      <p dir="auto" className="text-[10px] text-slate-600 leading-relaxed font-semibold whitespace-pre-line bg-white p-2.5 rounded-xl border border-slate-100">{tmpl.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4 text-xs">
              {canEditLead && <form onSubmit={handleAddFollowUpNoteSubmit} className="space-y-3.5 bg-slate-50/60 p-4 rounded-2xl border border-slate-150">
                <h5 className="font-extrabold text-slate-800 text-[11px] flex items-center gap-1.5 border-b border-slate-200 pb-1.5"><PhoneCall className="w-4 h-4 text-indigo-600" /> Log follow-up</h5>
                <div className="flex gap-2">
                  <input type="text" placeholder="New call or follow-up note…" value={followUpInput} onChange={(e) => setFollowUpInput(e.target.value)} className="flex-1 bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 focus:outline-none text-xs font-semibold text-slate-800 shadow-inner" required />
                  <select value={followUpOutcome} onChange={(e) => { setFollowUpOutcome(e.target.value); if (e.target.value !== 'callback') setFollowUpDate(''); }} className="bg-white border border-slate-200 rounded-xl px-2 py-2 text-[10px] font-bold cursor-pointer text-slate-600 focus:outline-none">
                    <option value="">Outcome…</option><option value="interested">Interested</option><option value="not_interested">Not interested</option><option value="callback">Callback</option><option value="registered">Registered</option>
                  </select>
                  <button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold px-4 rounded-xl cursor-pointer flex items-center justify-center shadow-md"><Plus className="w-4 h-4 stroke-[2.5]" /></button>
                </div>
                {followUpOutcome === 'callback' && (
                  <div>
                    <label className="block text-slate-500 font-bold text-[10px] mb-1">Next contact date:</label>
                    <input type="date" min={todayIso} value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold text-indigo-700" required />
                  </div>
                )}
              </form>}

              <div className="space-y-3">
                <h5 className="font-black text-slate-400 text-[10px] uppercase tracking-wider">Follow-up history:</h5>
                <div className="space-y-2 max-h-60 overflow-y-auto pe-0.5">
                  {(!visitor.followUpHistory || visitor.followUpHistory.length === 0) ? (
                    <p className="text-[11px] text-slate-400 italic text-center py-8 bg-slate-50/50 rounded-xl">No follow-ups yet.</p>
                  ) : (
                    visitor.followUpHistory.map((item) => (
                      <div key={item.id} className="bg-slate-50/60 border border-slate-150 p-3 rounded-xl space-y-1 relative">
                        <div className="flex justify-between items-center text-[9px] font-bold text-slate-400 border-b border-slate-200/40 pb-1">
                          <span className="flex items-center gap-0.5"><User className="w-3 h-3 text-indigo-400" /> By: {item.operator}</span>
                          <span className="font-mono">{item.date}</span>
                        </div>
                        <p className="text-[11px] text-slate-700 font-semibold pt-1 leading-relaxed">{item.notes}</p>
                        {item.outcome && <span className={`inline-block mt-1 px-2 py-0.5 rounded text-[9px] font-bold ${item.outcome === 'interested' ? 'bg-emerald-50 text-emerald-700' : item.outcome === 'not_interested' ? 'bg-rose-50 text-rose-700' : item.outcome === 'callback' ? 'bg-amber-50 text-amber-700' : item.outcome === 'registered' ? 'bg-indigo-50 text-indigo-700' : 'bg-slate-100 text-slate-600'}`}>{item.outcome}</span>}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
