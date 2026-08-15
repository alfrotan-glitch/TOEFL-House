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
import { api } from './api/client';
import { useAuth } from './contexts/useAuth';
import {
  Student, Teacher, Employee, Partner, Class, Visitor, Attendance, Payment, Book, BookSale,
  Exam, ExamResult, BudgetLine, ExpenseRequest, FinancialTransaction, AuditLog, Notification,
  Skill, ClassTeacherSkill, OperationalPaymentInput, ExpenseReport, ExpenseKind, Invoice, FinanceConfig, FinanceDashboard,
  // 1.0.0 types
  Donor, FundingCampaign, Donation, Scholarship, ScholarshipAward, SponsorshipAgreement,
  ImpactReport, ImpactMetric, WorkflowInstance, Automation, Session,
  // Rule Engine types
  BusinessRule, RuleCategory, RuleEngineResult, BusinessRuleVersion, PipelineStage,
  Branch, Campus, Organization, TeacherContractType,
} from './types';

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

export function useApiStore() {
  const { user } = useAuth();
  const legacyCanPickBranch = user?.role === 'owner' || user?.role === 'manager';
  const canPickBranch = user?.tabAccess?.settings ?? legacyCanPickBranch;
  const canSeeFinance = user?.tabAccess?.finance ?? ['owner', 'manager', 'finance'].includes(user?.role || '');
  const canSeeVisitors = user?.tabAccess?.visitors ?? ['owner', 'manager', 'registrar', 'counselor'].includes(user?.role || '');
  const canSeeAuditLog = user?.tabAccess?.audit ?? ['owner', 'manager'].includes(user?.role || '');
  const canManageFunding = user?.tabAccess?.funding ?? ['owner', 'manager', 'donor_manager'].includes(user?.role || '');

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
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [books, setBooks] = useState<Book[]>([]);
  const [bookSales, setBookSales] = useState<BookSale[]>([]);
  const [exams, setExams] = useState<Exam[]>([]);
  const [examResults, setExamResults] = useState<ExamResult[]>([]);
  const [budgetLines, setBudgetLines] = useState<BudgetLine[]>([]);
  const [expenseRequests, setExpenseRequests] = useState<ExpenseRequest[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [financeConfig, setFinanceConfig] = useState<FinanceConfig | null>(null);
  const [transactions, setTransactions] = useState<FinancialTransaction[]>([]);
  const [financeReconciliation, setFinanceReconciliation] = useState<{ healthy: boolean; scope: string; branchId: string | null; paymentBackedTotal: number; ledgerBackedTotal: number; amountVariance: number; unmatchedPayments: number; orphanLedgerRows: number; mismatchedPayments: Array<{ paymentId: string; paymentAmount: number; ledgerAmount: number; variance: number }> } | null>(null);
  const [financeDashboard, setFinanceDashboard] = useState<FinanceDashboard | null>(null);
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
  const [impactReports, setImpactReports] = useState<ImpactReport[]>([]);
  const [impactMetrics, setImpactMetrics] = useState<ImpactMetric[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowInstance[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [businessRules, setBusinessRules] = useState<Record<RuleCategory, BusinessRule[]>>({} as Record<RuleCategory, BusinessRule[]>);
  
  // NEW: Dashboard Profitability Analytics
  const [revenueByClass, setRevenueByClass] = useState<{ name: string; revenue: number }[]>([]);
  const [revenueByTimeSlot, setRevenueByTimeSlot] = useState<{ slot: string; revenue: number }[]>([]);

  const [isLoading, setIsLoading] = useState(true);
  const [isTabLoading, setIsTabLoading] = useState(false);
  const [loadedTabs, setLoadedTabs] = useState<Set<string>>(new Set());
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
  const reloadStudents = useCallback(() => api.get<Student[]>('/students', { ...bq, limit: '2000' }).then(setStudents), [bq]);
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
  const reloadVisitors = useCallback(
    () => (canSeeVisitors ? api.get<Visitor[]>('/visitors', { ...bq, limit: '100' }).then(setVisitors) : Promise.resolve()),
    [bq, canSeeVisitors]
  );
  const reloadAttendance = useCallback(() => api.get<Attendance[]>('/attendance', bq).then(setAttendance), [bq]);
  const reloadPayments = useCallback(() => api.get<Payment[]>('/payments', bq).then(setPayments), [bq]);
  const reloadBooks = useCallback(() => api.get<Book[]>('/books', bq).then(setBooks), [bq]);
  const reloadBookSales = useCallback(() => api.get<BookSale[]>('/books/sales/list', bq).then(setBookSales), [bq]);
  const reloadExams = useCallback(() => api.get<Exam[]>('/exams', bq).then(setExams), [bq]);
  const reloadExamResults = useCallback(() => api.get<ExamResult[]>('/exams/results/all', bq).then(setExamResults), [bq]);
  const reloadBudgetLines = useCallback(
    () => (canSeeFinance ? api.get<BudgetLine[]>('/finance/budget-lines', bq).then(setBudgetLines) : Promise.resolve()),
    [bq, canSeeFinance]
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
    () => (canSeeAuditLog ? api.get<AuditLog[]>('/audit-logs', bq).then(setAuditLogs) : Promise.resolve()),
    [bq, canSeeAuditLog]
  );
  const reloadNotifications = useCallback(() => api.get<Notification[]>('/notifications').then(setNotifications), []);
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
  };

  const updateCampus = async (campusId: string, payload: Partial<{
    name: string; code: string; address: string; postalCode: string;
    phone: string; email: string; description: string; isActive: boolean;
  }>) => {
    await api.put(`/campuses/${campusId}`, payload);
    await reloadCampuses();
  };

  const deactivateCampus = async (campusId: string) => {
    await api.delete(`/campuses/${campusId}`);
    await Promise.all([reloadCampuses(), reloadBranches(), reloadOrganization()]);
  };

  const deleteCampus = async (campusId: string) => {
    await api.delete(`/campuses/${campusId}?permanent=true`);
    await Promise.all([reloadCampuses(), reloadBranches(), reloadOrganization()]);
  };

  const createBranch = async (payload: {
    name: string; code: string; campusId: string; address: string;
    postalCode?: string; phone?: string; email?: string; description?: string; isActive?: boolean;
  }) => {
    await api.post('/branches', payload);
    await reloadBranches();
  };

  const updateBranch = async (branchId: string, payload: Partial<{
    name: string; code: string; campusId: string; address: string;
    postalCode: string; phone: string; email: string; description: string; isActive: boolean;
  }>) => {
    await api.put(`/branches/${branchId}`, payload);
    await reloadBranches();
  };

  const deactivateBranch = async (branchId: string) => {
    await api.delete(`/branches/${branchId}`);
    await reloadBranches();
  };

  const deleteBranch = async (branchId: string) => {
    await api.delete(`/branches/${branchId}?permanent=true`);
    await Promise.all([reloadBranches(), reloadCampuses(), reloadOrganization()]);
  };
  
  const reloadSkills = useCallback(() => api.get<Skill[]>('/skills').then(setSkills), []);
  const reloadProgramVersions = useCallback(() => api.get<any[]>('/catalog/program-versions').then((rows) => setProgramVersions((rows || []).map((r) => ({ id: r.id, name: r.program_name || r.programName || 'Program', versionLabel: r.version_label || r.versionLabel || 'v1', status: r.status })) )), []);
  const reloadClassTeacherSkills = useCallback(() => api.get<ClassTeacherSkill[]>('/class-teacher-skills').then(setClassTeacherSkills), []);

  // ---------- 1.0.0 NEW reloaders ----------
  const reloadDonors = useCallback(
    () => (canManageFunding ? safeGet<Donor[]>('/funding/donors', undefined, []).then(setDonors) : Promise.resolve()),
    [canManageFunding]
  );
  const reloadFundingCampaigns = useCallback(
    () => (canManageFunding ? safeGet<FundingCampaign[]>('/funding/campaigns', bq, []).then(setFundingCampaigns) : Promise.resolve()),
    [bq, canManageFunding]
  );
  const reloadDonations = useCallback(
    () => (canManageFunding ? safeGet<Donation[]>('/funding/donations', bq, []).then(setDonations) : Promise.resolve()),
    [bq, canManageFunding]
  );
  const reloadScholarships = useCallback(
    () => safeGet<Scholarship[]>('/funding/scholarships', bq, []).then(setScholarships),
    [bq]
  );
  const reloadScholarshipAwards = useCallback(
    () => safeGet<ScholarshipAward[]>('/funding/scholarships/awards', bq, []).then(setScholarshipAwards),
    [bq]
  );
  const reloadSponsorships = useCallback(
    () => (canManageFunding ? safeGet<SponsorshipAgreement[]>('/funding/sponsorships', bq, []).then(setSponsorships) : Promise.resolve()),
    [bq, canManageFunding]
  );
  const reloadImpactReports = useCallback(
    () => (canManageFunding ? safeGet<ImpactReport[]>('/impact/reports', bq, []).then(setImpactReports) : Promise.resolve()),
    [bq, canManageFunding]
  );
  const reloadImpactMetrics = useCallback(
    () => safeGet<ImpactMetric[]>('/impact/metrics', bq, []).then(setImpactMetrics),
    [bq]
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
          reloadStudents(),
          reloadTeachers(),
          reloadClasses(),
          reloadVisitors(),
          reloadNotifications(),
          ...(canSeeFinance ? [reloadFinanceOverview()] : []),
        ]);
      case 'students':
        return Promise.all([reloadStudents(), reloadPayments(), reloadClasses(), reloadProgramVersions()]);
      case 'teachers':
        return Promise.all([reloadTeachers(), reloadEmployees(), reloadSkills(), reloadClassTeacherSkills()]);
      case 'classes':
        return Promise.all([reloadClasses(), reloadTeachers(), reloadSkills(), reloadClassTeacherSkills(), reloadSessions()]);
      case 'visitors':
        return Promise.all([reloadVisitors(), reloadStudents(), reloadClasses(), reloadProgramVersions()]);
      case 'books':
        return Promise.all([reloadBooks(), reloadBookSales(), reloadStudents()]);
      case 'finance':
        return Promise.all([reloadBudgetLines(), reloadFinanceOverview()]);
      case 'exams':
        return Promise.all([reloadExams(), reloadExamResults(), reloadStudents(), reloadClasses()]);
      case 'attendance':
        return Promise.all([reloadAttendance(), reloadSessions(), reloadStudents(), reloadClasses()]);
      case 'academic-setup':
        return Promise.all([reloadBranches(), reloadCampuses(), reloadOrganization(), reloadSkills(), reloadProgramVersions()]);
      case 'settings':
        return Promise.all([reloadBranches(), reloadCampuses(), reloadOrganization(), reloadPartners()]);
      case 'funding':
        return Promise.all([reloadDonors(), reloadFundingCampaigns(), reloadDonations(), reloadScholarships(), reloadScholarshipAwards(), reloadSponsorships()]);
      case 'impact':
        return Promise.all([reloadImpactReports(), reloadImpactMetrics()]);
      case 'workflows':
        return Promise.all([reloadWorkflows(), reloadAutomations()]);
      case 'rules':
        return Promise.resolve();
      case 'audit':
        return reloadAuditLogs();
      case 'operations-report':
        return Promise.all([reloadStudents(), reloadClasses(), reloadVisitors()]);
      default:
        return Promise.resolve();
    }
  }, [
    canSeeFinance, reloadAuditLogs, reloadAttendance, reloadBookSales, reloadBooks, reloadBranches, reloadBudgetLines, reloadCampuses,
    reloadClasses, reloadClassTeacherSkills, reloadDonations, reloadDonors, reloadEmployees, reloadExamResults, reloadExams,
    reloadFinanceOverview, reloadFundingCampaigns, reloadImpactMetrics, reloadImpactReports,
    reloadNotifications, reloadOrganization, reloadPartners, reloadPayments, reloadProgramVersions,
    reloadScholarshipAwards, reloadScholarships, reloadSessions, reloadSkills, reloadStudents, reloadTeachers,
    reloadVisitors, reloadWorkflows, reloadAutomations, reloadSponsorships,
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
          await Promise.all([reloadFinanceOverview(), reloadBudgetLines(), reloadFinanceDashboard()]);
          break;
        case 'budgets':
          await reloadBudgetLines();
          break;
        case 'expenses':
          await Promise.all([reloadExpenseRequests(), reloadBudgetLines()]);
          break;
        case 'ops':
          await Promise.all([reloadExpenseRequests(), reloadBudgetLines()]);
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
          await Promise.all([reloadBudgetLines(), reloadFinanceOverview()]);
          break;
        default:
          break;
      }
    } finally {
      loadingTabsRef.current.delete(key);
      setIsTabLoading(false);
    }
  }, [reloadBudgetLines, reloadExpenseRequests, reloadFinanceConfig, reloadFinanceOverview, reloadFinanceDashboard, reloadFinanceReconciliation, reloadInvoices, reloadStudents, reloadTransactions, user]);

  const reloadAll = useCallback(async () => {
    setIsLoading(true);
    setLoadedTabs(new Set());
    loadingTabsRef.current.clear();

    // Startup should establish only the application shell and scope metadata.
    // Operational collections are hydrated by ensureTabData after the first paint.
    await Promise.all([reloadBranches(), reloadCampuses(), reloadOrganization()]);

    setLoadedTabs(new Set(['navigation']));
    setIsLoading(false);
  }, [reloadBranches, reloadCampuses, reloadOrganization]);

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
    currentRoleId: user?.role || 'registrar',
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
    return created;
  };

  const updateVisitorCRM = async (visitorId: string, interestedCourse: string, 
    followUpStatus: 'high_interest' | 'medium_interest' | 'low_interest' | 'not_answering' | 'no_interest',
    nextContactDate: string, notes?: string) => {
    await api.patch(`/visitors/${visitorId}/crm`, { interestedCourse, followUpStatus, nextContactDate, notes });
    await reloadVisitors();
  };

  const addVisitorFollowUp = async (visitorId: string, notes: string, outcome?: string) => {
    await api.post(`/visitors/${visitorId}/followups`, { notes, outcome: outcome || null });
    await reloadVisitors();
  };

  const updateVisitor = async (visitorId: string, updatedFields: Partial<Visitor>) => {
    await api.patch(`/visitors/${visitorId}`, updatedFields);
    await reloadVisitors();
  };

  const advanceVisitorStage = async (visitorId: string, stage?: PipelineStage) => {
    await api.post(`/visitors/${visitorId}/advance-stage`, stage ? { stage } : {});
    await reloadVisitors();
  };

  const registerVisitorToStudent = async (
    visitorId: string, classId: string, amountPaid: number, discountPercent: number,
    notes?: string, semesterFee?: number, branchId?: string, paymentMethod?: 'cash' | 'card' | 'bank_transfer'
  ) => {
    const result = await api.post<{ studentId: string; studentCode: string; receiptNumber: string; invoiceId: string; invoiceNumber: string; netAmount: number; status: string }>(`/visitors/${visitorId}/convert`, { classId, amountPaid, discountPercent, notes, semesterFee, branchId, paymentMethod });
    await Promise.all([reloadVisitors(), reloadStudents(), reloadPayments(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications(), reloadInvoices()]);
    return result;
  };


  const addStudentManual = async (
    fullName: string, phone: string, email: string, gender: 'male' | 'female', discountPercent: number,
    notes?: string, classId?: string, tuitionAmount?: number, fatherName?: string, addressRegion?: string,
    tazkiraNo?: string, whatsapp?: string, dob?: string, schoolOrUniversity?: string,
    emergencyContactName?: string, emergencyContactPhone?: string, amountPaidNow?: number, branchId?: string
  ) => {
    await api.post('/students/manual', {
      fullName, phone, email, gender, discountPercent, notes, classId, tuitionAmount, fatherName, addressRegion,
      tazkiraNo, whatsapp, dob, schoolOrUniversity, emergencyContactName, emergencyContactPhone, amountPaidNow, branchId,
    });
    await Promise.all([reloadStudents(), reloadPayments(), reloadTransactions(), reloadFinanceOverview()]);
  };

  const updateStudentStatus = async (studentId: string, status: 'active' | 'inactive' | 'graduated' | 'suspended') => {
    if (status === 'suspended') {
      await api.post(`/students/${studentId}/suspend`, {});
    } else {
      const current = students.find((student) => student.id === studentId);
      if (current?.status === 'suspended' && status === 'active') {
        await api.post(`/students/${studentId}/resume`, {});
      } else {
        await api.patch(`/students/${studentId}/status`, { status });
      }
    }
    await reloadStudents();
  };

  const updateStudent = async (studentId: string, updatedFields: Partial<Student>) => {
    await api.patch(`/students/${studentId}`, updatedFields);
    await reloadStudents();
  };

  const recordFeePayment = async (studentId: string, amount: number,
    category: 'fee' | 'book' | 'chapter' | 'exam' | 'card' | 'placement' | 'diploma' | 'other', notes?: string) => {
    await api.post(`/students/${studentId}/payments`, { amount, category, notes });
    await Promise.all([reloadPayments(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications()]);
  };

  const enrollStudentSemester = async (studentId: string, semesterName: string, classId: string,
    tuitionAmount: number, amountPaidNow?: number, notes?: string) => {
    await api.post(`/students/${studentId}/enroll-semester`, { semesterName, classId, tuitionAmount, amountPaidNow, notes });
    await Promise.all([reloadStudents(), reloadPayments(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications()]);
  };

  const issueStudentCard = async (studentId: string, cardDesign: { primaryColor: string; bgStyle: string; photo?: string | null; officePhone?: string; whatsapp?: string; socials?: { facebook?: string; instagram?: string; website?: string } }, notes?: string) => {
    const result = await api.post<{ feeCharged: number }>(`/students/${studentId}/issue-card`, { cardDesign, notes });
    await Promise.all([reloadStudents(), reloadPayments(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications()]);
    return result;
  };

  const chargeBudget = async (budgetLineId: string, amount: number) => {
    await api.post(`/finance/budget-lines/${budgetLineId}/charge`, { amount });
    await Promise.all([reloadBudgetLines(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications()]);
  };

  const createExpenseRequest = async (
    title: string,
    amount: number,
    budgetLineId: string,
    meta?: { expenseKind?: ExpenseKind; billPeriod?: string; paymentMethod?: 'cash' | 'card' | 'bank_transfer'; notes?: string }
  ) => {
    await api.post('/finance/expense-requests', { title, amount, budgetLineId, ...meta });
    await Promise.all([reloadExpenseRequests(), reloadNotifications()]);
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
    return result;
  };

  const getExpenseReport = async (year: string, month: string = 'all') => {
    return api.get<ExpenseReport>('/finance/expense-report', { year, month });
  };

  const updateExpenseAutoApproveThreshold = async (threshold: number) => {
    await api.put('/finance/expense-auto-approve-threshold', { threshold });
    setExpenseAutoApproveThreshold(threshold);
  };

  const processExpenseApproval = async (requestId: string, isApproved: boolean, rejectReason?: string) => {
    await api.post(`/finance/expense-requests/${requestId}/decide`, { isApproved, rejectReason });
    await Promise.all([reloadExpenseRequests(), reloadBudgetLines(), reloadTransactions(), reloadNotifications()]);
  };

  const runSavingEngine = async () => {
    await api.post('/finance/saving-engine/run');
    await Promise.all([reloadFinanceOverview(), reloadTransactions(), reloadNotifications()]);
  };

  const updateSavingSettings = async (percent: number) => {
    await api.put('/finance/saving-engine/settings', { percent });
    await reloadFinanceOverview();
  };

  const processMonthEnd = async (budgetLineId: string, decision: 'return' | 'transfer', targetBudgetLineId?: string) => {
    await api.post(`/finance/budget-lines/${budgetLineId}/month-end`, { decision, targetBudgetLineId });
    await Promise.all([reloadBudgetLines(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications()]);
  };

  const addBook = async (title: string, price: number, stock: number, isChapter: boolean, entryDate?: string, purchasePrice?: number) => {
    // Books are created in the branch the UI is currently scoped to, so the
    // new title is visible immediately in the list (the backend validates the
    // caller may access that branch).
    await api.post('/books', { title, price, stock, isChapter, entryDate, purchasePrice, branchId: currentBranchId });
    await reloadBooks();
  };

  const editBook = async (id: string, title: string, price: number, stock: number, isChapter: boolean, purchasePrice?: number) => {
    await api.put(`/books/${id}`, { title, price, stock, isChapter, purchasePrice });
    await reloadBooks();
  };

  const deleteBook = async (id: string) => {
    await api.delete(`/books/${id}`);
    await reloadBooks();
  };

  const recordBookSale = async (bookId: string, quantity: number, customerName: string, studentId?: string,
    discountAmount: number = 0, paymentMethod: 'cash' | 'card' | 'transfer' = 'cash') => {
    await api.post(`/books/${bookId}/sell`, { quantity, customerName, studentId, discountAmount, paymentMethod });
    await Promise.all([reloadBooks(), reloadBookSales(), reloadFinanceOverview(), reloadTransactions(), reloadNotifications()]);
  };

  const refundBookSale = async (saleId: string) => {
    await api.post(`/books/sales/${saleId}/refund`);
    await Promise.all([reloadBooks(), reloadBookSales(), reloadFinanceOverview(), reloadTransactions(), reloadNotifications()]);
  };

  // ================= Exams (Two-Phase Workflow) =================
  const registerExam = async (title: string, date: string, fee: number) => {
    await api.post('/exams', { title, date, fee });
    await reloadExams();
  };

  const editExam = async (examId: string, payload: { title: string; date: string; fee: number }) => {
    await api.put(`/exams/${examId}`, payload);
    await reloadExams();
  };

  const deleteExam = async (examId: string) => {
    await api.delete(`/exams/${examId}`);
    await Promise.all([reloadExams(), reloadExamResults()]);
  };

  const enrollExamCandidate = async (payload: { examId: string; studentId?: string; visitorId?: string; feePaid: boolean }) => {
    await api.post(`/exams/${payload.examId}/enroll`, payload);
    await Promise.all([reloadExamResults(), reloadTransactions(), reloadFinanceOverview(), reloadNotifications()]);
  };

  const addExamResult = async (payload: { examId: string; resultId: string; score: number; certIssued: boolean }) => {
    await api.patch(`/exams/${payload.examId}/results/${payload.resultId}`, { score: payload.score, certIssued: payload.certIssued });
    await Promise.all([reloadExamResults(), reloadFinanceOverview(), reloadTransactions()]);
  };

  const correctExamScore = async (payload: { examId: string; resultId: string; score: number }) => {
    await api.put(`/exams/${payload.examId}/results/${payload.resultId}/correct`, { score: payload.score });
    await Promise.all([reloadExamResults(), reloadFinanceOverview()]);
  };

  const addTeacher = async (fullName: string, phone: string, email: string, baseSalary: number,
    salaryType: TeacherContractType = 'fixed', specialization?: string, qualification?: string, contractType?: 'monthly' | 'hourly' | 'per_session', branchId?: string, defaultSkillRate?: number) => {
    await api.post('/teachers', {
      fullName, phone, email, baseSalary, salaryType, specialization, qualification, contractType, defaultSkillRate,
      branchId: branchId || currentBranchId,
    });
    await reloadTeachers();
  };

  const transferTeacher = async (teacherId: string, targetBranchId: string) => {
    const result = await api.post<{ ok: boolean; unassignedActiveClasses?: string[] }>(
      `/teachers/${teacherId}/transfer`,
      { targetBranchId }
    );
    await reloadTeachers();
    return result;
  };

  const editTeacher = async (id: string, fullName: string, phone: string, email: string, baseSalary: number,
    salaryType?: TeacherContractType, specialization?: string, qualification?: string,
    contractType?: 'monthly' | 'hourly' | 'per_session', status?: 'active' | 'inactive' | 'on_leave') => {
    await api.put(`/teachers/${id}`, { fullName, phone, email, baseSalary, salaryType, specialization, qualification, contractType, status });
    await reloadTeachers();
  };

  const deleteTeacher = async (id: string) => {
    await api.delete(`/teachers/${id}`);
    await reloadTeachers();
  };

  const getTeacherComputedSalary = async (teacherId: string) => {
    return api.get<{ model: string; due: number; base: number; skillsTotal: number; skillCount: number; targetSkills: number; shortfall: number; excess: number; breakdown: any[]; warnings: string[]; isBlocked: boolean; blockReason?: string }>(`/teachers/${teacherId}/computed-salary`);
  };

  const getTeacherSalaryStatus = async (teacherId: string, monthName: string) => {
    return api.get<TeacherSalaryStatus>(`/teachers/${teacherId}/salary-status`, { month: monthName });
  };

  const payTeacherSalary = async (teacherId: string, monthName: string, amountPaid: number, paymentType: 'full' | 'partial' | 'advance') => {
    await api.post(`/teachers/${teacherId}/pay-salary`, { monthName, amountPaid, paymentType });
    await Promise.all([reloadBudgetLines(), reloadTransactions(), reloadNotifications()]);
  };

  const addEmployee = async (fullName: string, phone: string, email: string, role: string, baseSalary: number, branchId?: string) => {
    await api.post('/employees', { fullName, phone, email, role, baseSalary, branchId: branchId || currentBranchId });
    await reloadEmployees();
  };

  const editEmployee = async (id: string, fullName: string, phone: string, email: string, role: string, baseSalary: number, status: 'active' | 'inactive') => {
    await api.put(`/employees/${id}`, { fullName, phone, email, role, baseSalary, status });
    await reloadEmployees();
  };

  const deleteEmployee = async (id: string) => {
    await api.delete(`/employees/${id}`);
    await reloadEmployees();
  };

  const transferEmployee = async (employeeId: string, targetBranchId: string) => {
    const result = await api.post<{ ok: boolean }>(`/employees/${employeeId}/transfer`, { targetBranchId });
    await reloadEmployees();
    return result;
  };

  const payEmployeeSalary = async (employeeId: string, monthName: string, amountPaid: number, paymentType: 'full' | 'partial' | 'advance') => {
    await api.post(`/employees/${employeeId}/pay-salary`, { monthName, amountPaid, paymentType });
    await Promise.all([reloadBudgetLines(), reloadTransactions(), reloadNotifications()]);
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
  };

  const deleteClass = async (id: string) => {
    await api.delete(`/classes/${id}`);
    await reloadClasses();
  };

  const mergeClass = async (sourceId: string, targetClassId: string) => {
    const result = await api.post<{ ok: boolean; movedStudents: number }>(`/classes/${sourceId}/merge`, { targetClassId });
    await reloadClasses();
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
  };

  // --- NEW: Class LMS & Gradebook Operations ---
  const activateClass = async (classId: string) => {
    await api.post(`/classes/${classId}/activate`);
    await reloadClasses();
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
  };

  const saveClassGrades = async (classId: string, grades: Array<{ assessmentId: string; studentId: string; score: number; status: string }>) => {
    await api.put(`/classes/${classId}/grades`, { grades });
  };

  const completeClassSemester = async (classId: string) => {
    await api.post(`/classes/${classId}/complete-semester`);
    await Promise.all([reloadClasses(), reloadStudents()]); // Reload students as their status might change
  };

  // ================= Admin & Settings =================
  const addPartner = async (fullName: string, phone: string, email: string, sharePercent: number, roleDescription: string) => {
    await api.post('/partners', { fullName, phone, email, sharePercent, roleDescription });
    await reloadPartners();
  };

  const editPartner = async (id: string, fullName: string, phone: string, email: string, sharePercent: number, roleDescription: string) => {
    await api.put(`/partners/${id}`, { fullName, phone, email, sharePercent, roleDescription });
    await reloadPartners();
  };

  const deletePartner = async (id: string) => {
    await api.delete(`/partners/${id}`);
    await reloadPartners();
  };

  const addSkill = async (name: string) => {
    await api.post('/skills', { name });
    await reloadSkills();
  };

  const assignTeacherSkill = async (classId: string, teacherId: string, skillId: string, monthlyRate: number) => {
    await api.post('/class-teacher-skills', { classId, teacherId, skillId, monthlyRate });
    await Promise.all([reloadClassTeacherSkills(), reloadTeachers()]);
  };

  const editTeacherSkillRate = async (assignmentId: string, monthlyRate: number) => {
    await api.put(`/class-teacher-skills/${assignmentId}`, { monthlyRate });
    await reloadClassTeacherSkills();
  };

  const removeTeacherSkill = async (assignmentId: string) => {
    await api.delete(`/class-teacher-skills/${assignmentId}`);
    await reloadClassTeacherSkills();
  };


  const listUserAccounts = async () => api.get<any[]>('/users');
  const createUserAccount = async (params: any) => { await api.post('/users', params); };
  const updateUserAccount = async (userId: string, updates: any) => { await api.patch(`/users/${userId}`, updates); };
  const resetUserPassword = async (userId: string, tempPassword: string) => {
    await api.post(`/users/${userId}/reset-password`, { tempPassword });
  };

  // ── Positions & access (owner-only, data-driven position lifecycle) ──
  const listPositions = async () => api.get<any[]>('/security/roles');
  const listPermissionCatalog = async () => api.get<any[]>('/security/permissions');
  const createPosition = async (params: { name: string; description?: string; permissions?: { permissionId: string; scope?: string }[] }) =>
    api.post<any>('/security/roles', params);
  const updatePosition = async (roleId: string, updates: { name?: string; description?: string; isActive?: boolean }): Promise<void> => {
    await api.patch(`/security/roles/${roleId}`, updates);
  };
  const updatePositionPermissions = async (roleId: string, permissions: { permissionId: string; scope?: string }[]): Promise<void> => {
    await api.put(`/security/roles/${roleId}/permissions`, { permissions });
  };
  const listUserPositions = async (userId: string) => api.get<any[]>(`/security/users/${userId}/roles`);
  const assignUserPosition = async (userId: string, params: { roleId: string; scopeType?: string; scopeId?: string | null }): Promise<void> => {
    await api.post(`/security/users/${userId}/roles`, params);
  };
  const removeUserPosition = async (userId: string, assignmentId: string): Promise<void> => {
    await api.delete(`/security/users/${userId}/roles/${assignmentId}`);
  };
  const viewEffectivePermissions = async (userId: string) => api.get<any[]>(`/security/users/${userId}/effective-permissions`);

  // BOS Analytics
  const getExecutiveDashboard = async (timeframe?: string) => api.get<any>('/bos/executive-dashboard', timeframe ? { timeframe } : undefined);
  const getMarketingFunnel = async (timeframe?: string) => api.get<any>('/bos/marketing-funnel', timeframe ? { timeframe } : undefined);
  const getStudentAnalytics = async (timeframe?: string) => api.get<any>('/bos/student-analytics', timeframe ? { timeframe } : undefined);
  const getDecisionWarnings = async () => api.get<any>('/bos/decision-warnings');
  const getProfitDistribution = async (timeframe?: string) => api.get<any>('/bos/profit-distribution/calculate', timeframe ? { timeframe } : undefined);
  
  const withdrawProfitDistribution = async (amount: number, recipientPartnerId?: string, notes?: string) => {
    await api.post('/bos/profit-distribution/withdraw', { amount, recipientPartnerId, notes });
    await Promise.all([reloadFinanceOverview(), reloadTransactions(), reloadRevenueByClass(), reloadRevenueByTimeSlot()]);
  };

  const classifyBudgetLine = async (budgetLineId: string, costType?: 'fixed' | 'variable', isMarketing?: boolean) => {
    await api.put(`/finance/budget-lines/${budgetLineId}/classify`, { costType, isMarketing });
    await reloadBudgetLines();
  };

  // ================= 1.0.0 NEW operations =================
  const addDonor = async (data: Partial<Donor>) => {
    await api.post('/funding/donors', data);
    await reloadDonors();
  };

  const editDonor = async (id: string, data: Partial<Donor>) => {
    await api.put(`/funding/donors/${id}`, data);
    await reloadDonors();
  };

  const addFundingCampaign = async (data: Partial<FundingCampaign>) => {
    await api.post('/funding/campaigns', data);
    await reloadFundingCampaigns();
  };

  const recordDonation = async (data: Partial<Donation>) => {
    await api.post('/funding/donations', data);
    await Promise.all([reloadDonations(), reloadFundingCampaigns(), reloadTransactions(), reloadFinanceOverview()]);
  };

  const addScholarship = async (data: Partial<Scholarship>) => {
    await api.post('/funding/scholarships', data);
    await reloadScholarships();
  };

  const awardScholarship = async (data: Partial<ScholarshipAward>) => {
    await api.post('/funding/scholarships/award', data);
    await Promise.all([reloadScholarships(), reloadScholarshipAwards(), reloadStudents()]);
  };

  const addSponsorship = async (data: Partial<SponsorshipAgreement>) => {
    await api.post('/funding/sponsorships', data);
    await reloadSponsorships();
  };

  const generateImpactReport = async (period: string, donorId?: string) => {
    const report = await api.post<ImpactReport>('/impact/reports/generate', { period, donorId });
    await reloadImpactReports();
    return report;
  };

  const approveWorkflowStep = async (instanceId: string, notes?: string) => {
    await api.post(`/workflows/instances/${instanceId}/approve`, { notes });
    await reloadWorkflows();
  };

  const rejectWorkflowStep = async (instanceId: string, reason: string) => {
    await api.post(`/workflows/instances/${instanceId}/reject`, { reason });
    await reloadWorkflows();
  };

  const triggerWorkflow = async (definitionId: string, entityType: string, entityId: string) => {
    await api.post('/workflows/trigger', { definitionId, entityType, entityId });
    await reloadWorkflows();
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
    return rule;
  };

  const updateBusinessRule = async (ruleId: string, category: RuleCategory, data: Partial<BusinessRule>) => {
    const rule = await api.patch<BusinessRule>(`/rules/${ruleId}`, data);
    await reloadBusinessRules(category);
    return rule;
  };

  const deactivateBusinessRule = async (ruleId: string, category: RuleCategory) => {
    await api.patch(`/rules/${ruleId}/deactivate`);
    await reloadBusinessRules(category);
  };

  const deleteBusinessRule = async (ruleId: string, category: RuleCategory) => {
    await api.delete(`/rules/${ruleId}`);
    await reloadBusinessRules(category);
  };

  const rollbackBusinessRule = async (ruleId: string, category: RuleCategory, version: number) => {
    const rule = await api.post<BusinessRule>(`/rules/${ruleId}/rollback`, { version });
    await reloadBusinessRules(category);
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
  };

  const toggleAutomation = async (id: string, isActive: boolean) => {
    await api.patch(`/automations/${id}`, { isActive });
    await reloadAutomations();
  };

  const createInvoice = async (payload: {
    studentId: string;
    items: { description: string; quantity?: number; unitPrice: number }[];
    discountAmount?: number;
    notes?: string;
    issue?: boolean;
  }) => {
    const inv = await api.post<Invoice>('/invoices', payload);
    await reloadInvoices();
    return inv;
  };

  const issueInvoice = async (invoiceId: string) => {
    const inv = await api.post<Invoice>(`/invoices/${invoiceId}/issue`, {});
    await reloadInvoices();
    return inv;
  };

  const payInvoice = async (invoiceId: string, amount: number, paymentMethod: 'cash' | 'card' | 'bank_transfer' = 'cash', notes?: string) => {
    const result = await api.post<{ invoice: Invoice; paymentId: string; receiptNumber: string }>(
      `/invoices/${invoiceId}/pay`,
      { amount, paymentMethod, notes }
    );
    await Promise.all([reloadInvoices(), reloadPayments(), reloadTransactions(), reloadFinanceOverview(), reloadFinanceConfig()]);
    return result;
  };

  const cancelInvoice = async (invoiceId: string) => {
    await api.post(`/invoices/${invoiceId}/cancel`, {});
    await reloadInvoices();
  };

  const updateFinanceConfig = async (patch: Partial<FinanceConfig>) => {
    await api.put('/invoices/config/settings', patch);
    await Promise.all([reloadFinanceConfig(), reloadFinanceOverview()]);
  };


  return {
    // Raw values
    students, teachers, employees, partners, classes, visitors, attendance, payments,
    books, bookSales, exams, examResults, budgetLines, expenseRequests, invoices, financeConfig, transactions, auditLogs, financeReconciliation, financeDashboard,
    savingBalance, mainAccountBalance, expenseAutoApproveThreshold, notifications, settings, currentBranchName, isLoading,
    skills, classTeacherSkills, branches, campuses, organization,
    // 1.0.0 values
    donors, fundingCampaigns, donations, scholarships, scholarshipAwards, sponsorships,
    impactReports, impactMetrics, sessions, workflows, automations,
    businessRules,
    // Dashboard Profitability Analytics
    revenueByClass, revenueByTimeSlot, 
    
    // Organization hierarchy configuration
    reloadBranches, reloadCampuses, reloadOrganization,
    createCampus, updateCampus, deactivateCampus, deleteCampus,
    createBranch, updateBranch, deactivateBranch, deleteBranch,
    // Utils
    changeBranch, reloadAll, ensureTabData, ensureFinanceSection, isTabLoading, reloadNotifications, reloadVisitors, reloadFinanceDashboard,
    // Existing business operations
    addVisitor, updateVisitorCRM, addVisitorFollowUp, updateVisitor, advanceVisitorStage, registerVisitorToStudent,
    addStudentManual, updateStudentStatus, updateStudent, recordFeePayment, enrollStudentSemester, issueStudentCard,
    chargeBudget, createExpenseRequest, recordOperationalPayment, getExpenseReport, updateExpenseAutoApproveThreshold, processExpenseApproval, runSavingEngine, updateSavingSettings, createInvoice, issueInvoice, payInvoice, cancelInvoice, updateFinanceConfig, reloadInvoices,
    processMonthEnd, addBook, editBook, deleteBook, recordBookSale, refundBookSale, 
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
    getProfitDistribution, withdrawProfitDistribution, classifyBudgetLine,
    // 1.0.0 Operations
    addDonor, editDonor, addFundingCampaign, recordDonation, addScholarship, awardScholarship,
    addSponsorship, generateImpactReport,
    approveWorkflowStep, rejectWorkflowStep, triggerWorkflow, createAutomation, toggleAutomation,
    getWorkflowInstanceDetail, getWorkflowDefinitions,
    reloadBusinessRules, createBusinessRule, updateBusinessRule, deactivateBusinessRule,
    deleteBusinessRule, rollbackBusinessRule, getBusinessRuleVersions, evaluateBusinessRules,
  };
}