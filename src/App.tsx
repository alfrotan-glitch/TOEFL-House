/**
 * @license SPDX-License-Identifier: Apache-2.0
 *
 * TOEFL House ERP — Main Application Shell
 * ============================================================
 * Architecture: Process-Centric, DDD Bounded Contexts
 * Domain-oriented ERP | Event-driven operations
 */
import React, { useState, useCallback, useMemo, useEffect, useRef, lazy, Suspense } from 'react';
import { resolveDocumentIssuer } from './config/documentIssuer';
import {
  Bell, Building2, UserCheck, LogOut, Menu, Search,
  CheckCircle2, AlertCircle, Info, CheckCheck,
} from 'lucide-react';
import { useAuth } from './contexts/useAuth';
import { useApiStore } from './apiStore';
import { api } from './api/client';
import type { UserRole } from './types';

// ── Navigation ──────────────────────────────────────────────────────────────
import Sidebar from './components/sidebar/Sidebar';
import { canAccessTab, firstAllowedTab } from './config/permissions';
import { getRoleLabel } from './config/roles';
import { NAVIGATION_SECTIONS } from './config/navigation';

// ── Auth Views ──────────────────────────────────────────────────────────────
import LoginView from './components/auth/LoginView';
import ChangePasswordGate from './components/auth/ChangePasswordGate';

// ── Error Boundary ──────────────────────────────────────────────────────────
import { ErrorBoundary } from './components/ErrorBoundary';
import GlobalSearch from './components/common/GlobalSearch';
import StudentPortalView from './components/students/StudentPortalView';

// ── BC #1–#9: Core Operational Views ────────────────────────────────────────
// Route-level code splitting: each workspace view is its own lazy chunk so
// the initial shell loads fast and only the active workspace's code is
// fetched. Fallbacks render inside the Suspense boundary around {view}.
const DashboardView = lazy(() => import('./components/dashboard/DashboardView'));
const StudentsView = lazy(() => import('./components/students/StudentsView'));
const TeachersView = lazy(() => import('./components/teachers/TeachersView'));
const ClassesView = lazy(() => import('./components/classes/ClassesView'));
const FinanceView = lazy(() => import('./components/finance/FinanceView'));
const BooksView = lazy(() => import('./components/books/BooksView'));
const ExamsView = lazy(() => import('./components/exams/ExamsView'));
const VisitorsView = lazy(() => import('./components/visitors/VisitorsView'));
const AuditLogView = lazy(() => import('./components/audit/AuditLogView'));
const SettingsView = lazy(() => import('./components/settings/SettingsView'));

// ── BC #3: Session-Centric Academic Core ────────────────────────────────────
const SessionsView = lazy(() => import('./components/sessions/SessionsView'));

// ── BC #11: Funding / Donation / Scholarship ────────────────────────────────
const FundingView = lazy(() => import('./components/funding/FundingView'));

// ── BC #12: Impact / NGO Reporting ──────────────────────────────────────────
const ImpactView = lazy(() => import('./components/impact/ImpactView'));
const OperationsReportView = lazy(() => import('./components/reports/OperationsReportView'));

// ── BC #13: Workflow & Automation ───────────────────────────────────────────
const WorkflowsView = lazy(() => import('./components/workflows/WorkflowsView'));
const RulesManagementView = lazy(() => import('./components/rules/RulesManagementView'));

// ── Academic Control Center ─────────────────────────────────────────────────
const AcademicSetupView = lazy(() => import('./components/academic/AcademicSetupView'));
const TestBankAdminView = lazy(() => import('./components/academic/TestBankAdminView'));

// ── BC #14: Event Bus ───────────────────────────────────────────────────────

// ── Cross-Context: Pipeline Analytics ───────────────────────────────────────

// ============================================================================
// Toast & Notification Types
// ============================================================================
interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

let toastId = 0;

type NotificationType = 'success' | 'alert' | 'critical' | 'info' | string;

function NotificationIcon({ type }: { type: NotificationType }) {
  switch (type) {
    case 'success': return <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />;
    case 'alert':
    case 'critical': return <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />;
    default: return <Info className="w-4 h-4 text-sky-500 shrink-0" />;
  }
}


// ============================================================================
// Authenticated Application
// ============================================================================
function AuthenticatedApp() {
  const { user, logout } = useAuth();
  const store = useApiStore();

  const [currentTab, setCurrentTab] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('erp.currentTab');
      return saved || 'dashboard';
    } catch {
      return 'dashboard';
    }
  });
  const [showNotifications, setShowNotifications] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  useEffect(() => {
    try { localStorage.setItem('erp.currentTab', currentTab); } catch { /* storage may be unavailable */ }
  }, [currentTab]);

  // ── Global toast state ──────────────────────────────────────────────
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  const triggerToast = useCallback((message: string, type: 'success' | 'error' | 'info') => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    toastTimers.current[id] = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      delete toastTimers.current[id];
    }, 4000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    if (toastTimers.current[id]) {
      clearTimeout(toastTimers.current[id]);
      delete toastTimers.current[id];
    }
  }, []);

  useEffect(() => {
    // `timers` aliases the same mutable object as toastTimers.current, so the
    // cleanup still clears every timer registered after this effect ran.
    const timers = toastTimers.current;
    return () => { Object.values(timers).forEach(clearTimeout); };
  }, [toastTimers]);

  const activeRole = (store.settings.currentRoleId || user?.role || 'registrar') as UserRole;
  const activeBranchId = store.settings.currentBranchId;
  // ── RBAC + role-based tab guard ─────────────────────────────────────
  const isTabAllowed = useCallback(
    (tab: string) => canAccessTab(tab, activeRole, user?.permissions, user?.tabAccess),
    [activeRole, user?.permissions, user?.tabAccess]
  );

  const effectiveTab = isTabAllowed(currentTab)
    ? currentTab
    : firstAllowedTab(activeRole, user?.permissions, user?.tabAccess);

  const currentPageLabel = useMemo(() => {
    for (const section of NAVIGATION_SECTIONS) {
      const item = section.items.find((entry) => entry.id === effectiveTab);
      if (item) return item.label;
    }
    return 'Workspace';
  }, [effectiveTab]);

  const handleTabChange = useCallback((tab: string) => {
    setCurrentTab(tab);
    setShowNotifications(false);
    setIsSidebarOpen(false);
  }, []);

  const unreadCount = store.notifications.filter((n) => !n.read).length;

  // ── Notification helpers ────────────────────────────────────────────
  const handleMarkAllRead = useCallback(async () => {
    try {
      await api.post('/notifications/read-all');
      await store.reloadNotifications();
      triggerToast('All notifications marked as read', 'success');
    } catch {
      triggerToast('Failed to mark notifications as read', 'error');
    }
  }, [store, triggerToast]);

  // ── Click outside handler for notification dropdown ─────────────────
  const notificationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setShowGlobalSearch(true);
      }
      if (event.key === 'Escape') setShowGlobalSearch(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (showNotifications && notificationRef.current && !notificationRef.current.contains(event.target as Node)) {
        setShowNotifications(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showNotifications]);

  // ── View Router (memoised) ──────────────────────────────────────────
  const view = useMemo(() => {
    switch (effectiveTab) {
      case 'dashboard':
        return (
          <DashboardView
            students={store.students} classes={store.classes} visitors={store.visitors} invoices={store.invoices}
            budgetLines={store.budgetLines} savingBalance={store.savingBalance}
            financeDashboard={store.financeDashboard} dashboardSummary={store.dashboardSummary}
            mainAccountBalance={store.mainAccountBalance} auditLogs={store.auditLogs} activeRole={activeRole}
            registerVisitorToStudent={store.registerVisitorToStudent} runSavingEngine={store.runSavingEngine}
            savingPercent={store.settings.dailySavingPercent} getExecutiveDashboard={store.getExecutiveDashboard}
            getMarketingFunnel={store.getMarketingFunnel} getStudentAnalytics={store.getStudentAnalytics}
            getDecisionWarnings={store.getDecisionWarnings} getProfitDistribution={store.getProfitDistribution}
            withdrawProfitDistribution={store.withdrawProfitDistribution}
            revenueByClass={store.revenueByClass} 
            revenueByTimeSlot={store.revenueByTimeSlot}
            onNavigate={handleTabChange}
          />
        );
      case 'visitors':
        return (
          <VisitorsView
            visitors={store.visitors} classes={store.classes} branches={store.settings.branches}
            teachers={store.teachers} 
            activeBranchId={activeBranchId} addVisitor={store.addVisitor} updateVisitorCRM={store.updateVisitorCRM}
            programVersions={store.settings.programVersions}
            addVisitorFollowUp={store.addVisitorFollowUp} updateVisitor={store.updateVisitor} reloadVisitors={store.reloadVisitors}
            advanceVisitorStage={store.advanceVisitorStage} registerVisitorToStudent={store.registerVisitorToStudent}
            visitorSummary={store.visitorSummary} visitorQuery={store.visitorQuery}
            checkConversionEligibility={store.checkConversionEligibility} checkDuplicateLeads={store.checkDuplicateLeads}
            permissionCodes={user?.permissions ? Array.from(user.permissions) : undefined} activeRole={activeRole}
          />
        );
      case 'students':
        return (
          <StudentsView
            students={store.students} visitors={store.visitors} classes={store.classes} payments={store.payments}
            studentBalances={store.studentBalances} attendanceSummary={store.attendanceSummary}
            studentSummary={store.studentSummary}
            exams={store.exams} examResults={store.examResults} attendance={store.attendance} activeRole={activeRole}
            branches={store.settings.branches} activeBranchId={activeBranchId}
            books={store.books} 
            addStudentManual={store.addStudentManual} updateStudentStatus={store.updateStudentStatus} updateStudent={store.updateStudent}
            recordFeePayment={store.recordFeePayment} enrollStudentSemester={store.enrollStudentSemester} issueStudentCard={store.issueStudentCard}
          />
        );
      case 'classes':
        return (
          <ClassesView
            classes={store.classes} teachers={store.teachers} students={store.students} activeRole={activeRole}
            onOpenTimetable={(classId) => { try { sessionStorage.setItem('erp.openSessionsClassId', classId); } catch { /* sessionStorage may be unavailable in private/restricted contexts */ } setCurrentTab('sessions'); }}
            branchId={activeBranchId} addClass={store.addClass} editClass={store.editClass} deleteClass={store.deleteClass}
            mergeClass={store.mergeClass} getClassMergeCandidates={store.getClassMergeCandidates} skills={store.skills}
            classTeacherSkills={store.classTeacherSkills} addSkill={store.addSkill} assignTeacherSkill={store.assignTeacherSkill}
            editTeacherSkillRate={store.editTeacherSkillRate} removeTeacherSkill={store.removeTeacherSkill}
            // NEW: LMS & Gradebook Props
            activateClass={store.activateClass}
            getClassGradebook={store.getClassGradebook}
            createClassAssessment={store.createClassAssessment}
            saveClassGrades={store.saveClassGrades}
            completeClassSemester={store.completeClassSemester}
          />
        );
      case 'sessions':
        return <SessionsView sessions={store.sessions} classes={store.classes} students={store.students} teachers={store.teachers} skills={store.skills} classTeacherSkills={store.classTeacherSkills} activeRole={activeRole} activeBranchId={activeBranchId} />;
      case 'teachers':
        return (
          <TeachersView
            teachers={store.teachers} employees={store.employees} classes={store.classes} budgetLines={store.budgetLines}
            activeRole={activeRole} skills={store.skills} classTeacherSkills={store.classTeacherSkills} addTeacher={store.addTeacher}
            editTeacher={store.editTeacher} deleteTeacher={store.deleteTeacher} transferTeacher={store.transferTeacher}
            getTeacherSalaryStatus={store.getTeacherSalaryStatus} branches={store.settings.branches} campuses={store.settings.campuses || store.campuses || []}
            currentBranchId={activeBranchId} payTeacherSalary={store.payTeacherSalary} addEmployee={store.addEmployee} editEmployee={store.editEmployee}
            deleteEmployee={store.deleteEmployee} transferEmployee={store.transferEmployee} payEmployeeSalary={store.payEmployeeSalary}
            assignTeacherSkill={store.assignTeacherSkill} editTeacherSkillRate={store.editTeacherSkillRate} removeTeacherSkill={store.removeTeacherSkill}
            triggerToast={triggerToast}
          />
        );
      case 'exams':
        return (
          <ExamsView 
            exams={store.exams} 
            examResults={store.examResults} 
            students={store.students} 
            visitors={store.visitors} 
            activeRole={activeRole} 
            registerExam={store.registerExam} 
            editExam={store.editExam}
            deleteExam={store.deleteExam}
            enrollExamCandidate={store.enrollExamCandidate} 
            addExamResult={store.addExamResult} 
            correctExamScore={store.correctExamScore}
            triggerToast={triggerToast} 
          />
        );
      case 'finance':
        return (
          <FinanceView
            budgetLines={store.budgetLines} expenseRequests={store.expenseRequests} transactions={store.transactions}
            mainAccountBalance={store.mainAccountBalance} savingBalance={store.savingBalance} activeRole={activeRole}
            chargeBudget={store.chargeBudget} createExpenseRequest={store.createExpenseRequest} recordOperationalPayment={store.recordOperationalPayment}
            getExpenseReport={store.getExpenseReport} updateExpenseAutoApproveThreshold={store.updateExpenseAutoApproveThreshold}
            expenseAutoApproveThreshold={store.expenseAutoApproveThreshold} invoices={store.invoices} students={store.students}
            financeConfig={store.financeConfig} permissionCodes={user?.permissions ? Array.from(user.permissions) : undefined} financeReconciliation={store.financeReconciliation} financeDashboard={store.financeDashboard} isTabLoading={store.isTabLoading} reloadFinanceDashboard={store.reloadFinanceDashboard} ensureFinanceSection={store.ensureFinanceSection} createInvoice={store.createInvoice} issueInvoice={store.issueInvoice} payInvoice={store.payInvoice}
            cancelInvoice={store.cancelInvoice} updateFinanceConfig={store.updateFinanceConfig} processExpenseApproval={store.processExpenseApproval}
            processMonthEnd={store.processMonthEnd} updateSavingSettings={store.updateSavingSettings} savingPercent={store.settings.dailySavingPercent}
            runSavingEngine={store.runSavingEngine}
          />
        );
      case 'funding':
        return (
          <FundingView
            students={store.students} donors={store.donors} campaigns={store.fundingCampaigns} donations={store.donations}
            scholarships={store.scholarships} scholarshipAwards={store.scholarshipAwards} sponsorships={store.sponsorships} activeRole={activeRole}
            addDonor={store.addDonor} editDonor={store.editDonor} addFundingCampaign={store.addFundingCampaign} recordDonation={store.recordDonation}
            addScholarship={store.addScholarship} awardScholarship={store.awardScholarship} addSponsorship={store.addSponsorship}
          />
        );
      case 'operations-report':
        return <OperationsReportView />;
      case 'impact':
        return <ImpactView reports={store.impactReports} generateReport={store.generateImpactReport} />;
      case 'books':
        return <BooksView issuer={resolveDocumentIssuer(store.settings.branches.find((b) => b.id === activeBranchId))} books={store.books} bookSales={store.bookSales} students={store.students} recordBookSale={store.recordBookSale} addBook={store.addBook} editBook={store.editBook} deleteBook={store.deleteBook} refundBookSale={store.refundBookSale} activeRole={activeRole} />;
      case 'workflows':
        return <WorkflowsView instances={store.workflows} automations={store.automations} activeRole={activeRole} approveWorkflowStep={store.approveWorkflowStep} rejectWorkflowStep={store.rejectWorkflowStep} getWorkflowInstanceDetail={store.getWorkflowInstanceDetail} toggleAutomation={store.toggleAutomation} />;
      case 'rules':
        return <RulesManagementView businessRules={store.businessRules} activeRole={activeRole} reloadBusinessRules={store.reloadBusinessRules} createBusinessRule={store.createBusinessRule} updateBusinessRule={store.updateBusinessRule} deactivateBusinessRule={store.deactivateBusinessRule} deleteBusinessRule={store.deleteBusinessRule} rollbackBusinessRule={store.rollbackBusinessRule} getBusinessRuleVersions={store.getBusinessRuleVersions} evaluateBusinessRules={store.evaluateBusinessRules} triggerToast={triggerToast} />;
      case 'audit':
        return <AuditLogView />;
      case 'academic-setup':
        return <AcademicSetupView branchId={activeBranchId} activeRole={activeRole} permissionCodes={user?.permissions ? Array.from(user.permissions) : undefined} />;
      case 'test-bank':
        return <TestBankAdminView triggerToast={triggerToast} />;
      case 'settings':
        return (
          <SettingsView
            settings={store.settings}
            partners={store.partners}
            addPartner={store.addPartner}
            editPartner={store.editPartner}
            deletePartner={store.deletePartner}
            activeRole={activeRole} onOpenAcademicSetup={() => handleTabChange('academic-setup')} listUserAccounts={store.listUserAccounts}
            createUserAccount={store.createUserAccount} resetUserPassword={store.resetUserPassword} createCampus={store.createCampus}
            updateCampus={store.updateCampus} deactivateCampus={store.deactivateCampus} deleteCampus={store.deleteCampus} createBranch={store.createBranch}
            updateBranch={store.updateBranch} deactivateBranch={store.deactivateBranch} deleteBranch={store.deleteBranch}
            listPositions={store.listPositions} listPermissionCatalog={store.listPermissionCatalog}
            createPosition={store.createPosition} updatePosition={store.updatePosition} updatePositionPermissions={store.updatePositionPermissions}
            listUserPositions={store.listUserPositions} assignUserPosition={store.assignUserPosition}
            removeUserPosition={store.removeUserPosition} viewEffectivePermissions={store.viewEffectivePermissions}
          />
        );
      default:
        return <div className="flex items-center justify-center h-64 text-slate-400 text-sm">The “{effectiveTab}” section is under development.</div>;
    }
  }, [effectiveTab, store, activeRole, activeBranchId, triggerToast, handleTabChange, user]);

  // Destructured so the dependency list is exactly what the effect body
  // reads: re-running on every store mutation would re-trigger tab loading.
  const { isLoading: storeLoading, ensureTabData } = store;
  useEffect(() => {
    if (!storeLoading) void ensureTabData(effectiveTab);
  }, [effectiveTab, storeLoading, ensureTabData]);

  // Student self-service portal — AFTER all hooks (Rules of Hooks). A
  // student account never touches the admin workspace: it renders the
  // read-only portal shell only.
  if (activeRole === 'student') {
    return <StudentPortalView />;
  }

  // ── Loading state (AFTER all hooks — Rules of Hooks) ────────────────
  if (store.isLoading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-50" dir="ltr">
        <div className="flex flex-col items-center gap-3 text-slate-400">
          <div className="w-10 h-10 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
          <span className="text-xs font-semibold">Loading data from server…</span>
        </div>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen w-screen overflow-hidden font-sans select-none bg-ambient" dir="ltr">
      {store.isTabLoading && !store.isLoading && (
        <div className="fixed top-20 right-4 z-50 flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 py-2 text-xs font-semibold text-slate-600 shadow-lg backdrop-blur" role="status" aria-live="polite">
          <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
          Loading workspace data…
        </div>
      )}

      <Sidebar
        currentTab={effectiveTab} setCurrentTab={handleTabChange} activeRole={activeRole} onLogout={logout}
        activeBranchId={activeBranchId} changeBranch={store.changeBranch} canPickBranch={activeRole === 'owner' || activeRole === 'manager'}
        branches={store.settings.branches} campuses={store.settings.campuses || store.campuses || []} currentBranchName={store.currentBranchName}
        isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} permissionCodes={user?.permissions ? Array.from(user.permissions) : undefined} tabAccess={user?.tabAccess}
      />

      {isSidebarOpen && <div className="lg:hidden fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-40" onClick={() => setIsSidebarOpen(false)} aria-hidden="true" />}

      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <header className="h-16 bg-white/80 backdrop-blur-md border-b border-slate-200 flex items-center justify-between px-4 md:px-8 shrink-0 z-10 shadow-sm sticky top-0">
          <div className="flex items-center gap-2.5">
            <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden p-2 bg-slate-50 border border-slate-200 hover:bg-slate-100 text-slate-600 rounded-xl cursor-pointer" aria-label="Open menu"><Menu className="w-5 h-5" /></button>
            <div className="bg-indigo-50 text-indigo-700 rounded-xl px-3.5 py-1.5 text-xs font-bold border border-indigo-100 flex items-center gap-1.5 shadow-sm"><Building2 className="w-3.5 h-3.5" /><span>{store.currentBranchName}</span></div>
            <div className="hidden md:flex bg-slate-50 text-slate-700 rounded-xl px-3.5 py-1.5 text-xs font-semibold items-center gap-1.5 border border-slate-100"><span className="text-slate-400">{currentPageLabel}</span></div>
            <div className="hidden lg:flex bg-slate-50 text-slate-700 rounded-xl px-3.5 py-1.5 text-xs font-semibold items-center gap-1.5 border border-slate-100"><UserCheck className="w-3.5 h-3.5 text-slate-400" /><span>{getRoleLabel(activeRole)}</span></div>
          </div>

          <div ref={notificationRef} className="flex items-center gap-3 relative">
            <button onClick={() => setShowGlobalSearch(true)} className="hidden md:flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-bold text-slate-500 hover:bg-white hover:border-indigo-200 hover:text-indigo-600" title="Global search">
              <Search className="w-4 h-4" /> <span>Search</span><span className="ml-1 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[9px] text-slate-400">Ctrl K</span>
            </button>
            <div className="hidden xl:flex items-center gap-2 px-3 py-1.5 bg-slate-50 text-slate-700 text-[11px] font-semibold rounded-full border border-slate-200">
              <span className="h-2 w-2 rounded-full bg-emerald-500" /> Connected
            </div>
            <button onClick={logout} className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 text-[11px] font-bold rounded-full border border-rose-100 cursor-pointer"><LogOut className="w-3.5 h-3.5" /><span className="hidden sm:inline">Sign Out</span></button>
            <button onClick={() => setShowNotifications(!showNotifications)} className="p-2 bg-slate-50 border border-slate-200 rounded-xl hover:bg-slate-100 text-slate-500 hover:text-slate-800 cursor-pointer relative"><Bell className="w-4 h-4" />{unreadCount > 0 && <span className="absolute top-1 right-1.5 w-2 h-2 bg-rose-600 rounded-full ring-2 ring-white animate-pulse" />}</button>

            {showNotifications && (
              <div className="absolute top-12 left-0 w-80 bg-white border border-slate-200 rounded-2xl shadow-xl p-4 z-40 text-xs text-left space-y-3.5 animate-in fade-in duration-200" dir="ltr">
                <div className="flex justify-between items-center border-b border-slate-100 pb-2">
                  <h4 className="font-extrabold text-slate-900">System Notifications</h4>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-indigo-600 font-bold font-mono bg-indigo-50 px-2 py-0.5 rounded-full">{unreadCount} new</span>
                    {unreadCount > 0 && <button onClick={handleMarkAllRead} className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-indigo-600 font-bold cursor-pointer"><CheckCheck className="w-3 h-3" /> Mark all read</button>}
                  </div>
                </div>
                <div className="space-y-3 max-h-60 overflow-y-auto">
                  {store.notifications.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-center"><Bell className="w-8 h-8 text-slate-300 mb-2" /><p className="text-slate-400 font-semibold">You're all caught up!</p><p className="text-slate-400 text-[10px] mt-1">No new notifications.</p></div>
                  ) : (
                    store.notifications.slice(0, 10).map((notif) => (
                      <div key={notif.id} className={`flex gap-2.5 items-start p-2.5 rounded-xl border ${notif.read ? 'bg-slate-50/50 border-slate-100' : 'bg-indigo-50/30 border-indigo-100'}`}>
                        <NotificationIcon type={notif.type} />
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-slate-800 text-[11px]">{notif.title}</p>
                          <p className="text-[10px] text-slate-500 leading-relaxed mt-0.5 line-clamp-2">{notif.message}</p>
                          <p className="text-[9px] text-slate-400 font-mono mt-1">{notif.date}</p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-4 md:px-8 py-6 max-w-7xl w-full mx-auto">
          <ErrorBoundary>
            <Suspense
              fallback={
                <div className="flex items-center justify-center py-24" role="status" aria-live="polite">
                  <div className="flex items-center gap-3 text-xs font-semibold text-slate-500">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
                    Loading workspace…
                  </div>
                </div>
              }
            >
              {view}
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      <GlobalSearch open={showGlobalSearch} onClose={() => setShowGlobalSearch(false)} onNavigate={handleTabChange} />

      {toasts.length > 0 && (
        <div className="fixed bottom-6 left-6 z-50 flex flex-col gap-2" dir="ltr">
          {toasts.map((t) => (
            <div key={t.id} onClick={() => dismissToast(t.id)} className={`px-4 py-3 rounded-xl shadow-lg text-xs font-bold text-white cursor-pointer animate-in slide-in-from-bottom-4 max-w-xs ${t.type === 'success' ? 'bg-emerald-600' : t.type === 'error' ? 'bg-rose-600' : 'bg-indigo-600'}`}>
              {t.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Root App Component
// ============================================================================
export default function App() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-900" dir="ltr">
        <div className="w-10 h-10 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) return <LoginView />;
  if (user.mustChangePassword) return <ChangePasswordGate />;

  return <AuthenticatedApp />;
}