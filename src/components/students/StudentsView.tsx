/**
 * @license SPDX-License-Identifier: Apache-2.0
 *
 * TOEFL House ERP — Student Management & Tuition Portal
 */
import { text } from '../../design-system/styles';
import {api} from '../../api/client';
import { useInvalidate } from '../../state/serverStateFreshness';
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {GraduationCap, Search, Filter, Eye, CreditCard, UserPlus, Users, RotateCcw, X, Download} from 'lucide-react';
import {Student, Class, Payment, Exam, ExamResult, Attendance, Branch, Visitor, StudentBalanceRow, AttendanceSummaryRow, StudentSummary } from '../../types';
import AddStudentForm from './AddStudentForm';
import StudentProfileDrawer from './StudentProfileDrawer';
import {formatAFN} from '../../utils/format';
import Toast from '../common/Toast';
import {useAcademicOptions} from '../../hooks/useAcademicOptions';
import { hasPermission } from '../../config/permissions';

interface StudentsViewProps {
  /** Server-aggregated attendance rates (GET /attendance/summary). */
  attendanceSummary?: AttendanceSummaryRow[];
  /** Server-aggregated tuition balances (GET /payments/balances). */
  studentBalances: StudentBalanceRow[];
  students: Student[];
  visitors?: Visitor[];
  classes: Class[];
  payments: Payment[];
  exams: Exam[];
  examResults: ExamResult[];
  attendance: Attendance[];
  permissionCodes?: string[];
  branches: Branch[];
  activeBranchId: string;
  addStudentManual: (fullName: string, phone: string, email: string, gender: 'male' | 'female', discountPercent: number, notes?: string, classId?: string, tuitionAmount?: number, fatherName?: string, addressRegion?: string, tazkiraNo?: string, whatsapp?: string, dob?: string, schoolOrUniversity?: string, emergencyContactName?: string, emergencyContactPhone?: string, amountPaidNow?: number, branchId?: string) => void;
  updateStudentStatus: (
    studentId: string,
    status: 'active' | 'inactive' | 'graduated' | 'suspended',
    fromStatus?: Student['status'],
  ) => void;
  updateStudent: (studentId: string, updatedFields: Partial<Student>) => void;
  recordFeePayment: (studentId: string, amount: number, category: 'fee' | 'book' | 'chapter' | 'exam' | 'card' | 'placement' | 'diploma' | 'other', notes?: string) => void;
  enrollStudentSemester: (studentId: string, semesterName: string, classId: string, tuitionAmount: number, amountPaidNow?: number, notes?: string) => void;
  issueStudentCard: (studentId: string, cardDesign: { primaryColor: string; bgStyle: string }, notes?: string) => Promise<{ feeCharged: number }>;
  books?: any[]; // Needed for smart book payments
  /** Authoritative roster totals from the server (audit STU-H2). */
  studentSummary?: StudentSummary | null;
}

export default function StudentsView({
  attendanceSummary,
  studentBalances,
  students, visitors = [], classes, payments, exams, examResults, attendance, permissionCodes, branches, activeBranchId,
  addStudentManual, updateStudentStatus, updateStudent, enrollStudentSemester, issueStudentCard, books = [],
  studentSummary = null
}: StudentsViewProps) {
  const invalidate = useInvalidate();
  const { educationalSections } = useAcademicOptions(classes, activeBranchId);
  const [subTab, setSubTab] = useState<'list' | 'add'>('list');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const triggerToast = (message: string, type: 'success' | 'error' | 'info') => setToast({ message, type });

  // Smart Payment Modal State
  const [paymentStudent, setPaymentStudent] = useState<Student | null>(null);
  const [payCategory, setPayCategory] = useState<'fee' | 'book' | 'card' | 'installment' | 'other'>('fee');
  const [payReason, setPayReason] = useState('');
  const [payAmount, setPayAmount] = useState(0);
  const [paySemesterId, setPaySemesterId] = useState('');
  const [payInstallmentId, setPayInstallmentId] = useState('');
  const [payBookId, setPayBookId] = useState('');
  const [payMethod, setPayMethod] = useState<'cash' | 'card' | 'bank_transfer'>('cash');
  const [paymentBusy, setPaymentBusy] = useState(false);

  // Extra Class Modal State
  const [showExtraClassModal, setShowExtraClassModal] = useState(false);
  const [extraClassId, setExtraClassId] = useState('');
  const [extraClassPaidNow, setExtraClassPaidNow] = useState(0);

  // Semester Enroll Modal State
  const [showEnrollModal, setShowEnrollModal] = useState(false);
  const [enrollSemesterName, setEnrollSemesterName] = useState('');
  const [enrollClassId, setEnrollClassId] = useState('');
  const [enrollTuitionAmount, setEnrollTuitionAmount] = useState(0);
  const [enrollAmountPaidNow, setEnrollAmountPaidNow] = useState(0);

  // Refund Modal State
  const [refundStudent, setRefundStudent] = useState<Student | null>(null);
  const [refundAmount, setRefundAmount] = useState(0);
  const [refundReason, setRefundReason] = useState('');

  // Offer controls from the server-resolved permission set. Role labels are
  // presentation metadata and cannot answer capability questions.
  const canCreateStudent = hasPermission(permissionCodes, 'Student.Create');
  const canEditStudent = hasPermission(permissionCodes, 'Student.Edit');
  const canAssignClass = hasPermission(permissionCodes, 'Class.Assign');
  const canCreatePayment = hasPermission(permissionCodes, 'Payment.Create');
  const hasPaymentView = hasPermission(permissionCodes, 'Payment.View');
  const canApproveRefund = hasPermission(permissionCodes, 'Refund.Approve');
  const canSuspendStudent = hasPermission(permissionCodes, 'Student.Suspend');
  const canResumeStudent = hasPermission(permissionCodes, 'Student.Resume');
  const canPrintStudent = hasPermission(permissionCodes, 'Student.Print');

  const [classFilter, setClassFilter] = useState<string>('all');
  // Whole-database server search: when any filter/search is active we query
  // the server (works at 10k+ students) instead of the loaded roster.
  const [searchResults, setSearchResults] = useState<Student[] | null>(null);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchOffset, setSearchOffset] = useState(0);
  const SEARCH_PAGE = 50;

  const activeStudentInfo = selectedStudent ? students.find(s => s.id === selectedStudent.id) || selectedStudent : null;

  // Finance map from SERVER-aggregated balances.
  //
  // Not reduced from the loaded `payments` array: that array is one page, so
  // with 6,000 payments and a 2,000-row cap two thirds never reach the browser
  // and every student outside the first page displays as owing their FULL fee
  // despite having paid. The server sums all payments per student in SQL, using
  // the same authoritative rule as studentBalance.
  const financeByStudent = useMemo(() => {
    const map = new Map<string, { total: number; paid: number; debt: number }>();
    for (const b of studentBalances) {
      map.set(b.studentId, { total: b.tuitionDue, paid: b.tuitionPaid, debt: b.outstanding });
    }
    return map;
  }, [studentBalances]);

  const getStudentFinance = (studentId: string) => financeByStudent.get(studentId) || { total: 0, paid: 0, debt: 0 };
  // A unioned permission code is not enough for an individual row. The server
  // omits finance fields outside the assignment's branch, and the balances
  // endpoint may legitimately return only one branch of an organization-wide
  // roster. Require both projections before presenting any amount as truth.
  const canViewStudentFinance = (student: Student): boolean =>
    hasPaymentView
    && student.discountPercent !== undefined
    && financeByStudent.has(student.id);
  const canViewActiveFinance = activeStudentInfo ? canViewStudentFinance(activeStudentInfo) : false;
  const canViewPaymentFinance = paymentStudent ? canViewStudentFinance(paymentStudent) : false;

  // Debounced whole-DB search. Empty term + all filters -> use loaded roster.
  const serverSearch = useCallback(async (offset: number) => {
    const q = searchTerm.trim();
    const params = new URLSearchParams({ limit: String(SEARCH_PAGE), offset: String(offset) });
    if (q) params.set('q', q);
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (classFilter !== 'all') params.set('classId', classFilter);
    setSearchLoading(true);
    try {
      const data = await api.get<{ rows: Student[]; total: number }>(`/students/search?${params.toString()}`);
      setSearchResults((prev) => (offset === 0 ? data.rows : [...(prev || []), ...data.rows]));
      setSearchTotal(data.total);
      setSearchOffset(offset + data.rows.length);
    } catch {
      setSearchResults([]);
      setSearchTotal(0);
    } finally {
      setSearchLoading(false);
    }
  }, [searchTerm, statusFilter, classFilter]);

  useEffect(() => {
    // All state changes happen inside the debounce callback (never
    // synchronously in the effect), so the reset path cannot cascade renders.
    const t = window.setTimeout(() => {
      if (!searchTerm.trim() && statusFilter === 'all' && classFilter === 'all') {
        setSearchResults(null); setSearchTotal(0); setSearchOffset(0);
        return;
      }
      void serverSearch(0);
    }, 350);
    return () => window.clearTimeout(t);
  }, [searchTerm, statusFilter, classFilter, serverSearch]);

  const filteredStudents = students.filter(student => {
    const term = searchTerm.trim().toLowerCase();
    const matchesSearch = !term
      || student.fullName.toLowerCase().includes(term)
      || student.studentCode.toLowerCase().includes(term)
      || (student.phone || '').includes(term)
      || (student.tazkiraNo || '').toLowerCase().includes(term)
      || (student.whatsapp || '').includes(term)
      || (student.email || '').toLowerCase().includes(term)
      || (student.fatherName || '').toLowerCase().includes(term);
    const matchesStatus = statusFilter === 'all' || student.status === statusFilter;
    const matchesClass = classFilter === 'all' || (student.semesters || []).some(sem => sem.classId === classFilter);
    return matchesSearch && matchesStatus && matchesClass;
  });
  const displayedStudents = searchResults !== null ? searchResults : filteredStudents;
  const showFinanceColumn = displayedStudents.some(canViewStudentFinance);

  /**
   * Roster caption (audit STU-H2).
   *
   * The old caption was `${filteredStudents.length} of ${students.length}`,
   * where BOTH numbers came from the truncated page — so a branch with 2,162
   * students was captioned "2000 of 2000" and nothing indicated that 162 rows
   * were missing. The denominator is now the server's authoritative total, and
   * when the page really is short of it we say so explicitly.
   */
  const shownStudentCount = filteredStudents.length;
  const rosterTotal = studentSummary?.filtered ?? null;
  const rosterCaption = rosterTotal === null
    ? `${shownStudentCount} student${shownStudentCount === 1 ? '' : 's'} loaded`
    : shownStudentCount < rosterTotal
      ? `Showing ${shownStudentCount} of ${rosterTotal} students — refine the search or use filters to reach the rest`
      : `${shownStudentCount} of ${rosterTotal} student${rosterTotal === 1 ? '' : 's'}`;

  /**
   * CSV export (audit STU-H2).
   *
   * Serialising `filteredStudents` — the loaded page — makes an export of a
   * 2,162-student branch silently produce 2,000 rows, financial columns
   * included. This asks the server to build the file over the FULL filtered
   * dataset, using the authoritative balance definition.
   */
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      const q = searchTerm.trim();
      if (q) params.set('q', q);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (classFilter !== 'all') params.set('classId', classFilter);
      const qs = params.toString();
      const res = await fetch(`/api/students/export${qs ? `?${qs}` : ''}`, { credentials: 'include' });
      if (!res.ok) {
        let msg = 'Export failed.';
        try { msg = (await res.json()).error || msg; } catch { /* non-JSON error body */ }
        return triggerToast(msg, 'error');
      }
      const total = Number(res.headers.get('X-Total-Count') || 0);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `students-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      triggerToast(total ? `Exported ${total} students.` : 'No students to export.', total ? 'success' : 'info');
    } catch {
      triggerToast('Export failed. Check your connection and try again.', 'error');
    } finally {
      setExporting(false);
    }
  };

  // Handlers
  const handleSmartPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!paymentStudent || payAmount <= 0) return triggerToast('Invalid amount.', 'error');
    if (paymentBusy) return; // double-click guard
    setPaymentBusy(true);
    try {
      // Idempotency key per submission: a double-click / network retry is
      // replayed by the backend (200 + same receipt) instead of charging twice.
      const idem = crypto.randomUUID();
      await api.post(`/students/${paymentStudent.id}/payments`, {
        amount: payAmount,
        category: payCategory,
        paymentMethod: payMethod,
        semesterId: payCategory === 'fee' ? paySemesterId : undefined,
        installmentId: payCategory === 'installment' ? payInstallmentId : undefined,
        bookId: payCategory === 'book' ? payBookId : undefined,
        notes: payCategory === 'other' ? payReason.trim() : undefined,
      }, undefined, { 'Idempotency-Key': idem });
      triggerToast('Payment recorded successfully.', 'success');
      setPaymentStudent(null);
      invalidate('students', 'payments');
    } catch (err: any) {
      triggerToast(err.response?.data?.error || 'Payment failed.', 'error');
    } finally {
      setPaymentBusy(false);
    }
  };

  const handleExtraClassEnroll = async () => {
    if (!activeStudentInfo || !extraClassId) return triggerToast('Select a class.', 'error');
    try {
      await api.post(`/students/${activeStudentInfo.id}/enroll-class`, { classId: extraClassId, amountPaidNow: extraClassPaidNow });
      triggerToast('Enrolled in extra class successfully.', 'success');
      setShowExtraClassModal(false);
      setExtraClassId(''); setExtraClassPaidNow(0);
      invalidate('students', 'payments');
    } catch (err: any) {
      triggerToast(err.response?.data?.error || 'Enrollment failed.', 'error');
    }
  };

  const handleSemesterEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeStudentInfo || !enrollSemesterName || !enrollClassId) return triggerToast('Missing fields.', 'error');
    try {
      await enrollStudentSemester(activeStudentInfo.id, enrollSemesterName, enrollClassId, enrollTuitionAmount, enrollAmountPaidNow);
      setShowEnrollModal(false);
      triggerToast('New semester enrollment successful.', 'success');
    } catch (err: any) {
      triggerToast(err.response?.data?.error || 'Enrollment failed.', 'error');
    }
  };

  const handleRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!refundStudent || refundAmount <= 0) return triggerToast('Invalid amount.', 'error');
    try {
      await api.post(`/students/${refundStudent.id}/refund`, { amount: refundAmount, reason: refundReason });
      triggerToast('Refund processed.', 'success');
      setRefundStudent(null);
      invalidate('students', 'payments');
    } catch (err: any) {
      triggerToast(err.response?.data?.error || 'Refund failed.', 'error');
    }
  };

  // UI Helpers
  const inputCls = "w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold focus:outline-none focus:ring-2 focus:ring-indigo-500/10";
  const btnPrimary = "px-4 py-2 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 cursor-pointer shadow-sm text-xs";
  const btnSecondary = "px-4 py-2 bg-slate-100 text-slate-600 rounded-lg font-semibold hover:bg-slate-200 cursor-pointer text-xs";
  const btnDanger = "px-4 py-2 bg-rose-600 text-white rounded-lg font-semibold hover:bg-rose-700 cursor-pointer shadow-sm text-xs";

  return (
    <div className="space-y-6 font-sans text-start">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-center justify-between border-b border-slate-200 pb-4 gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2"><GraduationCap className="w-6 h-6 text-indigo-600" /> Student Management</h2>
          <p className={text.hint}>Registration, smart payments, and concurrent enrollments</p>
        </div>
        <div className="flex gap-2 bg-slate-100 p-1 rounded-xl border border-slate-200">
          <button onClick={() => { setSubTab('list'); setSelectedStudent(null); }} className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg cursor-pointer ${subTab === 'list' ? 'bg-white text-indigo-600' : 'text-slate-600'}`}><Users className="w-4 h-4" /> List</button>
          {canCreateStudent && <button onClick={() => setSubTab('add')} className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg cursor-pointer ${subTab === 'add' ? 'bg-white text-indigo-600' : 'text-slate-600'}`}><UserPlus className="w-4 h-4" /> Register</button>}
        </div>
      </div>

      {subTab === 'list' ? (
        <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-xs space-y-4">
          {/* Search & Filter */}
          <div className="flex flex-col sm:flex-row items-center gap-3">
            <div className="relative flex-1 w-full">
              <input type="text" placeholder="Search by name, code, phone…" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl ps-3 pe-10 py-2.5 text-xs focus:outline-none font-semibold" />
              <Search className="w-4 h-4 text-slate-400 absolute end-3.5 top-3.5" />
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold">
              <Filter className="w-4 h-4 text-slate-400" />
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-xs cursor-pointer font-extrabold">
                <option value="all">All</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="inactive">Inactive</option><option value="graduated">Graduated</option>
              </select>
              <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} className="bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-xs cursor-pointer font-extrabold max-w-[180px]">
                <option value="all">All Classes</option>
                {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button type="button" onClick={exportCsv} disabled={exporting} aria-busy={exporting}
                className="ms-1 px-3 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-bold text-xs cursor-pointer flex items-center gap-1">
                <Download className="w-3.5 h-3.5" /> {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
            </div>
          </div>
          <div className="text-[11px] text-slate-500 font-semibold px-1 -mt-1">
            {searchResults !== null
              ? (searchLoading && searchOffset === 0 ? 'Searching the full database…' : `${searchTotal} match${searchTotal === 1 ? '' : 'es'} found`)
              : rosterCaption}
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-start border-collapse">
              <thead><tr className="border-b border-slate-100 text-slate-500 font-bold">
                <th className="py-3 px-4">Code</th><th className="py-3 px-4">Full Name</th><th className="py-3 px-4">Phone</th><th className="py-3 px-4 text-center">Status</th>{showFinanceColumn && <th className="py-3 px-4 text-center">Debt</th>}<th className="py-3 px-4 text-start">Actions</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-50 text-slate-600 font-semibold">
                {displayedStudents.map((student) => {
                  const fin = getStudentFinance(student.id);
                  const mayViewRowFinance = canViewStudentFinance(student);
                  return (
                    <tr key={student.id} className={`hover:bg-indigo-50/10 cursor-pointer ${selectedStudent?.id === student.id ? 'bg-indigo-50/25' : ''}`} onClick={() => setSelectedStudent(student)}>
                      <td className="py-3.5 px-4 font-mono font-black">{student.studentCode}</td>
                      <td className="py-3.5 px-4 font-extrabold text-slate-800">{student.fullName}</td>
                      <td className="py-3.5 px-4 font-mono">{student.phone}</td>
                      <td className="py-3.5 px-4 text-center"><span className={`px-2 py-1 rounded-full text-[10px] font-bold ${student.status === 'active' ? 'bg-emerald-50 text-emerald-700' : student.status === 'suspended' ? 'bg-amber-50 text-amber-700' : student.status === 'graduated' ? 'bg-indigo-50 text-indigo-700' : 'bg-rose-50 text-rose-700'}`}>{student.status}</span></td>
                      {showFinanceColumn && (
                        <td className="py-3.5 px-4 text-center">
                          {!mayViewRowFinance
                            ? <span className="text-slate-400 text-[10px] font-bold">Restricted</span>
                            : fin.debt <= 0
                              ? <span className="text-emerald-600 font-bold">Paid ✅</span>
                              : <span className="text-amber-700 bg-amber-50 px-2 py-1 rounded-full text-[10px] font-bold">{formatAFN(fin.debt)}</span>}
                        </td>
                      )}
                      <td className="py-3.5 px-4 text-start" onClick={(e) => e.stopPropagation()}>
                        <div className="flex gap-1.5">
                          <button onClick={() => setSelectedStudent(student)} className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-500 hover:text-indigo-600 cursor-pointer" title="View Profile"><Eye className="w-4 h-4" /></button>
                          {canCreatePayment && (
                            <button onClick={() => { setPaymentStudent(student); setPayCategory('fee'); setPayAmount(0); }} className="p-1.5 hover:bg-emerald-50 rounded-lg text-emerald-600 cursor-pointer" title="Collect Fee"><CreditCard className="w-4 h-4" /></button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {searchResults !== null && searchResults.length === 0 && !searchLoading && (
              <div className="text-center text-slate-400 text-xs font-semibold py-8">No students match your search.</div>
            )}
            {searchResults !== null && searchOffset < searchTotal && (
              <div className="flex justify-center pt-3">
                <button type="button" onClick={() => void serverSearch(searchOffset)} disabled={searchLoading}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold text-xs cursor-pointer">
                  {searchLoading ? 'Loading…' : `Load more (${searchTotal - searchOffset} remaining)`}
                </button>
              </div>
            )}
          </div>
        </div>
      ) : canCreateStudent ? (
        <AddStudentForm classes={classes} branches={branches} activeBranchId={activeBranchId} addStudentManual={addStudentManual} onCancel={() => setSubTab('list')} triggerToast={triggerToast} visitors={visitors} educationalSections={educationalSections} />
      ) : null}

      {/* CENTERED PROFILE MODAL */}
      {activeStudentInfo && (
        <div className="fixed inset-0 z-40 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-slate-50 w-full max-w-5xl h-[90vh] rounded-3xl shadow-2xl overflow-hidden flex flex-col">
            <div className="flex justify-between items-center bg-white px-6 py-4 border-b border-slate-200">
              <h3 className="font-extrabold text-slate-900 text-lg">{canViewActiveFinance ? 'Student Profile & Finance' : 'Student Profile'}</h3>
              <button onClick={() => setSelectedStudent(null)} className="p-2 bg-slate-100 hover:bg-rose-50 text-slate-500 hover:text-rose-600 rounded-xl text-xs font-bold cursor-pointer flex items-center gap-1"><X className="w-4 h-4" /> Close</button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              <StudentProfileDrawer
                key={activeStudentInfo.id} student={activeStudentInfo} serverBalance={studentBalances.find(b => b.studentId === activeStudentInfo.id)} payments={payments} attendance={attendance} attendanceSummary={attendanceSummary} exams={exams} examResults={examResults} classes={classes}
                canEditStudent={canEditStudent} canAssignClass={canAssignClass} canCreatePayment={canCreatePayment}
                canViewFinance={canViewActiveFinance} canApproveRefund={canApproveRefund}
                canSuspendStudent={canSuspendStudent} canResumeStudent={canResumeStudent} canPrintStudent={canPrintStudent}
                updateStudent={updateStudent} updateStudentStatus={updateStudentStatus}
                issueStudentCard={issueStudentCard} triggerToast={triggerToast} onClose={() => setSelectedStudent(null)}
                onOpenEnroll={() => { setEnrollSemesterName(''); setEnrollClassId(''); setEnrollTuitionAmount(0); setEnrollAmountPaidNow(0); setShowEnrollModal(true); }}
                onOpenExtraClass={() => setShowExtraClassModal(true)}
                onOpenRefund={() => { setRefundStudent(activeStudentInfo); setRefundAmount(0); setRefundReason(''); }}
                onPayInstallment={(instId, amount) => { setPaymentStudent(activeStudentInfo); setPayCategory('installment'); setPayInstallmentId(instId); setPayAmount(amount); }}
              />
            </div>
          </div>
        </div>
      )}

      {/* SMART PAYMENT MODAL */}
      {canCreatePayment && paymentStudent && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white border rounded-2xl p-5 shadow-xl w-full max-w-md text-xs space-y-4">
            <div className="flex justify-between border-b pb-2.5">
              <h3 className="font-extrabold text-slate-900 text-sm">Smart Payment Collection</h3>
              <button onClick={() => setPaymentStudent(null)} className="text-slate-400 font-bold cursor-pointer">✕</button>
            </div>
            
            <form onSubmit={handleSmartPayment} className="space-y-3 text-start">
              <div>
                <label className={text.label}>Payment Category:</label>
                <select value={payCategory} onChange={(e) => { setPayCategory(e.target.value as any); setPayAmount(0); setPayReason(''); }} className={inputCls}>
                  <option value="fee">Class Tuition Fee</option>
                  <option value="installment">Settle Installment</option>
                  <option value="book">Book Purchase</option>
                  <option value="card">Smart ID Card</option>
                  <option value="other">Other Fee</option>
                </select>
              </div>

              {/* Dynamic Fields based on Category */}
              {payCategory === 'fee' && (
                <div>
                  <label className={text.label}>Select Semester:</label>
                  <select value={paySemesterId} onChange={(e) => { setPaySemesterId(e.target.value); if (canViewPaymentFinance) { const fin = getStudentFinance(paymentStudent.id); setPayAmount(fin.debt); } else { setPayAmount(0); } }} className={inputCls} required>
                    <option value="">-- Select Semester --</option>
                    {paymentStudent.semesters?.map(sem => <option key={sem.id} value={sem.id}>{sem.semesterName}{canViewPaymentFinance ? ` (${formatAFN(sem.feeAmount ?? 0)})` : ''}</option>)}
                  </select>
                </div>
              )}

              {payCategory === 'installment' && (
                <div>
                  <label className={text.label}>Select Installment:</label>
                  <select value={payInstallmentId} onChange={(e) => { setPayInstallmentId(e.target.value); const inst = paymentStudent.installmentPlan?.find(i => i.id === e.target.value); if (inst) setPayAmount(inst.amount); }} className={inputCls} required>
                    <option value="">-- Pending Installments --</option>
                    {paymentStudent.installmentPlan?.filter(i => i.status !== 'paid').map(inst => <option key={inst.id} value={inst.id}>{inst.dueDate} - {formatAFN(inst.amount)}</option>)}
                  </select>
                </div>
              )}

              {payCategory === 'other' && (
                <div>
                  <label className={text.label}>Reason for this charge:</label>
                  <input
                    type="text"
                    value={payReason}
                    onChange={(e) => setPayReason(e.target.value)}
                    placeholder="e.g. Exam re-sit fee, replacement handout"
                    className={inputCls}
                    required
                    minLength={3}
                  />
                  {/* An ad-hoc charge has no obligation to justify it, so the
                      reason is what makes it auditable. The server enforces
                      this too — this input only avoids a round-trip. */}
                  <p className="text-[11px] text-slate-400 mt-1">Required. Appears on the receipt and in the financial ledger.</p>
                </div>
              )}

              {payCategory === 'book' && (
                <div>
                  <label className={text.label}>Select Book:</label>
                  <select value={payBookId} onChange={(e) => { setPayBookId(e.target.value); const b = books.find(b => b.id === e.target.value); if (b) setPayAmount(b.price); }} className={inputCls} required>
                    <option value="">-- Select Book --</option>
                    {books.map(b => <option key={b.id} value={b.id}>{b.title} (Stock: {b.stock}) - {formatAFN(b.price)}</option>)}
                  </select>
                </div>
              )}

              <div>
                <label className={text.label}>Payment method:</label>
                <select value={payMethod} onChange={(e) => setPayMethod(e.target.value as 'cash' | 'card' | 'bank_transfer')} className={inputCls}>
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                  <option value="bank_transfer">Bank transfer</option>
                </select>
              </div>

              {/* Obligation summary, shown BEFORE submission so the operator can
                  see what is owed rather than typing blind. Every figure is the
                  server's own balance (GET /payments/balances) — the frontend
                  does not recompute financial truth, it displays it. */}
              {canViewPaymentFinance && payCategory === 'fee' && (() => {
                const fin = getStudentFinance(paymentStudent.id);
                return (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1">
                    <div className="flex justify-between"><span className="text-slate-500">Total tuition</span><span className="font-mono font-bold">{formatAFN(fin.total)}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Already paid</span><span className="font-mono font-bold">{formatAFN(fin.paid)}</span></div>
                    <div className="flex justify-between border-t border-slate-200 pt-1">
                      <span className="text-slate-600 font-semibold">Remaining</span>
                      <span className={`font-mono font-extrabold ${fin.debt > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{formatAFN(fin.debt)}</span>
                    </div>
                    {fin.debt <= 0 && (
                      <p className="text-emerald-700 font-bold pt-1">Fully Paid — No outstanding balance.</p>
                    )}
                  </div>
                );
              })()}

              <div>
                <label className={text.label}>Amount (AFN):</label>
                <input
                  type="number"
                  value={payAmount}
                  onChange={(e) => setPayAmount(Number(e.target.value))}
                  className={`${inputCls} font-mono`}
                  min={1}
                  max={canViewPaymentFinance && payCategory === 'fee' ? getStudentFinance(paymentStudent.id).debt || undefined : undefined}
                  required
                />
                {/* UX only. The backend rejects an over-payment independently —
                    see the overpayment regression suite. */}
                {canViewPaymentFinance && payCategory === 'fee' && payAmount > getStudentFinance(paymentStudent.id).debt && (
                  <p className="text-rose-600 font-semibold mt-1">Amount exceeds the remaining balance of {formatAFN(getStudentFinance(paymentStudent.id).debt)}.</p>
                )}
              </div>

              <div className="flex gap-2 justify-end pt-3 border-t">
                <button type="button" onClick={() => setPaymentStudent(null)} className={btnSecondary}>Cancel</button>
                <button type="submit" disabled={paymentBusy || (canViewPaymentFinance && payCategory === 'fee' && getStudentFinance(paymentStudent.id).debt <= 0)} className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-semibold hover:bg-emerald-700 cursor-pointer shadow-sm text-xs disabled:opacity-50 disabled:cursor-not-allowed">{paymentBusy ? 'Recording…' : 'Confirm Payment'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EXTRA CLASS MODAL */}
      {canAssignClass && showExtraClassModal && activeStudentInfo && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white border rounded-2xl p-5 shadow-xl w-full max-w-md text-xs space-y-4">
            <h3 className="font-extrabold text-slate-900 text-sm border-b pb-2">Enroll in Extra Class</h3>
            <p className="text-slate-500">Student: {activeStudentInfo.fullName}</p>
            <select value={extraClassId} onChange={(e) => { setExtraClassId(e.target.value); const c = classes.find(c => c.id === e.target.value); setExtraClassPaidNow(c?.fee || 0); }} className={inputCls}>
              <option value="">-- Select Class --</option>
              {classes.filter(c => c.status === 'active' && c.branchId === activeStudentInfo?.branchId).map(c => <option key={c.id} value={c.id}>{c.name} ({c.level}) - Fee: {formatAFN(c.fee)}</option>)}
            </select>
            <div>
              <label className={text.label}>Pay Now (AFN):</label>
              <input type="number" value={extraClassPaidNow} onChange={(e) => setExtraClassPaidNow(Number(e.target.value))} className={`${inputCls} font-mono`} min={0} />
            </div>
            <div className="flex gap-2 justify-end pt-3 border-t">
              <button onClick={() => setShowExtraClassModal(false)} className={btnSecondary}>Cancel</button>
              <button onClick={handleExtraClassEnroll} className={btnPrimary}>Enroll Now</button>
            </div>
          </div>
        </div>
      )}

      {/* SEMESTER ENROLL MODAL */}
      {canAssignClass && showEnrollModal && activeStudentInfo && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white border rounded-2xl p-5 shadow-xl w-full max-w-md text-xs space-y-4">
            <h3 className="font-extrabold text-slate-900 text-sm border-b pb-2">New Semester Enrollment</h3>
            <form onSubmit={handleSemesterEnroll} className="space-y-3">
              <input type="text" placeholder="Semester Name (e.g. Fall 2026)" value={enrollSemesterName} onChange={(e) => setEnrollSemesterName(e.target.value)} className={inputCls} required />
              <select value={enrollClassId} onChange={(e) => { setEnrollClassId(e.target.value); const c = classes.find(c => c.id === e.target.value); if (c) { setEnrollTuitionAmount(c.fee); setEnrollAmountPaidNow(c.fee); } }} className={inputCls} required>
                <option value="">-- Select Class --</option>
                {classes.filter(c => c.status === 'active' && c.branchId === activeStudentInfo?.branchId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <div className="grid grid-cols-2 gap-3">
                <input type="number" placeholder="Total Fee" value={enrollTuitionAmount} onChange={(e) => setEnrollTuitionAmount(Number(e.target.value))} className={`${inputCls} font-mono`} required />
                <input type="number" placeholder="Paid Today" value={enrollAmountPaidNow} onChange={(e) => setEnrollAmountPaidNow(Number(e.target.value))} className={`${inputCls} font-mono`} required />
              </div>
              <div className="flex gap-2 justify-end pt-3 border-t">
                <button type="button" onClick={() => setShowEnrollModal(false)} className={btnSecondary}>Cancel</button>
                <button type="submit" className={btnPrimary}>Enroll</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* REFUND MODAL */}
      {canApproveRefund && refundStudent && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white border rounded-2xl p-5 shadow-xl w-full max-w-md text-xs space-y-4">
            <h3 className="font-extrabold text-rose-700 text-sm border-b pb-2 flex items-center gap-1"><RotateCcw className="w-4 h-4" /> Process Refund</h3>
            <form onSubmit={handleRefund} className="space-y-3">
              <div className="bg-rose-50 p-3 rounded-lg border border-rose-200 text-rose-800 text-[10px] font-bold">Warning: This deducts from the main account.</div>
              <input type="number" placeholder="Refund Amount (AFN)" value={refundAmount} onChange={(e) => setRefundAmount(Number(e.target.value))} className={`${inputCls} font-mono`} required min={1} />
              <textarea placeholder="Reason for refund" value={refundReason} onChange={(e) => setRefundReason(e.target.value)} rows={2} className={inputCls} required></textarea>
              <div className="flex gap-2 justify-end pt-3 border-t">
                <button type="button" onClick={() => setRefundStudent(null)} className={btnSecondary}>Cancel</button>
                <button type="submit" className={btnDanger}>Approve Refund</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}