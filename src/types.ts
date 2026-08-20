/**
 * @license SPDX-License-Identifier: Apache-2.0
 *
 * TOEFL House ERP — Domain Types
 * ============================================================
 * Architecture: Process-Centric, DDD Bounded Contexts
 * Domain-oriented ERP | Event-driven operations
 *
 * Single source of truth for every entity shared between the frontend
 * and the backend API. Each type maps 1:1 to a database table and is
 * grouped by its Bounded Context.
 */

// ============================================================================
// SHARED KERNEL — Cross-Context Primitives
// ============================================================================

/**
 * Canonical role codes — the same vocabulary the server stores in `roles.code`
 * and resolves from `user_roles`. The UI uses these for presentation and for
 * choosing what to offer; it never uses them to decide authorization, which is
 * always the server's answer (`permissions` / `tabAccess`).
 *
 * The array is the declaration and the type derives from it, so the vocabulary
 * exists once. Anything that needs to enumerate roles at runtime (a Set, a
 * label map, a dropdown) builds on `USER_ROLE_CODES` rather than retyping it;
 * `role-vocabulary.test.ts` holds this list identical to the server's
 * `ROLE_CODES`.
 */
export const USER_ROLE_CODES = [
  'owner',
  'general_manager',
  'head_of_department',
  'finance_manager',
  'receptionist',
  'counselor',
  'teacher',
  'data_entry',
  'student',
  'donor_manager',
] as const;

export type UserRole = (typeof USER_ROLE_CODES)[number];

export type PipelineStage =
  | 'lead'
  | 'inquiry'
  | 'follow_up'
  | 'placement_booking'
  | 'placement_fee'
  | 'placement_completed'
  | 'class_fee'
  | 'card_issued'
  | 'book_issued'
  | 'registration'
  | 'enrollment'
  | 'active'
  | 'graduated'
  | 'alumni'
  | 'lost';

export type EventSeverity = 'info' | 'warning' | 'critical' | 'success';

export type WorkflowStatus =
  | 'pending'
  | 'in_progress'
  | 'approved'
  | 'rejected'
  | 'completed'
  | 'cancelled';

// ============================================================================
// BC #1: IDENTITY & ACCESS (auth schema)
// ============================================================================

export interface User {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
  email: string;
  branchId: string;
  mustChangePassword: boolean;
  isActive: boolean;
  lastLoginAt?: string;
}

export interface Permission {
  id: string;
  role: UserRole;
  actions: string[];
}

/** Fixed root organization. Name is application-constant: "The TOEFL House". */
export interface Organization {
  id: string;
  name: string;
  campusCount?: number;
  branchCount?: number;
  createdAt?: string;
}

export interface Campus {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  address?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  email?: string | null;
  description?: string | null;
  isActive: boolean;
  /** Total branches under this campus (all statuses). */
  branchCount?: number;
  /** Active branches under this campus. */
  activeBranchCount?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface Branch {
  id: string;
  campusId?: string | null;
  name: string;
  /** Unique business code (not postal code). */
  code?: string | null;
  /** Legacy display field; mirrors address when present. */
  location: string;
  address?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  email?: string | null;
  description?: string | null;
  isActive: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

// ============================================================================
// BC #2: CRM — Lead Pipeline (crm schema)
// ============================================================================

export interface Campaign {
  id: string;
  name: string;
  source: 'ads' | 'social' | 'referral' | 'event' | 'organic' | 'other';
  startDate: string;
  endDate?: string;
  budget: number;
  status: 'active' | 'paused' | 'completed';
  branchId: string;
}

export interface Lead {
  id: string;
  serialNo?: string;
  fullName: string;
  phone: string;
  email?: string;
  gender: 'male' | 'female';
  source: Campaign['source'] | 'friend';
  campaignId?: string;
  stage: PipelineStage;
  /** 'visited' until converted, then 'registered' once enrolled as a student. */
  status?: 'visited' | 'registered' | 'follow_up';
  visitDate?: string;
  interestedCourse?: string;
  followUpStatus:
    | 'high_interest'
    | 'medium_interest'
    | 'low_interest'
    | 'not_answering'
    | 'no_interest';
  nextContactDate?: string;
  assignedTo?: string;
  branchId: string;
  createdAt: string;
  fatherName?: string;
  tazkiraNo?: string;
  dob?: string;
  schoolOrUniversity?: string;
  addressRegion?: string;
  whatsapp?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  notes?: string;
  followUpHistory?: FollowUp[];
  placementScore?: PlacementScore;
  programVersionId?: string | null;
  placementMethod?: 'skill_scores' | 'level_assessment' | 'written_test' | 'interview' | 'hybrid' | null;
  placementStatus?: 'not_started' | 'scheduled' | 'in_progress' | 'completed' | 'waived';
  currentPlacementAttemptId?: string | null;
}

export interface FollowUp {
  id: string;
  leadId: string;
  date: string;
  notes: string;
  operator: string;
  outcome?: 'interested' | 'not_interested' | 'callback' | 'registered';
}

/** Backward-compat alias — existing views keep working. */
export type Visitor = Lead;

// ============================================================================
// BC #3: ACADEMIC — Academic Pipeline (academic schema)
// ============================================================================

export interface Program {
  id: string;
  name: string;
  description?: string;
  durationMonths: number;
  branchId: string;
}

export interface Level {
  id: string;
  programId: string;
  name: string;
  order: number;
  prerequisites?: string[];
}

/** SESSION — the true atomic unit of the academic model. */
export interface Session {
  id: string;
  classId: string;
  className?: string;
  date: string;
  startTime: string;
  endTime: string;
  topic?: string;
  notes?: string | null;
  status: 'scheduled' | 'completed' | 'cancelled';
  teacherId: string;
  teacherName?: string;
  skillId?: string | null;
  skillName?: string | null;
  branchId: string;
  /** Session Engine (Academic Module Phase 2). */
  sessionType?: 'regular' | 'makeup' | 'substitute' | 'online' | 'hybrid' | 'rescheduled';
  linkedSessionId?: string | null;
  roomId?: string | null;
  isSubstitute?: boolean;
}

export interface Roster {
  id: string;
  sessionId: string;
  studentId: string;
  /**
   * Smart Attendance Engine (Academic Module Phase 2) — expanded from the
   * original 5-value set (still valid) to the full blueprint lifecycle.
   * 'sick'/'leave' remain permanent aliases of 'medical_leave'/'excused'.
   */
  attendanceStatus: 'present' | 'late' | 'absent' | 'excused' | 'medical_leave' | 'sick' | 'leave'
    | 'online' | 'hybrid' | 'left_early' | 'not_marked';
  lateMinutes?: number | null;
  /** Credit weight (0 | 0.5 | 1) this mark was worth under the attendance policy in effect when it was recorded. */
  attendanceWeight?: number | null;
  markedAt?: string;
}

export interface Homework {
  id: string;
  sessionId: string;
  title: string;
  description?: string;
  dueDate: string;
  assignedBy: string;
}

/** Session Engine (Academic Module Phase 2) — mirrors Homework. */
export interface Quiz {
  id: string;
  sessionId: string;
  title: string;
  description?: string | null;
  maxScore?: number | null;
  dueDate?: string | null;
  assignedBy: string;
}

/** Assessment Engine (Academic Module Phase 3). */
export interface ClassAssessment {
  id: string;
  classId?: string;
  title: string;
  type: 'midterm' | 'final' | 'assignment' | 'attendance' | 'participation'
    | 'quiz' | 'homework' | 'speaking' | 'listening' | 'reading' | 'writing'
    | 'practice_test' | 'makeup_exam';
  weight: number;
  maxScore: number;
  passingScore?: number | null;
  date?: string | null;
  publishDate?: string | null;
  dueDate?: string | null;
  visibility: 'visible' | 'hidden' | 'scheduled';
  rubric?: string | null;
  allowsMakeup: boolean;
  /** Set on a type:'makeup_exam' assessment, pointing back at what it makes up for. */
  makeupForAssessmentId?: string | null;
  /** Grade Lock Workflow (Academic Module Phase 7). */
  lockStatus: 'draft' | 'submitted' | 'reviewed' | 'approved' | 'published' | 'locked';
  lockStatusUpdatedAt?: string | null;
}

export interface StudentGrade {
  id: string;
  assessmentId: string;
  studentId: string;
  score: number | null;
  status: 'pending' | 'graded' | 'excused' | 'missing';
  /** Teacher comments on this specific student's grade. */
  notes?: string | null;
}

/** Gradebook Engine (Academic Module Phase 4). */
export interface GradeHistoryEntry {
  id: string;
  gradeId: string;
  assessmentId: string;
  studentId: string;
  previousScore: number | null;
  previousStatus: string | null;
  previousNotes: string | null;
  newScore: number | null;
  newStatus: string;
  newNotes: string | null;
  changedBy: string | null;
  changedAt: string;
}

/** Live projection shown in the gradebook before a semester is locked —
 *  same computation complete-semester uses to persist the final result. */
export interface ProjectedGrade {
  studentId: string;
  finalScore: number;
  finalPercentage: number;
  letterGrade: string;
  hasMissingGrades: boolean;
  isPassing: boolean;
}

// ============================================================================
// BC #4: STUDENT (students schema)
// ============================================================================

export interface Student {
  currentClassId?: string | null;
  currentProgramName?: string | null;
  currentProgramVersionId?: string | null;
  currentLevelCode?: string | null;
  id: string;
  studentCode: string;
  fullName: string;
  phone: string;
  email: string;
  gender: 'male' | 'female';
  status: 'active' | 'inactive' | 'graduated' | 'suspended';
  registrationDate: string;
  branchId: string;
  discountPercent: number;
  leadId?: string;
  fatherName?: string;
  addressRegion?: string;
  tazkiraNo?: string;
  whatsapp?: string;
  dob?: string;
  schoolOrUniversity?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  notes?: string;
  placementScore?: PlacementScore;
  programVersionId?: string | null;
  placementMethod?: 'skill_scores' | 'level_assessment' | 'written_test' | 'interview' | 'hybrid' | null;
  placementStatus?: 'not_started' | 'scheduled' | 'in_progress' | 'completed' | 'waived';
  currentPlacementAttemptId?: string | null;
  installmentPlan?: Installment[];
  cardDesign?: CardDesign;
  semesters?: Semester[];
  totalDebt?: number;
  /** Authoritative, server-computed. Present on GET /students/:id. */
  balance?: StudentBalances;
}

export interface PlacementScore {
  listening?: number;
  grammar?: number;
  writing?: number;
  speaking?: number;
  vocabulary?: number;
  reading?: number;
  total?: number | null;
  percentage?: number | null;
  levelRecommendation?: string | null;
  recommendationLevelId?: string | null;
  attemptId?: string;
  method?: string | null;
  date?: string;
  examiner?: string;
  components?: Array<{ key: string; label: string; score?: number | null; percentage?: number | null; status: string }>;
}

export interface Installment {
  id: string;
  dueDate: string;
  amount: number;
  status: 'paid' | 'pending' | 'overdue';
  notes?: string;
}

export interface CardDesign {
  primaryColor: string;
  bgStyle: 'waves' | 'solid' | 'modern' | 'dots';
  photo?: string | null;
  officePhone?: string;
  whatsapp?: string;
  socials?: { facebook?: string; instagram?: string; website?: string };
}

export interface Semester {
  id: string;
  semesterName: string;
  classId?: string;
  enrollDate: string;
  feeAmount: number;
  netFeeAmount?: number;
  status: 'active' | 'completed' | 'deferred';
  /** Gradebook Engine (Academic Module Phase 4) — populated once, at
   *  complete-semester time, by the same computation the live gradebook
   *  preview uses. Null until the semester is locked. */
  finalScore?: number | null;
  finalPercentage?: number | null;
  letterGrade?: string | null;
}

// ============================================================================
// BC #5: CLASS & ENROLLMENT (academic schema)
// ============================================================================

export interface Class {
  id: string;
  name: string;
  teacherId: string;
  programId?: string;
  levelId?: string;
  level: string;
  capacity: number;
  minViableSize: number;
  scheduleTime: string;
  startDate: string;
  endDate: string;
  /** Coarse, backward-compatible projection of lifecycleStage — see below. */
  status: 'draft' | 'scheduled' | 'active' | 'completed' | 'cancelled';
  fee: number;
  branchId: string;
  /** female | male | mixed */
  genderPolicy?: 'female' | 'male' | 'mixed';
  /** Active enrolled student count, computed server-side. */
  enrolled?: number;
  /**
   * Class Lifecycle Engine (Academic Module Phase 1). Fine-grained state;
   * `status` above is a derived 4-value projection of this for backward
   * compatibility with existing `status === 'active'` filters. Every
   * operating sub-stage (scheduled/enrollment_open/enrollment_closed/
   * activated/in_progress/suspended/grading) projects to status:'active'.
   */
  lifecycleStage?: 'draft' | 'scheduled' | 'enrollment_open' | 'enrollment_closed' | 'activated'
    | 'in_progress' | 'suspended' | 'grading' | 'completed' | 'archived' | 'cancelled';
  activationDate?: string | null;
  cancellationReason?: string | null;
}

export interface Enrollment {
  id: string;
  studentId: string;
  classId: string;
  enrollDate: string;
  fee: number;
  paidAmount: number;
  /**
   * Enrollment Lifecycle Engine (Academic Module Phase 1) — expanded from
   * the original 4-value set (still valid, unchanged in meaning) to the
   * full blueprint lifecycle. 'paused'/'suspended' remain permanent aliases
   * of 'frozen' for backward compatibility.
   */
  status: 'pending' | 'reserved' | 'confirmed' | 'active' | 'frozen' | 'paused' | 'suspended'
    | 'transferred' | 'dropped' | 'withdrawn' | 'completed' | 'graduated' | 'retake' | 'conditional_pass';
  enrollmentType?: 'new' | 'repeat' | 'partial_repeat' | 'resume' | 'jump' | 'extra';
  holdReason?: string | null;
}

export type Registration = Enrollment;

// ============================================================================
// BC #6: ASSESSMENT (assessment schema)
// ============================================================================

export interface Exam {
  id: string;
  title: string;
  date: string;
  fee: number;
  classId?: string;
  type: 'placement' | 'midterm' | 'final' | 'mock' | 'certification';
  branchId: string;
}

export interface ExamResult {
  id: string;
  examId: string;
  studentId?: string | null; // FIX: Changed to optional to support walk-in visitors
  visitorId?: string | null; // FIX: Added for Walk-in candidates
  candidateName?: string | null; // FIX: Added to store name at the time of exam
  score: number;
  status: 'pass' | 'fail' | 'pending'; // FIX: Added 'pending' for the two-phase workflow
  examFeePaid: boolean;
  certificateIssued: boolean;
  certificateNo?: string | null;
  branchId: string;
  createdAt?: string;
}

export interface Certificate {
  id: string;
  studentId: string;
  programId: string;
  levelId: string;
  issueDate: string;
  certificateNo: string;
  grade?: string;
}

// ============================================================================
// BC #7: TEACHER — Teacher Pipeline (hr schema)
// ============================================================================

/**
 * THE FIVE TEACHER CONTRACT TYPES — must stay identical to the backend
 * `CONTRACT_TYPES` (server/src/core/payroll/class-payroll.ts) and the
 * `teachers.salary_type` database CHECK.
 *
 * A contract type decides only HOW a teacher is PAID. It never decides
 * whether a SKILL (teaching workload) can be recorded, shown or reported —
 * every contract type records Skills.
 */
export const TEACHER_CONTRACT_TYPES = ['fixed', 'per_skill', 'per_session', 'hybrid', 'per_level'] as const;
export type TeacherContractType = (typeof TEACHER_CONTRACT_TYPES)[number];

export interface Teacher {
  id: string;
  activeClassCount?: number;
  fullName: string;
  phone: string;
  email: string;
  baseSalary: number;
  salaryType: TeacherContractType;
  defaultSkillRate?: number;
  performanceScore: number;
  status: 'active' | 'inactive' | 'on_leave';
  branchId: string;
  joinedDate: string;
  specialization?: string;
  qualification?: string;
  contractType?: 'monthly' | 'hourly' | 'per_session';
  userId?: string;
  /** Monthly teaching workload target in Skills. Reporting only — it never
   *  changes salary by itself. 0 = no target configured. */
  targetSkillsPerMonth?: number;
}

export interface TeacherEvaluation {
  id: string;
  teacherId: string;
  evaluatorId: string;
  date: string;
  score: number;
  criteria: Record<string, number>;
  notes?: string;
}

export interface Skill {
  id: string;
  name: string;
}

export interface ClassTeacherSkill {
  id: string;
  classId: string;
  teacherId: string;
  skillId: string;
  monthlyRate: number;
  branchId: string;
  /** Teacher Assignment Engine (Academic Module Phase 8). */
  assignmentType?: 'primary' | 'assistant' | 'substitute' | 'guest' | 'examiner';
  startDate?: string | null;
  endDate?: string | null;
  reason?: string | null;
  /** Set for a one-off, session-scoped assignment; null means class-scoped. */
  sessionId?: string | null;
}

// ============================================================================
// BC #8: HR — Employee (hr schema)
// ============================================================================

export interface Employee {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  role: string;
  baseSalary: number;
  status: 'active' | 'inactive';
  branchId: string;
  joinedDate: string;
  userId?: string;
}

export interface Partner {
  id: string;
  fullName: string;
  phone: string;
  email: string;
  sharePercent: number;
  roleDescription: string;
}

// ============================================================================
// BC #9: FINANCE — Finance Pipeline (finance schema)
// ============================================================================

export type ExpenseKind = 'recurring_bill' | 'one_time_purchase' | 'maintenance' | 'other';

/**
 * The three accounting treatments the Finance UI must keep visually distinct.
 * Mirrors `server/src/core/finance/category-taxonomy.ts`. The SERVER resolves
 * every value; the browser holds no classification logic of its own.
 */
export type FinanceCategoryClassification =
  | 'operating_expense'
  | 'capital_expenditure'
  | 'non_expense_cash_movement';

/** Which payroll run a budget line funds. */
export type PayrollTarget = 'teacher' | 'employee';

/** A channel or vendor BELOW a subcategory — e.g. Facebook under Digital Advertising. */
export interface FinanceCategoryChannel {
  id: string;
  name: string;
  kind: 'channel' | 'vendor';
}

export interface FinanceSubcategory {
  id: string;
  name: string;
  parentId: string;
  classification: FinanceCategoryClassification;
  sortOrder: number;
  isActive: boolean;
  channels: FinanceCategoryChannel[];
}

export interface FinanceCategory {
  id: string;
  name: string;
  classification: FinanceCategoryClassification;
  sortOrder: number;
  isActive: boolean;
  channels: FinanceCategoryChannel[];
  subcategories: FinanceSubcategory[];
}

/**
 * A branch-level allocation under exactly one canonical subcategory.
 *
 * The taxonomy is complete and organization-wide; budget lines are sparse and
 * deliberate. Every field describing WHERE the line sits is resolved by the
 * server — the browser never maps a line to a category or a treatment.
 */
export interface BudgetLine {
  id: string;
  name: string;
  currentAmount: number;
  allocatedAmount: number;
  icon?: string | null;
  costType: 'fixed' | 'variable';
  branchId: string;
  /** Canonical subcategory this envelope belongs to. */
  subcategoryId: string | null;
  subcategoryName: string | null;
  /** Parent category of that subcategory. */
  categoryId: string | null;
  categoryName: string | null;
  /** Server-resolved accounting treatment. Never computed in the browser. */
  classification: FinanceCategoryClassification;
  channelId?: string | null;
  /** Set on the two payroll envelopes; NULL on every ordinary line. */
  payrollTarget?: PayrollTarget | null;
  sortOrder: number;
  isActive: boolean;
}

/** Payload for POST /finance/budget-lines. */
export interface BudgetLineInput {
  subcategoryId: string;
  name: string;
  costType?: 'fixed' | 'variable';
  channelId?: string | null;
}

export interface ExpenseRequest {
  id: string;
  title: string;
  amount: number;
  budgetLineId: string;
  requester: string;
  status: 'pending' | 'approved' | 'rejected';
  date: string;
  approvedBy?: string;
  rejectReason?: string;
  branchId: string;
  workflowInstanceId?: string;
  /** Operational expense classification */
  expenseKind?: ExpenseKind;
  /** e.g. "1405-04" or "2026-07" for recurring utility bills */
  billPeriod?: string;
  paymentMethod?: 'cash' | 'card' | 'bank_transfer';
  notes?: string;
  autoApproved?: boolean;
}

export interface OperationalPaymentInput {
  budgetLineId: string;
  title: string;
  amount: number;
  expenseKind?: ExpenseKind;
  billPeriod?: string;
  paymentMethod?: 'cash' | 'card' | 'bank_transfer';
  notes?: string;
  /** If true, force pending approval even under threshold */
  requireApproval?: boolean;
}

export interface ExpenseReportRow {
  budgetLineId: string;
  budgetLineName: string;
  totalAmount: number;
  count: number;
  costType: 'fixed' | 'variable';
  categoryId?: string | null;
  categoryName?: string | null;
  subcategoryId?: string | null;
  subcategoryName?: string | null;
  classification?: FinanceCategoryClassification;
}

export interface ExpenseReport {
  year: string;
  month: string | 'all';
  rows: ExpenseReportRow[];
  /** OPERATING expense only — capex and non-expense movements are separate. */
  totalExpense: number;
  totalCapitalExpenditure?: number;
  totalNonExpenseCashMovement?: number;
  totalCashOut?: number;
  byKind: { kind: string; total: number; count: number }[];
}

/**
 * Finance command center — server-computed payload for the finance
 * manager's landing view (GET /api/finance/dashboard). Every figure is
 * calculated in SQL on the backend; the UI only renders it.
 */
/**
 * Authoritative Dashboard KPIs, computed entirely server-side in SQL.
 * The Dashboard renders these values and must not re-derive any of them from
 * loaded entity arrays — doing so is what produced audit findings D-1..D-5
 * (metrics counted from a paginated page rather than the population).
 */
/**
 * Server-computed visitor KPIs (UX-1). Mirrors GET /visitors/summary.
 *
 * These are SQL aggregates over the WHOLE branch-scoped population. The UI
 * renders them and derives none of them — counting a loaded page is exactly the
 * defect this replaces.
 */
export interface VisitorSummary {
  scope: 'organization' | 'branch';
  branchId: string | null;
  /** Server local date. The client must not compute its own. */
  today: string;
  /** Whole scoped population, ignoring filters. */
  total: number;
  /** Open leads: neither converted nor closed-lost. */
  pipeline: number;
  registered: number;
  /** Closed-lost leads, counted separately so they inflate no other bucket. */
  lost: number;
  overdue: number;
  conversionRate: number;
  /** Rows matching the current filters — the paginator's denominator. */
  filtered: number;
  /** Lead count per source over the whole scoped population. */
  bySource: Array<{ source: string; count: number }>;
  /**
   * Lead count per workflow stage over the whole scoped population.
   * The kanban renders its column badges from this, never from the loaded page.
   */
  byStage: Array<{ stage: string; count: number }>;
}

/** The visitor list query the store owns and the server executes. */
export interface VisitorQuery {
  search?: string;
  status?: string;
  source?: string;
  interest?: string;
  placement?: string;
  overdueOnly?: boolean;
  page?: number;
  pageSize?: number;
}

/** A possible pre-existing lead, from GET /visitors/duplicate-check (UX-9). */
export interface DuplicateCandidate {
  id: string;
  serialNo: string | null;
  fullName: string;
  phone: string | null;
  visitDate: string | null;
  status: string | null;
  stage: string | null;
  /** Why this candidate was suggested. Tazkira is an identity match. */
  matchedOn: 'tazkira' | 'phone' | 'name';
}

/** Mirrors GET /visitors/:id/conversion-eligibility (UX-3). */
export interface ConversionEligibility {
  eligible: boolean;
  code:
    | 'ok'
    | 'placement_required'
    | 'already_converted'
    | 'lead_lost'
    | 'student_exists'
    | 'class_not_found'
    | 'class_inactive';
  reason: string;
  requirementMode: string;
  placementStatus: string;
  placementActionable: boolean;
}

export interface DashboardSummary {
  scope: 'organization' | 'branch';
  branchId: string | null;
  /** Server local date (YYYY-MM-DD). The single date authority for the Dashboard. */
  today: string;
  /**
   * The exact Gregorian span of each period, plus the Shamsi key it represents.
   * Periods are Hijri Shamsi (audit D-6): "this month" is اسد ۱۴۰۵, which does
   * not share boundaries with the Gregorian month.
   */
  boundaries: Record<'today' | 'month' | 'year', { period: string; from: string; to: string; periodKey: string; periodEnd: string }>;
  population: {
    activeStudents: number;
    totalStudents: number;
    activeClasses: number;
    activeTeachers: number;
    totalVisitors: number;
    /** Leads still winnable: neither converted nor closed-lost. */
    pendingLeads: number;
    convertedLeads: number;
    /**
     * Closed-lost leads, so pendingLeads + convertedLeads + closedLeads
     * === totalVisitors holds and a dead lead never inflates open pipeline.
     */
    closedLeads: number;
    conversionRate: number;
  };
  periods: Record<'today' | 'month' | 'year', { newVisitors: number; newStudents: number }>;
  cashFlow: Array<{ date: string; income: number; expense: number }>;
}

export interface FinanceDashboard {
  scope: 'organization' | 'branch';
  branchId: string | null;
  balances: { main: number; saving: number };
  today: { income: number; expense: number; net: number };
  month: { income: number; expense: number; net: number };
  budget: {
    lines: number;
    allocated: number;
    remaining: number;
    used: number;
    utilizationPercent: number;
    exhausted: { id: string; name: string; remaining: number }[];
    atRisk: { id: string; name: string; allocated: number; remaining: number; usedPercent: number }[];
  };
  receivables: {
    openInvoices: number;
    openValue: number;
    overdueInvoices: number;
    overdueValue: number;
    drafts: number;
    collectedThisMonth: number;
  };
  approvals: {
    pendingCount: number;
    pendingValue: number;
    items: { id: string; title: string; amount: number; requester: string; date: string }[];
  };
  ledger: {
    recent: { id: string; date: string; type: string; category: string; amount: number; description: string; operatorName: string; branchId: string }[];
  };
  reconciliation: { healthy: boolean; amountVariance: number; unmatchedPayments: number; orphanLedgerRows: number };
  settings: { dailySavingPercent: number; expenseAutoApproveThreshold: number; invoiceDueDays: number };
  trend: { date: string; income: number; expense: number }[];
}

export interface Invoice {
  id: string;
  studentId: string;
  studentName?: string;
  studentCode?: string;
  items: InvoiceItem[];
  totalAmount: number;
  discountAmount: number;
  netAmount: number;
  status: 'draft' | 'issued' | 'paid' | 'partial' | 'overdue' | 'cancelled';
  issueDate: string;
  dueDate: string;
  branchId: string;
  notes?: string;
  invoiceNumber?: string;
  issuedBy?: string;
  createdAt?: string;
}

export interface FinanceConfig {
  invoiceDueDays: number;
  expenseAutoApproveThreshold: number;
  dailySavingPercent: number;
  mainAccountBalance: number;
  savingBalance: number;
}

export interface InvoiceItem {
  id?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface Payment {
  id: string;
  studentId?: string;
  invoiceId?: string;
  bookId?: string;
  amount: number;
  date: string;
  paymentMethod: 'cash' | 'card' | 'bank_transfer';
  status: 'completed' | 'pending' | 'failed' | 'refunded';
  category:
    | 'fee'
    | 'book'
    | 'chapter'
    | 'exam'
    | 'card'
    | 'placement'
    | 'diploma'
    | 'installment'
    | 'refund'
    | 'other';
  notes?: string;
  receiptNumber: string;
  branchId: string;
  semester?: string;
}

export interface FinancialTransaction {
  id: string;
  type: 'income' | 'expense' | 'saving_transfer' | 'budget_charge';
  category: string;
  amount: number;
  date: string;
  description: string;
  referenceId?: string;
  operatorName: string;
  branchId: string;
}

export interface Attendance {
  id: string;
  date: string;
  targetId: string;
  targetType: 'student' | 'teacher';
  /** The dedicated legacy attendance router only ever writes the original
   *  4 values; sessions.routes.ts additionally dual-writes into this same
   *  table with the full Smart Attendance Engine status set (Phase 2), so
   *  a GET response can legitimately include any of them. */
  status: 'present' | 'late' | 'absent' | 'excused' | 'medical_leave' | 'sick' | 'leave' | 'online' | 'hybrid' | 'left_early';
  classId?: string;
  sessionId?: string;
  branchId: string;
}

// ============================================================================
// BC #10: INVENTORY (inventory schema)
// ============================================================================

export interface RestockRecord {
  date: string;
  quantity: number;
  price: number;
  purchasePrice?: number;
}

export interface Book {
  id: string;
  title: string;
  price: number;
  purchasePrice?: number;
  stock: number;
  isChapter: boolean;
  branchId: string;
  entryDate?: string;
  restockHistory?: RestockRecord[];
}

export interface BookSale {
  id: string;
  bookId: string;
  quantity: number;
  totalAmount: number;
  discountAmount?: number;
  netAmount?: number;
  paymentMethod?: 'cash' | 'card' | 'transfer';
  status?: 'completed' | 'refunded';
  date: string;
  customerName: string;
  studentId?: string;
  branchId: string;
}

// ============================================================================
// BC #11: FUNDING — Sponsorship + Donation + Scholarship (funding schema)
// ============================================================================

export interface Donor {
  id: string;
  fullName: string;
  type: 'individual' | 'organization' | 'ngo' | 'government';
  phone?: string;
  email?: string;
  country?: string;
  notes?: string;
  createdAt: string;
}

export interface FundingCampaign {
  id: string;
  name: string;
  description?: string;
  donorId?: string;
  targetAmount: number;
  raisedAmount: number;
  startDate: string;
  endDate?: string;
  status: 'active' | 'completed' | 'cancelled';
  branchId: string;
}

export interface Donation {
  id: string;
  campaignId?: string;
  donorId: string;
  amount: number;
  date: string;
  restricted: boolean;
  restrictionNote?: string;
  receiptNo: string;
  branchId: string;
}

export interface Scholarship {
  id: string;
  name: string;
  donorId?: string;
  campaignId?: string;
  totalBudget: number;
  allocatedAmount: number;
  criteria: string;
  status: 'active' | 'exhausted' | 'closed';
  branchId: string;
}

export interface ScholarshipAward {
  id: string;
  scholarshipId: string;
  studentId: string;
  amount: number;
  awardDate: string;
  semester?: string;
  notes?: string;
}

export interface SponsorshipAgreement {
  id: string;
  donorId: string;
  studentId?: string;
  programId?: string;
  monthlyAmount: number;
  startDate: string;
  endDate: string;
  status: 'active' | 'completed' | 'terminated';
  branchId: string;
}

// ============================================================================
// BC #12: IMPACT — NGO/Donor Reporting (analytics schema)
// ============================================================================

export interface ImpactMetric {
  id: string;
  name: string;
  category: 'academic' | 'social' | 'economic' | 'demographic';
  targetValue: number;
  currentValue: number;
  period: string;
  branchId: string;
}

export interface ImpactReport {
  id: string;
  title: string;
  donorId?: string;
  campaignId?: string;
  period: string;
  generatedAt: string;
  metrics: ImpactMetric[];
  narrative?: string;
  status: 'draft' | 'published' | 'sent';
  branchId: string;
}

export interface SuccessStory {
  id: string;
  studentId: string;
  title: string;
  content: string;
  photoUrl?: string;
  publishedAt: string;
  tags: string[];
}

// ============================================================================
// BC #13: WORKFLOW & AUTOMATION (configuration schema)
// ============================================================================

export interface WorkflowDefinition {
  id: string;
  name: string;
  trigger: string;
  steps: WorkflowStep[];
  isActive: boolean;
}

export interface WorkflowStep {
  order: number;
  role: UserRole;
  action: 'approve' | 'review' | 'notify' | 'execute';
  slaHours?: number;
}

export interface WorkflowInstance {
  id: string;
  definitionId: string;
  entityType: string;
  entityId: string;
  currentStep: number;
  status: WorkflowStatus;
  startedAt: string;
  completedAt?: string;
  history: WorkflowHistoryEntry[];
}

export interface WorkflowHistoryEntry {
  step: number;
  actor: string;
  action: string;
  timestamp: string;
  notes?: string;
}

export interface Automation {
  id: string;
  name: string;
  trigger: string;
  conditions: RuleCondition[];
  actions: AutomationAction[];
  isActive: boolean;
}

export interface RuleCondition {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'contains';
  value: unknown;
}

export interface AutomationAction {
  type: 'notify' | 'create_entity' | 'update_entity' | 'transition' | 'webhook';
  config: Record<string, unknown>;
}

// ============================================================================
// BC #16: RULE ENGINE — Business Rules (Fee / Discount / Promotion / etc.)
// ============================================================================

export type RuleCategory =
  | 'fee' | 'discount' | 'promotion' | 'attendance' | 'payroll'
  | 'scholarship' | 'workflow' | 'notification' | 'finance' | 'academic';

export type BusinessRuleOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in' | 'contains' | 'between';

export type BusinessRuleValue = number | string | boolean | Array<number | string>;

export interface BusinessRuleCondition {
  field: string;
  operator: BusinessRuleOperator;
  value: BusinessRuleValue;
  rangeValue?: [number, number];
}

export interface BusinessRuleAction {
  type: 'set_value' | 'add_discount' | 'block' | 'warn' | 'notify' | 'trigger_event' | 'calculate';
  targetKey: string;
  value?: number | string | boolean;
  formula?: string;
  message?: string;
  channel?: 'sms' | 'email' | 'whatsapp' | 'internal' | 'push';
  eventName?: string;
}

export interface BusinessRule {
  id: string;
  name: string;
  description: string;
  category: RuleCategory;
  conditions: BusinessRuleCondition[];
  actions: BusinessRuleAction[];
  priority: number;
  isActive: boolean;
  scopeBranchId: string | null;
  version: number;
  lastModifiedBy: string;
  lastModifiedAt: string;
  createdAt: string;
}

export interface BusinessRuleVersion {
  version: number;
  conditions: BusinessRuleCondition[];
  actions: BusinessRuleAction[];
  priority: number;
  isActive: boolean;
  modifiedBy: string;
  modifiedAt: string;
}

export interface RuleEvaluationResult {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  actions: BusinessRuleAction[];
  outputs: Record<string, number | string | boolean>;
  executionTimeMs: number;
}

export interface RuleEngineResult {
  category: RuleCategory;
  branchId: string;
  evaluations: RuleEvaluationResult[];
  finalOutputs: Record<string, number | string | boolean>;
  isBlocked: boolean;
  blockReason?: string;
  warnings: string[];
  totalExecutionTimeMs: number;
}

// ============================================================================
// BC #14: EVENT BUS (audit schema)
// ============================================================================

export interface DomainEvent {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  operatorId?: string;
  branchId: string;
  metadata?: Record<string, unknown>;
}

export interface EventSubscription {
  id: string;
  eventType: string;
  handler: 'workflow' | 'automation' | 'notification' | 'webhook';
  config: Record<string, unknown>;
  isActive: boolean;
}

// ============================================================================
// BC #15: NOTIFICATION & AUDIT
// ============================================================================

export interface Notification {
  id: string;
  title: string;
  message: string;
  date: string;
  read: boolean;
  type: EventSeverity;
  userId?: string;
  link?: string;
}

export interface AuditLog {
  id: string;
  operatorId: string;
  operatorName: string;
  action: string;
  date: string;
  time: string;
  oldValue?: string;
  newValue?: string;
  ip: string;
  device: string;
  branchId: string;
}

// ============================================================================
// CONFIGURATION & SETTINGS
// ============================================================================

export interface SystemSettings {
  dailySavingPercent: number;
  currentBranchId: string;
  currentRoleId: UserRole;
  branches: Branch[];
  campuses?: Campus[];
  organization?: Organization | null;
  academicYear?: string;
}

// ============================================================================
// ACADEMIC CATALOG v2 — Versioned curriculum
// ============================================================================

export interface ProgramVersion {
  id: string;
  programId: string;
  versionLabel: string;
  versionNumber: number;
  status: 'draft' | 'published' | 'archived';
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  durationMonths: number;
  description?: string | null;
  isDefault?: boolean;
  publishedAt?: string | null;
}

export interface Subject {
  id: string;
  programVersionId: string;
  levelId?: string | null;
  code: string;
  name: string;
  description?: string | null;
  hours: number;
  sortOrder: number;
  isActive: boolean;
  modules?: SubjectModule[];
}

/**
 * Represents a specific module within a Subject.
 * Renamed from `Module` to `SubjectModule` to avoid global namespace 
 * conflicts with Node.js/Webpack module systems.
 */
export interface SubjectModule {
  id: string;
  subjectId: string;
  code: string;
  name: string;
  description?: string | null;
  hours: number;
  sortOrder: number;
  assessmentType?: string;
  isActive: boolean;
}

/** Backward-compat alias — existing code using `Module` will continue to work. */
export type Module = SubjectModule;

export interface PromotionRule {
  id: string;
  programVersionId: string;
  fromLevelId?: string | null;
  toLevelId?: string | null;
  name: string;
  minScore: number;
  minAttendancePct: number;
  requireAllSubjects: boolean;
  autoPromote: boolean;
  branchId?: string | null;
  isActive: boolean;
  version: number;
}

/** Promotion Engine (Academic Module Phase 5) — the per-student decision
 *  outcome from complete-semester or a manual review resolution. */
export interface PromotionDecision {
  studentId: string;
  outcome: 'promote' | 'retake' | 'conditional_pass' | 'manual_review' | 'drop';
}

/** Academic Policy Engine (Academic Module Phase 6) — the full resolved
 *  policy set for a class's scope, from GET /:id/policy-profile. */
export interface AcademicPolicyProfile {
  promotion: { minScore: number; minAttendancePercentage: number; requireAllSubjects: boolean; source: string };
  attendance: { lateThresholdMinutes: number; halfAbsenceThresholdMinutes: number; minAttendancePercentage: number; maxConsecutiveAbsences: number };
  letterGradeBands: { min: number; grade: string }[];
  retake: { maxAutomaticRetakes: number };
  conditionalPass: { maxConsecutiveConditionalPasses: number };
  transfer: { minDaysBeforeAutoApprove: number };
  freeze: { maxFreezeDurationDays: number; maxFreezesPerEnrollment: number };
  certificate: { minPercentageForCertificate: number };
  makeup: { windowDays: number };
}

export interface PlacementRule {
  id: string;
  programVersionId: string;
  name: string;
  minScore: number;
  maxScore: number;
  recommendedLevelId?: string | null;
  recommendedLevelCode?: string | null;
  branchId?: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface FeeRule {
  id: string;
  programVersionId?: string | null;
  levelId?: string | null;
  branchId?: string | null;
  feeType: 'registration' | 'placement' | 'semester' | 'book' | 'retake' | 'diploma' | 'card' | 'exam' | 'other';
  name: string;
  amount: number;
  currency: string;
  isOptional: boolean;
  version: number;
  isActive: boolean;
}

export interface FeeSnapshot {
  fees: { feeType: string; name: string; amount: number }[];
  total: number;
  currency: string;
  generatedAt: string;
}

// ============================================================================
// PIPELINE METRICS (Cross-Context Analytics)
// ============================================================================

export interface PipelineMetrics {
  pipeline:
    | 'lead'
    | 'academic'
    | 'teacher'
    | 'finance'
    | 'sponsorship'
    | 'donation'
    | 'curriculum'
    | 'session'
    | 'payroll'
    | 'quality'
    | 'marketing'
    | 'alumni';
  stage: PipelineStage | string;
  count: number;
  conversionRate: number;
  averageTimeInStage: number;
}
// ============================================================================
// REPORTING (server-computed /api/reports/overview)
// ============================================================================
export interface ReportGenderCount {
  male: number;
  female: number;
  total: number;
}

export interface ReportIncomeCategory {
  category: string;
  total: number;
  male: number;
  female: number;
  unclassified: number;
}

export interface OperationsReport {
  meta: {
    reportId: string;
    type: string;
    period: 'today' | 'month' | 'year' | 'quarter' | 'range';
    periodLabel: string;
    from: string;
    to: string;
    filters: {
      scope: 'organization' | 'branch';
      branchId: string | null;
      branchName: string | null;
      campusName: string | null;
      gender: 'all' | 'male' | 'female';
    };
    generatedBy: { userId: string | null; name: string };
    position: string;
    generatedAt: string;
    settings: { dailySavingPercent: number };
  };
  financial: {
    income: { total: number; byCategory: ReportIncomeCategory[] };
    expense: { total: number; byCategory: { category: string; total: number }[] };
    net: number;
    previous: { from: string; to: string; income: number; expense: number; net: number };
    transfers: { capitalInjection: number; profitDistribution: number; budgetCharged: number; savingTransferred: number };
    balances: { main: number; saving: number; budgetAllocated: number; budgetRemaining: number };
    collectedPayments: { count: number; total: number; male: number; female: number };
    discounts: { invoiceDiscounts: number; registrationDiscounts: number };
    outstanding: { openInvoices: number; gross: number; paid: number; remaining: number };
  };
  operational: {
    newStudents: ReportGenderCount;
    activeStudents: ReportGenderCount;
    registrations: ReportGenderCount;
    visitors: ReportGenderCount;
    placementCompleted: ReportGenderCount;
    examsConducted: number;
    certificatesIssued: ReportGenderCount;
    booksSold: { count: number; total: number };
    booksByTitle: { title: string; quantity: number; net: number }[];
    placement: {
      attempts: number;
      completed: number;
      inProgress: number;
      cancelled: number;
      avgScore: number;
      convertedToStudent: number;
      levelDistribution: { level: string; count: number }[];
    };
  };
}

/**
 * Per-student tuition balance, aggregated server-side over ALL payments.
 * Mirrors GET /api/payments/balances. Used instead of reducing the paginated
 * payments list, which under-reported any student outside the first page.
 */
/**
 * Authoritative Students roster summary from GET /students/summary.
 * Computed server-side over the FULL filtered set — the UI must never
 * re-derive these from the loaded page (audit STU-H2).
 */
export interface StudentSummary {
  filtered: number;
  unfiltered: number;
  byStatus: Array<{ status: string; count: number }>;
  active: number;
  inactive: number;
  suspended: number;
  graduated: number;
}

export interface StudentBalanceRow {
  studentId: string;
  tuitionDue: number;
  tuitionPaid: number;
  outstanding: number;
  creditBalance: number;
  /** Present on server responses. */
  paidPercentage?: number;
}

/**
 * The authoritative balance returned WITH a single student by
 * GET /api/students/:id. Clients render these figures rather than re-deriving
 * tuition from the paginated payments array: that duplicate computation
 * disagreed with the server whenever a semester was completed.
 *
 *   lifetime — every semester ever charged (the profile view)
 *   current  — only currently-active semesters (what is owed right now)
 */
export interface StudentBalanceFigures {
  tuitionDue: number;
  tuitionPaid: number;
  outstanding: number;
  creditBalance: number;
  paidPercentage: number;
}

export interface StudentBalances {
  lifetime: StudentBalanceFigures;
  current: StudentBalanceFigures;
}

/**
 * Per-student attendance summary, aggregated server-side over the COMPLETE
 * history. Mirrors GET /api/attendance/summary. Used instead of deriving a
 * percentage from the paginated attendance list, which would skew the rate for
 * any student whose records fall outside the returned page.
 */
export interface AttendanceSummaryRow {
  targetId: string;
  total: number;
  present: number;
  onLeave: number;
  absent: number;
  sick: number;
  rate: number | null;
}
