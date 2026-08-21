/**
 * @license SPDX-License-Identifier: Apache-2.0
 */
import { text } from '../../design-system/styles';
import React, { useState, useMemo, useEffect } from 'react';
import { Award, Plus, Check, Sparkles, AlertCircle, Bookmark, User, UserPlus, CreditCard, ClipboardList, CalendarDays, Trash2, Edit3, X, History, CalendarCheck, Printer, Edit } from 'lucide-react';
import { Exam, ExamResult, Student, Visitor, UserRole } from '../../types';
import { isLeadClosed } from '../../config/leadLifecycle';
import { formatAFN } from '../../utils/format';
import { ShamsiDateInput } from '../common/ShamsiDateInput';
import { BRAND_NAME } from '../../config/branding';
import { BrandLogo } from '../common/BrandLogo';

interface ExamsViewProps {
  exams: Exam[];
  examResults: ExamResult[];
  students: Student[];
  visitors: Visitor[];
  activeRole: UserRole;
  isGlobalOwner: boolean;
  registerExam: (title: string, date: string, fee: number) => Promise<void>;
  editExam: (examId: string, payload: { title: string; date: string; fee: number }) => Promise<void>;
  deleteExam: (examId: string) => Promise<void>;
  enrollExamCandidate: (payload: { examId: string; studentId?: string; visitorId?: string; feePaid: boolean }) => Promise<void>;
  addExamResult: (payload: { examId: string; resultId: string; score: number; certIssued: boolean }) => Promise<void>;
  correctExamScore: (payload: { examId: string; resultId: string; score: number }) => Promise<void>;
  triggerToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

const INITIAL_SKILL_SCORES = { reading: 0, listening: 0, speaking: 0, writing: 0 };

export default function ExamsView({
  exams, examResults, students, visitors, activeRole, isGlobalOwner, registerExam, editExam, deleteExam, enrollExamCandidate, addExamResult, correctExamScore, triggerToast,
}: ExamsViewProps) {
  const [showExamForm, setShowExamForm] = useState(false);
  const [editingExam, setEditingExam] = useState<Exam | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeTab, setActiveTab] = useState<'events' | 'roster' | 'enroll' | 'score'>('events');
  const [examTimeFilter, setExamTimeFilter] = useState<'upcoming' | 'past'>('upcoming');

  const [correctingResult, setCorrectingResult] = useState<ExamResult | null>(null);
  const [correctedScore, setCorrectedScore] = useState(0);
  const [printingResult, setPrintingResult] = useState<ExamResult | null>(null);

  const [examTitle, setExamTitle] = useState('');
  const [examDate, setExamDate] = useState(new Date().toISOString().split('T')[0]);
  const [examFee, setExamFee] = useState(1200);

  const [enrollExamId, setEnrollExamId] = useState('');
  const [candidateCategory, setCandidateCategory] = useState<'student' | 'visitor'>('student');
  const [selectedCandidateId, setSelectedCandidateId] = useState('');
  const [enrollFeePaid, setEnrollFeePaid] = useState(true);

  const [scoreExamId, setScoreExamId] = useState('');
  const [selectedResultId, setSelectedResultId] = useState('');
  const [skillScores, setSkillScores] = useState(INITIAL_SKILL_SCORES);

  const studentMap = useMemo(() => new Map(students.map(s => [s.id, s])), [students]);
  const visitorMap = useMemo(() => new Map(visitors.map(v => [v.id, v])), [visitors]);
  const activeStudents = useMemo(() => students.filter(s => s.status === 'active'), [students]);
  // Mirrors the server's exam-eligibility rule: anything not closed-lost.
  // The old inline allow-list tested `status` against stage vocabulary and
  // disagreed with the backend, which refused every candidate it offered.
  const activeVisitors = useMemo(() => visitors.filter((v) => !isLeadClosed(v)), [visitors]);

  const todayStr = new Date().toISOString().split('T')[0];
  const upcomingExams = useMemo(() => exams.filter(e => e.date >= todayStr).sort((a,b) => a.date.localeCompare(b.date)), [exams, todayStr]);
  const pastExams = useMemo(() => exams.filter(e => e.date < todayStr).sort((a,b) => b.date.localeCompare(a.date)), [exams, todayStr]);
  const displayExams = examTimeFilter === 'upcoming' ? upcomingExams : pastExams;

  const enrolledForScore = useMemo(() => {
    if (!scoreExamId) return [];
    return examResults.filter(r => r.examId === scoreExamId);
  }, [examResults, scoreExamId]);

  const totalScore = useMemo(() => {
    return Number(skillScores.reading) + Number(skillScores.listening) + Number(skillScores.speaking) + Number(skillScores.writing);
  }, [skillScores]);

  const isCertEligible = totalScore >= 90;

  useEffect(() => {
    if (printingResult) {
      const handleAfterPrint = () => setPrintingResult(null);
      window.addEventListener('afterprint', handleAfterPrint);
      setTimeout(() => window.print(), 500);
      return () => window.removeEventListener('afterprint', handleAfterPrint);
    }
  }, [printingResult]);

  const handleSkillChange = (skill: keyof typeof INITIAL_SKILL_SCORES, value: string) => {
    const numValue = Math.min(30, Math.max(0, Number(value) || 0)); 
    setSkillScores(prev => ({ ...prev, [skill]: numValue }));
  };

  const openCreateForm = () => {
    setEditingExam(null);
    setExamTitle('');
    setExamDate(new Date().toISOString().split('T')[0]);
    setExamFee(1200);
    setShowExamForm(true);
  };

  const openEditForm = (exam: Exam) => {
    setEditingExam(exam);
    setExamTitle(exam.title);
    setExamDate(exam.date);
    setExamFee(exam.fee);
    setShowExamForm(true);
  };

  const handleSaveExam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!examTitle || isProcessing) return;
    setIsProcessing(true);
    try {
      if (editingExam) {
        await editExam(editingExam.id, { title: examTitle, date: examDate, fee: examFee });
        triggerToast('Exam event updated successfully.', 'success');
      } else {
        await registerExam(examTitle, examDate, examFee);
        triggerToast('Exam event created successfully.', 'success');
      }
      setShowExamForm(false);
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Failed to save exam event.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDeleteExam = async (examId: string) => {
    if (!window.confirm('Are you sure? Un-scored enrollments will be lost.')) return;
    try {
      await deleteExam(examId);
      triggerToast('Exam event deleted.', 'success');
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Failed to delete exam.', 'error');
    }
  };

  const handleEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCandidateId || !enrollExamId || isProcessing) return;
    setIsProcessing(true);
    try {
      const payload = candidateCategory === 'student' 
        ? { examId: enrollExamId, studentId: selectedCandidateId, feePaid: enrollFeePaid }
        : { examId: enrollExamId, visitorId: selectedCandidateId, feePaid: enrollFeePaid };
      await enrollExamCandidate(payload);
      triggerToast('Candidate enrolled successfully.', 'success');
      setSelectedCandidateId('');
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Failed to enroll candidate.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAddResult = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedResultId || !scoreExamId || isProcessing) return;
    setIsProcessing(true);
    try {
      await addExamResult({ examId: scoreExamId, resultId: selectedResultId, score: totalScore, certIssued: isCertEligible });
      triggerToast('Exam scores saved successfully.', 'success');
      setSelectedResultId('');
      setSkillScores(INITIAL_SKILL_SCORES);
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Failed to save scores.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const openCorrectModal = (result: ExamResult) => {
    setCorrectingResult(result);
    setCorrectedScore(result.score);
  };

  const handleCorrectScore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!correctingResult || isProcessing) return;
    setIsProcessing(true);
    try {
      await correctExamScore({ examId: correctingResult.examId, resultId: correctingResult.id, score: correctedScore });
      triggerToast('Score corrected successfully.', 'success');
      setCorrectingResult(null);
    } catch (err) {
      triggerToast(err instanceof Error ? err.message : 'Failed to correct score.', 'error');
    } finally {
      setIsProcessing(false);
    }
  };

  const canManage = activeRole === 'receptionist' || isGlobalOwner || activeRole === 'general_manager';
  const canCorrect = isGlobalOwner || activeRole === 'general_manager';
  const sortedResults = useMemo(() => [...examResults].reverse(), [examResults]);

  return (
    <div className="space-y-6 font-sans text-start" id="exams-view-root">
      
      {/* ========================================================================
          ENTERPRISE CERTIFICATE PRINT LAYOUT (World-Class Design)
          ======================================================================== */}
      {printingResult && (
        <div id="print-certificate" className="hidden print:block fixed inset-0 z-50 bg-white overflow-hidden">
          
          {/* Main Certificate Inner Container */}
          <div className="cert-inner relative w-full h-full bg-white p-8 flex flex-col overflow-hidden">
            
            {/* Outer Border (Brand Color) */}
            <div className="absolute inset-4 border-12 border-[#4c0519] rounded-lg pointer-events-none"></div>
            {/* Inner Gold Border */}
            <div className="absolute inset-6 border-2 border-rose-500/70 rounded-md pointer-events-none"></div>
            
            {/* Corner Ornaments */}
            <div className="absolute top-8 start-8 w-12 h-12 border-t-4 border-l-4 border-rose-600/80 pointer-events-none"></div>
            <div className="absolute top-8 end-8 w-12 h-12 border-t-4 border-r-4 border-rose-600/80 pointer-events-none"></div>
            <div className="absolute bottom-8 start-8 w-12 h-12 border-b-4 border-l-4 border-rose-600/80 pointer-events-none"></div>
            <div className="absolute bottom-8 end-8 w-12 h-12 border-b-4 border-r-4 border-rose-600/80 pointer-events-none"></div>
            
            {/* Content Wrapper */}
            <div className="relative z-10 flex flex-col items-center justify-between h-full py-10 px-16 text-center">
              
              {/* Header */}
              <header className="flex flex-col items-center">
                <div className="bg-white rounded-2xl flex items-center justify-center shadow-lg ring-4 ring-rose-500/30 mb-3 px-4 py-3">
                  <BrandLogo height={52} />
                </div>
                <h1 className="text-4xl font-serif font-extrabold text-[#4c0519] tracking-wide leading-none">
                  {BRAND_NAME}
                </h1>
                <div className="w-32 h-0.5 bg-rose-600 mt-3 mb-2"></div>
                <p className="text-xs font-serif font-bold text-slate-500 uppercase tracking-[0.4em]">
                  Official Certificate of Achievement
                </p>
              </header>

              {/* Body */}
              <main className="flex flex-col items-center gap-3">
                <p className="text-lg font-serif text-slate-600 italic">This is to proudly certify that</p>
                
                <p className="text-5xl font-serif font-extrabold text-[#4c0519] tracking-wide border-b-2 border-rose-600/60 pb-2 px-10 leading-tight">
                  {printingResult.candidateName}
                </p>
                
                <p className="text-base font-serif text-slate-600 mt-2">has successfully completed and passed the</p>
                
                <p className="text-2xl font-serif font-bold text-slate-800 uppercase tracking-wider">
                  {exams.find(e => e.id === printingResult.examId)?.title ?? ''}
                </p>
                
                <div className="mt-3 px-6 py-1.5 bg-rose-50 border border-rose-200 rounded-full">
                  <p className="text-lg font-serif text-[#4c0519]">
                    Obtaining a Total Score of <span className="font-extrabold text-rose-700">{printingResult.score} / 120</span>
                  </p>
                </div>
              </main>

              {/* Footer */}
              <footer className="w-full flex justify-between items-end px-8 mt-4">
                {/* Date */}
                <div className="text-start">
                  <div className="w-40 border-b border-slate-400 mb-1"></div>
                  <p className="text-[10px] font-serif text-slate-500 uppercase tracking-wider">Date of Issue</p>
                  <p className="text-sm font-serif font-bold text-slate-700">
                    {exams.find(e => e.id === printingResult.examId)?.date || 'N/A'}
                  </p>
                </div>
                
                {/* Official Seal */}
                <div className="flex flex-col items-center">
                  <div className="w-24 h-24 rounded-full border-[3px] border-rose-600/50 border-dashed flex items-center justify-center text-[#4c0519] opacity-80 transform -rotate-12">
                    <div className="text-center">
                      <Award className="w-8 h-8 mx-auto mb-1" />
                      <p className="text-[8px] font-bold uppercase tracking-widest">Approved</p>
                    </div>
                  </div>
                </div>

                {/* Certificate Number */}
                <div className="text-end">
                  <div className="w-40 border-b border-slate-400 mb-1 ms-auto"></div>
                  <p className="text-[10px] font-serif text-slate-500 uppercase tracking-wider">Certificate No</p>
                  <p className="text-sm font-serif font-bold text-slate-700">
                    {printingResult.certificateNo || 'N/A'}
                  </p>
                </div>
              </footer>
            </div>
          </div>
        </div>
      )}
      <div className="flex flex-col sm:flex-row items-center justify-between border-b border-slate-200 pb-4 gap-4 no-print">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900">Standardized Exams & Certificates</h2>
          <p className={text.hint}>Manage exam events, enroll candidates, collect fees, and enter 4-skill scores</p>
        </div>
        {canManage && (
          <button onClick={openCreateForm} className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs px-4 py-2.5 rounded-xl cursor-pointer shadow-sm transition-all">
            <Plus className="w-4 h-4" /> Define New Exam
          </button>
        )}
      </div>

      {showExamForm && (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm max-w-xl mx-auto animate-in fade-in duration-200 no-print">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-sm font-bold text-slate-900">{editingExam ? 'Edit Exam Event' : 'Define New Exam Event'}</h3>
            <button onClick={() => setShowExamForm(false)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
          </div>
          <form onSubmit={handleSaveExam} className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <div className="sm:col-span-2">
              <label className={text.label}>Exam title:</label>
              <input type="text" placeholder="e.g. TOEFL Simulation July - 2026" value={examTitle} onChange={(e) => setExamTitle(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500/30 focus:outline-none" required disabled={isProcessing} />
            </div>
            <div>
              <ShamsiDateInput label="Exam date" value={examDate} onChange={setExamDate} disabled={isProcessing} />
            </div>
            <div>
              <label className={text.label}>Registration fee (AFN):</label>
              <input type="number" value={examFee} onChange={(e) => setExamFee(Number(e.target.value))} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono focus:ring-2 focus:ring-indigo-500/30 focus:outline-none" min={0} disabled={isProcessing} />
            </div>
            <div className="sm:col-span-3 flex gap-2 justify-end pt-2 border-t border-slate-100">
              <button type="button" onClick={() => setShowExamForm(false)} className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg font-semibold hover:bg-slate-200 cursor-pointer" disabled={isProcessing}>Cancel</button>
              <button type="submit" disabled={isProcessing} className="px-4 py-2 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 cursor-pointer shadow-sm disabled:opacity-50 flex items-center gap-1.5">
                {isProcessing ? <><div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> Saving...</> : (editingExam ? 'Update Exam' : 'Define Exam')}
              </button>
            </div>
          </form>
        </div>
      )}

      {correctingResult && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4 no-print">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5"><Edit className="w-4 h-4 text-amber-600" /> Correct Score</h3>
              <button onClick={() => setCorrectingResult(null)} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-xs text-slate-600 mb-4">You are correcting the score for <strong>{correctingResult.candidateName}</strong>. If the new score is below 90, any issued certificate will be automatically revoked.</p>
            <form onSubmit={handleCorrectScore} className="space-y-4">
              <input type="number" value={correctedScore} onChange={(e) => setCorrectedScore(Number(e.target.value))} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 font-mono focus:ring-2 focus:ring-amber-500/30 focus:outline-none" min={0} max={120} required disabled={isProcessing} />
              <div className="flex gap-2 justify-end pt-2 border-t border-slate-100">
                <button type="button" onClick={() => setCorrectingResult(null)} className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg font-semibold hover:bg-slate-200 cursor-pointer" disabled={isProcessing}>Cancel</button>
                <button type="submit" disabled={isProcessing} className="px-4 py-2 bg-amber-600 text-white rounded-lg font-semibold hover:bg-amber-700 cursor-pointer shadow-sm disabled:opacity-50 flex items-center gap-1.5">
                  {isProcessing ? <><div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> Saving...</> : 'Confirm Correction'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 no-print">
        <div className="lg:col-span-8 bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-4">
          <div className="flex flex-wrap gap-2 justify-between items-center">
            <div className="flex gap-2 bg-slate-100 p-1 rounded-lg w-fit">
              <button onClick={() => setActiveTab('events')} className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md font-semibold transition-colors text-xs ${activeTab === 'events' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}>
                <CalendarDays className="w-3.5 h-3.5" /> Events
              </button>
              <button onClick={() => setActiveTab('roster')} className={`flex items-center gap-1.5 px-4 py-1.5 rounded-md font-semibold transition-colors text-xs ${activeTab === 'roster' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}>
                <Bookmark className="w-3.5 h-3.5" /> Roster & Results
              </button>
            </div>

            {activeTab === 'events' && (
              <div className="flex gap-1 bg-slate-50 border border-slate-200 p-1 rounded-lg text-xs">
                <button onClick={() => setExamTimeFilter('upcoming')} className={`flex items-center gap-1 px-3 py-1 rounded-md font-semibold transition-colors ${examTimeFilter === 'upcoming' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
                  <CalendarCheck className="w-3 h-3" /> Upcoming
                </button>
                <button onClick={() => setExamTimeFilter('past')} className={`flex items-center gap-1 px-3 py-1 rounded-md font-semibold transition-colors ${examTimeFilter === 'past' ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
                  <History className="w-3 h-3" /> Past
                </button>
              </div>
            )}
          </div>

          {activeTab === 'events' ? (
            <div className="overflow-x-auto text-xs">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="border-b border-slate-100 text-slate-500">
                    <th className="py-2.5 px-3 font-bold text-slate-700">Title</th>
                    <th className="py-2.5 px-3 font-bold text-slate-700">Date</th>
                    <th className="py-2.5 px-3 font-bold text-slate-700 text-center">Fee</th>
                    <th className="py-2.5 px-3 font-bold text-slate-700 text-center">Enrolled</th>
                    {canManage && <th className="py-2.5 px-3 font-bold text-slate-700 text-end">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 text-slate-600">
                  {displayExams.length === 0 ? (
                    <tr><td colSpan={5} className="text-center py-8 text-slate-400">No {examTimeFilter} exams.</td></tr>
                  ) : (
                    displayExams.map((exam) => (
                      <tr key={exam.id} className="hover:bg-slate-50/40 transition-colors">
                        <td className="py-3 px-3 font-semibold text-slate-800">{exam.title}</td>
                        <td className="py-3 px-3 font-mono">{exam.date}</td>
                        <td className="py-3 px-3 text-center font-mono">{formatAFN(exam.fee)}</td>
                        <td className="py-3 px-3 text-center">
                          <span className="inline-flex items-center justify-center bg-indigo-50 text-indigo-700 font-bold w-8 h-8 rounded-full">
                            {(exam as any).enrolledCount || 0}
                          </span>
                        </td>
                        {canManage && (
                          <td className="py-3 px-3 text-end">
                            <button onClick={() => openEditForm(exam)} className="p-1.5 text-slate-500 hover:bg-slate-100 hover:text-indigo-600 rounded-md me-1 cursor-pointer"><Edit3 className="w-3.5 h-3.5" /></button>
                            <button onClick={() => handleDeleteExam(exam.id)} className="p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600 rounded-md cursor-pointer"><Trash2 className="w-3.5 h-3.5" /></button>
                          </td>
                        )}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="overflow-x-auto text-xs">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="border-b border-slate-100 text-slate-500">
                    <th className="py-2.5 px-3 font-bold text-slate-700">Candidate</th>
                    <th className="py-2.5 px-3 font-bold text-slate-700">Exam Date</th>
                    <th className="py-2.5 px-3 font-bold text-slate-700 text-center">Total Score</th>
                    <th className="py-2.5 px-3 font-bold text-slate-700 text-center">Fee Status</th>
                    <th className="py-2.5 px-3 font-bold text-slate-700 text-end">Certificate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 text-slate-600">
                  {sortedResults.length === 0 ? (
                    <tr><td colSpan={5} className="text-center py-8 text-slate-400">No candidates enrolled yet.</td></tr>
                  ) : (
                    sortedResults.map((result) => {
                      const student = result.studentId ? studentMap.get(result.studentId) : null;
                      const visitor = result.visitorId ? visitorMap.get(result.visitorId) : null;
                      const exam = exams.find(e => e.id === result.examId);
                      const hasCertificate = Boolean(result.certificateIssued);
                      const candidateName = student ? student.fullName : (visitor ? visitor.fullName : (result.candidateName || 'Unknown Candidate'));

                      return (
                        <tr key={result.id} className="hover:bg-slate-50/40 transition-colors">
                          <td className="py-3 px-3">
                            <p className="font-semibold text-slate-800 flex items-center gap-1.5">
                              {!student && !visitor && <UserPlus className="w-3 h-3 text-amber-500" />}
                              {candidateName}
                            </p>
                            <p className="text-[10px] text-slate-400 font-mono mt-0.5">{exam ? exam.title : 'Unknown Exam'}</p>
                          </td>
                          <td className="py-3 px-3 font-mono text-slate-500">{exam ? exam.date : 'N/A'}</td>
                          <td className="py-3 px-3 text-center">
                            {result.score > 0 ? (
                              <span className={`inline-flex font-mono font-bold px-2 py-0.5 rounded ${result.status === 'pass' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                                {result.score} / 120
                              </span>
                            ) : (
                              <span className="text-[10px] text-slate-400 italic">Pending Score</span>
                            )}
                          </td>
                          <td className="py-3 px-3 text-center">
                            <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-bold ${result.examFeePaid ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                              {result.examFeePaid ? 'Paid' : 'Outstanding'}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-end">
                            {hasCertificate ? (
                              <div className="flex items-center justify-end gap-2">
                                <div className="inline-flex items-center gap-1 text-[10px] bg-amber-50 text-amber-800 font-mono px-2 py-1 rounded border border-amber-200/60 font-semibold shadow-inner">
                                  <Sparkles className="w-3 h-3 text-amber-500 shrink-0" />
                                  <span>{result.certificateNo || 'Issued'}</span>
                                </div>
                                <button onClick={() => setPrintingResult(result)} className="p-1.5 text-slate-500 hover:bg-indigo-50 hover:text-indigo-600 rounded-md cursor-pointer" title="Print Certificate">
                                  <Printer className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : (
                              <span className="text-[10px] text-slate-400 italic">No certificate</span>
                            )}
                            {canCorrect && result.score > 0 && (
                              <button onClick={() => openCorrectModal(result)} className="p-1.5 text-slate-500 hover:bg-amber-50 hover:text-amber-600 rounded-md ms-2 cursor-pointer" title="Correct Score">
                                <Edit className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {canManage && (
          <div className="lg:col-span-4 bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-4 h-fit no-print">
            <div className="flex gap-2 bg-slate-100 p-1 rounded-lg">
              <button onClick={() => setActiveTab('enroll')} className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md font-semibold transition-colors text-xs ${activeTab === 'enroll' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}>
                <CreditCard className="w-3.5 h-3.5" /> Enroll & Pay
              </button>
              <button onClick={() => setActiveTab('score')} className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md font-semibold transition-colors text-xs ${activeTab === 'score' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}>
                <ClipboardList className="w-3.5 h-3.5" /> Enter Scores
              </button>
            </div>

            {activeTab === 'enroll' ? (
              <form onSubmit={handleEnroll} className="space-y-4 text-xs">
                <div className="space-y-1">
                  <label className="block text-slate-600 font-medium">Select upcoming exam:</label>
                  <select value={enrollExamId} onChange={(e) => setEnrollExamId(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer focus:ring-2 focus:ring-indigo-500/30 focus:outline-none" required disabled={isProcessing}>
                    <option value="" disabled>Select an exam...</option>
                    {upcomingExams.map(e => <option key={e.id} value={e.id}>{e.title} (Fee: {formatAFN(e.fee)})</option>)}
                  </select>
                  {upcomingExams.length === 0 && <p className="text-[10px] text-rose-500 mt-1">No upcoming exams. Create a new event first.</p>}
                </div>

                <div className="flex gap-2 bg-slate-50 p-1 rounded-lg border border-slate-200">
                  <button type="button" onClick={() => setCandidateCategory('student')} className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md font-semibold transition-colors ${candidateCategory === 'student' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}>
                    <User className="w-3.5 h-3.5" /> Student
                  </button>
                  <button type="button" onClick={() => setCandidateCategory('visitor')} className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md font-semibold transition-colors ${candidateCategory === 'visitor' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'}`}>
                    <UserPlus className="w-3.5 h-3.5" /> Visitor
                  </button>
                </div>

                <div className="space-y-1">
                  <label className="block text-slate-600 font-medium">Select {candidateCategory}:</label>
                  <select value={selectedCandidateId} onChange={(e) => setSelectedCandidateId(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer focus:ring-2 focus:ring-indigo-500/30 focus:outline-none" required disabled={isProcessing}>
                    <option value="" disabled>Select a candidate...</option>
                    {candidateCategory === 'student' 
                      ? activeStudents.map(s => <option key={s.id} value={s.id}>{s.fullName} ({s.studentCode})</option>)
                      : activeVisitors.map(v => <option key={v.id} value={v.id}>{v.fullName} ({v.phone || 'No Phone'})</option>)
                    }
                  </select>
                </div>

                <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-700 pt-1">
                  <input type="checkbox" checked={enrollFeePaid} onChange={(e) => setEnrollFeePaid(e.target.checked)} className="rounded text-indigo-600 focus:ring-indigo-500 w-4 h-4" disabled={isProcessing} />
                  <span>Exam fee paid (direct to cash)</span>
                </label>

                <button type="submit" disabled={isProcessing} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg transition-colors cursor-pointer shadow-sm text-center flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
                  {isProcessing ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> Processing...</> : <><Check className="w-4 h-4" /> Enroll Candidate</>}
                </button>
              </form>
            ) : (
              <form onSubmit={handleAddResult} className="space-y-4 text-xs">
                <div className="space-y-1">
                  <label className="block text-slate-600 font-medium">Select exam event:</label>
                  <select value={scoreExamId} onChange={(e) => { setScoreExamId(e.target.value); setSelectedResultId(''); }} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer focus:ring-2 focus:ring-indigo-500/30 focus:outline-none" required disabled={isProcessing}>
                    <option value="" disabled>Select an exam...</option>
                    {exams.map(e => (
                      <option key={e.id} value={e.id} disabled={e.date > todayStr}>
                        {e.title} {e.date > todayStr ? '(Locked - Upcoming)' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="block text-slate-600 font-medium">Select enrolled candidate:</label>
                  <select value={selectedResultId} onChange={(e) => setSelectedResultId(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 cursor-pointer focus:ring-2 focus:ring-indigo-500/30 focus:outline-none" required disabled={isProcessing || !scoreExamId}>
                    <option value="" disabled>Select a candidate...</option>
                    {enrolledForScore.map(r => {
                      const student = r.studentId ? studentMap.get(r.studentId) : null;
                      const visitor = r.visitorId ? visitorMap.get(r.visitorId) : null;
                      const name = student ? student.fullName : (visitor ? visitor.fullName : (r.candidateName || 'Unknown'));
                      return <option key={r.id} value={r.id} disabled={r.score > 0}>{name} {r.score > 0 ? '(Scored)' : ''}</option>;
                    })}
                  </select>
                  {scoreExamId && enrolledForScore.length === 0 && <p className="text-[10px] text-rose-500 mt-1">No candidates enrolled in this exam yet.</p>}
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  {(['reading', 'listening', 'speaking', 'writing'] as const).map((skill) => (
                    <div key={skill}>
                      <label className="block text-slate-600 font-medium capitalize mb-1">{skill} (0-30):</label>
                      <input type="number" value={skillScores[skill]} onChange={(e) => handleSkillChange(skill, e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono focus:ring-2 focus:ring-indigo-500/30 focus:outline-none" min={0} max={30} required disabled={isProcessing || !selectedResultId} />
                    </div>
                  ))}
                </div>

                <div className="flex justify-between items-center bg-slate-800 text-white rounded-lg px-4 py-2.5">
                  <span className="font-bold text-xs">Total Score:</span>
                  <span className="font-mono font-extrabold text-lg">{totalScore} <span className="text-slate-400 text-xs">/ 120</span></span>
                </div>

                {isCertEligible ? (
                  <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-3 rounded-lg text-[10px] flex gap-1.5 leading-relaxed">
                    <Check className="w-4 h-4 shrink-0" />
                    <span>Score is 90 or above. A graduation certificate will be automatically issued.</span>
                  </div>
                ) : (
                  <div className="bg-amber-50 border border-amber-200 text-amber-800 p-3 rounded-lg text-[10px] flex gap-1.5 leading-relaxed">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>Per {BRAND_NAME} policy, certificates are issued only for scores 90 and above.</span>
                  </div>
                )}

                <button type="submit" disabled={isProcessing || !selectedResultId} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg transition-colors cursor-pointer shadow-sm text-center flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
                  {isProcessing ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> Saving Scores...</> : <><Award className="w-4 h-4" /> Save Final Scores</>}
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
}