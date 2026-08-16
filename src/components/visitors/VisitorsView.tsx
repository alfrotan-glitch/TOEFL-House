/**
 * @license SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo , useCallback} from 'react';
import {UserPlus, Search, Sparkles, UserCheck, MessageSquare, Megaphone, Share2, Compass, AlertCircle, CheckCircle2, Clock, Kanban, List, Award} from 'lucide-react';
import {Visitor, Class, Branch, Teacher} from '../../types'; // Added Teacher
import AddVisitorForm from './AddVisitorForm';
import VisitorDeskPanel from './VisitorDeskPanel';
import PlacementTestModal from './PlacementTestModal';
import ConvertToStudentModal from './ConvertToStudentModal';
import Toast from '../common/Toast';
import {useAcademicOptions} from '../../hooks/useAcademicOptions';

interface VisitorsViewProps {
  visitors: Visitor[];
  classes: Class[];
  branches: Branch[];
  teachers: Teacher[]; // Added teachers prop
  activeBranchId: string;
  addVisitor: (
    fullName: string, phone: string, gender: 'male' | 'female', source: Visitor['source'], 
    notes?: string, interestedCourse?: string,
    followUpStatus?: 'high_interest' | 'medium_interest' | 'low_interest' | 'not_answering' | 'no_interest',
    nextContactDate?: string, fatherName?: string, addressRegion?: string, tazkiraNo?: string, whatsapp?: string,
    dob?: string, schoolOrUniversity?: string, emergencyContactName?: string, emergencyContactPhone?: string,
    branchId?: string, email?: string, programVersionId?: string
  ) => Promise<{ id: string; serialNo: string } | void>;
  updateVisitorCRM: (
    visitorId: string, interestedCourse: string, 
    followUpStatus: 'high_interest' | 'medium_interest' | 'low_interest' | 'not_answering' | 'no_interest', 
    nextContactDate: string, notes?: string
  ) => Promise<void>;
  addVisitorFollowUp: (visitorId: string, notes: string, outcome?: string) => Promise<void>;
  updateVisitor: (visitorId: string, updatedFields: Partial<Visitor>) => Promise<void>;
  reloadVisitors: () => Promise<void>;
  advanceVisitorStage: (visitorId: string, stage?: Visitor['stage']) => Promise<void>;
  registerVisitorToStudent: (
    visitorId: string, classId: string, amountPaid: number, discountPercent: number, notes?: string,
    semesterFee?: number, branchId?: string, paymentMethod?: 'cash' | 'card' | 'bank_transfer'
  ) => Promise<{ studentId: string; studentCode: string; receiptNumber: string; invoiceId: string; invoiceNumber: string; netAmount: number; status: string }>;
  programVersions?: Array<{ id: string; name: string; versionLabel: string; status: string }>;
}

export default function VisitorsView({
  visitors, classes, branches, activeBranchId, addVisitor, updateVisitorCRM, addVisitorFollowUp,
  updateVisitor, reloadVisitors, advanceVisitorStage, registerVisitorToStudent, programVersions = []
}: VisitorsViewProps) {
  const { courseOptions } = useAcademicOptions(classes, activeBranchId);

  const [showAddForm, setShowAddForm] = useState<boolean>(false);
  const [selectedVisitorId, setSelectedVisitorId] = useState<string | null>(null);
  const [showPlacementModal, setShowPlacementModal] = useState<boolean>(false);
  const [crmViewMode, setCrmViewMode] = useState<'list' | 'kanban'>('kanban');
  const [convertingVisitor, setConvertingVisitor] = useState<Visitor | null>(null);

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const triggerToast = (message: string, type: 'success' | 'error' | 'info') => setToast({ message, type });

  const [searchTerm, setSearchTerm] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [interestFilter, setInterestFilter] = useState<string>('all');

  const todayIso = new Date().toISOString().split('T')[0];

  const leadPipelineStatus = useCallback((v: Visitor): string => v.status || (v.stage === 'registration' || v.stage === 'enrollment' ? 'registered' : 'visited'), []);
  const isPendingLead = useCallback((v: Visitor) => ['visited', 'follow_up', 'lead'].includes(leadPipelineStatus(v)), [leadPipelineStatus]);
  const isConvertedLead = useCallback((v: Visitor) => leadPipelineStatus(v) === 'registered', [leadPipelineStatus]);
  const isOverdueContact = useCallback((v: Visitor) => v.nextContactDate && !isConvertedLead(v) && v.nextContactDate < todayIso, [isConvertedLead, todayIso]);

  const stats = useMemo(() => {
    const pendingCount = visitors.filter(isPendingLead).length;
    const convertedCount = visitors.filter(isConvertedLead).length;
    const overdueCount = visitors.filter(isOverdueContact).length;
    const conversionRate = visitors.length > 0 ? Math.round((convertedCount / visitors.length) * 100) : 0;
    return { pendingCount, convertedCount, overdueCount, conversionRate };
  }, [visitors, isPendingLead, isConvertedLead, isOverdueContact]);

  const filteredVisitors = useMemo(() => {
    return visitors.filter(v => {
      const matchesSearch = v.fullName.toLowerCase().includes(searchTerm.toLowerCase()) || v.phone.includes(searchTerm) || (v.notes && v.notes.toLowerCase().includes(searchTerm.toLowerCase()));
      const matchesStatus = statusFilter === 'all' || leadPipelineStatus(v) === statusFilter;
      const matchesSource = sourceFilter === 'all' || v.source === sourceFilter;
      const matchesInterest = interestFilter === 'all' || v.followUpStatus === interestFilter;
      return matchesSearch && matchesStatus && matchesSource && matchesInterest;
    });
  }, [visitors, searchTerm, statusFilter, sourceFilter, interestFilter, leadPipelineStatus]);

  const activeVisitor = visitors.find(v => v.id === selectedVisitorId) || null;


  const SOURCE_BADGES: Record<string, { class: string; icon: React.ReactNode; label: string }> = {
    ads: { class: 'bg-sky-50 text-sky-700 border-sky-100', icon: <Megaphone className="w-3 h-3" />, label: 'Facebook ads' },
    friend: { class: 'bg-emerald-50 text-emerald-700 border-emerald-100', icon: <Share2 className="w-3 h-3" />, label: 'Referral' },
    social: { class: 'bg-indigo-50 text-indigo-700 border-indigo-100', icon: <Compass className="w-3 h-3" />, label: 'Social media' },
    other: { class: 'bg-slate-50 text-slate-700 border-slate-100', icon: <MessageSquare className="w-3 h-3" />, label: 'Other' },
  };

  const INTEREST_BADGES: Record<string, string> = {
    high_interest: 'bg-amber-100 text-amber-800 border-amber-200',
    medium_interest: 'bg-indigo-50 text-indigo-700 border-indigo-100',
    low_interest: 'bg-slate-100 text-slate-600 border-slate-200',
    not_answering: 'bg-rose-50 text-rose-700 border-rose-200',
    no_interest: 'bg-rose-100 text-rose-800 border-rose-200',
  };

  return (
    <div className="space-y-6 font-sans text-left" dir="ltr" id="visitors-view-root">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-center justify-between border-b border-slate-200 pb-4 gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2"><UserPlus className="w-6 h-6 text-indigo-600 stroke-[2.5]" /> CRM & lead pipeline</h2>
          <p className="text-xs text-slate-500 mt-1">Capture, nurture, place, and enroll — live data only</p>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="bg-slate-100 p-1 rounded-xl flex gap-1 border border-slate-200/60">
            <button onClick={() => setCrmViewMode('list')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${crmViewMode === 'list' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-500'}`}><List className="w-3.5 h-3.5" /> Table</button>
            <button onClick={() => setCrmViewMode('kanban')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${crmViewMode === 'kanban' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-500'}`}><Kanban className="w-3.5 h-3.5" /> Kanban</button>
          </div>
          <button onClick={() => setShowAddForm(!showAddForm)} className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs px-4 py-2.5 rounded-xl cursor-pointer shadow-md transition-all hover:-translate-y-0.5">
            <UserPlus className="w-4 h-4 stroke-[2.5]" /> New visitor
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm"><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Total leads</p><p className="mt-0.5 font-mono text-lg font-black text-slate-900">{visitors.length}</p></div>
        <div className="rounded-2xl border border-amber-100 bg-amber-50/50 p-3.5 shadow-sm"><p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700/70">In pipeline</p><p className="mt-0.5 font-mono text-lg font-black text-amber-900">{stats.pendingCount}</p></div>
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50/50 p-3.5 shadow-sm"><p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700/70">Enrolled</p><p className="mt-0.5 font-mono text-lg font-black text-emerald-900">{stats.convertedCount}</p></div>
        <div className="rounded-2xl border border-indigo-100 bg-indigo-50/40 p-3.5 shadow-sm"><p className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700/70">Conversion</p><p className="mt-0.5 font-mono text-lg font-black text-indigo-900">{stats.conversionRate}%</p></div>
        <div className={`rounded-2xl border p-3.5 shadow-sm ${stats.overdueCount > 0 ? 'border-rose-200 bg-rose-50/60' : 'border-slate-200 bg-white'}`}><p className={`text-[10px] font-semibold uppercase tracking-wide ${stats.overdueCount > 0 ? 'text-rose-700/80' : 'text-slate-400'}`}>Overdue</p><p className={`mt-0.5 font-mono text-lg font-black ${stats.overdueCount > 0 ? 'text-rose-800' : 'text-slate-900'}`}>{stats.overdueCount}</p></div>
      </div>

      {stats.overdueCount > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/80 px-3 py-2.5 text-xs text-rose-950">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
          <div><p className="font-bold">{stats.overdueCount} lead(s) past next-contact date</p><p className="text-[10px] text-rose-800/80">Open the desk panel and log a follow-up or update the contact date.</p></div>
        </div>
      )}

      {/* Marketing Funnel Dashboard */}
      {visitors.length > 0 && (
        <div className="bg-white border border-slate-200/80 rounded-3xl p-6 shadow-xs space-y-6">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3 flex-wrap gap-2">
            <h3 className="text-sm font-black text-slate-900 flex items-center gap-2"><Sparkles className="w-5 h-5 text-indigo-600 stroke-[2.5] animate-pulse" /> Branch conversion dashboard</h3>
            <div className="flex gap-4 text-xs font-bold">
              <span className="text-slate-500">Total: <span className="text-slate-900 font-mono">{visitors.length}</span></span>
              <span className="text-amber-600">Follow-up: <span className="font-mono">{stats.pendingCount}</span></span>
              <span className="text-emerald-600 font-extrabold">Enrolled: <span className="font-mono">{stats.convertedCount}</span></span>
              <span className="text-indigo-600 font-black">Rate: <span className="font-mono">{stats.conversionRate}%</span></span>
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            <div className="lg:col-span-8 space-y-3">
              <div className="w-full bg-slate-50 rounded-2xl h-10 flex items-center justify-between px-4 overflow-hidden border border-slate-150 relative">
                <div className="absolute inset-y-0 right-0 bg-indigo-600/5 w-full rounded-r-2xl" />
                <span className="font-extrabold text-slate-800 text-xs z-10 flex items-center gap-2"><span className="w-5 h-5 rounded-lg bg-indigo-600 text-white flex items-center justify-center text-[10px] font-bold">1</span> Inbound leads</span>
                <span className="font-mono font-black text-slate-900 text-sm z-10">{visitors.length} (100%)</span>
              </div>
              <div className="w-full bg-slate-50 rounded-2xl h-10 flex items-center justify-between px-4 overflow-hidden border border-slate-150 relative">
                <div className="absolute inset-y-0 right-0 bg-amber-500/5 rounded-r-2xl border-l border-amber-300/30" style={{ width: `${visitors.length > 0 ? (stats.pendingCount / visitors.length) * 100 : 0}%` }} />
                <span className="font-extrabold text-slate-800 text-xs z-10 flex items-center gap-2"><span className="w-5 h-5 rounded-lg bg-amber-500 text-white flex items-center justify-center text-[10px] font-bold">2</span> Active nurturing</span>
                <span className="font-mono font-black text-amber-700 text-sm z-10">{stats.pendingCount} ({visitors.length > 0 ? Math.round((stats.pendingCount / visitors.length) * 100) : 0}%)</span>
              </div>
              <div className="w-full bg-slate-50 rounded-2xl h-10 flex items-center justify-between px-4 overflow-hidden border border-slate-150 relative">
                <div className="absolute inset-y-0 right-0 bg-emerald-500/5 rounded-r-2xl border-l border-emerald-300/30" style={{ width: `${stats.conversionRate}%` }} />
                <span className="font-extrabold text-slate-800 text-xs z-10 flex items-center gap-2"><span className="w-5 h-5 rounded-lg bg-emerald-500 text-white flex items-center justify-center text-[10px] font-bold">3</span> Converted students</span>
                <span className="font-mono font-black text-emerald-700 text-sm z-10">{stats.convertedCount} ({stats.conversionRate}%)</span>
              </div>
            </div>
            <div className="lg:col-span-4 bg-slate-50/50 border border-slate-200/60 rounded-2xl p-4 space-y-3">
              <h4 className="text-[11px] font-extrabold text-slate-400 uppercase tracking-wider">Channel performance:</h4>
              <div className="space-y-2 text-xs">
                {Object.entries(SOURCE_BADGES).map(([key, val]) => (
                  <div key={key} className="flex justify-between items-center bg-white p-2.5 rounded-xl border border-slate-100">
                    <span className="flex items-center gap-1.5 font-bold text-slate-700">{val.icon} {val.label}</span>
                    <span className="font-mono font-black text-slate-900">{visitors.filter(v => v.source === key).length}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Visitor Form Modal */}
      {showAddForm && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto animate-in fade-in duration-200" id="add-visitor-form-modal">
          <div className="w-full max-w-2xl my-auto">
            <AddVisitorForm programVersions={programVersions} activeBranchId={activeBranchId} branches={branches} addVisitor={addVisitor} onCancel={() => setShowAddForm(false)} triggerToast={triggerToast} onVisitorCreated={(visitorId) => setSelectedVisitorId(visitorId)} />
          </div>
        </div>
      )}

      {/* Core Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className={'lg:col-span-12 transition-all duration-300 space-y-4'}>
          
          {/* Filters */}
          <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <h3 className="text-sm font-black text-slate-900 flex items-center gap-2"><Compass className="w-4.5 h-4.5 text-indigo-600" /> Applicant status & lead bank</h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 text-xs">
              <div className="relative sm:col-span-5">
                <input type="text" placeholder="Search by name, phone, or notes…" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-3 pr-9 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/10 font-semibold" />
                <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
              </div>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="sm:col-span-2 bg-slate-50 border border-slate-200 rounded-xl px-2 py-2 text-xs font-bold cursor-pointer focus:outline-none">
                <option value="all">All statuses</option><option value="visited">Pending</option><option value="registered">Enrolled</option>
              </select>
              <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="sm:col-span-2 bg-slate-50 border border-slate-200 rounded-xl px-2 py-2 text-xs font-bold cursor-pointer focus:outline-none">
                <option value="all">All sources</option><option value="social">Social media</option><option value="ads">Facebook ads</option><option value="friend">Friends</option><option value="other">Other</option>
              </select>
              <select value={interestFilter} onChange={(e) => setInterestFilter(e.target.value)} className="sm:col-span-3 bg-slate-50 border border-slate-200 rounded-xl px-2 py-2 text-xs font-bold cursor-pointer focus:outline-none">
                <option value="all">All interest levels</option><option value="high_interest">🔥 High</option><option value="medium_interest">⚡ Medium</option><option value="low_interest">❄️ Low</option><option value="not_answering">📞 No response</option><option value="no_interest">❌ Dropped</option>
              </select>
            </div>
          </div>

          {/* Views */}
          {crmViewMode === 'list' ? (
            <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-xs overflow-x-auto">
              <table className="w-full text-xs text-left border-collapse">
                <thead><tr className="border-b border-slate-100 text-slate-500 font-bold">
                  <th className="py-3 px-3">Visitor</th><th className="py-3 px-3">Phone / source</th><th className="py-3 px-3">Level / course</th><th className="py-3 px-3">Next contact</th><th className="py-3 px-3 text-center">Status</th><th className="py-3 px-3 text-left">Enrollment</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-50 text-slate-600">
                  {filteredVisitors.length === 0 ? <tr><td colSpan={6} className="text-center py-10 text-slate-400">No visitors match this search.</td></tr> : (
                    filteredVisitors.map((v) => {
                      const src = SOURCE_BADGES[v.source] || SOURCE_BADGES.other;
                      const intBadge = INTEREST_BADGES[v.followUpStatus || ''] || 'bg-slate-50 text-slate-500';
                      return (
                        <tr key={v.id} onClick={() => setSelectedVisitorId(v.id)} className={`hover:bg-indigo-50/15 transition-all cursor-pointer ${selectedVisitorId === v.id ? 'bg-indigo-50/25 border-r-2 border-indigo-600' : ''}`}>
                          <td className="py-3 px-3"><p className="font-extrabold text-slate-800 text-xs sm:text-sm">{v.fullName}</p><p className="text-[10px] text-slate-400 mt-0.5">Visit: {v.visitDate}</p></td>
                          <td className="py-3 px-3"><p className="font-mono font-bold text-slate-700 text-xs">{v.phone}</p><div className="mt-1"><span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border ${src.class}`}>{src.icon} {src.label}</span></div></td>
                          <td className="py-3 px-3"><div className="flex flex-col gap-1"><span className="text-[10px] font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md w-fit border border-indigo-100">{v.interestedCourse || '—'}</span><span className={`inline-flex px-2 py-0.5 rounded-full text-[9px] font-semibold border w-fit ${intBadge}`}>{v.followUpStatus?.replace('_', ' ')}</span>{v.placementScore && <span className="inline-flex items-center gap-0.5 text-[9px] text-emerald-700 font-extrabold bg-emerald-50 px-1.5 rounded-md w-fit"><Award className="w-3 h-3" /> {v.placementScore.total} pts</span>}</div></td>
                          <td className="py-3 px-3 font-mono font-semibold text-indigo-600">{v.nextContactDate ? <span className="flex items-center gap-1 text-[10px]"><Clock className="w-3.5 h-3.5" /> {v.nextContactDate}</span> : <span className="text-slate-300">-</span>}</td>
                          <td className="py-3 px-3 text-center"><span className={`inline-flex px-2 py-1 rounded-full text-[9px] font-black border ${isConvertedLead(v) ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>{isConvertedLead(v) ? 'Enrolled' : 'In follow-up'}</span></td>
                          <td className="py-3 px-3 text-left" onClick={(e) => e.stopPropagation()}>
                            {isPendingLead(v) ? <button onClick={() => setConvertingVisitor(v)} className="bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-[10px] px-3 py-1.5 rounded-xl shadow-xs flex items-center gap-1"><UserCheck className="w-3.5 h-3.5" /> Enroll now</button> : <span className="text-[10px] text-emerald-600 font-bold flex items-center gap-0.5 justify-end"><CheckCircle2 className="w-3.5 h-3.5" /> Completed</span>}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            /* Workflow board */
            <div className="overflow-x-auto pb-2">
              <div className="grid grid-cols-5 gap-3 min-w-[1200px] items-start">
                {[
                  { key: 'new', label: 'New', stages: ['lead', 'inquiry'], tone: 'slate' },
                  { key: 'nurture', label: 'Nurture', stages: ['follow_up'], tone: 'indigo' },
                  { key: 'placement', label: 'Placement', stages: ['placement_booking', 'placement_fee', 'placement_completed'], tone: 'violet' },
                  { key: 'enrollment', label: 'Enrollment', stages: ['class_fee', 'card_issued', 'book_issued', 'registration'], tone: 'amber' },
                  { key: 'lifecycle', label: 'Lifecycle', stages: ['enrollment', 'active', 'graduated', 'alumni', 'lost'], tone: 'emerald' },
                ].map((col) => {
                  const colVisitors = filteredVisitors.filter((v) => col.stages.includes(v.stage || 'lead'));
                  return (
                    <div key={col.key} className="rounded-2xl border border-slate-200 bg-slate-50/70 min-h-[430px] p-3">
                      <div className="flex items-center justify-between mb-3 px-1">
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">{col.label}</p>
                          <p className="text-[9px] text-slate-400">{col.stages.length} workflow stage{col.stages.length > 1 ? 's' : ''}</p>
                        </div>
                        <span className="px-2 py-1 rounded-full bg-white border border-slate-200 text-[10px] font-black text-slate-700">{colVisitors.length}</span>
                      </div>
                      <div className="space-y-2 max-h-[560px] overflow-y-auto pr-1">
                        {colVisitors.length === 0 ? (
                          <div className="border border-dashed border-slate-200 rounded-xl bg-white/60 p-6 text-center text-[10px] text-slate-400">No leads in this phase.</div>
                        ) : colVisitors.map((v) => {
                          const nextStage = (() => {
                            const order = ['lead','inquiry','follow_up','placement_booking','placement_fee','placement_completed','class_fee','card_issued','book_issued','registration','enrollment','active','graduated','alumni','lost'];
                            const index = order.indexOf(v.stage || 'lead');
                            return index >= 0 && index < order.length - 1 ? order[index + 1] : undefined;
                          })();
                          return (
                            <div key={v.id} onClick={() => setSelectedVisitorId(v.id)} className="bg-white border border-slate-200 rounded-xl p-3 space-y-2 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all cursor-pointer">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="font-extrabold text-slate-800 text-[11px] break-words">{v.fullName}</p>
                                  <p className="text-[9px] font-mono text-slate-400 mt-0.5">{v.serialNo}</p>
                                </div>
                                {v.nextContactDate && <span className={`text-[9px] font-black ${v.nextContactDate < todayIso ? 'text-rose-600' : 'text-slate-400'}`}>{v.nextContactDate < todayIso ? 'OVERDUE' : v.nextContactDate}</span>}
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                <span className="px-1.5 py-0.5 rounded-md bg-indigo-50 border border-indigo-100 text-indigo-700 text-[9px] font-bold">{v.stage?.replaceAll('_', ' ')}</span>
                                <span className={`px-1.5 py-0.5 rounded-md border text-[9px] font-bold ${INTEREST_BADGES[v.followUpStatus || ''] || 'bg-slate-50 text-slate-500 border-slate-200'}`}>{v.followUpStatus?.replaceAll('_', ' ') || 'medium interest'}</span>
                              </div>
                              <div className="text-[10px] text-slate-500 flex items-center justify-between gap-2">
                                <span className="truncate">{v.interestedCourse || 'No course interest recorded'}</span>
                                {v.placementScore && <span className="text-emerald-700 font-black">{v.placementScore.total}/100</span>}
                              </div>
                              <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2" onClick={(e) => e.stopPropagation()}>
                                <button onClick={() => setSelectedVisitorId(v.id)} className="text-[9px] font-bold text-slate-500 hover:text-indigo-600">Open workspace</button>
                                {nextStage && nextStage !== 'lost' ? (
                                  <button onClick={() => advanceVisitorStage(v.id)} className="text-[9px] font-black text-white bg-indigo-600 hover:bg-indigo-700 px-2.5 py-1.5 rounded-lg">Advance</button>
                                ) : v.stage === 'lost' ? (
                                  <span className="text-[9px] font-black text-slate-400">Closed</span>
                                ) : null}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {activeVisitor && (
        <VisitorDeskPanel courseOptions={courseOptions} key={activeVisitor.id} visitor={activeVisitor} onClose={() => setSelectedVisitorId(null)} updateVisitorCRM={updateVisitorCRM} addVisitorFollowUp={addVisitorFollowUp} updateVisitor={updateVisitor} onOpenPlacementTest={() => setShowPlacementModal(true)} onOpenConvert={() => setConvertingVisitor(activeVisitor)} triggerToast={triggerToast} />
      )}

      {activeVisitor && showPlacementModal && (
        <PlacementTestModal
          visitor={activeVisitor}
          onClose={() => setShowPlacementModal(false)}
          onCompleted={async () => { await reloadVisitors(); setShowPlacementModal(false); }}
          triggerToast={triggerToast}
        />
      )}

      {convertingVisitor && (
        <ConvertToStudentModal convertingVisitor={convertingVisitor} classes={classes} branches={branches} activeBranchId={activeBranchId} registerVisitorToStudent={registerVisitorToStudent} onClose={() => setConvertingVisitor(null)} triggerToast={triggerToast} />
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}