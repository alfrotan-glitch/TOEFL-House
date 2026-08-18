/**
 * @license SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { ShamsiDate } from '../common/ShamsiDate';
import {CheckCircle2, Award, QrCode, CreditCard, Calendar, AlertCircle, Palette, CheckSquare, Printer, Plus, RotateCcw, X, Pencil, Save, Ban, Camera} from 'lucide-react';
import {Student, Class, Payment, Exam, ExamResult, Attendance, AttendanceSummaryRow, StudentBalanceRow } from '../../types';
import {formatAFN} from '../../utils/format';
import { isRefundPayment } from '../../utils/studentBalance';
import {printStudentIdCard} from '../../utils/certificateTemplates';
import StudentJourneyTimeline from './journey/StudentJourneyTimeline';
import { BRAND_NAME } from '../../config/branding';
import { BrandLogo } from '../common/BrandLogo';

interface StudentProfileDrawerProps {
  /** Server-aggregated attendance rates (GET /attendance/summary). */
  attendanceSummary?: AttendanceSummaryRow[];
  student: Student;
  /**
   * Authoritative tuition balance for this student (GET /payments/balances).
   * The drawer must NOT re-derive tuition from `payments`: that array is one
   * page, and the client rule diverged from the server's the moment a semester
   * was completed — the roster and this drawer showed debts 20,000 AFN apart.
   */
  serverBalance?: StudentBalanceRow;
  payments: Payment[];
  attendance: Attendance[];
  exams: Exam[];
  examResults: ExamResult[];
  classes: Class[];
  isOwnerOrManager: boolean;
  isRegistrar: boolean;
  updateStudent: (studentId: string, updatedFields: Partial<Student>) => void;
  updateStudentStatus: (studentId: string, status: 'active' | 'inactive' | 'graduated' | 'suspended') => void;
  issueStudentCard: (
    studentId: string,
    cardDesign: {
      primaryColor: string; bgStyle: string;
      photo?: string | null;
      officePhone?: string; whatsapp?: string;
      socials?: { facebook?: string; instagram?: string; website?: string };
    },
    notes?: string
  ) => Promise<{ feeCharged: number }>;
  triggerToast: (message: string, type: 'success' | 'error' | 'info') => void;
  onClose: () => void;
  onOpenEnroll: () => void;
  onOpenExtraClass: () => void;
  onOpenRefund: () => void;
  onPayInstallment: (installmentId: string, amount: number) => void;
}

/**
 * Client-side mirror of the server's STUDENT_TRANSITIONS
 * (server/src/core/students/student-lifecycle.ts).
 *
 * This is presentation only — it decides which buttons are offered. The server
 * remains the sole authority and re-validates every transition; this exists so
 * the operator is not invited to click something that can only return 409.
 */
const STUDENT_TRANSITIONS: Record<string, readonly string[]> = {
  active: ['active', 'inactive', 'suspended', 'graduated'],
  inactive: ['inactive', 'active', 'graduated'],
  suspended: ['suspended', 'active', 'inactive'],
  graduated: ['graduated'],
};

function canTransition(from: string | null | undefined, to: string): boolean {
  return (STUDENT_TRANSITIONS[String(from ?? 'active')] ?? []).includes(to);
}

function terminalHint(from: string | null | undefined): string {
  return String(from) === 'graduated'
    ? 'This student has graduated — graduation is a final state.'
    : `Not allowed from "${from}".`;
}

const STATUS_ACTIONS = [
  { to: 'active' as const, label: 'Active', activeClass: 'bg-emerald-600 text-white' },
  { to: 'inactive' as const, label: 'Hold', activeClass: 'bg-rose-600 text-white' },
  { to: 'graduated' as const, label: 'Graduated', activeClass: 'bg-indigo-600 text-white' },
];

export default function StudentProfileDrawer({
  attendanceSummary,
  student, serverBalance, payments, attendance, exams, examResults, classes,
  isOwnerOrManager, isRegistrar, updateStudent, updateStudentStatus, issueStudentCard,
  triggerToast, onOpenEnroll, onOpenExtraClass, onOpenRefund, onPayInstallment
}: StudentProfileDrawerProps) {
  const [drawerTab, setDrawerTab] = useState<'info' | 'card'>('info');
  const [statusBusy, setStatusBusy] = useState(false);

  /**
   * Single place that performs a status change from this drawer, so every
   * button reports the SERVER's message on failure instead of a generic
   * "failed" (the audit flagged generic errors as a defect class).
   */
  const changeStatus = async (
    to: 'active' | 'inactive' | 'graduated' | 'suspended',
    successMessage?: string,
  ) => {
    if (statusBusy) return;
    setStatusBusy(true);
    try {
      await updateStudentStatus(student.id, to);
      triggerToast(successMessage ?? `Student marked ${to}.`, 'success');
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : `Could not set status to ${to}.`, 'error');
    } finally {
      setStatusBusy(false);
    }
  };
  const [editingIdentity, setEditingIdentity] = useState(false);
  const [draftPhone, setDraftPhone] = useState(student.phone || '');
  const [draftEmail, setDraftEmail] = useState(student.email || '');
  const [draftAddress, setDraftAddress] = useState(student.addressRegion || '');
  const [draftSchool, setDraftSchool] = useState(student.schoolOrUniversity || '');
  
  // Card Customizer State
  const [primaryColor, setPrimaryColor] = useState<string>('rose');
  const [bgStyle, setBgStyle] = useState<'waves' | 'solid' | 'modern' | 'dots'>('waves');
  const [customMotto, setCustomMotto] = useState<string>('Where Leaders Learn');
  const [showQrCode] = useState<boolean>(true);
  const [cardPhoto, setCardPhoto] = useState<string | null>(null);
  const [officePhone, setOfficePhone] = useState<string>('');
  const [whatsapp, setWhatsapp] = useState<string>('');
  const [socialFb, setSocialFb] = useState<string>('');
  const [socialIg, setSocialIg] = useState<string>('');
  const [socialWeb, setSocialWeb] = useState<string>('');

  // Sync the editable draft fields whenever a different student is shown, by
  // adjusting state during render (no setState-in-effect). Editing one field
  // never re-triggers this because only the student id participates.
  const [prevStudentId, setPrevStudentId] = useState<string>(student.id);
  if (prevStudentId !== student.id) {
    setPrevStudentId(student.id);
    setDraftPhone(student.phone || '');
    setDraftEmail(student.email || '');
    setDraftAddress(student.addressRegion || '');
    setDraftSchool(student.schoolOrUniversity || '');
    if (student.cardDesign) {
      setPrimaryColor(student.cardDesign.primaryColor || 'rose');
      setBgStyle(student.cardDesign.bgStyle || 'waves');
      setCustomMotto(student.notes?.includes('Motto:') ? student.notes.split('Motto:')[1].trim().split('\n')[0] : 'Where Leaders Learn');
      setCardPhoto((student.cardDesign as any)?.photo ?? null);
      setOfficePhone((student.cardDesign as any)?.officePhone ?? '');
      setWhatsapp((student.cardDesign as any)?.whatsapp ?? '');
      setSocialFb((student.cardDesign as any)?.socials?.facebook ?? '');
      setSocialIg((student.cardDesign as any)?.socials?.instagram ?? '');
      setSocialWeb((student.cardDesign as any)?.socials?.website ?? '');
    }
  }

  // Financial figures come from the SERVER, which sums every payment for this
  // student in SQL. Deriving them here from the paginated `payments` array
  // produced a second, disagreeing source of truth. `student.balance` is
  // present when the record was fetched individually; otherwise the roster's
  // authoritative row is used. Both originate from utils/studentBalance.
  const serverFigures = student.balance?.lifetime ?? serverBalance;
  const totalTuition = serverFigures?.tuitionDue ?? 0;
  const totalPaidFees = serverFigures?.tuitionPaid ?? 0;
  const remainingDebt = serverFigures?.outstanding ?? 0;
  const paidPercentage = serverFigures?.paidPercentage
    ?? (totalTuition > 0 ? Math.min(100, Math.max(0, Math.round((totalPaidFees / totalTuition) * 100))) : 100);

  // Attendance. The recent-days strip below is drawn from the loaded page, but
  // the RATE comes from the server, which aggregates the complete history:
  // /attendance is bounded, so a percentage derived from it would understate
  // any student whose records fall outside the page.
  const studentAttendance = attendance ? attendance.filter(a => a.targetId === student.id && a.targetType === 'student') : [];
  const summary = attendanceSummary?.find(a => a.targetId === student.id);
  const totalDays = summary ? summary.total : studentAttendance.length;
  const attendanceRate = summary
    ? summary.rate
    : (studentAttendance.length > 0
        ? Math.round((studentAttendance.filter(a => a.status === 'present' || a.status === 'leave').length / studentAttendance.length) * 100)
        : null);

  // Exam Results Mapping
  const studentExamResults = examResults ? examResults.filter(er => er.studentId === student.id) : [];
  const displayResults = studentExamResults.map(er => {
    const exam = exams ? exams.find(e => e.id === er.examId) : null;
    return { id: er.id, title: exam ? exam.title : 'Assessment result', date: exam ? exam.date : '—', score: Number(er.score || 0) };
  });

  const currentAssignedClass = student.semesters && student.semesters.length > 0 
    ? classes.find(c => c.id === student.semesters![student.semesters!.length - 1].classId)?.name 
    : 'No class assigned';

  const handleSaveCardDesign = async () => {
    const design = {
      primaryColor, bgStyle, photo: cardPhoto,
      officePhone: officePhone || undefined,
      whatsapp: whatsapp || undefined,
      socials: { facebook: socialFb || undefined, instagram: socialIg || undefined, website: socialWeb || undefined },
    };
    try {
      const result = await issueStudentCard(student.id, design, `${student.notes || ''}\n[Motto: ${customMotto}]`);
      triggerToast(result.feeCharged > 0 ? `Smart card issued. Fee ${result.feeCharged} AFN charged.` : 'Card design saved.', 'success');
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Could not save card design.', 'error');
    }
  };

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { triggerToast('Photo must be under 2 MB.', 'error'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => setCardPhoto(String(reader.result));
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-6 text-sm text-left animate-in fade-in slide-in-from-bottom-4 duration-300">
      
      {/* Header Info & Actions */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between border-b border-slate-200 pb-4 gap-3">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-rose-600 text-white flex items-center justify-center font-black text-lg overflow-hidden shrink-0">
            {(student.cardDesign as any)?.photo
              ? <img src={(student.cardDesign as any).photo} alt={student.fullName} className="w-full h-full object-cover" />
              : student.fullName.substring(0, 1)}
          </div>
          <div>
            <h3 className="font-extrabold text-slate-900 text-base">{student.fullName}</h3>
            <p className="text-xs text-slate-500 mt-0.5">ID: <span className="font-mono font-bold text-indigo-600">{student.studentCode}</span> • {student.currentProgramName || 'Program not assigned'} {student.currentLevelCode ? `• ${student.currentLevelCode}` : ''} • Class: {currentAssignedClass}</p>
          </div>
        </div>
        
        <div className="flex flex-wrap gap-2 items-center">
          {isOwnerOrManager && (
            <div className="flex gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200">
              {/* Lifecycle-aware controls. Graduation is terminal server-side
                  (audit STU-C2), so offering "Active"/"Hold" on a graduated
                  student would only produce a 409. Suspended students must go
                  through the suspend/resume workflow below, not these. */}
              {STATUS_ACTIONS.map(({ to, label, activeClass }) => {
                const allowed = canTransition(student.status, to);
                return (
                  <button
                    key={to}
                    onClick={() => changeStatus(to)}
                    disabled={!allowed || statusBusy}
                    title={allowed ? `Mark as ${label}` : terminalHint(student.status)}
                    className={`px-3 py-1.5 rounded-lg text-[10px] font-bold ${allowed && !statusBusy ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'} ${student.status === to ? activeClass : 'text-slate-600'}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          {isRegistrar && (
            <button onClick={() => setEditingIdentity((v) => !v)} className="flex items-center gap-1 text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-100 hover:bg-indigo-100 cursor-pointer">
              <Pencil className="w-3 h-3" /> Edit profile
            </button>
          )}
          {isRegistrar && student.status !== 'suspended' && (
            <button disabled={statusBusy} onClick={() => changeStatus('suspended', 'Student suspended.')} className="flex items-center gap-1 text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-amber-50 text-amber-700 border border-amber-100 hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              <Ban className="w-3 h-3" /> Suspend
            </button>
          )}
          {isRegistrar && student.status === 'suspended' && (
            <button disabled={statusBusy} onClick={() => changeStatus('active', 'Student resumed.')} className="flex items-center gap-1 text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-100 hover:bg-emerald-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              <CheckCircle2 className="w-3 h-3" /> Resume
            </button>
          )}
          {isRegistrar && (
            <button onClick={onOpenExtraClass} className="flex items-center gap-1 text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-sky-50 text-sky-700 border border-sky-100 hover:bg-sky-100 cursor-pointer">
              <Plus className="w-3 h-3" /> Extra Class
            </button>
          )}
          {isOwnerOrManager && (
            <button onClick={onOpenRefund} className="flex items-center gap-1 text-[10px] font-bold px-2.5 py-1.5 rounded-lg bg-rose-50 text-rose-700 border border-rose-100 hover:bg-rose-100 cursor-pointer">
              <RotateCcw className="w-3 h-3" /> Refund
            </button>
          )}
        </div>
      </div>

      {editingIdentity && (
        <div className="bg-white border border-indigo-100 rounded-2xl p-4 shadow-xs">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-extrabold text-slate-800 text-xs flex items-center gap-1.5"><Pencil className="w-4 h-4 text-indigo-600" /> Quick Profile Edit</h4>
            <button onClick={() => setEditingIdentity(false)} className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input value={draftPhone} onChange={(e) => setDraftPhone(e.target.value)} placeholder="Phone" className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-xs font-semibold" />
            <input value={draftEmail} onChange={(e) => setDraftEmail(e.target.value)} placeholder="Email" className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-xs font-semibold" />
            <input value={draftAddress} onChange={(e) => setDraftAddress(e.target.value)} placeholder="Address / Region" className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-xs font-semibold" />
            <input value={draftSchool} onChange={(e) => setDraftSchool(e.target.value)} placeholder="School / University" className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-xs font-semibold" />
          </div>
          <div className="flex justify-end mt-3">
            <button onClick={async () => { try { await updateStudent(student.id, { phone: draftPhone, email: draftEmail, addressRegion: draftAddress, schoolOrUniversity: draftSchool }); setEditingIdentity(false); triggerToast('Student profile updated.', 'success'); } catch (err) { triggerToast(err instanceof Error ? err.message : 'Profile update failed.', 'error'); } }} className="flex items-center gap-1.5 bg-indigo-600 text-white px-3 py-2 rounded-xl text-[10px] font-extrabold"><Save className="w-3 h-3" /> Save changes</button>
          </div>
        </div>
      )}

      {/* Dashboard Widgets */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Finance Widget */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
          <div className="flex justify-between items-center mb-2">
            <span className="font-bold text-slate-700 text-xs flex items-center gap-1"><CreditCard className="w-4 h-4 text-indigo-500" /> Finance</span>
            <span className="font-mono font-black text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded text-[10px]">{paidPercentage}% Paid</span>
          </div>
          <div className="w-full bg-slate-200 rounded-full h-2 mb-3"><div className="bg-indigo-600 h-2 rounded-full" style={{ width: `${paidPercentage}%` }}></div></div>
          <div className="grid grid-cols-3 text-[10px] text-slate-500 font-bold">
            <div><span className="block text-slate-400">Total</span><span className="font-mono text-slate-800 text-xs">{formatAFN(Number(totalTuition||0))}</span></div>
            <div className="text-center"><span className="block text-slate-400">Paid</span><span className="font-mono text-emerald-600 text-xs">{formatAFN(Number(totalPaidFees||0))}</span></div>
            <div className="text-right"><span className="block text-slate-400">Due</span><span className={`font-mono text-xs ${remainingDebt > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{formatAFN(Number(remainingDebt||0))}</span></div>
          </div>
        </div>

        {/* Attendance Widget */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
          <div className="flex justify-between items-center mb-2">
            <span className="font-bold text-slate-700 text-xs flex items-center gap-1"><Calendar className="w-4 h-4 text-emerald-500" /> Attendance</span>
            <span className={`font-mono font-black px-2 py-0.5 rounded text-[10px] ${attendanceRate === null ? 'bg-slate-100 text-slate-400' : attendanceRate >= 85 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{attendanceRate === null ? 'N/A' : `${attendanceRate}%`}</span>
          </div>
          {totalDays === 0 ? <p className="text-[10px] text-slate-400 italic py-2">No records yet.</p> : (
            <div className="flex gap-1 mt-2">
              {studentAttendance.slice(-15).map((item, i) => {
                let bg = 'bg-slate-200';
                if (item.status === 'present') bg = 'bg-emerald-500';
                if (item.status === 'absent') bg = 'bg-rose-500';
                if (item.status === 'leave') bg = 'bg-amber-400';
                return <div key={i} className={`w-3 h-3 rounded-sm ${bg}`} title={`${item.date} - ${item.status}`}></div>;
              })}
            </div>
          )}
        </div>

        {/* Alerts Widget */}
        {((attendanceRate !== null && attendanceRate < 85) || remainingDebt > 0) ? (
          <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 shadow-xs flex flex-col justify-center">
            <div className="flex items-center gap-1.5 text-rose-800 mb-1"><AlertCircle className="w-4 h-4 text-rose-600 shrink-0" /><span className="font-extrabold text-[11px]">Alerts Active</span></div>
            <p className="text-[10px] text-rose-700 leading-relaxed font-semibold">
              {attendanceRate !== null && attendanceRate < 85 && `⚠️ Low attendance (${attendanceRate}%). `}
              {remainingDebt > 0 && `💳 Outstanding debt: ${formatAFN(Number(remainingDebt||0))} AFN.`}
            </p>
          </div>
        ) : (
          <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 shadow-xs flex flex-col justify-center">
            <div className="flex items-center gap-1.5 text-emerald-800 mb-1"><CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /><span className="font-extrabold text-[11px]">All Clear</span></div>
            <p className="text-[10px] text-emerald-700 leading-relaxed font-semibold">Student is in good standing. No academic or financial alerts.</p>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex bg-slate-100 p-1 rounded-2xl border border-slate-200 w-full max-w-xs mx-auto">
        <button onClick={() => setDrawerTab('info')} className={`flex-1 text-center py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${drawerTab === 'info' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-600'}`}>Academic & Finance</button>
        <button onClick={() => setDrawerTab('card')} className={`flex-1 text-center py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${drawerTab === 'card' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-600'}`}>ID Card Studio</button>
      </div>

      {drawerTab === 'info' ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          
          {/* Left Column: History & Timelines */}
          <div className="space-y-5">
            {/* Installments & Payments */}
            <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
              <h4 className="font-extrabold text-slate-800 text-xs flex items-center gap-1.5 border-b border-slate-100 pb-2 mb-3"><CheckSquare className="w-4 h-4 text-indigo-500" /> Installments & Payments</h4>
              
              {/* Installment Plan */}
              {student.installmentPlan && student.installmentPlan.length > 0 && (
                <div className="space-y-2 mb-4">
                  {student.installmentPlan.map((inst, _index) => (
                    <div key={inst.id} className="flex items-center gap-2 bg-slate-50 p-2 rounded-lg border border-slate-100">
                      <span className="text-[10px] font-bold text-slate-500">{inst.dueDate}</span>
                      <span className="flex-1 text-[11px] font-bold text-slate-700">{formatAFN(Number(inst.amount||0))}</span>
                      {inst.status === 'paid' ? (
                        <span className="text-[9px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-bold">Paid</span>
                      ) : (
                        <button onClick={() => onPayInstallment(inst.id, Number(inst.amount||0))} className="text-[9px] bg-indigo-600 text-white px-2 py-1 rounded-lg font-bold cursor-pointer hover:bg-indigo-700">Settle Now</button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Payment History */}
              <div className="space-y-2 max-h-48 overflow-y-auto pr-2">
                {payments.filter(p => p.studentId === student.id).map(pay => (
                  <div key={pay.id} className="flex justify-between items-center text-[11px] bg-slate-50 border border-slate-100 p-2.5 rounded-xl">
                    <div><p className="font-black text-slate-800 text-[10px]">{pay.category === 'fee' ? 'Tuition' : pay.category === 'refund' ? 'Refund' : pay.category}</p><p className="text-[9px] text-slate-400 font-mono">{pay.date} • {pay.receiptNumber}</p></div>
                    <span className={`font-mono font-black px-2 py-0.5 rounded-lg border text-[10px] ${isRefundPayment(pay) ? 'bg-rose-50 text-rose-600 border-rose-100' : 'bg-emerald-50 text-emerald-600 border-emerald-100'}`}>{isRefundPayment(pay) ? '−' : '+'}{formatAFN(Math.abs(Number(pay.amount||0)))}</span>
                  </div>
                ))}
                {payments.filter(p => p.studentId === student.id).length === 0 && <p className="text-[10px] text-slate-400 text-center py-4 italic">No transactions yet.</p>}
              </div>
            </div>

            {/* Exam Progress */}
            <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
              <h4 className="font-extrabold text-slate-800 text-xs flex items-center gap-1.5 border-b border-slate-100 pb-2 mb-3"><Award className="w-4 h-4 text-amber-500" /> Exam Progress</h4>
              {displayResults.length === 0 ? <p className="text-[10px] text-slate-400 italic py-4 text-center">No exam results recorded.</p> : (
                displayResults.map(res => (
                  <div key={res.id} className="bg-slate-50 p-3 rounded-xl mb-2">
                    <div className="flex justify-between items-center mb-1">
                      <h5 className="font-bold text-slate-900 text-[10px]">{res.title}</h5>
                      <span className="font-mono font-black text-xs text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded">{res.score} / 120</span>
                    </div>
                    <div className="w-full bg-slate-200 rounded-full h-1.5"><div className="bg-indigo-600 h-1.5 rounded-full" style={{ width: `${Math.round((res.score/120)*100)}%` }}></div></div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right Column: Details & Journey */}
          <div className="space-y-5">
            <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
              <h4 className="font-extrabold text-slate-800 text-xs flex items-center gap-1.5 border-b border-slate-100 pb-2 mb-3">Identity & Contact</h4>
              <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-600 font-semibold">
                <div><span className="text-slate-400 block">Father's Name</span>{student.fatherName || 'N/A'}</div>
                <div><span className="text-slate-400 block">Phone</span><span className="font-mono">{student.phone}</span></div>
                <div><span className="text-slate-400 block">Tazkira No</span><span className="font-mono">{student.tazkiraNo || 'N/A'}</span></div>
                <div><span className="text-slate-400 block">WhatsApp</span><span className="font-mono">{student.whatsapp || 'N/A'}</span></div>
                <div className="col-span-2"><span className="text-slate-400 block">Address</span>{student.addressRegion || 'N/A'}</div>
                <div className="col-span-2"><span className="text-slate-400 block">Emergency Contact</span>{student.emergencyContactName} - <span className="font-mono">{student.emergencyContactPhone}</span></div>
              </div>
              {isRegistrar && (
                <button onClick={onOpenEnroll} className="w-full mt-4 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold py-2 rounded-xl text-[10px] flex items-center justify-center gap-1 border border-indigo-100 cursor-pointer"><Plus className="w-3 h-3" /> Add New Semester</button>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs">
              <h4 className="font-extrabold text-slate-800 text-xs flex items-center gap-1.5 border-b border-slate-100 pb-2 mb-3">Student Journey</h4>
              <StudentJourneyTimeline studentId={student.id} />
            </div>
          </div>
        </div>
      ) : (
        /* ID CARD STUDIO TAB */
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
          <div className="bg-white rounded-3xl overflow-hidden shadow-lg border border-rose-200">
            <div className="bg-gradient-to-r from-rose-900 to-rose-600 px-5 py-3 flex justify-between items-center">
              <div>
                <div className="font-black text-white text-sm tracking-wide">{BRAND_NAME}</div>
                <div className="text-[8px] font-bold text-rose-100 tracking-[0.18em]">STUDENT IDENTITY CARD</div>
              </div>
              <div className="w-9 h-9 rounded-full bg-white flex items-center justify-center p-1"><BrandLogo height={18} /></div>
            </div>
            <div className="px-5 py-4 flex gap-4">
              <div className="w-20 h-24 rounded-xl border-2 border-rose-500 bg-rose-50 flex items-center justify-center overflow-hidden shrink-0 text-slate-300">
                {cardPhoto ? <img src={cardPhoto} alt="student" className="w-full h-full object-cover" /> : <span className="text-3xl">👤</span>}
              </div>
              <div className="flex-1 min-w-0 space-y-1 text-[10px] text-slate-700">
                <div><span className="text-rose-600 font-bold uppercase tracking-wide">Name:</span> <span className="font-extrabold text-slate-900">{student.fullName}</span></div>
                <div><span className="text-rose-600 font-bold uppercase tracking-wide">Code:</span> <span className="font-mono font-bold text-slate-900">{student.studentCode}</span></div>
                <div><span className="text-rose-600 font-bold uppercase tracking-wide">Date:</span> <ShamsiDate value={student.registrationDate} format="long" className="font-bold text-slate-900" /></div>
                {customMotto && <div className="italic text-rose-800 pt-1">{customMotto}</div>}
              </div>
              {showQrCode && (
                <div className="bg-rose-50 border border-rose-200 rounded-lg p-1 shrink-0"><QrCode className="w-12 h-12 text-slate-900" /></div>
              )}
            </div>
            <div className="border-t-2 border-rose-500 px-5 py-2 flex justify-between items-center text-[8px] text-slate-600">
              <div className="space-y-0.5">
                {officePhone && <div><b className="text-slate-900">Office:</b> {officePhone}</div>}
                {whatsapp && <div><b className="text-slate-900">WhatsApp:</b> {whatsapp}</div>}
                {(socialFb || socialIg || socialWeb) && <div>{[socialFb, socialIg, socialWeb].filter(Boolean).join(' · ')}</div>}
              </div>
              <span className="font-bold text-rose-700">Scan to verify</span>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4">
            <h4 className="font-extrabold text-slate-800 text-sm flex items-center gap-1.5 border-b border-slate-100 pb-2"><Palette className="w-4 h-4 text-rose-600" /> Card Customizer</h4>
            <div>
              <label className="block text-slate-500 font-bold mb-2 text-xs">Student Photo:</label>
              <div className="flex items-center gap-3">
                <div className="w-14 h-16 rounded-lg border-2 border-rose-300 bg-rose-50 flex items-center justify-center overflow-hidden text-slate-300">
                  {cardPhoto ? <img src={cardPhoto} alt="student" className="w-full h-full object-cover" /> : <Camera className="w-5 h-5" />}
                </div>
                <label className="flex-1 cursor-pointer bg-white border border-rose-200 hover:bg-rose-50 text-rose-700 font-bold py-2.5 rounded-xl text-xs text-center">
                  {cardPhoto ? 'Change Photo' : 'Upload Photo'}
                  <input type="file" accept="image/*" onChange={handlePhotoUpload} className="hidden" />
                </label>
                {cardPhoto && <button onClick={() => setCardPhoto(null)} className="text-rose-500 text-[10px] font-bold hover:underline">Remove</button>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-500 font-bold mb-1 text-xs">Office Phone:</label>
                <input type="text" value={officePhone} onChange={(e) => setOfficePhone(e.target.value)} placeholder="e.g. 020 220 0000" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-bold text-slate-800 text-xs" />
              </div>
              <div>
                <label className="block text-slate-500 font-bold mb-1 text-xs">WhatsApp:</label>
                <input type="text" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="e.g. 0799 000 000" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-bold text-slate-800 text-xs" />
              </div>
              <div>
                <label className="block text-slate-500 font-bold mb-1 text-xs">Facebook:</label>
                <input type="text" value={socialFb} onChange={(e) => setSocialFb(e.target.value)} placeholder="@toeflhouse" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-bold text-slate-800 text-xs" />
              </div>
              <div>
                <label className="block text-slate-500 font-bold mb-1 text-xs">Instagram:</label>
                <input type="text" value={socialIg} onChange={(e) => setSocialIg(e.target.value)} placeholder="@toeflhouse" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-bold text-slate-800 text-xs" />
              </div>
              <div className="col-span-2">
                <label className="block text-slate-500 font-bold mb-1 text-xs">Website:</label>
                <input type="text" value={socialWeb} onChange={(e) => setSocialWeb(e.target.value)} placeholder="https://toeflhouse.af" className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-bold text-slate-800 text-xs" />
              </div>
            </div>
            <div>
              <label className="block text-slate-500 font-bold mb-2 text-xs">Footer Tagline:</label>
              <input type="text" value={customMotto} onChange={(e) => setCustomMotto(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-bold text-slate-800 text-xs" />
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={handleSaveCardDesign} className="flex-1 bg-white border border-rose-200 hover:bg-rose-50 text-rose-700 font-bold py-2.5 rounded-xl text-xs cursor-pointer">Save Template</button>
              <button onClick={() => printStudentIdCard(student, { primaryColor, bgStyle, customMotto, showQrCode, photo: cardPhoto, officePhone, whatsapp, socials: { facebook: socialFb, instagram: socialIg, website: socialWeb } })} className="flex-1 bg-rose-600 hover:bg-rose-700 text-white font-extrabold py-2.5 rounded-xl text-xs cursor-pointer flex items-center justify-center gap-1"><Printer className="w-4 h-4" /> Print ID</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}