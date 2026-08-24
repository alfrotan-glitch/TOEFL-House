/**
 * TOEFL House ERP — API Store (Frontend State Management)
 * ============================================================
 * Central hook that manages all frontend state and API interactions.
 * Replaces the old localStorage-based dbStore with real API calls.
 *
 * Architecture:
 * - All data fetched from Express backend via REST API
 * - JWT token injected automatically via api client
 * - snake_case → camelCase conversion handled by api client
 * - Role-based access control enforced on both frontend and backend
 *
 * @module apiStore
 * @version 2.0.0
 * @license Apache-2.0
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api, ApiError } from './api/client';
import { useAuth } from './contexts/useAuth';
import {
  Student, Teacher, Employee, Partner, Class, Visitor, Attendance, Payment, BooksWorkspace,
  Exam, ExamResult, BudgetLine, BudgetLineInput, FinanceCategory, ExpenseRequest, FinancialTransaction, AuditLog, Notification, PaginatedRows,
  Skill, ClassTeacherSkill, OperationalPaymentInput, ExpenseReport, ExpenseKind, Invoice, FinanceConfig, FinanceDashboard,
  // 1.0.0 types
  Donor, FundingCampaign, Donation, DonationRestriction, Scholarship, ScholarshipAward, SponsorshipAgreement, FundingSummary,
  ImpactReport, WorkflowInstance, Automation, Session,
  // Rule Engine types
  BusinessRule, RuleCategory, RuleEngineResult, BusinessRuleVersion, PipelineStage,
  Branch, Campus, Organization, TeacherContractType,
  StudentBalanceRow,
  StudentSummary,
  AttendanceSummaryRow, DashboardSummary, VisitorSummary, VisitorQuery, ConversionEligibility, DuplicateCandidate, InvoicePurpose } from './types';

/** Real due/paid/remaining figures for one teacher/month, mirroring GET /teachers/:id/salary-status. */
export interface TeacherSalaryStatus {
  teacherId: string;
  periodKey: string;
  periodLabel: string;
  model: TeacherContractType;
  due: number;
  paid: number;
  remaining: number;
  fullPaid: boolean;
  breakdown: { label: string; amount: number }[];
  canPayFull: boolean;
  /** Fixed component of pay (0 for purely Skill-based contracts). */
  base: number;
  /** Skill-derived component of pay (0 on a fixed contract). */
  skillsTotal: number;
  /** Actual recorded Skill workload — reported for EVERY contract type. */
  skillCount: number;
  targetSkills: number;
  shortfall: number;
  excess: number;
}

/** Safe GET — returns fallback on 404/500 so missing backend endpoints don't crash the UI */
async function safeGet<T>(path: string, query?: Record<string, string | undefined>, fallback?: T): Promise<T> {
  try {
    return await api.get<T>(path, query);
  } catch (error) {
    if (fallback !== undefined && error instanceof Error && 'status' in error && (error as { status?: unknown }).status === 404) {
      return fallback;
    }
    throw error;
  }
}

/**
 * Rows per visitor page. Deliberately far below the server's MAX_PAGE_SIZE:
 * the point of UX-1 is that the UI pages through the full population, not that
 * it grabs a bigger slice and keeps counting locally.
 */
const VISITOR_PAGE_SIZE = 25;
/** Books history pages are server-capped independently; this is the desk default. */
const BOOK_HISTORY_PAGE_SIZE = 50;

export function useApiStore() {
  const { user } = useAuth();
  // Tab visibility is the server's decision (`tabAccess`, derived from resolved
  // permissions). There is deliberately no role-name fallback: reconstructing
  // authorization from a role string in the browser is a second authority, and
  // it disagreed with the server the moment either side changed.
  const canPickBranch = user?.tabAccess?.settings ?? false;
  const canSeeFinance = user?.tabAccess?.finance ?? false;
  const canViewStudentFinance = user?.permissions?.has('Payment.View') ?? false;
  const canSeeVisitors = user?.tabAccess?.visitors ?? false;
  const canSeeAuditLog = user?.tabAccess?.audit ?? false;
  const canViewFunding = user?.tabAccess?.funding ?? false;
  const canViewImpact = user?.tabAccess?.impact ?? false;
  const canUseFundingReference = canViewFunding || (user?.permissions?.has('Impact.Edit') ?? false);

  const [branches, setBranches] = useState<Branch[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [currentBranchId, setCurrentBranchId] = useState<string>(user?.branchId || '1');

  // ===== Existing collections =====
  const [students, setStudents] = useState<Student[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [classes, setClasses] = useState<Class[]>([]);
  const [visitors, setVisitors] = useState<Visitor[]>([]);
  const [visitorSummary, setVisitorSummary] = useState<VisitorSummary | null>(null);
  const [visitorQuery, setVisitorQuery] = useState<VisitorQuery>({ page: 0, pageSize: VISITOR_PAGE_SIZE });
  /**
   * Mirror of `visitorQuery` readable synchronously inside callbacks. State
   * would make `reloadVisitors` change identity on every query change, and the
   * mutation helpers that call it would then need it in their dependency
   * arrays — a re-render cascade. The ref keeps `reloadVisitors` stable.
   */
  const visitorQueryRef = useRef<VisitorQuery>({ page: 0, pageSize: VISITOR_PAGE_SIZE });
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [booksWorkspace, setBooksWorkspace] = useState<BooksWorkspace | null>(null);
  const [exams, setExams] = useState<Exam[]>([]);
  const [examResults, setExamResults] = useState<ExamResult[]>([]);
  const [budgetLines, setBudgetLines] = useState<BudgetLine[]>([]);
  // Canonical Category → Subcategory tree, fetched from the server. The UI must
  // never invent or locally derive an accounting category, so this is the ONLY
  // source the Finance panels group by.
  const [financeCategories, setFinanceCategories] = useState<FinanceCategory[]>([]);
  const [expenseRequests, setExpenseRequests] = useState<ExpenseRequest[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [financeConfig, setFinanceConfig] = useState<FinanceConfig | null>(null);
  const [transactions, setTransactions] = useState<FinancialTransaction[]>([]);
  const [financeReconciliation, setFinanceReconciliation] = useState<{ healthy: boolean; scope: string; branchId: string | null; paymentBackedTotal: number; ledgerBackedTotal: number; amountVariance: number; unmatchedPayments: number; orphanLedgerRows: number; mismatchedPayments: Array<{ paymentId: string; paymentAmount: number; ledgerAmount: number; variance: number }> } | null>(null);
  const [financeDashboard, setFinanceDashboard] = useState<FinanceDashboard | null>(null);
  const [dashboardSummary, setDashboardSummary] = useState<DashboardSummary | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [savingBalance, setSavingBalance] = useState(0);
  const [mainAccountBalance, setMainAccountBalance] = useState(0);
  const [dailySavingPercent, setDailySavingPercent] = useState(5);
  const [expenseAutoApproveThreshold, setExpenseAutoApproveThreshold] = useState(0);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [programVersions, setProgramVersions] = useState<Array<{ id: string; name: string; versionLabel: string; status: string }>>([]);
  const [classTeacherSkills, setClassTeacherSkills] = useState<ClassTeacherSkill[]>([]);

  // ===== 1.0.0 NEW collections =====
  const [donors, setDonors] = useState<Donor[]>([]);
  const [fundingCampaigns, setFundingCampaigns] = useState<FundingCampaign[]>([]);
  const [donations, setDonations] = useState<Donation[]>([]);
  const [scholarships, setScholarships] = useState<Scholarship[]>([]);
  const [scholarshipAwards, setScholarshipAwards] = useState<ScholarshipAward[]>([]);
  const [sponsorships, setSponsorships] = useState<SponsorshipAgreement[]>([]);
  const [fundingSummary, setFundingSummary] = useState<FundingSummary | null>(null);
  const [impactReports, setImpactReports] = useState<ImpactReport[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowInstance[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [businessRules, setBusinessRules] = useState<Record<RuleCategory, BusinessRule[]>>({} as Record<RuleCategory, BusinessRule[]>);

  // NEW: Dashboard Profitability Analytics
  const [revenueByClass, setRevenueByClass] = useState<{ name: string; revenue: number }[]>([]);
  const [revenueByTimeSlot, setRevenueByTimeSlot] = useState<{ slot: string; revenue: number }[]>([]);

  const [isLoading, setIsLoading] = useState(true);
  const [isTabLoading, setIsTabLoading] = useState(false);
  /**
   * Set when the roster changes elsewhere, so cached copies are refetched.
   * A ref, not state: nothing renders from it, and writing it must not trigger
   * a re-render of every consumer of this store.
   */
  const rosterStaleRef = useRef(false);
  const setRosterStale = useCallback((value: boolean) => { rosterStaleRef.current = value; }, []);

  const [loadedTabs, setLoadedTabs] = useState<Set<string>>(new Set());

  /**
   * Which tabs render which dataset.
   *
   * `loadedTabs` is a "already fetched, don't fetch again" cache. It was only
   * ever cleared on login or branch switch, so once a tab had loaded it served
   * whatever was in memory forever: register a student on Students, open Exams,
   * and the new student was missing from the picker until the user pressed F5.
   * Mutating a dataset now evicts every tab that displays it.
   */
  const TAB_DATASETS: Record<string, readonly string[]> = useMemo(() => ({
    students:   ['dashboard', 'students', 'visitors', 'books', 'exams', 'attendance', 'operations-report'],
    payments:   ['students', 'finance'],
    visitors:   ['dashboard', 'visitors', 'operations-report'],
    teachers:   ['dashboard', 'teachers', 'classes'],
    classes:    ['dashboard', 'classes', 'students', 'visitors', 'exams', 'attendance', 'operations-report'],
    attendance: ['students', 'attendance'],
    books:      ['books'],
    exams:      ['exams'],
    finance:    ['dashboard', 'finance'],
    skills:     ['teachers', 'classes', 'academic-setup'],
    funding:    ['funding', 'impact'],
    academic:   ['academic-setup', 'students', 'visitors', 'classes'],
    settings:   ['settings', 'academic-setup'],
    organization: ['settings', 'academic-setup', 'dashboard'],
    workflows:  ['workflows'],
    audit:      ['dashboard', 'audit'],
  }), []);

  /**
   * Dataset version counters — the canonical freshness signal.
   * ==========================================================================
   * Evicting a tab from `loadedTabs` only helps a component that is about to
   * MOUNT. It does nothing for a component that is already on screen holding
   * its own fetched copy (ClassesView's academic config, SessionsView's rows,
   * the placement workspace...). Those components stayed stale until the user
   * pressed F5, which was effectively the only global invalidation in the app.
   *
   * Every dataset therefore carries a monotonic version. A consumer puts the
   * version of the dataset it displays into its fetch effect's dependency list,
   * so a mutation ANYWHERE — another component, another panel, another tab —
   * bumps the counter and the consumer refetches from the server. No polling,
   * no timers, no remounting, no page reload.
   *
   * `datasetVersion` is the read side; `invalidate()` is the write side. Both
   * flow through the dependency map below so the graph is declared once.
   */
  const [datasetVersion, setDatasetVersion] = useState<Record<string, number>>({});

  /**
   * Dataset dependency graph.
   *
   * Mutating the key dataset also makes these datasets stale, because their
   * server-rendered content is derived from it. Declared once here rather than
   * by having each mutation site remember to notify its consumers.
   *
   * Deliberately narrow: an academic-configuration change alters the levels,
   * rooms, slots and fees that classes/sessions/attendance render, so those are
   * listed — but a payment does NOT invalidate the academic catalog. Adding an
   * edge costs every consumer of that dataset a refetch, so edges are only
   * present where the displayed data genuinely derives from the source.
   */
  const DATASET_DEPENDENTS: Record<string, readonly string[]> = useMemo(() => ({
    // Academic configuration feeds class/session scheduling and the pickers
    // that classes, visitors and students render.
    academic:   ['classes', 'sessions', 'attendance'],
    // Class changes drive the session grid and the attendance register.
    classes:    ['sessions', 'attendance'],
    // Enrolling/among students changes class rosters and attendance lists.
    students:   ['attendance'],
    // Money movements change balances shown on the student and finance views.
    payments:   ['finance'],
    invoices:   ['finance', 'payments'],
    // Teacher assignment is rendered inside classes and sessions.
    teachers:   ['classes', 'sessions'],
    // Placement outcomes change visitor state and conversion eligibility.
    placement:  ['visitors'],
    // Offerings are generated from the catalog and consumed by class creation.
    offerings:  ['classes', 'academic'],
    // Branch/organization settings change fees and scoping everywhere academic.
    organization: ['academic'],
  }), []);

  /** Expand a dataset list to include everything derived from it (1 level, no cycles). */
  const expandDatasets = useCallback((datasets: string[]): string[] => {
    const out = new Set<string>();
    for (const ds of datasets) {
      out.add(ds);
      for (const dep of DATASET_DEPENDENTS[ds] ?? []) out.add(dep);
    }
    return [...out];
  }, [DATASET_DEPENDENTS]);

  /**
   * Marks datasets as changed so dependent tabs refetch on next visit AND any
   * already-mounted consumer refetches immediately.
   *
   * Call after a mutation has SUCCEEDED. A failed mutation must never reach
   * this function: nothing changed on the server, so nothing should refetch.
   */
  const invalidate = useCallback((...datasets: string[]) => {
    const affected = expandDatasets(datasets);
    setLoadedTabs((prev) => {
      const next = new Set(prev);
      for (const ds of affected) {
        for (const tab of TAB_DATASETS[ds] ?? []) next.delete(tab);
      }
      // Every backend mutation writes an audit log, so the trail is always stale.
      next.delete('audit');
      return next;
    });
    // Bump the version of every affected dataset so mounted consumers refetch.
    // `audit` is always included: every backend mutation writes an audit row, so
    // a mounted audit log is stale after any successful write anywhere.
    setDatasetVersion((prev) => {
      const next = { ...prev };
      for (const ds of [...affected, 'audit']) next[ds] = (next[ds] ?? 0) + 1;
      return next;
    });
    // The roster is cached separately (reloadStudentsLite reuses whatever is in
    // memory), so evicting tabs is not enough — mark it stale too.
    if (affected.includes('students')) setRosterStale(true);
  }, [TAB_DATASETS, expandDatasets, setRosterStale]);
  const loadingTabsRef = useRef<Set<string>>(new Set());

  // Keep the working branch in sync with the authenticated user's branch by
  // adjusting state during render (the React-sanctioned alternative to a
  // setState-in-effect): only the branch id participates, so unrelated user
  // refreshes never re-select the branch.
  const [syncedUserBranchId, setSyncedUserBranchId] = useState<string | undefined>(user?.branchId);
  if (syncedUserBranchId !== user?.branchId) {
    setSyncedUserBranchId(user?.branchId);
    setCurrentBranchId(user?.branchId || '1');
  }

  const bq = useMemo(() => ({ branchId: currentBranchId }), [currentBranchId]);



  // ---------- Existing reloaders ----------

  // Whether the roster in state is the LITE projection (id, code, name,
  // status, registration date, gender, branch — no semesters, no joins).
  // Screens needing full records call reloadStudents(), which always refetches
  // and clears this flag; a lite roster can therefore never masquerade as one.
  const [studentsAreLite, setStudentsAreLite] = useState(false);
  const [studentBalances, setStudentBalances] = useState<StudentBalanceRow[]>([]);
  // Authoritative roster totals (audit STU-H2). Never derived from the loaded page.
  const [studentSummary, setStudentSummary] = useState<StudentSummary | null>(null);
  const [attendanceSummary, setAttendanceSummary] = useState<AttendanceSummaryRow[]>([]);

  const reloadStudents = useCallback(
    () => Promise.all([
      api.get<Student[]>('/students', { ...bq, limit: '2000' }),
      // The roster page is still capped; the SUMMARY is what tells the user how
      // many students actually exist, so a truncated page can no longer be
      // presented as the whole roster (audit STU-H2).
      api.get<StudentSummary>('/students/summary', bq).catch(() => null),
    ]).then(([rows, summary]) => {
      setStudents(rows); setStudentsAreLite(false); setRosterStale(false);
      if (summary) setStudentSummary(summary);
    }),
    [bq, setRosterStale],
  );

  /**
   * Lightweight roster for tabs that only resolve a student id to a name in a
   * dropdown or lookup table (books, exams, attendance, visitors, dashboard).
   *
   * The full projection is 25 fields plus a nested `semesters` array and two
   * extra batch queries — 1.4 MB for 2,000 students. Six of eight tabs were
   * downloading all of it to render names in a picker. Lite is ~60 bytes/row.
   *
   * Reuses whatever roster is already in memory: a FULL roster obviously
   * satisfies a lookup, and a lite one already did the job. Only an empty
   * roster triggers a request, so tab switching costs nothing.
   */
  const reloadStudentsLite = useCallback(() => {
    let alreadyPopulated = false;
    // Read current state without adding `students` as a dependency, which
    // would rebuild every reloader on each roster change.
    setStudents((current) => {
      alreadyPopulated = current.length > 0;
      return current;
    });
    // Reuse an in-memory roster ONLY while it is still trusted. Previously this
    // skipped whenever anything was loaded, so a student registered on another
    // tab never appeared in pickers until a page refresh.
    if (alreadyPopulated && !rosterStaleRef.current) return Promise.resolve();
    return api
      .get<Student[]>('/students', { ...bq, limit: '2000', view: 'lite' })
      .then((rows) => { setStudents(rows); setStudentsAreLite(true); setRosterStale(false); });
  }, [bq, setRosterStale]);
  /**
   * Guarantees a FULL roster is in memory. Screens that read semesters,
   * discounts or contact details must call this rather than assuming the
   * loaded roster is complete — it may be the lite projection.
   */
  const ensureFullStudents = useCallback(() => {
    let needsUpgrade = false;
    setStudents((current) => {
      needsUpgrade = current.length === 0;
      return current;
    });
    setStudentsAreLite((lite) => {
      if (lite) needsUpgrade = true;
      return lite;
    });
    return needsUpgrade ? reloadStudents() : Promise.resolve();
  }, [reloadStudents]);

  /**
   * Per-student tuition balances, aggregated server-side.
   * Replaces reducing the paginated payments array, which silently reported
   * every student outside the first page as owing their full fee.
   */
  const reloadStudentBalances = useCallback(
    () => canViewStudentFinance
      ? api.get<StudentBalanceRow[]>('/payments/balances', bq)
          .then(setStudentBalances)
          .catch((error: unknown) => {
            if (error instanceof ApiError && error.status === 403) {
              setStudentBalances([]);
              return;
            }
            throw error;
          })
      : Promise.resolve(setStudentBalances([])),
    [bq, canViewStudentFinance],
  );

  const reloadTeachers = useCallback(() => api.get<Teacher[]>('/teachers', bq).then(setTeachers), [bq]);
  const reloadEmployees = useCallback(
    () => (canSeeFinance ? api.get<Employee[]>('/employees', bq).then(setEmployees) : Promise.resolve()),
    [bq, canSeeFinance]
  );
  const reloadPartners = useCallback(
    () => (canPickBranch ? api.get<Partner[]>('/partners').then(setPartners) : Promise.resolve()),
    [canPickBranch]
  );
  const reloadClasses = useCallback(() => api.get<Class[]>('/classes', bq).then(setClasses), [bq]);
  /**
   * Visitors are fetched one SERVER-FILTERED page at a time (UX-1).
   *
   * The previous version pulled a fixed 100 rows and let the view search,
   * filter and count inside that array: with 250 leads the conversion tile read
   * 27% against a true 11%, and searching for lead #101+ reported "no matches"
   * for a person who existed. Search and filters now travel to the server, so a
   * page is a page OF THE MATCHES, and every headline number comes from
   * `/visitors/summary` instead of being derived here.
   */
  const reloadVisitors = useCallback(
    (query?: VisitorQuery) => {
      if (!canSeeVisitors) return Promise.resolve();
      // A bare reloadVisitors() after a mutation must refresh the view the user
      // is LOOKING AT. Defaulting to an empty query would silently drop their
      // search and bounce them to page 1 every time they logged a follow-up.
      const effective = query ?? visitorQueryRef.current;
      const page = effective.page ?? 0;
      const pageSize = effective.pageSize ?? VISITOR_PAGE_SIZE;
      const params: Record<string, string | undefined> = {
        ...bq,
        limit: String(pageSize),
        offset: String(page * pageSize),
        search: effective.search || undefined,
        status: effective.status && effective.status !== 'all' ? effective.status : undefined,
        source: effective.source && effective.source !== 'all' ? effective.source : undefined,
        interest: effective.interest && effective.interest !== 'all' ? effective.interest : undefined,
        placement: effective.placement && effective.placement !== 'all' ? effective.placement : undefined,
        overdue: effective.overdueOnly ? 'true' : undefined,
      };
      const nextQuery = { ...effective, page, pageSize };
      visitorQueryRef.current = nextQuery;
      setVisitorQuery(nextQuery);
      return Promise.all([
        api.get<Visitor[]>('/visitors', params),
        api.get<VisitorSummary>('/visitors/summary', params),
      ]).then(([rows, summary]) => {
        setVisitors(rows);
        setVisitorSummary(summary);
      });
    },
    [bq, canSeeVisitors]
  );
  /**
   * Advisory possible-duplicate lookup for the registration form (UX-9).
   *
   * Never blocks a submit: it returns candidates and the operator decides.
   * Phone is deliberately not a unique key server-side because household and
   * office lines are legitimately shared.
   */
  const checkDuplicateLeads = useCallback(
    (params: { phone?: string; tazkiraNo?: string; fullName?: string }) =>
      api.get<{ candidates: DuplicateCandidate[] }>('/visitors/duplicate-check', {
        ...bq,
        phone: params.phone || undefined,
        tazkiraNo: params.tazkiraNo || undefined,
        fullName: params.fullName || undefined,
      }).then((r) => r.candidates ?? []),
    [bq]
  );

  /**
   * Ask the server whether a conversion would be accepted, before showing the
   * user a fee/payment form (UX-3). Read-only: the server answers by calling
   * into the same placement authority the write path enforces, so this can
   * never green-light something Confirm would refuse.
   */
  const checkConversionEligibility = useCallback(
    (visitorId: string, classId?: string) =>
      api.get<ConversionEligibility>(`/visitors/${visitorId}/conversion-eligibility`, {
        classId: classId || undefined,
      }),
    []
  );

  const reloadAttendance = useCallback(() => api.get<Attendance[]>('/attendance', bq).then(setAttendance), [bq]);

  /**
   * Attendance rates aggregated server-side over the full history.
   * The raw /attendance list is now bounded, so a percentage derived from it
   * would be wrong for any student with records beyond the page.
   */
  const reloadAttendanceSummary = useCallback(
    () => api.get<AttendanceSummaryRow[]>('/attendance/summary', bq).then(setAttendanceSummary),
    [bq],
  );
  const reloadPayments = useCallback(() => api.get<Payment[]>('/payments', bq).then(setPayments), [bq]);
  const reloadBooksWorkspace = useCallback(
    (page = 1) => api.get<BooksWorkspace>('/books/workspace', { ...bq, page: String(page), limit: String(BOOK_HISTORY_PAGE_SIZE) }).then(setBooksWorkspace),
    [bq],
  );
  const loadBooksHistoryPage = useCallback((page: number) => reloadBooksWorkspace(page), [reloadBooksWorkspace]);
  const reloadExams = useCallback(() => api.get<Exam[]>('/exams', bq).then(setExams), [bq]);
  const reloadExamResults = useCallback(() => api.get<ExamResult[]>('/exams/results/all', bq).then(setExamResults), [bq]);
  const reloadBudgetLines = useCallback(
    () => (canSeeFinance ? api.get<BudgetLine[]>('/finance/budget-lines', bq).then(setBudgetLines) : Promise.resolve()),
    [bq, canSeeFinance]
  );
  /**
   * The taxonomy is organization-level and identical for every branch, but it
   * is refetched alongside budget lines rather than cached forever: a stale
   * category cache is exactly how a renamed or retired subcategory keeps
   * appearing in the picker after an upgrade.
   */
  const reloadFinanceCategories = useCallback(
    () => (canSeeFinance
      ? api.get<{ categories: FinanceCategory[] }>('/finance/categories')
          .then((r) => setFinanceCategories(r.categories || []))
          .catch(() => setFinanceCategories([]))
      : Promise.resolve()),
    [canSeeFinance]
  );
  const reloadExpenseRequests = useCallback(
    () => (canSeeFinance ? api.get<ExpenseRequest[]>('/finance/expense-requests', bq).then(setExpenseRequests) : Promise.resolve()),
    [bq, canSeeFinance]
  );
  const reloadInvoices = useCallback(
    () => (canSeeFinance ? api.get<Invoice[]>('/invoices', bq).then(setInvoices).catch(() => setInvoices([])) : Promise.resolve()),
    [bq, canSeeFinance]
  );
  const reloadFinanceConfig = useCallback(
    () => (canSeeFinance ? api.get<FinanceConfig>('/invoices/config/settings').then(setFinanceConfig).catch(() => setFinanceConfig(null)) : Promise.resolve()),
    [canSeeFinance]
  );
  const reloadTransactions = useCallback(
    () => (canSeeFinance ? api.get<FinancialTransaction[]>('/finance/transactions', bq).then(setTransactions) : Promise.resolve()),
    [bq, canSeeFinance]
  );
  const reloadAuditLogs = useCallback(
    () => (canSeeAuditLog
      ? api.get<PaginatedRows<AuditLog>>('/audit-logs', { ...bq, limit: '50' }).then((page) => setAuditLogs(page.rows))
      : Promise.resolve(setAuditLogs([]))),
    [bq, canSeeAuditLog]
  );
  // The notifications endpoint chooses its default through the canonical RBAC
  // scope resolver: organization-wide principals receive every authorized
  // branch, while branch-scoped principals remain confined to their branch.
  const reloadNotifications = useCallback(
    () => api.get<Notification[]>('/notifications').then(setNotifications),
    [],
  );
  const reloadFinanceReconciliation = useCallback(
    () => (canSeeFinance ? api.get<typeof financeReconciliation>('/finance/reconciliation', bq).then(setFinanceReconciliation) : Promise.resolve()),
    [bq, canSeeFinance]
  );
  const reloadFinanceOverview = useCallback(
    () => canSeeFinance
      ? api.get<{ mainAccountBalance: number; savingBalance: number; dailySavingPercent: number; expenseAutoApproveThreshold?: number }>('/finance/overview')
          .then((o) => {
            setMainAccountBalance(o.mainAccountBalance);
            setSavingBalance(o.savingBalance);
            setDailySavingPercent(o.dailySavingPercent);
            if (o.expenseAutoApproveThreshold != null) setExpenseAutoApproveThreshold(o.expenseAutoApproveThreshold);
          })
      : Promise.resolve(),
    [canSeeFinance]
  );
  // Authoritative Dashboard KPIs. Every population metric (conversion rate,
  // pending leads, active students, per-period intake) and the cash-flow series
  // are computed in SQL server-side. The Dashboard must render these and derive
  // nothing itself.
  const reloadDashboardSummary = useCallback(
    () => api.get<DashboardSummary>('/dashboard/summary', bq).then(setDashboardSummary).catch(() => setDashboardSummary(null)),
    [bq]
  );
  const reloadFinanceDashboard = useCallback(
    () => (canSeeFinance ? api.get<FinanceDashboard>('/finance/dashboard', bq).then(setFinanceDashboard).catch(() => setFinanceDashboard(null)) : Promise.resolve()),
    [bq, canSeeFinance]
  );
  const reloadBranches = useCallback(() => api.get<Branch[]>('/branches').then(setBranches), []);
  const reloadCampuses = useCallback(() => api.get<Campus[]>('/campuses').then(setCampuses), []);
  const reloadOrganization = useCallback(() => api.get<Organization>('/organization').then(setOrganization), []);

  const createCampus = async (payload: {
    name: string; code: string; address?: string; postalCode?: string;
    phone?: string; email?: string; description?: string; isActive?: boolean;
  }) => {
    await api.post('/campuses', payload);
    await reloadCampuses();
    invalidate('organization');
  };

  const updateCampus = async (campusId: string, payload: Partial<{
    name: string; code: string; address: string; postalCode: string;
    phone: string; email: string; description: string; isActive: boolean;
  }>) => {
    await api.put(`/campuses/${campusId}`, payload);
    await reloadCampuses();
    invalidate('organization');
  };

  const deactivateCampus = async (campusId: string) => {
    await api.delete(`/campuses/${campusId}`);
    await Promise.all([reloadCampuses(), reloadBranches(), reloadOrganization()]);
    invalidate('organization');
  };

  const deleteCampus = async (campusId: string) => {
    await api.delete(`/campuses/${campusId}?permanent=true`);
    await Promise.all([reloadCampuses(), reloadBranches(), reloadOrganization()]);
    invalidate('organization');
  };

  const createBranch = async (payload: {
    name: string; code: string; campusId: string; address: string;
    postalCode?: string; phone?: string; email?: string; description?: string; isActive?: boolean;
  }) => {
    await api.post('/branches', payload);
    await reloadBranches();
    invalidate('organization');
  };

  const updateBranch = async (branchId: string, payload: Partial<{
    name: string; code: string; campusId: string; address: string;
    postalCode: string; phone: string; email: string; description: string; isActive: boolean;
  }>) => {
    await api.put(`/branches/${branchId}`, payload);
    await reloadBranches();
    invalidate('organization');
  };

  const deactivateBranch = async (branchId: string) => {
    await api.delete(`/branches/${branchId}`);
    await reloadBranches();
    invalidate('organization');
  };

  const deleteBranch = async (branchId: string) => {
    await api.delete(`/branches/${branchId}?permanent=true`);
    await Promise.all([reloadBranches(), reloadCampuses(), reloadOrganization()]);
    invalidate('organization');
  };

  const reloadSkills = useCallback(() => api.get<Skill[]>('/skills').then(setSkills), []);
  const reloadProgramVersions = useCallback(() => api.get<any[]>('/catalog/program-versions', bq).then((rows) => setProgramVersions((rows || []).map((r) => ({ id: r.id, name: r.program_name || r.programName || 'Program', versionLabel: r.version_label || r.versionLabel || 'v1', status: r.status })) )), [bq]);
  const reloadClassTeacherSkills = useCallback(() => api.get<ClassTeacherSkill[]>('/class-teacher-skills').then(setClassTeacherSkills), []);

  // ---------- 1.0.0 NEW reloaders ----------
  const reloadDonors = useCallback(
    () => (canUseFundingReference ? safeGet<Donor[]>('/funding/donors', bq, []).then(setDonors) : Promise.resolve()),
    [bq, canUseFundingReference]
  );
  const reloadFundingCampaigns = useCallback(
    () => (canUseFundingReference ? safeGet<FundingCampaign[]>('/funding/campaigns', bq, []).then(setFundingCampaigns) : Promise.resolve()),
    [bq, canUseFundingReference]
  );
  const reloadDonations = useCallback(
    () => (canViewFunding ? safeGet<Donation[]>('/funding/donations', bq, []).then(setDonations) : Promise.resolve()),
    [bq, canViewFunding]
  );
  const reloadScholarships = useCallback(
    () => (canViewFunding ? safeGet<Scholarship[]>('/funding/scholarships', bq, []).then(setScholarships) : Promise.resolve()),
    [bq, canViewFunding]
  );
  const reloadScholarshipAwards = useCallback(
    () => (canViewFunding ? safeGet<ScholarshipAward[]>('/funding/scholarships/awards', bq, []).then(setScholarshipAwards) : Promise.resolve()),
    [bq, canViewFunding]
  );
  const reloadSponsorships = useCallback(
    () => (canViewFunding ? safeGet<SponsorshipAgreement[]>('/funding/sponsorships', bq, []).then(setSponsorships) : Promise.resolve()),
    [bq, canViewFunding]
  );
  const reloadFundingSummary = useCallback(
    () => (canViewFunding ? safeGet<FundingSummary | null>('/funding/summary', bq, null).then(setFundingSummary) : Promise.resolve()),
    [bq, canViewFunding]
  );
  const reloadImpactReports = useCallback(
    () => (canViewImpact ? safeGet<ImpactReport[]>('/impact/reports', bq, []).then(setImpactReports) : Promise.resolve()),
    [bq, canViewImpact]
  );
  const reloadFundingWorkspace = useCallback(
    () => Promise.all([
      reloadDonors(), reloadFundingCampaigns(), reloadDonations(), reloadScholarships(),
      reloadScholarshipAwards(), reloadSponsorships(), reloadFundingSummary(),
    ]),
    [reloadDonations, reloadDonors, reloadFundingCampaigns, reloadFundingSummary, reloadScholarshipAwards, reloadScholarships, reloadSponsorships],
  );
  const reloadSessions = useCallback(
    () => safeGet<Session[]>('/sessions', bq, []).then(setSessions),
    [bq]
  );
  const reloadWorkflows = useCallback(
    () => safeGet<WorkflowInstance[]>('/workflows/instances', bq, []).then(setWorkflows),
    [bq]
  );
  const reloadAutomations = useCallback(
    () => safeGet<Automation[]>('/automations', undefined, []).then(setAutomations),
    []
  );
  const reloadRevenueByClass = useCallback(
    () => (canSeeFinance ? safeGet<{ name: string; revenue: number }[]>('/bos/revenue-by-class', bq, []).then(setRevenueByClass) : Promise.resolve()),
    [bq, canSeeFinance]
  );
  const reloadRevenueByTimeSlot = useCallback(
    () => (canSeeFinance ? safeGet<{ slot: string; revenue: number }[]>('/bos/revenue-by-timeslot', bq, []).then(setRevenueByTimeSlot) : Promise.resolve()),
    [bq, canSeeFinance]
  );

  const reloadBusinessRules = useCallback(
    (category: RuleCategory) =>
      safeGet<BusinessRule[]>('/rules', { category, ...bq }, []).then(rules =>
        setBusinessRules(prev => ({ ...prev, [category]: rules }))
      ),
    [bq]
  );

  const loadTab = useCallback(async (tab: string) => {
    switch (tab) {
      case 'dashboard':
        // Dashboard is intentionally non-blocking. The application shell must render
        // before operational datasets are hydrated; dashboard data loads after the
        // workspace is visible and is never allowed to hold the global startup gate.
        return Promise.all([
          // Dashboard needs student COUNTS (status, registration date), not
          // full records: the lite roster skips 18 fields and two joins.
          reloadStudentsLite(),
          reloadTeachers(),
          reloadClasses(),
          reloadVisitors(),
          reloadNotifications(),
          reloadDashboardSummary(),
          ...(canSeeFinance
            ? [reloadFinanceOverview(), reloadFinanceDashboard(), reloadRevenueByClass(), reloadRevenueByTimeSlot()]
            : []),
          ...(canSeeAuditLog ? [reloadAuditLogs()] : []),
        ]);
      case 'students':
        return Promise.all([reloadStudents(), reloadStudentBalances(), reloadAttendanceSummary(), reloadClasses(), reloadProgramVersions()]);
      case 'teachers':
        return Promise.all([reloadTeachers(), reloadEmployees(), reloadSkills(), reloadClassTeacherSkills()]);
      case 'classes':
        return Promise.all([reloadClasses(), reloadTeachers(), reloadSkills(), reloadClassTeacherSkills(), reloadSessions()]);
      case 'visitors':
        return Promise.all([reloadVisitors(), reloadStudentsLite(), reloadClasses(), reloadProgramVersions()]);
      case 'books':
        return Promise.all([reloadBooksWorkspace(), reloadStudentsLite()]);
      case 'finance':
        return Promise.all([reloadBudgetLines(), reloadFinanceOverview()]);
      case 'exams':
        return Promise.all([reloadExams(), reloadExamResults(), reloadStudentsLite(), reloadClasses()]);
      case 'attendance':
        return Promise.all([reloadAttendance(), reloadAttendanceSummary(), reloadSessions(), reloadStudentsLite(), reloadClasses()]);
      case 'academic-setup':
        return Promise.all([reloadBranches(), reloadCampuses(), reloadOrganization(), reloadSkills(), reloadProgramVersions()]);
      case 'settings':
        return Promise.all([reloadBranches(), reloadCampuses(), reloadOrganization(), reloadPartners()]);
      case 'funding':
        return reloadFundingWorkspace();
      case 'impact':
        return Promise.all([reloadImpactReports(), reloadDonors(), reloadFundingCampaigns()]);
      case 'workflows':
        return Promise.all([reloadWorkflows(), reloadAutomations()]);
      case 'rules':
        return Promise.resolve();
      case 'audit':
        return reloadAuditLogs();
      case 'operations-report':
        return Promise.all([reloadStudentsLite(), reloadClasses(), reloadVisitors()]);
      default:
        return Promise.resolve();
    }
  }, [
    canSeeAuditLog, canSeeFinance, reloadAuditLogs, reloadAttendance, reloadAttendanceSummary, reloadAutomations, reloadBooksWorkspace,
    reloadBranches, reloadBudgetLines, reloadCampuses, reloadClasses, reloadClassTeacherSkills, reloadDashboardSummary,
    reloadDonors, reloadEmployees, reloadExamResults, reloadExams, reloadFinanceDashboard, reloadFinanceOverview,
    reloadFundingCampaigns, reloadFundingWorkspace, reloadImpactReports, reloadNotifications, reloadOrganization,
    reloadPartners, reloadProgramVersions, reloadRevenueByClass, reloadRevenueByTimeSlot, reloadSessions,
    reloadSkills, reloadStudents, reloadStudentsLite, reloadStudentBalances, reloadTeachers, reloadVisitors,
    reloadWorkflows,
  ]);

  const ensureTabData = useCallback(async (tab: string) => {
    if (!user || loadedTabs.has(tab) || loadingTabsRef.current.has(tab)) return;
    loadingTabsRef.current.add(tab);
    setIsTabLoading(true);
    try {
      await loadTab(tab);
      setLoadedTabs((prev) => new Set(prev).add(tab));
    } finally {
      loadingTabsRef.current.delete(tab);
      setIsTabLoading(false);
    }
  }, [loadTab, loadedTabs, user]);

  const ensureFinanceSection = useCallback(async (section: string) => {
    if (!user || loadingTabsRef.current.has(`finance:${section}`)) return;
    const key = `finance:${section}`;
    loadingTabsRef.current.add(key);
    setIsTabLoading(true);
    try {
      switch (section) {
        case 'overview':
          await Promise.all([reloadFinanceOverview(), reloadBudgetLines(), reloadFinanceCategories(), reloadFinanceDashboard()]);
          break;
        case 'budgets':
          await Promise.all([reloadBudgetLines(), reloadFinanceCategories()]);
          break;
        case 'expenses':
          await Promise.all([reloadExpenseRequests(), reloadBudgetLines(), reloadFinanceCategories()]);
          break;
        case 'ops':
          await Promise.all([reloadExpenseRequests(), reloadBudgetLines(), reloadFinanceCategories()]);
          break;
        case 'invoices':
          await Promise.all([reloadInvoices(), reloadFinanceConfig(), reloadStudents()]);
          break;
        case 'ledger':
        case 'pnl':
          await Promise.all([reloadTransactions(), reloadBudgetLines()]);
          break;
        case 'reconciliation':
          await reloadFinanceReconciliation();
          break;
        case 'closing':
          await Promise.all([reloadBudgetLines(), reloadFinanceCategories(), reloadFinanceOverview()]);
          break;
        default:
          break;
      }
    } finally {
      loadingTabsRef.current.delete(key);
      setIsTabLoading(false);
    }
  }, [reloadBudgetLines, reloadFinanceCategories, reloadExpenseRequests, reloadFinanceConfig, reloadFinanceOverview, reloadFinanceDashboard, reloadFinanceReconciliation, reloadInvoices, reloadStudents, reloadTransactions, user]);

  const reloadAll = useCallback(async () => {
    setIsLoading(true);
    setLoadedTabs(new Set());
    loadingTabsRef.current.clear();
    // Branch switch / re-login: bump EVERY known dataset so components that are
    // still mounted refetch under the new scope instead of continuing to show
    // the previous branch's rows. Bumping (rather than resetting to 0) keeps the
    // counter monotonic, so a late response from the old branch can still be
    // recognised as stale by the consumers' request-generation guards.
    setDatasetVersion((prev) => {
      const next: Record<string, number> = { ...prev };
      for (const ds of Object.keys(TAB_DATASETS)) next[ds] = (next[ds] ?? 0) + 1;
      for (const ds of Object.keys(DATASET_DEPENDENTS)) next[ds] = (next[ds] ?? 0) + 1;
      return next;
    });

    // Startup should establish only the application shell and scope metadata.
    // Operational collections are hydrated by ensureTabData after the first paint.
    await Promise.all([reloadBranches(), reloadCampuses(), reloadOrganization()]);

    setLoadedTabs(new Set(['navigation']));
    setIsLoading(false);
  }, [reloadBranches, reloadCampuses, reloadOrganization, TAB_DATASETS, DATASET_DEPENDENTS]);

  useEffect(() => {
    void (async () => {
      // Student portal accounts have no administrative permissions — skip the
      // admin data load entirely (every call would 403 and waste the quota).
      if (user && user.role !== 'student') await reloadAll();
    })();
  }, [user, currentBranchId, reloadAll]);

  const currentBranchName = useMemo(() => {
    const b = branches.find((x) => x.id === currentBranchId);
    if (!b) return 'Unknown branch';
    const campus = campuses.find((c) => c.id === b.campusId);
    if (campus) return `${campus.name} / ${b.name}`;
    return b.name;
  }, [branches, campuses, currentBranchId]);

  const changeBranch = (branchId: string) => { if (canPickBranch) setCurrentBranchId(branchId); };

  const settings = {
    currentBranchId,
    currentRoleId: user?.role || 'receptionist',
    dailySavingPercent,
    branches,
    campuses,
    organization,
    programVersions,
  };

  // ================= Existing business operations =================
  const addVisitor = async (
    fullName: string, phone: string, gender: 'male' | 'female', source: Visitor['source'],
    notes?: string, interestedCourse?: string,
    followUpStatus?: 'high_interest' | 'medium_interest' | 'low_interest' | 'not_answering' | 'no_interest',
    nextContactDate?: string, fatherName?: string, addressRegion?: string, tazkiraNo?: string, whatsapp?: string,
    dob?: string, schoolOrUniversity?: string, emergencyContactName?: string, emergencyContactPhone?: string,
    branchId?: string, email?: string, programVersionId?: string
  ) => {
    const created = await api.post<{ id: string; serialNo: string }>('/visitors', {
      fullName, phone, email, gender, source, notes, interestedCourse, followUpStatus, nextContactDate,
      fatherName, addressRegion, tazkiraNo, whatsapp, dob, schoolOrUniversity,
      emergencyContactName, emergencyContactPhone, branchId, programVersionId,
    });
    await reloadVisitors();
    invalidate('visitors');
    return created;
  };

  const updateVisitorCRM = async (visitorId: string, interestedCourse: string,
    followUpStatus: 'high_interest' | 'medium_interest' | 'low_interest' | 'not_answering' | 'no_interest',
    nextContactDate: string, notes?: string) => {
    await api.patch(`/visitors/${visitorId}/crm`, { interestedCourse, followUpStatus, nextContactDate, notes });
    await reloadVisitors();
    invalidate('visitors');
  };

  const addVisitorFollowUp = async (visitorId: string, notes: string, outcome?: string, nextContactDate?: string) => {
    await api.post(`/visitors/${visitorId}/followups`, { notes, outcome: outcome || null, nextContactDate: nextContactDate || null });
    await reloadVisitors();
    invalidate('visitors');
  };

  const updateVisitor = async (visitorId: string, updatedFields: Partial<Visitor>) => {
    await api.patch(`/visitors/${visitorId}`, updatedFields);
    await reloadVisitors();
    invalidate('visitors');
  };

  const advanceVisitorStage = async (visitorId: string, stage?: PipelineStage) => {
    // Send the stage we believe the visitor is currently in. The server uses it
    // as an optimistic-concurrency token: if another operator (or a double
    // click) already advanced this lead, the request is rejected with 409
    // instead of chaining a second transition on top (audit V-7).
    const current = visitors.find((v) => v.id === visitorId)?.stage;
    await api.post(`/visitors/${visitorId}/advance-stage`, {
      ...(stage ? { stage } : {}),
      ...(current ? { fromStage: current } : {}),
    });
    await reloadVisitors();
    invalidate('visitors');
  };

  const registerVisitorToStudent = async (
    visitorId: string,
    payload: { classId?: string; notes?: string; branchId?: string; programVersionId?: string; levelId?: string }
  ) => {
    const result = await api.post<{ studentId: string; studentCode: string; invoices: Array<{ id: string; invoiceNumber: string | null; chargeKind: 'registration' | 'placement'; amount: number; status: string }>; nextStep: string }>(`/visitors/${visitorId}/convert`, payload);
    await Promise.all([reloadVisitors(), reloadStudents(), reloadPayments(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications(), reloadInvoices()]);
    invalidate('finance', 'payments', 'students', 'visitors');
    return result;
  };


  const addStudentManual = async (
    fullName: string, phone: string, email: string, gender: 'male' | 'female', discountPercent: number,
    notes?: string, classId?: string, fatherName?: string, addressRegion?: string,
    tazkiraNo?: string, whatsapp?: string, dob?: string, schoolOrUniversity?: string,
    emergencyContactName?: string, emergencyContactPhone?: string, branchId?: string
  ) => {
    await api.post('/students/manual', {
      fullName, phone, email, gender, discountPercent, notes, classId, fatherName, addressRegion,
      tazkiraNo, whatsapp, dob, schoolOrUniversity, emergencyContactName, emergencyContactPhone, branchId,
    });
    await Promise.all([reloadStudents(), reloadPayments(), reloadTransactions(), reloadFinanceOverview(), reloadInvoices()]);
    invalidate('finance', 'payments', 'students');
  };

  const updateStudentStatus = async (
    studentId: string,
    status: 'active' | 'inactive' | 'graduated' | 'suspended',
    fromStatus?: Student['status'],
  ) => {
    if (status === 'suspended') {
      await api.post(`/students/${studentId}/suspend`, {});
    } else if (fromStatus === 'suspended' && status === 'active') {
      // Search results may not be present in the cached roster. Carry the
      // profile's authoritative current status into dispatch so Resume never
      // degrades into the forbidden ordinary status PATCH on those rows.
      await api.post(`/students/${studentId}/resume`, {});
    } else {
      await api.patch(`/students/${studentId}/status`, { status });
    }
    await reloadStudents();
    invalidate('students');
  };

  const updateStudent = async (studentId: string, updatedFields: Partial<Student>) => {
    await api.patch(`/students/${studentId}`, updatedFields);
    await reloadStudents();
    invalidate('students');
  };

  const enrollStudentSemester = async (studentId: string, semesterName: string, classId: string,
    tuitionAmount: number, amountPaidNow?: number, notes?: string) => {
    await api.post(`/students/${studentId}/enroll-semester`, { semesterName, classId, tuitionAmount, amountPaidNow, notes });
    await Promise.all([reloadStudents(), reloadPayments(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications()]);
    invalidate('finance', 'payments', 'students');
  };

  const issueStudentCard = async (studentId: string, cardDesign: { primaryColor: string; bgStyle: string; photo?: string | null; officePhone?: string; whatsapp?: string; socials?: { facebook?: string; instagram?: string; website?: string } }, notes?: string) => {
    const result = await api.post<{ feeCharged: number }>(`/students/${studentId}/issue-card`, { cardDesign, notes });
    await Promise.all([reloadStudents(), reloadPayments(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications()]);
    invalidate('finance', 'payments', 'students');
    return result;
  };

  const chargeBudget = async (budgetLineId: string, amount: number) => {
    await api.post(`/finance/budget-lines/${budgetLineId}/charge`, { amount });
    await Promise.all([reloadBudgetLines(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications()]);
    invalidate('finance');
  };

  const createExpenseRequest = async (
    title: string,
    amount: number,
    budgetLineId: string,
    meta?: { expenseKind?: ExpenseKind; billPeriod?: string; paymentMethod?: 'cash' | 'card' | 'bank_transfer'; notes?: string }
  ) => {
    await api.post('/finance/expense-requests', { title, amount, budgetLineId, ...meta });
    await Promise.all([reloadExpenseRequests(), reloadNotifications()]);
    invalidate('finance');
  };

  const recordOperationalPayment = async (input: OperationalPaymentInput) => {
    const result = await api.post<{ id: string; status: string; autoApproved: boolean; threshold: number }>(
      '/finance/operational-payments',
      input
    );
    await Promise.all([
      reloadExpenseRequests(),
      reloadBudgetLines(),
      reloadTransactions(),
      reloadFinanceOverview(),
      reloadNotifications(),
    ]);
    invalidate('finance');
    return result;
  };

  const getExpenseReport = async (year: string, month: string = 'all') => {
    return api.get<ExpenseReport>('/finance/expense-report', { year, month });
  };

  const updateExpenseAutoApproveThreshold = async (threshold: number) => {
    await api.put('/finance/expense-auto-approve-threshold', { threshold });
    setExpenseAutoApproveThreshold(threshold);
    invalidate('finance', 'settings');
  };

  const processExpenseApproval = async (requestId: string, isApproved: boolean, rejectReason?: string) => {
    await api.post(`/finance/expense-requests/${requestId}/decide`, { isApproved, rejectReason });
    // Approving pays the expense from its budget line and writes an `expense`
    // ledger row, so the overview totals move (verified: expense 20000 ->
    // 27000, net 480000 -> 473000).
    await Promise.all([reloadExpenseRequests(), reloadBudgetLines(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications()]);
    invalidate('finance');
  };

  const runSavingEngine = async () => {
    await api.post('/finance/saving-engine/run');
    await Promise.all([reloadFinanceOverview(), reloadTransactions(), reloadNotifications()]);
    invalidate('finance');
  };

  const updateSavingSettings = async (percent: number) => {
    await api.put('/finance/saving-engine/settings', { percent });
    await reloadFinanceOverview();
    invalidate('finance');
  };

  const processMonthEnd = async (budgetLineId: string, decision: 'return' | 'transfer', targetBudgetLineId?: string) => {
    await api.post(`/finance/budget-lines/${budgetLineId}/month-end`, { decision, targetBudgetLineId });
    await Promise.all([reloadBudgetLines(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications()]);
    invalidate('finance');
  };

  const createBookCatalogItem = async (input: {
    title: string;
    itemKind: 'book' | 'chapter';
    saleEnabled: boolean;
    salePrice?: number | null;
    lendingEnabled: boolean;
    initialQuantity: number;
    receivedOn?: string;
    unitCost?: number | null;
    note?: string;
  }) => {
    await api.post('/books/catalog', { ...input, branchId: currentBranchId }, undefined, { 'Idempotency-Key': crypto.randomUUID() });
    await reloadBooksWorkspace();
    invalidate('books');
  };

  const updateBookCatalogItem = async (bookId: string, input: {
    title?: string;
    saleEnabled?: boolean;
    salePrice?: number | null;
    lendingEnabled?: boolean;
    defaultUnitCost?: number | null;
    status?: 'active' | 'archived';
  }) => {
    await api.patch(`/books/catalog/${bookId}`, input);
    await reloadBooksWorkspace();
    invalidate('books');
  };

  const receiveBookStock = async (bookId: string, input: { quantity: number; receivedOn?: string; unitCost?: number | null; note?: string }) => {
    await api.post(`/books/catalog/${bookId}/receipts`, input, undefined, { 'Idempotency-Key': crypto.randomUUID() });
    await reloadBooksWorkspace();
    invalidate('books');
  };

  const recordBookSale = async (bookId: string, input: {
    quantity: number;
    purchaserName?: string;
    studentId?: string;
    discountAmount?: number;
    paymentMethod?: 'cash' | 'card' | 'bank_transfer';
    soldOn?: string;
  }) => {
    await api.post(`/books/catalog/${bookId}/sales`, input, undefined, { 'Idempotency-Key': crypto.randomUUID() });
    await Promise.all([reloadBooksWorkspace(), reloadFinanceOverview(), reloadTransactions(), reloadNotifications()]);
    invalidate('books', 'finance');
  };

  const returnBookSale = async (saleId: string, input: { reason: string; returnedOn?: string }) => {
    await api.post(`/books/sales/${saleId}/return`, input, undefined, { 'Idempotency-Key': crypto.randomUUID() });
    await Promise.all([reloadBooksWorkspace(), reloadFinanceOverview(), reloadTransactions(), reloadNotifications()]);
    invalidate('books', 'finance');
  };

  const issueBookLoan = async (bookId: string, input: { studentId: string; dueOn: string; issuedOn?: string }) => {
    await api.post(`/books/catalog/${bookId}/loans`, input, undefined, { 'Idempotency-Key': crypto.randomUUID() });
    await reloadBooksWorkspace();
    // The command appends the student's canonical Journey chronology, so a
    // mounted timeline must refetch as well as the Books workspace.
    invalidate('books', 'students');
  };

  const returnBookLoan = async (loanId: string, input: { returnedOn?: string; note?: string }) => {
    await api.post(`/books/loans/${loanId}/return`, input, undefined, { 'Idempotency-Key': crypto.randomUUID() });
    await reloadBooksWorkspace();
    // A return is another Journey fact; it is not a cash mutation.
    invalidate('books', 'students');
  };

  // ================= Exams (Two-Phase Workflow) =================
  const registerExam = async (title: string, date: string, fee: number) => {
    await api.post('/exams', { title, date, fee });
    await reloadExams();
    invalidate('exams');
  };

  const editExam = async (examId: string, payload: { title: string; date: string; fee: number }) => {
    await api.put(`/exams/${examId}`, payload);
    await reloadExams();
    invalidate('exams');
  };

  const deleteExam = async (examId: string) => {
    await api.delete(`/exams/${examId}`);
    await Promise.all([reloadExams(), reloadExamResults()]);
    invalidate('exams');
  };

  const enrollExamCandidate = async (payload: { examId: string; studentId?: string; visitorId?: string; feePaid: boolean }) => {
    await api.post(`/exams/${payload.examId}/enroll`, payload);
    await Promise.all([reloadExamResults(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications()]);
    invalidate('exams', 'finance');
  };

  const addExamResult = async (payload: { examId: string; resultId: string; score: number; certIssued: boolean }) => {
    await api.patch(`/exams/${payload.examId}/results/${payload.resultId}`, { score: payload.score, certIssued: payload.certIssued });
    await Promise.all([reloadExamResults(), reloadFinanceOverview(), reloadTransactions()]);
    invalidate('exams', 'finance');
  };

  const correctExamScore = async (payload: { examId: string; resultId: string; score: number }) => {
    await api.put(`/exams/${payload.examId}/results/${payload.resultId}/correct`, { score: payload.score });
    await Promise.all([reloadExamResults(), reloadFinanceOverview()]);
    invalidate('exams', 'finance');
  };

  const addTeacher = async (fullName: string, phone: string, email: string, baseSalary: number,
    salaryType: TeacherContractType = 'fixed', specialization?: string, qualification?: string, contractType?: 'monthly' | 'hourly' | 'per_session', branchId?: string, defaultSkillRate?: number) => {
    await api.post('/teachers', {
      fullName, phone, email, baseSalary, salaryType, specialization, qualification, contractType, defaultSkillRate,
      branchId: branchId || currentBranchId,
    });
    await reloadTeachers();
    invalidate('teachers');
  };

  const transferTeacher = async (teacherId: string, targetBranchId: string) => {
    const result = await api.post<{ ok: boolean; unassignedActiveClasses?: string[] }>(
      `/teachers/${teacherId}/transfer`,
      { targetBranchId }
    );
    await reloadTeachers();
    invalidate('teachers');
    return result;
  };

  const editTeacher = async (id: string, fullName: string, phone: string, email: string, baseSalary: number,
    salaryType?: TeacherContractType, specialization?: string, qualification?: string,
    contractType?: 'monthly' | 'hourly' | 'per_session', status?: 'active' | 'inactive' | 'on_leave',
    defaultSkillRate?: number) => {
    await api.put(`/teachers/${id}`, { fullName, phone, email, baseSalary, salaryType, specialization, qualification, contractType, status, defaultSkillRate });
    await reloadTeachers();
    invalidate('teachers');
  };

  const deleteTeacher = async (id: string) => {
    await api.delete(`/teachers/${id}`);
    await reloadTeachers();
    invalidate('teachers');
  };

  const getTeacherComputedSalary = async (teacherId: string) => {
    return api.get<{ model: string; due: number; base: number; skillsTotal: number; skillCount: number; targetSkills: number; shortfall: number; excess: number; breakdown: any[]; warnings: string[]; isBlocked: boolean; blockReason?: string }>(`/teachers/${teacherId}/computed-salary`);
  };

  const getTeacherSalaryStatus = async (teacherId: string, monthName: string) => {
    return api.get<TeacherSalaryStatus>(`/teachers/${teacherId}/salary-status`, { month: monthName });
  };

  const payTeacherSalary = async (teacherId: string, monthName: string, amountPaid: number, paymentType: 'full' | 'partial') => {
    await api.post(`/teachers/${teacherId}/pay-salary`, { monthName, amountPaid, paymentType });
    // A salary payment writes an `expense` ledger row, so GET /finance/overview
    // returns different `expense` and `net` totals immediately afterwards
    // (verified: expense 0 -> 20000, net 500000 -> 480000). Without reloading
    // it the finance header keeps showing the pre-payment net until something
    // else happens to refresh it.
    await Promise.all([reloadBudgetLines(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications()]);
    invalidate('finance');
  };

  const addEmployee = async (fullName: string, phone: string, email: string, role: string, baseSalary: number, branchId?: string) => {
    await api.post('/employees', { fullName, phone, email, role, baseSalary, branchId: branchId || currentBranchId });
    await reloadEmployees();
    invalidate('teachers');
  };

  const editEmployee = async (id: string, fullName: string, phone: string, email: string, role: string, baseSalary: number, status: 'active' | 'inactive') => {
    await api.put(`/employees/${id}`, { fullName, phone, email, role, baseSalary, status });
    await reloadEmployees();
    invalidate('teachers');
  };

  const deleteEmployee = async (id: string) => {
    await api.delete(`/employees/${id}`);
    await reloadEmployees();
    invalidate('teachers');
  };

  const transferEmployee = async (employeeId: string, targetBranchId: string) => {
    const result = await api.post<{ ok: boolean }>(`/employees/${employeeId}/transfer`, { targetBranchId });
    await reloadEmployees();
    invalidate('teachers');
    return result;
  };

  const payEmployeeSalary = async (employeeId: string, monthName: string, amountPaid: number, paymentType: 'full' | 'partial' | 'advance') => {
    await api.post(`/employees/${employeeId}/pay-salary`, { monthName, amountPaid, paymentType });
    // Same as teacher payroll: this moves `expense` and `net` on the overview.
    await Promise.all([reloadBudgetLines(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications()]);
    invalidate('finance');
  };

  // ================= Class Management & LMS =================
  const addClass = async (
    name: string, teacherId: string, level: string, capacity: number, scheduleTime: string,
    startDate: string, endDate: string, fee: number, extras?: {
      programId?: string; levelId?: string; roomId?: string; timeSlotId?: string;
      academicTermId?: string; activationDate?: string; genderPolicy?: 'female' | 'male' | 'mixed';
      minViableSize?: number; branchId?: string;
    }
  ) => {
    await api.post('/classes', {
      name, teacherId, level, capacity, scheduleTime, startDate, endDate, fee,
      genderPolicy: extras?.genderPolicy || 'mixed', programId: extras?.programId, levelId: extras?.levelId,
      roomId: extras?.roomId, timeSlotId: extras?.timeSlotId, academicTermId: extras?.academicTermId,
      activationDate: extras?.activationDate, minViableSize: extras?.minViableSize, branchId: extras?.branchId,
    });
    await reloadClasses();
    invalidate('classes');
  };

  const editClass = async (
    id: string, name: string, teacherId: string, level: string, capacity: number,
    scheduleTime: string, startDate: string, endDate: string, fee: number,
    status?: 'active' | 'completed', genderPolicy?: 'female' | 'male' | 'mixed'
  ) => {
    await api.put(`/classes/${id}`, {
      name, teacherId, level, capacity, scheduleTime, startDate, endDate, fee, status,
      genderPolicy: genderPolicy || 'mixed',
    });
    await reloadClasses();
    invalidate('classes');
  };

  const deleteClass = async (id: string) => {
    await api.delete(`/classes/${id}`);
    await reloadClasses();
    invalidate('classes');
  };

  const mergeClass = async (sourceId: string, targetClassId: string) => {
    const result = await api.post<{ ok: boolean; movedStudents: number }>(`/classes/${sourceId}/merge`, { targetClassId });
    await reloadClasses();
    invalidate('classes');
    return result;
  };

  const getClassMergeCandidates = async (classId: string) =>
    api.get<{
      source: { id: string; name: string; enrolled: number; capacity: number; minViableSize: number; underMin: boolean };
      candidates: Array<{ id: string; name: string; level: string; scheduleTime: string; capacity: number; enrolled: number; freeSeats: number; }>;
    }>(`/classes/${classId}/merge-candidates`);

  const recordAttendance = async (date: string,
    records: { targetId: string; targetType: 'student' | 'teacher'; status: 'present' | 'absent' | 'sick' | 'leave'; classId?: string }[]) => {
    await api.post('/attendance', { date, records });
    await reloadAttendance();
    invalidate('attendance');
  };

  // --- NEW: Class LMS & Gradebook Operations ---
  const activateClass = async (classId: string) => {
    await api.post(`/classes/${classId}/activate`);
    await reloadClasses();
    invalidate('classes');
  };

  const getClassGradebook = async (classId: string) => {
    return api.get<{
      students: Array<{ id: string; full_name: string; student_code: string; semester_id: string }>;
      assessments: Array<{ id: string; title: string; type: string; weight: number; max_score: number }>;
      grades: Array<{ id: string; assessment_id: string; student_id: string; score: number; status: string }>;
    }>(`/classes/${classId}/gradebook`);
  };

  const createClassAssessment = async (classId: string, payload: { title: string; type: string; weight: number; maxScore: number; date?: string }) => {
    await api.post(`/classes/${classId}/assessments`, payload);
    invalidate('academic', 'classes');
  };

  const saveClassGrades = async (classId: string, grades: Array<{ assessmentId: string; studentId: string; score: number; status: string }>) => {
    await api.put(`/classes/${classId}/grades`, { grades });
    invalidate('academic', 'classes');
  };

  const completeClassSemester = async (classId: string) => {
    await api.post(`/classes/${classId}/complete-semester`);
    await Promise.all([reloadClasses(), reloadStudents()]); // Reload students as their status might change
    invalidate('classes', 'students');
  };

  // ================= Admin & Settings =================
  const addPartner = async (fullName: string, phone: string, email: string, sharePercent: number, roleDescription: string) => {
    await api.post('/partners', { fullName, phone, email, sharePercent, roleDescription });
    await reloadPartners();
    invalidate('settings');
  };

  const editPartner = async (id: string, fullName: string, phone: string, email: string, sharePercent: number, roleDescription: string) => {
    await api.put(`/partners/${id}`, { fullName, phone, email, sharePercent, roleDescription });
    await reloadPartners();
    invalidate('settings');
  };

  const deletePartner = async (id: string) => {
    await api.delete(`/partners/${id}`);
    await reloadPartners();
    invalidate('settings');
  };

  const addSkill = async (name: string) => {
    await api.post('/skills', { name });
    await reloadSkills();
    invalidate('skills');
  };

  const assignTeacherSkill = async (classId: string, teacherId: string, skillId: string, monthlyRate: number) => {
    await api.post('/class-teacher-skills', { classId, teacherId, skillId, monthlyRate });
    await Promise.all([reloadClassTeacherSkills(), reloadTeachers()]);
    invalidate('skills', 'teachers');
  };

  const editTeacherSkillRate = async (assignmentId: string, monthlyRate: number) => {
    await api.put(`/class-teacher-skills/${assignmentId}`, { monthlyRate });
    await reloadClassTeacherSkills();
    invalidate('skills');
  };

  const removeTeacherSkill = async (assignmentId: string) => {
    await api.delete(`/class-teacher-skills/${assignmentId}`);
    await reloadClassTeacherSkills();
    invalidate('skills');
  };


  const listUserAccounts = async () => api.get<any[]>('/users');
  const createUserAccount = async (params: any) => { await api.post('/users', params); invalidate('settings'); };
  const updateUserAccount = async (userId: string, updates: any) => { await api.patch(`/users/${userId}`, updates); invalidate('settings'); };
  const resetUserPassword = async (userId: string, tempPassword: string) => {
    await api.post(`/users/${userId}/reset-password`, { tempPassword });
  };

  // ── Positions & access (owner-only, data-driven position lifecycle) ──
  const listPositions = async () => api.get<any[]>('/security/roles');
  const listPermissionCatalog = async () => api.get<any[]>('/security/permissions');
  const createPosition = async (params: { name: string; description?: string; permissions?: { permissionId: string; scope?: string }[] }) => {
    const created = await api.post<any>('/security/roles', params);
    invalidate('settings');
    return created;
  };
  const updatePosition = async (roleId: string, updates: { name?: string; description?: string; isActive?: boolean }): Promise<void> => {
    await api.patch(`/security/roles/${roleId}`, updates);
    invalidate('settings');
  };
  const updatePositionPermissions = async (roleId: string, permissions: { permissionId: string; scope?: string }[]): Promise<void> => {
    await api.put(`/security/roles/${roleId}/permissions`, { permissions });
    invalidate('settings');
  };
  const listUserPositions = async (userId: string) => api.get<any[]>(`/security/users/${userId}/roles`);
  const assignUserPosition = async (userId: string, params: { roleId: string; scopeType?: string; scopeId?: string | null }): Promise<void> => {
    await api.post(`/security/users/${userId}/roles`, params);
    invalidate('settings');
  };
  const removeUserPosition = async (userId: string, assignmentId: string): Promise<void> => {
    await api.delete(`/security/users/${userId}/roles/${assignmentId}`);
    invalidate('settings');
  };
  const viewEffectivePermissions = async (userId: string) => api.get<any[]>(`/security/users/${userId}/effective-permissions`);

  // BOS Analytics
  const getExecutiveDashboard = async (timeframe?: string) => api.get<any>('/bos/executive-dashboard', timeframe ? { timeframe } : undefined);
  const getMarketingFunnel = async (timeframe?: string) => api.get<any>('/bos/marketing-funnel', timeframe ? { timeframe } : undefined);
  const getStudentAnalytics = async (timeframe?: string) => api.get<any>('/bos/student-analytics', timeframe ? { timeframe } : undefined);
  const getDecisionWarnings = async () => api.get<any>('/bos/decision-warnings');
  const getProfitDistribution = async () => api.get<any>('/bos/profit-distribution/calculate');

  const withdrawProfitDistribution = async (amount: number, recipientPartnerId?: string, notes?: string) => {
    await api.post('/bos/profit-distribution/withdraw', { amount, recipientPartnerId, notes });
    await Promise.all([
      reloadFinanceOverview(),
      reloadFinanceDashboard(),
      reloadDashboardSummary(),
      reloadTransactions(),
      reloadRevenueByClass(),
      reloadRevenueByTimeSlot(),
      reloadNotifications(),
    ]);
    invalidate('finance');
  };

  /** Create a branch budget envelope under a canonical subcategory. */
  const createBudgetLine = async (input: BudgetLineInput) => {
    await api.post('/finance/budget-lines', input);
    await reloadBudgetLines();
    invalidate('finance');
  };

  /** Rename, reclassify the cost type of, or retire a budget envelope. */
  const updateBudgetLine = async (
    budgetLineId: string,
    patch: { name?: string; costType?: 'fixed' | 'variable'; isActive?: boolean; channelId?: string | null },
  ) => {
    await api.patch(`/finance/budget-lines/${budgetLineId}`, patch);
    await reloadBudgetLines();
    invalidate('finance');
  };

  // ================= 1.0.0 NEW operations =================
  const refreshFundingWorkspace = async () => {
    await Promise.all([reloadFundingWorkspace(), reloadTransactions(), reloadFinanceOverview()]);
    invalidate('finance', 'funding');
  };

  const addDonor = async (data: Pick<Donor, 'fullName' | 'type'> & Partial<Pick<Donor, 'phone' | 'email' | 'country' | 'notes'>>) => {
    await api.post('/funding/donors', data);
    await refreshFundingWorkspace();
    invalidate('funding');
  };

  const editDonor = async (id: string, data: Partial<Pick<Donor, 'fullName' | 'type' | 'phone' | 'email' | 'country' | 'notes'>>) => {
    await api.put(`/funding/donors/${id}`, data);
    await refreshFundingWorkspace();
    invalidate('funding');
  };

  const addFundingCampaign = async (data: Pick<FundingCampaign, 'name' | 'targetAmount'> & Partial<Pick<FundingCampaign, 'description' | 'donorId' | 'startDate' | 'endDate'>>) => {
    await api.post('/funding/campaigns', { ...data, branchId: currentBranchId });
    await refreshFundingWorkspace();
    invalidate('funding');
  };

  const recordDonation = async (data: {
    donorId: string; amount: number; date?: string; campaignId?: string | null; restriction?: DonationRestriction | null;
  }) => {
    await api.post('/funding/donations', { ...data, branchId: currentBranchId });
    await refreshFundingWorkspace();
    invalidate('funding', 'finance');
  };

  const addScholarship = async (data: Pick<Scholarship, 'name' | 'totalBudget'> & Partial<Pick<Scholarship, 'donorId' | 'campaignId' | 'criteria'>>) => {
    await api.post('/funding/scholarships', { ...data, branchId: currentBranchId });
    await refreshFundingWorkspace();
    invalidate('funding');
  };

  const awardScholarship = async (data: Pick<ScholarshipAward, 'scholarshipId' | 'studentId' | 'amount'> & Partial<Pick<ScholarshipAward, 'awardDate' | 'notes'>>) => {
    await api.post('/funding/scholarships/award', { ...data, branchId: currentBranchId });
    await Promise.all([refreshFundingWorkspace(), reloadStudents()]);
    invalidate('students');
  };

  const addSponsorship = async (data: Pick<SponsorshipAgreement, 'donorId' | 'monthlyAmount' | 'startDate' | 'endDate'> & Partial<Pick<SponsorshipAgreement, 'studentId' | 'programId' | 'campaignId'>>) => {
    await api.post('/funding/sponsorships', { ...data, branchId: currentBranchId });
    await refreshFundingWorkspace();
    invalidate('funding');
  };

  const generateImpactReport = async (input: { period: string; scopeKind: 'branch' | 'donor' | 'campaign'; scopeId?: string | null }) => {
    const report = await api.post<ImpactReport>('/impact/reports/generate', { ...input, branchId: currentBranchId });
    await reloadImpactReports();
    invalidate('impact');
    return report;
  };

  const approveWorkflowStep = async (instanceId: string, notes?: string) => {
    await api.post(`/workflows/instances/${instanceId}/approve`, { notes });
    await reloadWorkflows();
    invalidate('workflows');
  };

  const rejectWorkflowStep = async (instanceId: string, reason: string) => {
    await api.post(`/workflows/instances/${instanceId}/reject`, { reason });
    await reloadWorkflows();
    invalidate('workflows');
  };

  const triggerWorkflow = async (definitionId: string, entityType: string, entityId: string) => {
    await api.post('/workflows/trigger', { definitionId, entityType, entityId });
    await reloadWorkflows();
    invalidate('workflows');
  };

  const getWorkflowInstanceDetail = async (instanceId: string) => {
    return api.get<any>(`/workflows/instances/${instanceId}`);
  };

  const getWorkflowDefinitions = async () => {
    return api.get<any[]>('/workflows/definitions');
  };

  // Rule Engine actions
  const createBusinessRule = async (data: Partial<BusinessRule>) => {
    const rule = await api.post<BusinessRule>('/rules', data);
    await reloadBusinessRules(rule.category);
    invalidate('workflows');
    return rule;
  };

  const updateBusinessRule = async (ruleId: string, category: RuleCategory, data: Partial<BusinessRule>) => {
    const rule = await api.patch<BusinessRule>(`/rules/${ruleId}`, data);
    await reloadBusinessRules(category);
    invalidate('workflows');
    return rule;
  };

  const deactivateBusinessRule = async (ruleId: string, category: RuleCategory) => {
    await api.patch(`/rules/${ruleId}/deactivate`);
    await reloadBusinessRules(category);
    invalidate('workflows');
  };

  const deleteBusinessRule = async (ruleId: string, category: RuleCategory) => {
    await api.delete(`/rules/${ruleId}`);
    await reloadBusinessRules(category);
    invalidate('workflows');
  };

  const rollbackBusinessRule = async (ruleId: string, category: RuleCategory, version: number) => {
    const rule = await api.post<BusinessRule>(`/rules/${ruleId}/rollback`, { version });
    await reloadBusinessRules(category);
    invalidate('workflows');
    return rule;
  };

  const getBusinessRuleVersions = async (ruleId: string) => {
    return api.get<BusinessRuleVersion[]>(`/rules/${ruleId}/versions`);
  };

  const evaluateBusinessRules = async (category: RuleCategory, data: Record<string, unknown>, dryRun = true) => {
    return api.post<RuleEngineResult>('/rules/evaluate', { category, data, dryRun, branchId: currentBranchId });
  };

  const createAutomation = async (data: Partial<Automation>) => {
    await api.post('/automations', data);
    await reloadAutomations();
    invalidate('workflows');
  };

  const toggleAutomation = async (id: string, isActive: boolean) => {
    await api.patch(`/automations/${id}`, { isActive });
    await reloadAutomations();
    invalidate('workflows');
  };

  const createInvoice = async (payload: {
    studentId: string;
    purpose: InvoicePurpose;
    semesterId?: string;
    items: { description: string; quantity?: number; unitPrice: number }[];
    discountAmount?: number;
    notes?: string;
    issue?: boolean;
  }) => {
    const inv = await api.post<Invoice>('/invoices', payload);
    await reloadInvoices();
    invalidate('finance');
    return inv;
  };

  const issueInvoice = async (invoiceId: string) => {
    const inv = await api.post<Invoice>(`/invoices/${invoiceId}/issue`, {});
    await reloadInvoices();
    invalidate('finance');
    return inv;
  };

  const payInvoice = async (invoiceId: string, amount: number, paymentMethod: 'cash' | 'card' | 'bank_transfer' = 'cash', notes?: string) => {
    // Explicit per-submission key so a retry is replayed by the server rather
    // than charged twice. The backend also derives one when absent.
    const result = await api.post<{ invoice: Invoice; paymentId: string; receiptNumber: string }>(
      `/invoices/${invoiceId}/pay`,
      { amount, paymentMethod, notes },
      undefined,
      { 'Idempotency-Key': crypto.randomUUID() }
    );
    await Promise.all([reloadInvoices(), reloadPayments(), reloadTransactions(), reloadFinanceOverview(), reloadFinanceConfig()]);
    invalidate('finance', 'payments');
    return result;
  };

  const cancelInvoice = async (invoiceId: string) => {
    await api.post(`/invoices/${invoiceId}/cancel`, {});
    await reloadInvoices();
    invalidate('finance');
  };

  const updateFinanceConfig = async (patch: Partial<FinanceConfig>) => {
    await api.put('/invoices/config/settings', patch);
    await Promise.all([reloadFinanceConfig(), reloadFinanceOverview()]);
    invalidate('finance');
  };


  return {
    // Raw values
    students, teachers, employees, partners, classes, visitors, visitorSummary, visitorQuery, attendance, payments,
    booksWorkspace, exams, examResults, budgetLines, financeCategories, reloadFinanceCategories, expenseRequests, invoices, financeConfig, transactions, auditLogs, financeReconciliation, financeDashboard, dashboardSummary,
    savingBalance, mainAccountBalance, expenseAutoApproveThreshold, notifications, settings, currentBranchName, isLoading,
    skills, classTeacherSkills, branches, campuses, organization,
    // 1.0.0 values
    donors, fundingCampaigns, donations, scholarships, scholarshipAwards, sponsorships, fundingSummary,
    impactReports, sessions, workflows, automations,
    businessRules,
    // Dashboard Profitability Analytics
    revenueByClass, revenueByTimeSlot,

    // Organization hierarchy configuration
    reloadBranches, reloadCampuses, reloadOrganization,
    createCampus, updateCampus, deactivateCampus, deleteCampus,
    createBranch, updateBranch, deactivateBranch, deleteBranch,
    // Utils
    changeBranch, reloadAll, ensureTabData, ensureFinanceSection, isTabLoading, reloadNotifications, reloadVisitors, reloadFinanceDashboard, reloadDashboardSummary, refreshFundingWorkspace,
    // Canonical server-state freshness surface. `invalidate` is the single
    // write side for cache eviction; `datasetVersion` is the read side that
    // mounted consumers subscribe to. See the dataset dependency graph above.
    invalidate, datasetVersion,
    studentsAreLite, ensureFullStudents, studentBalances, reloadStudentBalances, studentSummary,
    attendanceSummary, reloadAttendanceSummary,
    // Existing business operations
    addVisitor, updateVisitorCRM, addVisitorFollowUp, updateVisitor, advanceVisitorStage, registerVisitorToStudent, checkConversionEligibility, checkDuplicateLeads,
    addStudentManual, updateStudentStatus, updateStudent, enrollStudentSemester, issueStudentCard,
    chargeBudget, createExpenseRequest, recordOperationalPayment, getExpenseReport, updateExpenseAutoApproveThreshold, processExpenseApproval, runSavingEngine, updateSavingSettings, createInvoice, issueInvoice, payInvoice, cancelInvoice, updateFinanceConfig, reloadInvoices,
    processMonthEnd, createBookCatalogItem, updateBookCatalogItem, receiveBookStock, recordBookSale, returnBookSale, issueBookLoan, returnBookLoan, loadBooksHistoryPage,
    // Exams (Two-Phase Workflow)
    registerExam, editExam, deleteExam, enrollExamCandidate, addExamResult, correctExamScore,
    // HR & Payroll
    addTeacher, editTeacher, deleteTeacher, transferTeacher, getTeacherComputedSalary, getTeacherSalaryStatus, addEmployee, editEmployee, deleteEmployee, transferEmployee,
    payEmployeeSalary, payTeacherSalary,
    // Academic & Class Management
    addClass, editClass, deleteClass, mergeClass, getClassMergeCandidates, recordAttendance, addPartner, editPartner, deletePartner,
    addSkill, assignTeacherSkill, editTeacherSkillRate, removeTeacherSkill,
    // Class LMS & Gradebook
    activateClass, getClassGradebook, createClassAssessment, saveClassGrades, completeClassSemester,
    // Admin
    listUserAccounts, createUserAccount, updateUserAccount, resetUserPassword,
    listPositions, listPermissionCatalog, createPosition, updatePosition, updatePositionPermissions,
    listUserPositions, assignUserPosition, removeUserPosition, viewEffectivePermissions,
    // BOS Analytics
    getExecutiveDashboard, getMarketingFunnel, getStudentAnalytics, getDecisionWarnings,
    getProfitDistribution, withdrawProfitDistribution, createBudgetLine, updateBudgetLine,
    // 1.0.0 Operations
    addDonor, editDonor, addFundingCampaign, recordDonation, addScholarship, awardScholarship,
    addSponsorship, generateImpactReport,
    approveWorkflowStep, rejectWorkflowStep, triggerWorkflow, createAutomation, toggleAutomation,
    getWorkflowInstanceDetail, getWorkflowDefinitions,
    reloadBusinessRules, createBusinessRule, updateBusinessRule, deactivateBusinessRule,
    deleteBusinessRule, rollbackBusinessRule, getBusinessRuleVersions, evaluateBusinessRules,
  };
}
