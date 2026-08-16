/**
 * Student Portal — read-only self-service view.
 * A student logs in with their student code + full name (auto-provisioned
 * account) and sees ONLY their own profile here: identity, class, payments,
 * attendance and the option to print their own ID card. No edit actions and
 * no navigation to any administrative module.
 */
import React, { useEffect, useState } from 'react';
import { GraduationCap, CreditCard, Calendar, Printer, LogOut, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/useAuth';
import type { Student, Payment, Attendance } from '../../types';
import { printStudentIdCard, type IdCardDesign } from '../../utils/certificateTemplates';
import { formatAFN } from '../../utils/format';
import { BRAND_NAME } from '../../config/branding';
import { BrandLogo } from '../common/BrandLogo';

export default function StudentPortalView() {
  const { logout } = useAuth();
  const [student, setStudent] = useState<Student | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const me = await api.get<Student>('/students/me');
        setStudent(me);
        setPayments(await api.get<Payment[]>('/payments', { branchId: me.branchId }));
        try { setAttendance(await api.get<Attendance[]>('/attendance', { branchId: me.branchId })); } catch { setAttendance([]); }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load your profile.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex items-center gap-2 text-slate-500 text-sm font-bold"><Loader2 className="w-5 h-5 animate-spin" /> Loading your profile…</div>
      </div>
    );
  }

  if (error || !student) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white border border-rose-200 rounded-2xl p-6 text-center max-w-sm">
          <AlertCircle className="w-8 h-8 text-rose-500 mx-auto mb-2" />
          <p className="text-sm font-bold text-slate-800">{error || 'Profile unavailable.'}</p>
          <button onClick={logout} className="mt-4 px-4 py-2 bg-slate-100 rounded-xl text-xs font-bold cursor-pointer">Sign out</button>
        </div>
      </div>
    );
  }

  const myPayments = payments.filter((p) => p.studentId === student.id);
  const myAttendance = attendance.filter((a) => a.targetId === student.id && a.targetType === 'student');
  const present = myAttendance.filter((a) => a.status === 'present' || a.status === 'leave').length;
  const rate = myAttendance.length ? Math.round((present / myAttendance.length) * 100) : null;
  // Server-computed. Deriving this from `myPayments` produced a third
  // disagreeing source of truth (the portal, the roster and the profile each
  // had their own rule). `current` scope = what the student owes right now.
  const portalBalance = student.balance?.current;
  const totalDue = portalBalance?.tuitionDue ?? 0;
  const totalPaid = portalBalance?.tuitionPaid ?? 0;
  const debt = portalBalance?.outstanding ?? 0;
  const cardDesign = student.cardDesign;

  const printCard = () => {
    const design: IdCardDesign = {
      primaryColor: 'rose',
      bgStyle: 'waves',
      customMotto: 'Where Leaders Learn',
      showQrCode: true,
      photo: cardDesign?.photo ?? null,
      officePhone: cardDesign?.officePhone,
      whatsapp: cardDesign?.whatsapp,
      socials: cardDesign?.socials,
    };
    void printStudentIdCard(student, design);
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans" dir="ltr">
      <header className="bg-gradient-to-r from-rose-900 to-rose-600 text-white px-6 py-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center"><GraduationCap className="w-5 h-5" /></div>
          <div>
            <div className="font-black text-sm tracking-wide">{BRAND_NAME} — Student Portal</div>
            <div className="text-[10px] text-rose-100">Read-only self-service · {student.branchId ? `Branch ${student.branchId}` : ''}</div>
          </div>
        </div>
        <button onClick={logout} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/15 hover:bg-white/25 text-xs font-bold cursor-pointer"><LogOut className="w-3.5 h-3.5" /> Sign out</button>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {/* Identity card preview */}
        <div className="bg-white rounded-2xl border border-rose-200 overflow-hidden shadow-sm">
          <div className="bg-gradient-to-r from-rose-900 to-rose-600 px-5 py-3 flex justify-between items-center">
            <div>
              <div className="font-black text-white text-sm">{BRAND_NAME}</div>
              <div className="text-[8px] font-bold text-rose-100 tracking-[0.18em]">STUDENT IDENTITY CARD</div>
            </div>
            <div className="w-9 h-9 rounded-full bg-white flex items-center justify-center p-1"><BrandLogo height={18} /></div>
          </div>
          <div className="px-5 py-4 flex gap-4 items-center">
            <div className="w-20 h-24 rounded-xl border-2 border-rose-500 bg-rose-50 flex items-center justify-center overflow-hidden shrink-0">
              {cardDesign?.photo ? <img src={cardDesign.photo} alt="student" className="w-full h-full object-cover" /> : <span className="text-3xl text-slate-300">👤</span>}
            </div>
            <div className="flex-1 min-w-0 space-y-1 text-[10px] text-slate-700">
              <div><span className="text-rose-600 font-bold uppercase">Name:</span> <span className="font-extrabold text-slate-900">{student.fullName}</span></div>
              <div><span className="text-rose-600 font-bold uppercase">Code:</span> <span className="font-mono font-bold text-slate-900">{student.studentCode}</span></div>
              <div><span className="text-rose-600 font-bold uppercase">Status:</span> <span className="font-bold text-slate-900 capitalize">{student.status}</span></div>
              <div><span className="text-rose-600 font-bold uppercase">Class:</span> <span className="font-bold text-slate-900">{(student.semesters || []).map((s) => s.classId).filter(Boolean).join(', ') || '—'}</span></div>
            </div>
            <button onClick={printCard} className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-xs cursor-pointer shrink-0"><Printer className="w-4 h-4" /> Print my ID</button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <div className="text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1"><CreditCard className="w-3.5 h-3.5" /> Total tuition</div>
            <div className="text-xl font-black text-slate-900 mt-1">{formatAFN(totalDue)}</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <div className="text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Paid</div>
            <div className="text-xl font-black text-emerald-600 mt-1">{formatAFN(totalPaid)}</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-2xl p-4">
            <div className="text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" /> Outstanding</div>
            <div className={`text-xl font-black mt-1 ${debt > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{formatAFN(debt)}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white border border-slate-200 rounded-2xl p-5">
            <h3 className="font-extrabold text-slate-800 text-xs flex items-center gap-1.5 border-b border-slate-100 pb-2 mb-3"><CreditCard className="w-4 h-4 text-rose-600" /> Payment history</h3>
            {myPayments.length === 0 ? <p className="text-[10px] text-slate-400 italic">No payments yet.</p> : (
              <div className="space-y-1.5">
                {myPayments.slice(0, 12).map((p) => (
                  <div key={p.id} className="flex justify-between text-[11px] border-b border-slate-50 pb-1.5">
                    <span className="text-slate-500 font-semibold">{p.date} · {p.category} · {p.receiptNumber ? `#${p.receiptNumber}` : ''}</span>
                    <span className="font-bold text-emerald-700">{formatAFN(p.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="bg-white border border-slate-200 rounded-2xl p-5">
            <h3 className="font-extrabold text-slate-800 text-xs flex items-center gap-1.5 border-b border-slate-100 pb-2 mb-3"><Calendar className="w-4 h-4 text-rose-600" /> Attendance</h3>
            <div className="flex items-center gap-3 mb-3">
              <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold ${rate === null ? 'bg-slate-100 text-slate-500' : rate >= 85 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                {rate === null ? 'No records yet' : `${rate}% present`}
              </span>
              <span className="text-[10px] text-slate-400">{myAttendance.length} sessions recorded</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {myAttendance.slice(-20).map((a) => (
                <span key={a.id} className={`w-6 h-6 rounded-md flex items-center justify-center text-[9px] font-bold ${a.status === 'present' || a.status === 'leave' ? 'bg-emerald-100 text-emerald-700' : a.status === 'late' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`} title={a.status}>{a.status === 'present' ? 'P' : a.status === 'leave' ? 'L' : a.status === 'late' ? 'T' : 'A'}</span>
              ))}
            </div>
          </div>
        </div>

        <div className="text-center text-[10px] text-slate-400">
          Contact the office for any correction. <span className="font-bold text-slate-500">{BRAND_NAME}</span>
        </div>
      </main>
    </div>
  );
}
