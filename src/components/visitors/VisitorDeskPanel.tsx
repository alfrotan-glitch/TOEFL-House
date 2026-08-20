/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type {CourseOption} from '../../utils/academicOptions';
import React, { useState, useEffect } from 'react';
import {X, Award, Check, Copy, UserCog, PhoneCall, CheckCircle2, Plus, User, UserCheck, UserPlus, ChevronRight} from 'lucide-react';
import {Visitor, ConversionEligibility} from '../../types';
import { BRAND_NAME } from '../../config/branding';

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
  addVisitorFollowUp: (visitorId: string, notes: string, outcome?: string) => Promise<void>;
  updateVisitor: (visitorId: string, updatedFields: Partial<Visitor>) => Promise<void>;
  onOpenPlacementTest: () => void;
  onOpenConvert: () => void;
  courseOptions?: CourseOption[];
  triggerToast: (message: string, type: 'success' | 'error' | 'info') => void;
  /** UX-4 — the backend requires Lead.Convert / Lead.Edit for these actions. */
  canConvertLead?: boolean;
  canEditLead?: boolean;
  /** UX-3 — read-only pre-flight so Enroll is never a dead end. */
  checkConversionEligibility?: (visitorId: string, classId?: string) => Promise<ConversionEligibility>;
}

interface PipelineStep {
  key: string;
  label: string;
  icon: React.ReactNode;
  isDone: (v: Visitor) => boolean;
  isCurrent: (v: Visitor) => boolean;
  hint: string;
}

const PIPELINE_STEPS: PipelineStep[] = [
  { key: 'register', label: 'Registered', icon: <UserPlus className="w-3.5 h-3.5" />, isDone: () => true, isCurrent: () => false, hint: 'Visitor registered.' },
  { key: 'followup', label: 'Follow-up', icon: <PhoneCall className="w-3.5 h-3.5" />, isDone: (v) => (v.followUpHistory?.length ?? 0) > 0, isCurrent: (v) => (v.followUpHistory?.length ?? 0) === 0 && !v.placementScore, hint: 'Log contact attempts and gauge interest.' },
  { key: 'placement', label: 'Placement', icon: <Award className="w-3.5 h-3.5" />, isDone: (v) => !!v.placementScore, isCurrent: (v) => !v.placementScore && (v.followUpHistory?.length ?? 0) > 0, hint: 'Assess grammar, listening, speaking.' },
  { key: 'enroll', label: 'Enroll', icon: <UserCheck className="w-3.5 h-3.5" />, isDone: (v) => v.status === 'registered', isCurrent: (v) => !!v.placementScore && v.status !== 'registered', hint: 'Convert to student: assign class, take payment.' },
];

export default function VisitorDeskPanel({
  visitor, courseOptions = [], onClose, updateVisitorCRM, addVisitorFollowUp, updateVisitor, onOpenPlacementTest, onOpenConvert, triggerToast,
  canConvertLead = true, canEditLead = true, checkConversionEligibility,
}: VisitorDeskPanelProps) {
  /**
   * Lead-level conversion eligibility (UX-3), checked with no class selected:
   * it answers "is this lead convertible at all?" so the Enroll button can
   * explain itself instead of opening a form that ends in a refusal.
   */
  const [eligibility, setEligibility] = useState<ConversionEligibility | null>(null);
  useEffect(() => {
    // Fetched for EVERY viewer. Gating this on `canConvertLead` meant a
    // counselor — who is authorized to run the placement assessment that
    // unblocks the lead — never learned the lead was blocked.
    if (!checkConversionEligibility) return;
    let cancelled = false;
    checkConversionEligibility(visitor.id)
      .then((res) => { if (!cancelled) setEligibility(res); })
      .catch(() => { /* Non-fatal: the modal re-checks and fails closed. */ });
    return () => { cancelled = true; };
  }, [visitor.id, visitor.placementStatus, visitor.status, checkConversionEligibility]);
  const [deskTab, setDeskTab] = useState<'details' | 'logs'>('details');
  const [followUpInput, setFollowUpInput] = useState<string>('');
  const [followUpOutcome, setFollowUpOutcome] = useState<string>('');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [crmCourse, setCrmCourse] = useState(visitor.interestedCourse || '');
  const [crmStatus, setCrmStatus] = useState(visitor.followUpStatus || 'medium_interest');
  const [crmDate, setCrmDate] = useState(visitor.nextContactDate || '');
  const [crmNotes, setCrmNotes] = useState(visitor.notes || '');

  // Sync the editable CRM fields whenever a different visitor is shown, by
  // adjusting state during render (no setState-in-effect).
  const [prevVisitorId, setPrevVisitorId] = useState<string>(visitor.id);
  if (prevVisitorId !== visitor.id) {
    setPrevVisitorId(visitor.id);
    setDeskTab('details');
    setCrmCourse(visitor.interestedCourse || '');
    setCrmStatus(visitor.followUpStatus || 'medium_interest');
    setCrmDate(visitor.nextContactDate || '');
    setCrmNotes(visitor.notes || '');
  }

  const handleSaveCRM = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await updateVisitorCRM(visitor.id, crmCourse || courseOptions[0]?.value || '', crmStatus as any, crmDate, crmNotes);
      triggerToast('Visitor CRM info updated successfully.', 'success');
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Could not save CRM info. Please try again.', 'error');
    }
  };

  const handleAddFollowUpNoteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!followUpInput.trim()) return;
    try {
      await addVisitorFollowUp(visitor.id, followUpInput, followUpOutcome || undefined);
      setFollowUpInput('');
      setFollowUpOutcome('');
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Could not add follow-up note.', 'error');
    }
  };

  const getSourceLabel = (src: string) => {
    switch (src) { case 'ads': return 'Facebook ads'; case 'friend': return 'Referral'; case 'social': return 'Social media'; default: return 'Other'; }
  };

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

  const currentStep = PIPELINE_STEPS.find((s) => s.isCurrent(visitor));

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto animate-in fade-in duration-200" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white border border-slate-200 rounded-3xl shadow-2xl w-full max-w-2xl my-auto animate-in zoom-in-95 duration-200 max-h-[92vh] flex flex-col">
        
        {/* Header */}
        <div className="flex justify-between items-start border-b border-slate-100 px-6 py-4 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-700 font-black text-base flex items-center justify-center border border-indigo-100">{visitor.fullName.substring(0, 1)}</div>
            <div>
              <h3 className="font-extrabold text-slate-900 text-sm flex items-center gap-2">
                {visitor.fullName}
                {visitor.serialNo && <span className="text-[10px] text-slate-400 font-mono font-semibold">#{visitor.serialNo}</span>}
                {visitor.status === 'registered' && <span className="bg-emerald-100 text-emerald-800 text-[9px] px-2 py-0.5 rounded-full font-black">Enrolled</span>}
              </h3>
              <p className="text-[11px] text-slate-500 font-mono font-bold mt-0.5">{visitor.phone}{visitor.whatsapp && visitor.whatsapp !== visitor.phone && <span className="text-slate-400"> · WA: {visitor.whatsapp}</span>}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 bg-slate-50 hover:bg-slate-100 text-slate-400 hover:text-slate-600 rounded-xl cursor-pointer"><X className="w-4 h-4" /></button>
        </div>

        {/* Stepper */}
        <div className="bg-gradient-to-r from-indigo-50/60 to-purple-50/40 border-b border-slate-100 px-6 py-3.5 shrink-0">
          <div className="flex items-center justify-between gap-1">
            {PIPELINE_STEPS.map((step, i) => {
              const done = step.isDone(visitor);
              const isCurrent = step.key === currentStep?.key;
              return (
                <React.Fragment key={step.key}>
                  <div className="flex flex-col items-center gap-1 flex-1 min-w-0">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all ${done ? 'bg-emerald-500 border-emerald-500 text-white' : isCurrent ? 'bg-indigo-600 border-indigo-600 text-white ring-4 ring-indigo-100 animate-pulse' : 'bg-white border-slate-200 text-slate-300'}`}>
                      {done ? <Check className="w-3.5 h-3.5 stroke-[3]" /> : step.icon}
                    </div>
                    <span className={`text-[9px] font-extrabold text-center leading-tight ${isCurrent ? 'text-indigo-700' : done ? 'text-emerald-700' : 'text-slate-400'}`}>{step.label}</span>
                  </div>
                  {i < PIPELINE_STEPS.length - 1 && <div className={`h-0.5 flex-1 mx-1 rounded-full ${PIPELINE_STEPS[i].isDone(visitor) ? 'bg-emerald-400' : 'bg-slate-200'}`} style={{ maxWidth: '24px' }} />}
                </React.Fragment>
              );
            })}
          </div>
          {currentStep && visitor.status !== 'registered' && (
            <div className="mt-2.5 flex items-center gap-2 bg-white/80 border border-indigo-100 rounded-xl px-3 py-2">
              <ChevronRight className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
              <p className="text-[10px] font-bold text-slate-700">Next: <span className="text-indigo-700">{currentStep.label}</span> — {currentStep.hint}</p>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        {visitor.status !== 'registered' && (
          <div className="px-6 py-3 border-b border-slate-100 flex gap-2 shrink-0">
            {canEditLead && (
              <button onClick={() => setDeskTab('logs')} className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl font-bold text-xs cursor-pointer transition-colors shadow-sm ${currentStep?.key === 'followup' ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'}`}><PhoneCall className="w-3.5 h-3.5" /> Log Follow-up</button>
            )}
            <button onClick={onOpenPlacementTest} className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl font-bold text-xs cursor-pointer transition-colors shadow-sm ${currentStep?.key === 'placement' ? 'bg-indigo-600 hover:bg-indigo-700 text-white' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'}`}><Award className="w-3.5 h-3.5" /> {visitor.placementStatus === 'completed' ? 'Re-assess' : 'Assessment Workspace'}</button>
            {/* UX-4: hidden outright when the caller lacks Lead.Convert — the
                server 403s, so offering the button only wastes the operator's
                data entry. UX-3: when placement blocks this lead the button is
                disabled and says so, rather than opening a payment form. */}
            {canConvertLead && (
              <button
                onClick={onOpenConvert}
                disabled={Boolean(eligibility && !eligibility.eligible && !eligibility.placementActionable)}
                title={eligibility && !eligibility.eligible ? eligibility.reason : undefined}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl font-bold text-xs cursor-pointer transition-colors shadow-sm disabled:opacity-40 disabled:cursor-not-allowed ${currentStep?.key === 'enroll' ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'}`}
              ><UserCheck className="w-3.5 h-3.5" /> Enroll</button>
            )}
          </div>
        )}

        {/* Why Enroll is unavailable — stated before the operator invests any
            data entry, with the assessment as the obvious next step. */}
        {/* Shown regardless of Lead.Convert: a blocker is information, not an
            action. The Enroll BUTTON above remains gated on Lead.Convert. */}
        {eligibility && !eligibility.eligible && visitor.status !== 'registered' && (
          <div className="px-6 pb-3 shrink-0">
            <p className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[10px] font-semibold text-amber-900">
              <Award className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />
              <span>{eligibility.reason}</span>
            </p>
          </div>
        )}

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
                    <p className="font-extrabold text-emerald-900 text-[11px]">Placement completed — {visitor.placementScore.total}/100</p>
                    <p className="text-[10px] text-emerald-700 mt-0.5">Recommended: <span className="font-black">{visitor.placementScore.levelRecommendation}</span> {visitor.placementScore.examiner ? <> · by {visitor.placementScore.examiner}</> : null}</p>
                  </div>
                  <button onClick={onOpenPlacementTest} className="px-2.5 py-1.5 bg-white border border-emerald-200 text-emerald-700 rounded-lg text-[10px] font-bold hover:bg-emerald-50 cursor-pointer">Re-test</button>
                </div>
              )}

              <form onSubmit={handleSaveCRM} className="bg-slate-50/60 border border-slate-150 rounded-2xl p-4 space-y-3 text-xs">
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
                    <input type="text" placeholder="YYYY-MM-DD" value={crmDate} onChange={(e) => setCrmDate(e.target.value)} className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-2 focus:outline-none font-bold text-indigo-600 font-mono text-center" />
                  </div>
                  <div>
                    <label className="block text-slate-500 font-bold mb-1">Initial source:</label>
                    <div className="bg-slate-100 border border-slate-150 rounded-xl px-2.5 py-2 font-bold text-slate-700 text-center">{getSourceLabel(visitor.source)}</div>
                  </div>
                </div>

                <div className="border-t border-dashed border-slate-200 pt-3 mt-1">
                  <span className="block text-[10px] font-extrabold text-indigo-700 mb-2">Additional identity details:</span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">Father's name:</label><input type="text" value={visitor.fatherName || ''} onChange={(e) => updateVisitor(visitor.id, { fatherName: e.target.value })} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px]" placeholder="e.g. Abdul Khaliq" /></div>
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">Tazkira no.:</label><input type="text" value={visitor.tazkiraNo || ''} onChange={(e) => updateVisitor(visitor.id, { tazkiraNo: e.target.value })} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 font-mono text-[11px]" placeholder="Tazkira no." /></div>
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">Date of birth / age:</label><input type="text" value={visitor.dob || ''} onChange={(e) => updateVisitor(visitor.id, { dob: e.target.value })} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px]" placeholder="1381/05/12" /></div>
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">WhatsApp:</label><input type="tel" value={visitor.whatsapp || ''} onChange={(e) => updateVisitor(visitor.id, { whatsapp: e.target.value })} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-start" placeholder="07xxxxxxx" /></div>
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">Email:</label><input type="email" value={visitor.email || ''} onChange={(e) => updateVisitor(visitor.id, { email: e.target.value })} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-start" placeholder="name@example.com" /></div>
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">School / university:</label><input type="text" value={visitor.schoolOrUniversity || ''} onChange={(e) => updateVisitor(visitor.id, { schoolOrUniversity: e.target.value })} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px]" placeholder="School or university" /></div>
                    <div className="sm:col-span-2"><label className="block text-slate-500 font-bold text-[10px] mb-0.5">Home address:</label><input type="text" value={visitor.addressRegion || ''} onChange={(e) => updateVisitor(visitor.id, { addressRegion: e.target.value })} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px]" placeholder="Full address" /></div>
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">Emergency contact name:</label><input type="text" value={visitor.emergencyContactName || ''} onChange={(e) => updateVisitor(visitor.id, { emergencyContactName: e.target.value })} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px]" placeholder="Father or brother name" /></div>
                    <div><label className="block text-slate-500 font-bold text-[10px] mb-0.5">Emergency phone:</label><input type="tel" value={visitor.emergencyContactPhone || ''} onChange={(e) => updateVisitor(visitor.id, { emergencyContactPhone: e.target.value })} className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-start" placeholder="07xxxxxxx" /></div>
                  </div>
                </div>

                <div><label className="block text-slate-500 font-bold mb-1">Reception notes:</label><textarea value={crmNotes} onChange={(e) => setCrmNotes(e.target.value)} rows={2} className="w-full bg-white border border-slate-200 rounded-xl px-2.5 py-2 focus:outline-none font-semibold text-slate-800" /></div>
                <div className="flex justify-end"><button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl font-bold cursor-pointer">Save CRM Changes</button></div>
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
              <form onSubmit={handleAddFollowUpNoteSubmit} className="space-y-3.5 bg-slate-50/60 p-4 rounded-2xl border border-slate-150">
                <h5 className="font-extrabold text-slate-800 text-[11px] flex items-center gap-1.5 border-b border-slate-200 pb-1.5"><PhoneCall className="w-4 h-4 text-indigo-600" /> Log follow-up</h5>
                <div className="flex gap-2">
                  <input type="text" placeholder="New call or follow-up note…" value={followUpInput} onChange={(e) => setFollowUpInput(e.target.value)} className="flex-1 bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 focus:outline-none text-xs font-semibold text-slate-800 shadow-inner" required />
                  <select value={followUpOutcome} onChange={(e) => setFollowUpOutcome(e.target.value)} className="bg-white border border-slate-200 rounded-xl px-2 py-2 text-[10px] font-bold cursor-pointer text-slate-600 focus:outline-none">
                    <option value="">Outcome…</option><option value="interested">Interested</option><option value="not_interested">Not interested</option><option value="callback">Callback</option><option value="registered">Registered</option>
                  </select>
                  <button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold px-4 rounded-xl cursor-pointer flex items-center justify-center shadow-md"><Plus className="w-4 h-4 stroke-[2.5]" /></button>
                </div>
              </form>

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