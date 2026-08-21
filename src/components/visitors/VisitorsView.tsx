/**
 * @license SPDX-License-Identifier: Apache-2.0
 */

import { text } from '../../design-system/styles';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {UserPlus, Search, Sparkles, UserCheck, MessageSquare, Megaphone, Share2, Compass, AlertCircle, CheckCircle2, Clock, Kanban, List, Award} from 'lucide-react';
import {Visitor, Class, Branch, Teacher, VisitorSummary, VisitorQuery, ConversionEligibility, DuplicateCandidate} from '../../types'; // Added Teacher
import {hasPermission} from '../../config/permissions';
import {VISITOR_SOURCE_OPTIONS, SOURCE_LABELS} from '../../config/visitorSources';
import {isLeadClosed, isLeadOpen, leadLifecycleBucket, LEAD_BUCKET_LABEL, LEAD_BUCKET_BADGE, PLACEMENT_LABEL, PLACEMENT_BADGE, placementKey} from '../../config/leadLifecycle';
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
  reloadVisitors: (query?: VisitorQuery) => Promise<void>;
  /** Server-computed KPIs. Null until the first load resolves. */
  visitorSummary?: VisitorSummary | null;
  /** The query the store last executed, so the view reflects server state. */
  visitorQuery?: VisitorQuery;
  /** Effective permission codes for the signed-in user (UX-4). */
  permissionCodes?: string[];
  advanceVisitorStage: (visitorId: string, stage?: Visitor['stage']) => Promise<void>;
  registerVisitorToStudent: (
    visitorId: string, classId: string, amountPaid: number, discountPercent: number, notes?: string,
    semesterFee?: number, branchId?: string, paymentMethod?: 'cash' | 'card' | 'bank_transfer'
  ) => Promise<{ studentId: string; studentCode: string; receiptNumber: string; invoiceId: string; invoiceNumber: string; netAmount: number; status: string }>;
  /** Read-only pre-flight for conversion (UX-3). */
  checkConversionEligibility: (visitorId: string, classId?: string) => Promise<ConversionEligibility>;
  /** Advisory duplicate lookup for the registration form (UX-9). */
  checkDuplicateLeads?: (params: { phone?: string; tazkiraNo?: string; fullName?: string }) => Promise<DuplicateCandidate[]>;
  programVersions?: Array<{ id: string; name: string; versionLabel: string; status: string }>;
}

export default function VisitorsView({
  visitors, classes, branches, activeBranchId, addVisitor, updateVisitorCRM, addVisitorFollowUp,
  updateVisitor, reloadVisitors, visitorSummary, visitorQuery, permissionCodes,
  advanceVisitorStage, registerVisitorToStudent, checkConversionEligibility, checkDuplicateLeads, programVersions = []
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
  const [placementFilter, setPlacementFilter] = useState<string>('all');
  const [page, setPage] = useState<number>(0);
  const [isFetching, setIsFetching] = useState<boolean>(false);

  /**
   * Changing a filter invalidates the current page number — page 3 of a
   * previous filter is meaningless under a new one. Resetting at the event is
   * simpler (and lint-clean) versus reacting to the change in an effect.
   */
  const applyFilter = useCallback(<T,>(setter: (v: T) => void) => (value: T) => { setter(value); setPage(0); }, []);

  // ── Permission-aware UI (UX-4) ────────────────────────────────────────────
  // The backend already refuses these actions; the audit found the UI offering
  // them to everyone, so a counselor filled in a class, fee and payment method
  // before being told "You do not have permission to perform this operation."
  // These flags mirror the exact permission codes the routes require.
  const canCreateLead = hasPermission(permissionCodes, 'Lead.Create');
  const canEditLead = hasPermission(permissionCodes, 'Lead.Edit');
  const canConvertLead = hasPermission(permissionCodes, 'Lead.Convert');

  /**
   * Push the current search/filters to the server (UX-1).
   *
   * Search is debounced so typing does not issue a request per keystroke; the
   * filter selects apply immediately. Every change resets to page 0, because
   * page 3 of a previous filter is meaningless under a new one.
   */
  const pageSize = visitorQuery?.pageSize ?? 25;
  useEffect(() => {
    const handle = setTimeout(() => {
      setIsFetching(true);
      void reloadVisitors({
        search: searchTerm || undefined,
        status: statusFilter,
        source: sourceFilter,
        interest: interestFilter,
        placement: placementFilter,
        page,
        pageSize,
      }).finally(() => setIsFetching(false));
    }, searchTerm ? 300 : 0);
    return () => clearTimeout(handle);
  }, [searchTerm, statusFilter, sourceFilter, interestFilter, placementFilter, page, pageSize, reloadVisitors]);


  // Local calendar date, matching the server's `today()` (toLocaleDateString
  // 'en-CA'). Deriving this with toISOString() is UTC, which in Asia/Kabul
  // (UTC+4:30) returns YESTERDAY for the first 4.5 hours of every working day —
  // flagging follow-ups that are due today as OVERDUE.
  const todayIso = new Date().toLocaleDateString('en-CA');

  // Row-level lifecycle comes from the shared vocabulary, which mirrors the
  // server's authority. The inline rule this replaces read
  // `status || (stage === 'registration' || stage === 'enrollment' ? …)`, whose
  // stage branch was unreachable because `status` is NOT NULL, and which had no
  // notion of closed-lost — so a dead lead rendered "In follow-up" with an
  // "Enroll now" button the server refuses.
  // Thin wrappers kept only where the JSX reads better; the badge renders
  // straight from `leadLifecycleBucket`, so no separate "converted" helper is
  // needed here.
  const isClosedLead = useCallback((v: Visitor) => isLeadClosed(v), []);
  const isPendingLead = useCallback((v: Visitor) => isLeadOpen(v), []);
  // Only an OPEN lead can be overdue: a converted lead needs no follow-up and a
  // closed one is no longer worked.
  const isOverdueContact = useCallback((v: Visitor) => Boolean(v.nextContactDate) && isLeadOpen(v) && (v.nextContactDate as string) < todayIso, [todayIso]);

  /**
   * Advance a lead one stage, with the feedback the bare call never gave.
   *
   * `advanceVisitorStage` sends `fromStage` as an optimistic-concurrency token
   * (audit V-7), so a double-click or a colleague working the same lead is
   * correctly rejected with 409. A bare
   * `onClick={() => advanceVisitorStage(v.id)}` — no await, no catch — turns
   * that rejection into an unhandled promise: the card does not move and
   * nothing is said. Users read that as a broken button and click again, which
   * is precisely what produces the next 409.
   *
   * `advancing` also disables the button in flight, removing the double-click
   * that causes the conflict in the first place.
   */
  const [advancing, setAdvancing] = useState<string | null>(null);
  const handleAdvance = useCallback(async (v: Visitor) => {
    if (advancing) return;
    setAdvancing(v.id);
    try {
      await advanceVisitorStage(v.id);
      triggerToast(`${v.fullName} moved to the next stage.`, 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not advance this lead.';
      triggerToast(message, 'error');
      // A 409 means our view of the stage is stale; resync so the next click
      // is made against the truth rather than repeating the same conflict.
      await reloadVisitors().catch(() => undefined);
    } finally {
      setAdvancing(null);
    }
  }, [advancing, advanceVisitorStage, reloadVisitors]);

  /**
   * Headline figures come from the server (UX-1).
   *
   * Counted from the loaded page instead, with 250 leads the conversion tile
   * reads 27% against a true 11%. Nothing here recomputes a population — the view renders what /visitors/summary returned. `stats` is
   * null until the first response lands so the UI can show a placeholder
   * instead of a confident zero.
   */
  const stats = visitorSummary;

  /**
   * `visitors` is already the server's filtered page. Filtering it again here
   * is what made lead #101 unfindable, so the list renders the rows as given.
   */
  const filteredVisitors = visitors;
  /**
   * Null until the server answers. Deliberately NOT defaulted to
   * `visitors.length` — that is the page, and quoting a page as a total is the
   * whole defect. The UI shows a placeholder until the real figure arrives.
   */
  /**
   * Per-stage population counts from the server, keyed for O(1) lookup.
   * Null until the summary lands, so a column badge shows a placeholder rather
   * than a confident zero while loading.
   */
  const stageTotals = useMemo(() => {
    if (!visitorSummary?.byStage) return null;
    return Object.fromEntries(visitorSummary.byStage.map((r) => [r.stage, r.count])) as Record<string, number>;
  }, [visitorSummary]);

  const totalMatching = visitorSummary?.filtered ?? null;
  const totalPages = Math.max(1, Math.ceil((totalMatching ?? 0) / pageSize));
  const hasActiveFilters = Boolean(searchTerm) || statusFilter !== 'all' || sourceFilter !== 'all' || interestFilter !== 'all' || placementFilter !== 'all';

  const activeVisitor = visitors.find(v => v.id === selectedVisitorId) || null;


  const SOURCE_BADGES: Record<string, { class: string; icon: React.ReactNode; label: string }> = {
    ads: { class: 'bg-sky-50 text-sky-700 border-sky-100', icon: <Megaphone className="w-3 h-3" />, label: SOURCE_LABELS.ads },
    facebook: { class: 'bg-sky-50 text-sky-700 border-sky-100', icon: <Megaphone className="w-3 h-3" />, label: SOURCE_LABELS.facebook },
    friend: { class: 'bg-emerald-50 text-emerald-700 border-emerald-100', icon: <Share2 className="w-3 h-3" />, label: SOURCE_LABELS.friend },
    referral: { class: 'bg-emerald-50 text-emerald-700 border-emerald-100', icon: <Share2 className="w-3 h-3" />, label: SOURCE_LABELS.referral },
    walk_in: { class: 'bg-violet-50 text-violet-700 border-violet-100', icon: <UserCheck className="w-3 h-3" />, label: SOURCE_LABELS.walk_in },
    social: { class: 'bg-indigo-50 text-indigo-700 border-indigo-100', icon: <Compass className="w-3 h-3" />, label: SOURCE_LABELS.social },
    event: { class: 'bg-amber-50 text-amber-700 border-amber-100', icon: <Sparkles className="w-3 h-3" />, label: SOURCE_LABELS.event },
    organic: { class: 'bg-teal-50 text-teal-700 border-teal-100', icon: <Search className="w-3 h-3" />, label: SOURCE_LABELS.organic },
    other: { class: 'bg-slate-50 text-slate-700 border-slate-100', icon: <MessageSquare className="w-3 h-3" />, label: SOURCE_LABELS.other },
  };

  const INTEREST_BADGES: Record<string, string> = {
    high_interest: 'bg-amber-100 text-amber-800 border-amber-200',
    medium_interest: 'bg-indigo-50 text-indigo-700 border-indigo-100',
    low_interest: 'bg-slate-100 text-slate-600 border-slate-200',
    not_answering: 'bg-rose-50 text-rose-700 border-rose-200',
    no_interest: 'bg-rose-100 text-rose-800 border-rose-200',
  };

  return (
    <div className="space-y-6 font-sans text-start" id="visitors-view-root">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-center justify-between border-b border-slate-200 pb-4 gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2"><UserPlus className="w-6 h-6 text-indigo-600 stroke-[2.5]" /> CRM & lead pipeline</h2>
          <p className={text.hint}>Capture, nurture, place, and enroll — live data only</p>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="bg-slate-100 p-1 rounded-xl flex gap-1 border border-slate-200/60">
            <button onClick={() => setCrmViewMode('list')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${crmViewMode === 'list' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-500'}`}><List className="w-3.5 h-3.5" /> Table</button>
            <button onClick={() => setCrmViewMode('kanban')} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${crmViewMode === 'kanban' ? 'bg-white text-indigo-600 shadow-xs' : 'text-slate-500'}`}><Kanban className="w-3.5 h-3.5" /> Kanban</button>
          </div>
          {canCreateLead && (
            <button onClick={() => setShowAddForm(!showAddForm)} className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs px-4 py-2.5 rounded-xl cursor-pointer shadow-md transition-all hover:-translate-y-0.5">
              <UserPlus className="w-4 h-4 stroke-[2.5]" /> New visitor
            </button>
          )}
        </div>
      </div>

      {/* KPI strip — every figure is server-computed over the FULL population.
          A dash is shown until the summary lands: a confident "0" during load
          is itself a wrong number. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm"><p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Total leads</p><p className="mt-0.5 font-mono text-lg font-black text-slate-900">{stats ? stats.total : '—'}</p></div>
        <div className="rounded-2xl border border-amber-100 bg-amber-50/50 p-3.5 shadow-sm"><p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700/70">In pipeline</p><p className="mt-0.5 font-mono text-lg font-black text-amber-900">{stats ? stats.pipeline : '—'}</p></div>
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50/50 p-3.5 shadow-sm"><p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700/70">Enrolled</p><p className="mt-0.5 font-mono text-lg font-black text-emerald-900">{stats ? stats.registered : '—'}</p></div>
        <div className="rounded-2xl border border-indigo-100 bg-indigo-50/40 p-3.5 shadow-sm"><p className="text-[10px] font-semibold uppercase tracking-wide text-indigo-700/70">Conversion</p><p className="mt-0.5 font-mono text-lg font-black text-indigo-900">{stats ? `${stats.conversionRate}%` : '—'}</p></div>
        <div className={`rounded-2xl border p-3.5 shadow-sm ${stats && stats.overdue > 0 ? 'border-rose-200 bg-rose-50/60' : 'border-slate-200 bg-white'}`}><p className={`text-[10px] font-semibold uppercase tracking-wide ${stats && stats.overdue > 0 ? 'text-rose-700/80' : 'text-slate-400'}`}>Overdue</p><p className={`mt-0.5 font-mono text-lg font-black ${stats && stats.overdue > 0 ? 'text-rose-800' : 'text-slate-900'}`}>{stats ? stats.overdue : '—'}</p></div>
      </div>

      {stats && stats.overdue > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50/80 px-3 py-2.5 text-xs text-rose-950">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
          <div><p className="font-bold">{stats.overdue} lead(s) past next-contact date</p><p className="text-[10px] text-rose-800/80">Open the desk panel and log a follow-up or update the contact date.</p></div>
        </div>
      )}

      {/* Marketing Funnel Dashboard */}
      {stats && stats.total > 0 && (
        <div className="bg-white border border-slate-200/80 rounded-3xl p-6 shadow-xs space-y-6">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3 flex-wrap gap-2">
            <h3 className="text-sm font-black text-slate-900 flex items-center gap-2"><Sparkles className="w-5 h-5 text-indigo-600 stroke-[2.5] animate-pulse" /> Branch conversion dashboard</h3>
            <div className="flex gap-4 text-xs font-bold">
              <span className="text-slate-500">Total: <span className="text-slate-900 font-mono">{stats.total}</span></span>
              <span className="text-amber-600">Follow-up: <span className="font-mono">{stats.pipeline}</span></span>
              <span className="text-emerald-600 font-extrabold">Enrolled: <span className="font-mono">{stats.registered}</span></span>
              <span className="text-indigo-600 font-black">Rate: <span className="font-mono">{stats.conversionRate}%</span></span>
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            <div className="lg:col-span-8 space-y-3">
              <div className="w-full bg-slate-50 rounded-2xl h-10 flex items-center justify-between px-4 overflow-hidden border border-slate-150 relative">
                <div className="absolute inset-y-0 end-0 bg-indigo-600/5 w-full rounded-r-2xl" />
                <span className="font-extrabold text-slate-800 text-xs z-10 flex items-center gap-2"><span className="w-5 h-5 rounded-lg bg-indigo-600 text-white flex items-center justify-center text-[10px] font-bold">1</span> Inbound leads</span>
                <span className="font-mono font-black text-slate-900 text-sm z-10">{stats.total} (100%)</span>
              </div>
              <div className="w-full bg-slate-50 rounded-2xl h-10 flex items-center justify-between px-4 overflow-hidden border border-slate-150 relative">
                <div className="absolute inset-y-0 end-0 bg-amber-500/5 rounded-r-2xl border-s border-amber-300/30" style={{ width: `${stats.total > 0 ? (stats.pipeline / stats.total) * 100 : 0}%` }} />
                <span className="font-extrabold text-slate-800 text-xs z-10 flex items-center gap-2"><span className="w-5 h-5 rounded-lg bg-amber-500 text-white flex items-center justify-center text-[10px] font-bold">2</span> Active nurturing</span>
                <span className="font-mono font-black text-amber-700 text-sm z-10">{stats.pipeline} ({stats.total > 0 ? Math.round((stats.pipeline / stats.total) * 100) : 0}%)</span>
              </div>
              <div className="w-full bg-slate-50 rounded-2xl h-10 flex items-center justify-between px-4 overflow-hidden border border-slate-150 relative">
                <div className="absolute inset-y-0 end-0 bg-emerald-500/5 rounded-r-2xl border-s border-emerald-300/30" style={{ width: `${stats.conversionRate}%` }} />
                <span className="font-extrabold text-slate-800 text-xs z-10 flex items-center gap-2"><span className="w-5 h-5 rounded-lg bg-emerald-500 text-white flex items-center justify-center text-[10px] font-bold">3</span> Converted students</span>
                <span className="font-mono font-black text-emerald-700 text-sm z-10">{stats.registered} ({stats.conversionRate}%)</span>
              </div>
            </div>
            <div className="lg:col-span-4 bg-slate-50/50 border border-slate-200/60 rounded-2xl p-4 space-y-3">
              <h4 className="text-[11px] font-extrabold text-slate-400 uppercase tracking-wider">Channel performance:</h4>
              {/* Counts come from the server's GROUP BY over every source it
                  stores. Counting the loaded page here under-reported every
                  channel, and iterating a 4-key badge map hid walk_in,
                  referral, event, organic and facebook entirely. */}
              <div className="space-y-2 text-xs">
                {(stats.bySource || []).map(({ source, count }) => {
                  const badge = SOURCE_BADGES[source] || SOURCE_BADGES.other;
                  return (
                    <div key={source} className="flex justify-between items-center bg-white p-2.5 rounded-xl border border-slate-100">
                      <span className="flex items-center gap-1.5 font-bold text-slate-700">{badge.icon} {SOURCE_LABELS[source] || source}</span>
                      <span className="font-mono font-black text-slate-900">{count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Visitor Form Modal */}
      {showAddForm && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto animate-in fade-in duration-200" id="add-visitor-form-modal">
          <div className="w-full max-w-2xl my-auto">
            <AddVisitorForm programVersions={programVersions} activeBranchId={activeBranchId} branches={branches} addVisitor={addVisitor} onCancel={() => setShowAddForm(false)} triggerToast={triggerToast} onVisitorCreated={(visitorId) => setSelectedVisitorId(visitorId)} checkDuplicateLeads={checkDuplicateLeads} onOpenExistingLead={(visitorId) => { setShowAddForm(false); setSelectedVisitorId(visitorId); }} />
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
              <div className="relative sm:col-span-4">
                <input type="text" placeholder="Search by name, phone, or notes…" value={searchTerm} onChange={(e) => applyFilter(setSearchTerm)(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl ps-3 pe-9 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/10 font-semibold" />
                <Search className="w-4 h-4 text-slate-400 absolute end-3 top-2.5" />
              </div>
              <select value={statusFilter} onChange={(e) => applyFilter(setStatusFilter)(e.target.value)} className="sm:col-span-2 bg-slate-50 border border-slate-200 rounded-xl px-2 py-2 text-xs font-bold cursor-pointer focus:outline-none">
                <option value="all">All statuses</option><option value="pending">In pipeline</option><option value="registered">Enrolled</option><option value="lost">Lost</option>
              </select>
              <select value={sourceFilter} onChange={(e) => applyFilter(setSourceFilter)(e.target.value)} className="sm:col-span-2 bg-slate-50 border border-slate-200 rounded-xl px-2 py-2 text-xs font-bold cursor-pointer focus:outline-none">
                <option value="all">All sources</option>
                {VISITOR_SOURCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {/* Placement filter. The server has supported ?placement= since the
                  UX-1 work; it simply had no UI, so "who still needs assessing?"
                  was unanswerable without opening leads one by one. */}
              <select value={placementFilter} onChange={(e) => applyFilter(setPlacementFilter)(e.target.value)} className="sm:col-span-2 bg-slate-50 border border-slate-200 rounded-xl px-2 py-2 text-xs font-bold cursor-pointer focus:outline-none">
                <option value="all">All placement states</option>
                <option value="needs_assessment">Needs assessment</option>
                <option value="completed">Assessed</option>
                <option value="waived">Waived</option>
              </select>
              <select value={interestFilter} onChange={(e) => applyFilter(setInterestFilter)(e.target.value)} className="sm:col-span-2 bg-slate-50 border border-slate-200 rounded-xl px-2 py-2 text-xs font-bold cursor-pointer focus:outline-none">
                <option value="all">All interest levels</option><option value="high_interest">🔥 High</option><option value="medium_interest">⚡ Medium</option><option value="low_interest">❄️ Low</option><option value="not_answering">📞 No response</option><option value="no_interest">❌ Dropped</option>
              </select>
            </div>

            {/* Result count + paginator. The user must always know how much of
                the population they are looking at — the audit's core failure
                was a screen that showed 100 of 250 leads and said nothing. */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px]">
              <p className="font-bold text-slate-500">
                {isFetching ? 'Loading…' : (
                  <>
                    Showing <span className="font-mono text-slate-800">{filteredVisitors.length}</span>
                    {' '}of <span className="font-mono text-slate-800">{totalMatching ?? '—'}</span>
                    {hasActiveFilters ? ' matching' : ''} lead{totalMatching === 1 ? '' : 's'}
                    {hasActiveFilters && stats ? <span className="text-slate-400"> · {stats.total} total</span> : null}
                  </>
                )}
              </p>
              <div className="flex items-center gap-1.5">
                {hasActiveFilters && (
                  <button
                    onClick={() => { setSearchTerm(''); setStatusFilter('all'); setSourceFilter('all'); setInterestFilter('all'); setPlacementFilter('all'); setPage(0); }}
                    className="px-2.5 py-1 rounded-lg font-bold text-slate-600 hover:bg-slate-100 cursor-pointer"
                  >Clear filters</button>
                )}
                <button
                  onClick={() => setPage((n) => Math.max(0, n - 1))}
                  disabled={page === 0 || isFetching}
                  className="px-2.5 py-1 rounded-lg font-bold border border-slate-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 cursor-pointer"
                >Previous</button>
                <span className="font-mono font-bold text-slate-600 px-1">{page + 1} / {totalPages}</span>
                <button
                  onClick={() => setPage((n) => Math.min(totalPages - 1, n + 1))}
                  disabled={page >= totalPages - 1 || isFetching}
                  className="px-2.5 py-1 rounded-lg font-bold border border-slate-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 cursor-pointer"
                >Next</button>
              </div>
            </div>
          </div>

          {/* Views */}
          {crmViewMode === 'list' ? (
            <div className="bg-white border border-slate-200 rounded-3xl p-5 shadow-xs overflow-x-auto">
              <table className="w-full text-xs text-start border-collapse">
                <thead><tr className="border-b border-slate-100 text-slate-500 font-bold">
                  <th className="py-3 px-3">Visitor</th><th className="py-3 px-3">Phone / source</th><th className="py-3 px-3">Level / course</th><th className="py-3 px-3">Next contact</th><th className="py-3 px-3 text-center">Status</th><th className="py-3 px-3 text-start">Enrollment</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-50 text-slate-600">
                  {filteredVisitors.length === 0 ? (
                    <tr><td colSpan={6} className="text-center py-10 text-slate-400">
                      {isFetching ? 'Loading leads…'
                        : hasActiveFilters ? 'No leads match these filters. Try Clear filters.'
                        : 'No leads yet. Use “New visitor” to register the first one.'}
                    </td></tr>
                  ) : (
                    filteredVisitors.map((v) => {
                      const src = SOURCE_BADGES[v.source] || SOURCE_BADGES.other;
                      const intBadge = INTEREST_BADGES[v.followUpStatus || ''] || 'bg-slate-50 text-slate-500';
                      return (
                        <tr key={v.id} onClick={() => setSelectedVisitorId(v.id)} className={`hover:bg-indigo-50/15 transition-all cursor-pointer ${selectedVisitorId === v.id ? 'bg-indigo-50/25 border-r-2 border-indigo-600' : ''}`}>
                          <td className="py-3 px-3"><p className="font-extrabold text-slate-800 text-xs sm:text-sm">{v.fullName}</p><p className="text-[10px] text-slate-400 mt-0.5">Visit: {v.visitDate}</p></td>
                          <td className="py-3 px-3"><p className="font-mono font-bold text-slate-700 text-xs">{v.phone}</p><div className="mt-1"><span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border ${src.class}`}>{src.icon} {src.label}</span></div></td>
                          <td className="py-3 px-3"><div className="flex flex-col gap-1"><span className="text-[10px] font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md w-fit border border-indigo-100">{v.interestedCourse || '—'}</span><span className={`inline-flex px-2 py-0.5 rounded-full text-[9px] font-semibold border w-fit ${intBadge}`}>{v.followUpStatus?.replace('_', ' ')}</span>{v.placementScore && <span className="inline-flex items-center gap-0.5 text-[9px] text-emerald-700 font-extrabold bg-emerald-50 px-1.5 rounded-md w-fit"><Award className="w-3 h-3" /> {v.placementScore.total} pts</span>}<span className={`inline-flex px-2 py-0.5 rounded-full text-[9px] font-semibold border w-fit ${PLACEMENT_BADGE[placementKey(v.placementStatus)]}`}>{PLACEMENT_LABEL[placementKey(v.placementStatus)]}</span></div></td>
                          {/* Row-level overdue marker. The COUNT is server-computed;
                              this only flags the row the user is looking at, using the
                              same local-calendar `todayIso` the server's today() matches. */}
                          <td className={`py-3 px-3 font-mono font-semibold ${isOverdueContact(v) ? 'text-rose-600' : 'text-indigo-600'}`}>{v.nextContactDate ? <span className="flex items-center gap-1 text-[10px]"><Clock className="w-3.5 h-3.5" /> {v.nextContactDate}{isOverdueContact(v) ? <span className="font-black uppercase text-[9px]">overdue</span> : null}</span> : <span className="text-slate-300">-</span>}</td>
                          <td className="py-3 px-3 text-center"><span className={`inline-flex px-2 py-1 rounded-full text-[9px] font-black border ${LEAD_BUCKET_BADGE[leadLifecycleBucket(v)]}`}>{LEAD_BUCKET_LABEL[leadLifecycleBucket(v)]}</span></td>
                          <td className="py-3 px-3 text-start" onClick={(e) => e.stopPropagation()}>
                            {isClosedLead(v)
                              ? <span className="text-[10px] text-slate-400 font-bold" title="Reopen this lead before it can be enrolled.">Closed</span>
                              : isPendingLead(v)
                                ? (canConvertLead
                                    ? <button onClick={() => setConvertingVisitor(v)} className="bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-[10px] px-3 py-1.5 rounded-xl shadow-xs flex items-center gap-1"><UserCheck className="w-3.5 h-3.5" /> Enroll now</button>
                                    : <span className="text-[10px] text-slate-400 font-bold" title="Only the registrar can enroll a lead.">Registrar only</span>)
                                : <span className="text-[10px] text-emerald-600 font-bold flex items-center gap-0.5 justify-end"><CheckCircle2 className="w-3.5 h-3.5" /> Completed</span>}
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
              <div className="grid grid-cols-6 gap-3 min-w-[1320px] items-start">
                {[
                  { key: 'new', label: 'New', stages: ['lead', 'inquiry'], tone: 'slate' },
                  { key: 'nurture', label: 'Nurture', stages: ['follow_up'], tone: 'indigo' },
                  { key: 'placement', label: 'Placement', stages: ['placement_booking', 'placement_fee', 'placement_completed'], tone: 'violet' },
                  { key: 'enrollment', label: 'Enrollment', stages: ['class_fee', 'card_issued', 'book_issued', 'registration'], tone: 'amber' },
                  { key: 'lifecycle', label: 'Enrolled', stages: ['enrollment', 'active', 'graduated', 'alumni'], tone: 'emerald' },
                  // 'lost' had been folded into Lifecycle alongside enrollment,
                  // active, graduated and alumni — won and lost outcomes in one
                  // pile. A closed lead is its own terminal state.
                  { key: 'lost', label: 'Lost', stages: ['lost'], tone: 'slate' },
                ].map((col) => {
                  const colVisitors = filteredVisitors.filter((v) => col.stages.includes(v.stage || 'lead'));
                  // Column badge = SERVER count over the whole population.
                  // Using colVisitors.length here showed "New: 21" against a
                  // true 223, because filteredVisitors is one 25-row page.
                  const colTotal = stageTotals
                    ? col.stages.reduce((n, st) => n + (stageTotals[st] ?? 0), 0)
                    : null;
                  return (
                    <div key={col.key} className="rounded-2xl border border-slate-200 bg-slate-50/70 min-h-[430px] p-3">
                      <div className="flex items-center justify-between mb-3 px-1">
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">{col.label}</p>
                          <p className="text-[9px] text-slate-400">{col.stages.length} workflow stage{col.stages.length > 1 ? 's' : ''}</p>
                        </div>
                        <span className="px-2 py-1 rounded-full bg-white border border-slate-200 text-[10px] font-black text-slate-700" title={colTotal !== null ? `${colTotal} lead(s) in this phase across the whole branch` : undefined}>{colTotal ?? '—'}</span>
                      </div>
                      <div className="space-y-2 max-h-[560px] overflow-y-auto pe-1">
                        {colVisitors.length === 0 ? (
                          <div className="border border-dashed border-slate-200 rounded-xl bg-white/60 p-6 text-center text-[10px] text-slate-400">
                            {isFetching ? 'Loading…' : colTotal ? `${colTotal} lead(s) in this phase — not on this page.` : 'No leads in this phase.'}
                          </div>
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
                                {nextStage && nextStage !== 'lost' && canEditLead ? (
                                  <button
                                    onClick={() => void handleAdvance(v)}
                                    disabled={advancing === v.id}
                                    title={`Advance ${v.fullName} to ${nextStage.replace(/_/g, ' ')}`}
                                    className="text-[9px] font-black text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed px-2.5 py-1.5 rounded-lg"
                                  >{advancing === v.id ? 'Advancing…' : `Advance → ${nextStage.replace(/_/g, ' ')}`}</button>
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
        <VisitorDeskPanel courseOptions={courseOptions} key={activeVisitor.id} visitor={activeVisitor} onClose={() => setSelectedVisitorId(null)} updateVisitorCRM={updateVisitorCRM} addVisitorFollowUp={addVisitorFollowUp} updateVisitor={updateVisitor} onOpenPlacementTest={() => setShowPlacementModal(true)} onOpenConvert={() => setConvertingVisitor(activeVisitor)} triggerToast={triggerToast} canConvertLead={canConvertLead} canEditLead={canEditLead} checkConversionEligibility={checkConversionEligibility} />
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
        <ConvertToStudentModal convertingVisitor={convertingVisitor} classes={classes} branches={branches} activeBranchId={activeBranchId} registerVisitorToStudent={registerVisitorToStudent} onClose={() => setConvertingVisitor(null)} triggerToast={triggerToast} checkConversionEligibility={checkConversionEligibility} onOpenPlacementTest={() => { setSelectedVisitorId(convertingVisitor.id); setConvertingVisitor(null); setShowPlacementModal(true); }} />
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}