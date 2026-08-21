import { nextInvoiceNumber } from '../utils/invoice.js';
/**
 * TOEFL House ERP — Student Routes (BC #4)
 * Handles student lifecycle, concurrent enrollments, smart payments, installments, and refunds.
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { assertTextLengths, optionalText, requiredText, TEXT_LIMITS } from '../utils/textInput.js';
import { parsePagination as parsePaginationShared } from '../utils/pagination.js';
import { getStudentBalance, getStudentBalancesByIds, getStudentBalancesPage, getSemesterTuitionSettled } from '../utils/studentBalance.js';
import {
  ensureTuitionObligation,
  getPayableInstallment,
  listStudentInstallments,
  markInstallmentPaid,
  setInstallmentPlan,
} from '../core/finance/obligations.js';
import { authenticate, authorize, requirePermission, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import {
  canAccessAllBranchesForRequirement,
  canAccessBranchForRequirement,
  hasPermissionForBranchWithActionScopes,
  isGlobalOwner,
} from '../core/rbac/rbac-service.js';
import { assertStudentAccess } from '../core/rbac/abac.js';
import { writeAudit } from '../middleware/audit.js';
import { assertMoney } from '../utils/money.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { toCsv } from '../utils/csv.js';
import { id, today } from '../utils/ids.js';
import { recordIncome } from '../utils/income.js';
import { getNumberSetting, incrementNumberSetting } from '../utils/settings.js';
import { evaluateRules } from '../core/configuration/rule-engine.js';
import { resolveAuthorizedDiscount } from '../core/configuration/discount-authority.js';
import { resolveFee } from '../core/configuration/policy-resolver.js';
import { nextReceiptNumber, nextStudentCode } from '../utils/receipt.js';
import { getJourneyEngine } from '../core/journey/journey-engine.js';
import { getEnrollmentService } from '../core/academic/enrollment-service.js';
import { countActiveStudentsInClass } from '../core/academic/class-capacity.js';
import { assertClassGenderAllowsStudent } from './classes.routes.js';
import { assertPlacementEligibleForClass } from '../core/placement/enrollment-gate.js';
import { assertNotAlreadySeatedInClass } from '../core/academic/class-admission.js';
import { JourneyEventType } from '../core/journey/event-types.js';
import { SYSTEM_DEFAULTS } from '../core/configuration/policy-catalog.js';
import { resolveIdempotency, isUniqueViolation } from '../utils/idempotency.js';
// Single authorities for the Student subsystem (audit STU-C1/C2/H1/H3).
import { normalizeStudentInput, studentPhoneKey } from '../core/students/student-input.js';
import {
  assertStudentTransition,
  assertStudentOperable,
  isStudentStatus,
  STUDENT_STATUSES,
  type StudentStatus,
} from '../core/students/student-lifecycle.js';
import { createLogger } from '../core/observability/logger.js';
const log = createLogger('students');

export const studentsRouter = Router();
studentsRouter.use(authenticate);

export const paymentsRouter = Router();
paymentsRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetStudentById = db.prepare('SELECT * FROM students WHERE id = ?');
const stmtGetLinkedStudentTeacher = db.prepare(
  'SELECT linked_teacher_id AS teacherId, linked_student_id AS studentId FROM users WHERE id = ?',
);
const stmtGetStudentsAll = db.prepare('SELECT * FROM students ORDER BY registration_date DESC LIMIT ? OFFSET ?');
const stmtGetStudentsByBranch = db.prepare('SELECT * FROM students WHERE branch_id = ? ORDER BY registration_date DESC LIMIT ? OFFSET ?');
const stmtGetSemestersBatch = db.prepare(`SELECT * FROM student_semesters WHERE student_id IN (SELECT value FROM json_each(?)) ORDER BY enroll_date`);
const stmtGetSemestersByStudent = db.prepare('SELECT * FROM student_semesters WHERE student_id = ? ORDER BY enroll_date DESC');
const stmtGetPrimaryEnrollmentsBatch = db.prepare(`SELECT e.* FROM enrollments e WHERE e.status IN ('active','confirmed','pending') AND e.enrollment_type != 'extra' AND e.student_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM enrollments e2 WHERE e2.student_id = e.student_id AND e2.status IN ('active','confirmed','pending') AND e2.enrollment_type != 'extra' AND e2.started_at > e.started_at)`);
interface PaymentRow { id: string; student_id: string; amount: number; date: string; category: string; receipt_number: string | null; semester: string | null; status: string; payment_method: string | null; notes: string | null; branch_id: string; invoice_id: string | null; book_id: string | null; }

const stmtGetPaymentsAll = db.prepare<[number, number], PaymentRow>('SELECT * FROM payments ORDER BY date DESC LIMIT ? OFFSET ?');
const stmtGetPaymentsByBranch = db.prepare<[string, number, number], PaymentRow>('SELECT * FROM payments WHERE branch_id = ? ORDER BY date DESC LIMIT ? OFFSET ?');

const stmtGetClassDetails = db.prepare('SELECT * FROM classes WHERE id = ?');
const stmtGetClassFee = db.prepare('SELECT fee FROM classes WHERE id = ?');
const stmtGetBookPrice = db.prepare('SELECT id, title, price, stock FROM books WHERE id = ? AND branch_id = ?');
const stmtUpdateBookStock = db.prepare('UPDATE books SET stock = stock - 1 WHERE id = ? AND branch_id = ? AND stock > 0');
/**
 * Phone identity lookup, normalized (audit STU-H3).
 *
 * The old statement compared the raw column, so "0700-111-001" and
 * "+93700111001" both slipped past an existing "0700111001". This mirrors
 * `phoneMatchKey()` — digits only, compared on the last 9 — which is the same
 * rule migration 073's unique index enforces at the database level. The two
 * must stay in lockstep: the application produces the clean 409, the index is
 * the race-safe backstop.
 */
const stmtFindStudentByPhoneKey = db.prepare(
  `SELECT id, full_name FROM students
    WHERE phone IS NOT NULL AND TRIM(phone) <> ''
      AND SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'(',''),')',''),'+',''),'.',''),'/',''), -9) = ?
    LIMIT 1`
);

/** Resolve the current owner of a normalized phone key, or undefined. */
function findStudentByPhoneKey(phone: string | null | undefined): { id: string; full_name: string } | undefined {
  const key = studentPhoneKey(phone);
  if (!key) return undefined;
  return stmtFindStudentByPhoneKey.get(key) as { id: string; full_name: string } | undefined;
}
const stmtFindStudentByEmail = db.prepare("SELECT id, full_name FROM students WHERE lower(trim(email)) = lower(trim(?)) LIMIT 1");
const stmtFindStudentByTazkira = db.prepare("SELECT id, full_name FROM students WHERE tazkira_no = ? LIMIT 1");
const stmtFindVisitorByTazkira = db.prepare(
  "SELECT id, full_name FROM visitors WHERE tazkira_no = ? AND id <> COALESCE(?, '') LIMIT 1",
);
const stmtInsertRegistration = db.prepare(
  `INSERT INTO registrations (id, student_id, class_id, date, amount_paid, receipt_number, discount_applied, branch_id, source, semester) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtGetTransferSourceEnrollment = db.prepare(`
  SELECT id FROM enrollments
  WHERE student_id = ? AND status = 'active' AND enrollment_type <> 'extra'
  ORDER BY started_at DESC, created_at DESC, id DESC
  LIMIT 1
`);


const stmtInsertEnrollment = db.prepare(
  `INSERT INTO enrollments (id, student_id, program_id, semester_name, level_code, class_id, branch_id, enrollment_type, status, started_at, notes, fee_snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, 'extra', 'active', ?, ?, ?)`
);
const stmtGetClassSessions = db.prepare("SELECT id FROM sessions WHERE class_id = ? AND status != 'cancelled'");
const stmtInsertRoster = db.prepare('INSERT INTO rosters (id, session_id, student_id, attendance_status) VALUES (?, ?, ?, ?)');
const stmtInsertInvoice = db.prepare(
  `INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, notes, invoice_number, issued_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const stmtInsertStudent = db.prepare(
  `INSERT INTO students (id, student_code, full_name, phone, email, qr_code, status, registration_date, branch_id, discount_percent, gender, father_name, address_region, tazkira_no, whatsapp, dob, school_or_university, emergency_contact_name, emergency_contact_phone, notes) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtInsertSemester = db.prepare(
  `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, net_fee_amount, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
);
const stmtInsertPayment = db.prepare(
  `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, notes, receipt_number, branch_id, semester, invoice_id, book_id, idempotency_key) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`
);
/**
 * Idempotency replay lookup, SCOPED TO THE STUDENT.
 *
 * The key alone is not sufficient. A client-supplied `Idempotency-Key` is
 * attacker- and bug-controlled. Matched on the key alone, reusing one across
 * two students returns the FIRST student's receipt for the SECOND student's
 * genuine payment — the second charge is silently swallowed, never booked (proven: two
 * payable 700 AFN charges, one key, second student left with zero payments and
 * the first student's receipt number). Matching on student_id as well means a
 * replay can only ever return that same student's own earlier payment.
 *
 * Cross-student key collisions still hit the UNIQUE index and are surfaced as
 * a conflict rather than a false success.
 */
const stmtGetPaymentByIdempotency = db.prepare(
  'SELECT id, receipt_number, amount FROM payments WHERE idempotency_key = ? AND student_id = ?',
);
// Placement fees are auto-booked once at assessment completion (payment row
// with idempotency key 'placement:<attemptId>' linked to the candidate's
// visitor). This detects that booking for a converted student so a manual
// 'placement' payment cannot duplicate it.
const stmtHasBookedPlacementFee = db.prepare(`
  SELECT 1 FROM payments p
  JOIN placement_assessment_attempts a ON p.idempotency_key = 'placement:' || a.id
  WHERE a.visitor_id = ? AND a.status = 'completed' AND p.category = 'placement'
  LIMIT 1
`);
// Fixed-fee categories (ID card, diploma) are charged once per student.
// The fee can be booked by either the payment desk OR an issuing workflow
// (issue-card creates a payment row; the certificate path books diploma
// income directly with no payment row). The guard must therefore check BOTH
// the payments table and the authoritative ledger, otherwise a manual
// payment after a certificate (or a certificate after a manual payment)
// would double-charge.
const stmtHasPaidFixedFee = db.prepare(`
  SELECT 1 FROM (
    SELECT 1 FROM payments WHERE student_id = ? AND category = ? AND status = 'completed'
    UNION ALL
    SELECT 1 FROM financial_transactions WHERE type = 'income' AND category = ? AND reference_id = ? AND amount > 0
  ) LIMIT 1
`);
const stmtInsertSimplePayment = db.prepare(
  `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, notes, receipt_number, branch_id, idempotency_key) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)`
);
/**
 * The refund writer. Separate from the charge writer because a refund carries
 * two facts a charge does not: the payment it reverses, and the semester that
 * payment settled (owner decisions D-113 and D-114). Both are written here, not
 * chosen by the caller, so the attribution cannot disagree with the money.
 */
const stmtInsertRefundPayment = db.prepare(
  `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, notes, receipt_number, branch_id, idempotency_key, refunds_payment_id, semester)
   VALUES (?, ?, ?, ?, 'cash', 'completed', 'refund', ?, ?, ?, ?, ?, ?)`
);
/** The payment a refund may reverse, with what is left of it. */
const stmtGetRefundTarget = db.prepare(
  `SELECT p.id, p.student_id, p.branch_id, p.amount, p.category, p.semester, p.status, p.date, p.receipt_number,
          COALESCE((SELECT SUM(ABS(r.amount)) FROM payments r
                     WHERE r.refunds_payment_id = p.id AND r.status = 'completed'), 0) AS refunded
     FROM payments p WHERE p.id = ?`
);
/** Every payment of this student that can still be refunded, and by how much. */
const stmtListRefundablePayments = db.prepare(
  `SELECT p.id, p.amount, p.category, p.date, p.semester, p.receipt_number, p.payment_method,
          COALESCE((SELECT SUM(ABS(r.amount)) FROM payments r
                     WHERE r.refunds_payment_id = p.id AND r.status = 'completed'), 0) AS refunded
     FROM payments p
    WHERE p.student_id = ? AND p.status = 'completed' AND p.category <> 'refund' AND p.amount > 0
    ORDER BY p.date DESC, p.rowid DESC`
);
const stmtUpdateStudentCard = db.prepare('UPDATE students SET card_design = ?, notes = ? WHERE id = ?');
const stmtUpdateStudentDetails = db.prepare(
  `UPDATE students SET full_name=?, phone=?, email=?, discount_percent=?, gender=?, father_name=?, address_region=?, tazkira_no=?, whatsapp=?, dob=?, school_or_university=?, emergency_contact_name=?, emergency_contact_phone=?, notes=?, placement_score=?, card_design=? WHERE id=?`
);
const stmtUpdateStudentStatus = db.prepare(
  `UPDATE students SET status = ?
    WHERE id = ? AND status = ? AND status <> 'suspended'`,
);
/**
 * Graduation releases the seat (audit STU-H4). Only enrollments that still
 * occupy capacity are touched — `active|confirmed|pending`, exactly the set
 * `countActiveStudentsInClass()` counts — so terminal rows (dropped,
 * transferred, withdrawn) keep their historical status.
 */
const stmtCompleteEnrollmentsOnGraduation = db.prepare(
  `UPDATE enrollments
      SET status = 'completed', ended_at = COALESCE(ended_at, datetime('now')), updated_at = datetime('now')
    WHERE student_id = ? AND status IN ('active','confirmed','pending')`
);
const stmtCompleteSemestersOnGraduation = db.prepare(
  `UPDATE student_semesters SET status = 'completed'
    WHERE student_id = ? AND status IN ('active','deferred')`
);

// The frontend loads the student list once per workspace and filters/searchs
// client-side over the loaded set, so the default cap must cover the whole
// manageable roster (batch queries keep it fast). Explicit pagination still
// works for API consumers.
const DEFAULT_PAGE_SIZE = 2000;
const MAX_PAGE_SIZE = 2000;

// STUDENT_STATUSES was a local copy of the lifecycle vocabulary — one of the
// four divergent copies audit STU-M2 recorded. It now comes from the single
// authority in core/students/student-lifecycle.ts.

/** Rejects an unknown status filter instead of quietly returning everything. */
function assertStudentStatus(value: string): void {
  if (!(STUDENT_STATUSES as readonly string[]).includes(value)) {
    throw new HttpError(400, `Invalid status filter. Expected one of: ${STUDENT_STATUSES.join(', ')}.`);
  }
}

function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId || !user?.branchId || !user?.fullName) throw new HttpError(403, 'User context missing.');
  return user;
}

/**
 * Delegates to the shared hardened parser. The previous local version let a
 * NEGATIVE limit through (`-1` is truthy and not > MAX_PAGE_SIZE), and SQLite
 * reads `LIMIT -1` as unbounded — so `?limit=-1` dumped the whole table.
 */
function parsePagination(req: import('express').Request) {
  return parsePaginationShared(req as { query: Record<string, unknown> }, {
    defaultPageSize: DEFAULT_PAGE_SIZE,
    maxPageSize: MAX_PAGE_SIZE,
  });
}

type StudentContextRow = StudentRow;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

/**
 * Parses a stored JSON array, falling back when the column holds anything that
 * is not actually an array.
 *
 * parseJson() only guards against a PARSE failure, not against the parsed value
 * having the wrong shape. A double-encoded plan (a JSON string containing JSON)
 * parses cleanly to a string, and the caller then did `plan.find(...)` on it —
 * producing `500 plan.find is not a function` on the payment endpoint. Malformed
 * stored data must degrade to "no installments", never crash a money route.
 */

function requireStudent(
  req: import('express').Request,
  studentId: string,
  options: { objectView?: boolean } = {},
): StudentContextRow {
  const student = stmtGetStudentById.get(studentId) as StudentContextRow | undefined;
  if (!student) throw new HttpError(404, 'Student not found.');
  if (options.objectView) {
    assertStudentAccess(req, studentId);
    return student;
  }
  const { branchId, isAll } = resolveBranchScope(req);
  if (!isAll && branchId && student.branch_id && student.branch_id !== branchId) {
    const cross = !!student.branch_id && canAccessBranchResource(req, student.branch_id);
    if (!cross) throw new HttpError(403, 'Student belongs to another branch.');
  }
  return student;
}

/**
 * Guarded profile-status writer for non-suspension transitions.
 *
 * Graduation closes open enrollments and semesters because those rows are the
 * seat-occupancy authority. Suspension and resume remain dedicated enrollment
 * workflows. The profile and dependent lifecycle rows change in one
 * transaction so they cannot disagree.
 */
export function applyStudentStatus(
  req: import('express').Request,
  student: { id: string; full_name: string; status: string },
  to: StudentStatus,
): void {
  const from = student.status;
  db.transaction(() => {
    const updated = stmtUpdateStudentStatus.run(to, student.id, from);
    if (updated.changes !== 1) {
      throw new HttpError(409, 'Student status changed concurrently; reload before trying again.');
    }
    if (to === 'graduated') {
      // Free the seat(s). `completed` is the enrollment-lifecycle terminal
      // state for a finished course and is excluded from the capacity count.
      stmtCompleteEnrollmentsOnGraduation.run(student.id);
      stmtCompleteSemestersOnGraduation.run(student.id);
    }
  })();
  writeAudit(req, `Changed student ${student.full_name} status to ${to}`, {
    oldValue: JSON.stringify({ status: from }),
    newValue: JSON.stringify({ status: to }),
  });
}

interface StudentRow { id: string; student_code: string; full_name: string; phone: string | null; email: string | null; qr_code: string | null; status: string; registration_date: string; branch_id: string; discount_percent: number; gender: string; lead_id: string | null; father_name: string | null; address_region: string | null; tazkira_no: string | null; whatsapp: string | null; dob: string | null; school_or_university: string | null; emergency_contact_name: string | null; emergency_contact_phone: string | null; notes: string | null; placement_score: string | null; card_design: string | null; }

function mapStudentBase(row: StudentRow, includeFinance = true) {
  return {
    id: row.id, studentCode: row.student_code, fullName: row.full_name, phone: row.phone, email: row.email,
    qrCode: row.qr_code, status: row.status, registrationDate: row.registration_date, branchId: row.branch_id,
    ...(includeFinance ? { discountPercent: row.discount_percent } : {}),
    gender: row.gender, leadId: row.lead_id || undefined,
    fatherName: row.father_name, addressRegion: row.address_region, tazkiraNo: row.tazkira_no,
    whatsapp: row.whatsapp, dob: row.dob, schoolOrUniversity: row.school_or_university,
    emergencyContactName: row.emergency_contact_name, emergencyContactPhone: row.emergency_contact_phone,
    notes: row.notes, placementScore: parseJson(row.placement_score, undefined),
    ...(includeFinance ? { installmentPlan: listStudentInstallments(db, row.id).map((i) => ({ id: i.id, amount: i.amount, dueDate: i.dueDate ?? '', status: i.status, semesterName: i.semesterName })) } : {}),
    cardDesign: parseJson(row.card_design, undefined),
  };
}

function mayViewStudentFinance(req: import('express').Request, branchId: string): boolean {
  return !!req.rbac && (
    isGlobalOwner(req.rbac)
    || hasPermissionForBranchWithActionScopes(
      db,
      req.rbac,
      branchId,
      ['Payment.View'],
      ['organization', 'campus', 'branch', 'department'],
    )
  );
}

function mapStudents(
  rows: StudentRow[],
  options: { includeFinance?: boolean | ((row: StudentRow) => boolean) } = {},
) {
  if (rows.length === 0) return [];
  const financeDecision = options.includeFinance ?? true;
  const semesters = stmtGetSemestersBatch.all(JSON.stringify(rows.map(r => r.id))) as any[];
  const byStudent = new Map<string, any[]>();
  for (const s of semesters) {
    if (!byStudent.has(s.student_id)) byStudent.set(s.student_id, []);
    byStudent.get(s.student_id)!.push(s);
  }
  const primaryEnrollments = stmtGetPrimaryEnrollmentsBatch.all(JSON.stringify(rows.map((r) => r.id))) as any[];
  const enrollmentByStudent = new Map<string, any>();
  for (const enrollment of primaryEnrollments) enrollmentByStudent.set(enrollment.student_id, enrollment);

  return rows.map((row) => {
    const includeFinance = typeof financeDecision === 'function'
      ? financeDecision(row)
      : financeDecision;
    const sems = (byStudent.get(row.id) || []).map((s) => ({
      id: s.id,
      semesterName: s.semester_name,
      classId: s.class_id,
      enrollDate: s.enroll_date,
      ...(includeFinance ? { feeAmount: s.fee_amount, netFeeAmount: s.net_fee_amount ?? null } : {}),
      status: s.status,
    }));
    const enrollment = enrollmentByStudent.get(row.id);
    return {
      ...mapStudentBase(row, includeFinance),
      semesters: sems,
      currentClassId: enrollment?.class_id ?? (sems.length ? sems[sems.length - 1].classId : null),
      currentProgramName: enrollment?.program_name ?? null,
      currentProgramVersionId: enrollment?.program_version_id ?? null,
      currentLevelCode: enrollment?.level_code ?? null,
    };
  });
}

/**
 * Enterprise Feature: Academic Hold
 * Checks if the student has any outstanding debt from previous semesters.
 * If they do, enrollment is blocked unless overridden by finance/owner.
 */
function checkAcademicHold(req: import('express').Request, studentId: string) {
  const student = stmtGetStudentById.get(studentId) as { branch_id: string } | undefined;
  const canOverride = !!req.rbac && !!student && canAccessBranchForRequirement(
    db,
    req.rbac,
    student.branch_id,
    { roleCodes: ['owner', 'general_manager', 'finance_manager'] },
  );
  if (canOverride) return;

  // Uses the shared authoritative balance so the hold threshold agrees with the
  // debt shown on the profile, the roster, the portal and the dashboard.
  const totalDebt = getStudentBalance(db, studentId, 'active').outstanding;

  if (totalDebt > 0) {
    throw new HttpError(403, `Academic Hold: Student has an outstanding debt of ${totalDebt} AFN. Please clear the balance before new enrollment.`);
  }
}

// ============================================================================
// §1 — LIST / READ
// ============================================================================
paymentsRouter.get('/', requirePermission('Payment.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  const { limit, offset } = parsePagination(req);
  const rows = isAll ? stmtGetPaymentsAll.all(limit, offset) : (branchId ? stmtGetPaymentsByBranch.all(branchId, limit, offset) : []);
  // `status` and `notes` were omitted, so every consumer saw status===undefined
  // and rendered refunds as positive '+' payments. `semester` lets a caller
  // attribute a payment to the term it settled.
  res.json(rows.map((r) => ({
    id: r.id, studentId: r.student_id, amount: r.amount, date: r.date,
    category: r.category, receiptNumber: r.receipt_number,
    status: r.status, notes: r.notes, semester: r.semester ?? null,
    paymentMethod: r.payment_method ?? null,
  })));
}));

/**
 * Per-student tuition balances, aggregated in SQL.
 *
 * Deriving each student's paid/owed figure by downloading the payments list and
 * reducing it client-side does not work: that list is one page, so with 6,000
 * payments and a 2,000-row cap two thirds never reach the browser and those
 * students display as owing their FULL fee despite having paid. It is also
 * 379 KB of payload to compute a handful of numbers.
 *
 * This returns one small row per student, summed over ALL their payments using
 * the same authoritative rule as utils/studentBalance (fee + installment +
 * refund, refunds signed-negative).
 */
paymentsRouter.get('/balances', requirePermission('Payment.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  // Bounded to the same window as the roster it accompanies: returning a row
  // per student for the whole academy to annotate a 2,000-row page is wasted
  // transfer. Ordered to match the roster's default ordering.
  const { limit, offset } = parsePaginationShared(req as { query: Record<string, unknown> }, {
    defaultPageSize: DEFAULT_PAGE_SIZE,
    maxPageSize: MAX_PAGE_SIZE,
  });
  // Delegates to the single authoritative definition rather than inlining its
  // own SQL. A local copy summing only active semesters, while the profile sums
  // all of them, shows the same student two different debts.
  res.json(getStudentBalancesPage(db, { branchId: isAll ? null : branchId, scope: 'all', limit, offset }));
}));

interface StudentReadScope {
  branchId: string | null;
  isAll: boolean;
  teacherId: string | null;
  ownStudentId: string | null;
}

function resolveStudentReadScope(req: import('express').Request): StudentReadScope {
  const { branchId, isAll } = resolveBranchScope(req, { ignoreAccessRequirement: true });
  if (!req.rbac) throw new HttpError(403, 'Authorization context is unavailable.');
  const hasBroadScope = isAll
    ? canAccessAllBranchesForRequirement(req.rbac, { permissionCodes: ['Student.View'] })
    : !!branchId && canAccessBranchForRequirement(db, req.rbac, branchId, { permissionCodes: ['Student.View'] });
  if (hasBroadScope) return { branchId, isAll, teacherId: null, ownStudentId: null };
  if (!branchId) throw new HttpError(403, 'No authorized student scope is available for this request.');

  const linked = stmtGetLinkedStudentTeacher.get(req.user?.userId) as
    | { teacherId: string | null; studentId: string | null }
    | undefined;
  if (hasPermissionForBranchWithActionScopes(
    db, req.rbac, branchId, ['Student.View'], ['class'],
  ) && linked?.teacherId) {
    return { branchId, isAll: false, teacherId: linked.teacherId, ownStudentId: null };
  }
  if (hasPermissionForBranchWithActionScopes(
    db, req.rbac, branchId, ['Student.View'], ['own'],
  ) && linked?.studentId) {
    return { branchId, isAll: false, teacherId: null, ownStudentId: linked.studentId };
  }
  throw new HttpError(403, 'No authorized student scope is available for this request.');
}

function studentAuthorityFilter(scope: StudentReadScope): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!scope.isAll) { clauses.push('students.branch_id = ?'); params.push(scope.branchId); }
  if (scope.teacherId) {
    clauses.push(`EXISTS (
      SELECT 1 FROM classes c
       WHERE c.teacher_id = ?
         AND (EXISTS (SELECT 1 FROM student_semesters ss
                       WHERE ss.student_id = students.id AND ss.class_id = c.id
                         AND ss.status IN ('active','deferred'))
           OR EXISTS (SELECT 1 FROM enrollments e
                       WHERE e.student_id = students.id AND e.class_id = c.id
                         AND e.status IN ('active','confirmed','pending')))
    )`);
    params.push(scope.teacherId);
  }
  if (scope.ownStudentId) { clauses.push('students.id = ?'); params.push(scope.ownStudentId); }
  return { clauses, params };
}

/**
 * Whole-database student search with pagination — works at any scale
 * (10k / 20k+ students). Returns { rows, total } so the UI can page and
 * show an exact match count. Filters: q (name/code/phone/tazkira/whatsapp/
 * email/father), status, classId.
 */
studentsRouter.get('/search', requirePermission('Student.View'), ah(async (req, res) => {
  const scope = resolveStudentReadScope(req);
  const { limit, offset } = parsePagination(req);
  const { whereSql, params } = buildStudentListWhere(req, scope);
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM students ${whereSql}`).get(...params) as { c: number }).c;
  const rows = db.prepare(`SELECT * FROM students ${whereSql} ORDER BY registration_date DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as StudentRow[];
  res.json({
    rows: mapStudents(rows, { includeFinance: (row) => mayViewStudentFinance(req, row.branch_id) }),
    total,
  });
}));

/**
 * THE shared filter definition for the student roster, search and export
 * (audit STU-H2). Separate copies of this WHERE clause in the roster and the
 * search endpoint — with the CSV export having no server-side filter at all and
 * reducing whatever page the browser happened to hold — is three answers to one
 * question. One builder means the three surfaces can never disagree about what
 * "the current filter" means.
 *
 * Branch scoping is applied here, so no caller can forget it.
 */
function buildStudentListWhere(
  req: import('express').Request,
  scope: StudentReadScope,
): { whereSql: string; params: unknown[] } {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const classId = typeof req.query.classId === 'string' ? req.query.classId.trim() : '';
  const authority = studentAuthorityFilter(scope);
  const where: string[] = [...authority.clauses];
  const params: unknown[] = [...authority.params];
  if (q) {
    where.push(`(full_name LIKE ? ESCAPE '\\' OR student_code LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
                OR COALESCE(tazkira_no,'') LIKE ? ESCAPE '\\' OR COALESCE(whatsapp,'') LIKE ? ESCAPE '\\'
                OR COALESCE(email,'') LIKE ? ESCAPE '\\' OR COALESCE(father_name,'') LIKE ? ESCAPE '\\')`);
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    for (let i = 0; i < 7; i++) params.push(like);
  }
  if (status) {
    // Reject rather than silently ignore. Dropping an unrecognised value makes
    // `?status=' OR '1'='1` (and any typo) return the UNFILTERED page, and the
    // caller cannot tell "no matches" from "filter discarded".
    assertStudentStatus(status);
    where.push('status = ?');
    params.push(status);
  }
  if (classId) {
    where.push(`EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = students.id AND e.class_id = ?)`);
    params.push(classId);
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * Authoritative roster summary (audit STU-H2).
 *
 * Mirrors `GET /visitors/summary`, which the Visitors tab already uses. Every
 * figure is computed in SQL over the FULL filtered set — never derived from
 * the page the browser happens to hold. Counted from the loaded array instead,
 * the Students tab captions its list "2000 of 2000" against a true 2,162,
 * because both numbers come from the same truncation.
 */
studentsRouter.get('/summary', requirePermission('Student.View'), ah(async (req, res) => {
  const scope = resolveStudentReadScope(req);
  const { whereSql, params } = buildStudentListWhere(req, scope);

  const filtered = (db.prepare(`SELECT COUNT(*) AS c FROM students ${whereSql}`).get(...params) as { c: number }).c;
  const authority = studentAuthorityFilter(scope);
  const authorityWhere = authority.clauses.length ? `WHERE ${authority.clauses.join(' AND ')}` : '';
  const unfiltered = (db.prepare(`SELECT COUNT(*) AS c FROM students ${authorityWhere}`)
    .get(...authority.params) as { c: number }).c;

  const byStatus = db.prepare(
    `SELECT status, COUNT(*) AS count FROM students ${whereSql} GROUP BY status`
  ).all(...params) as Array<{ status: string; count: number }>;

  res.json({
    filtered,
    unfiltered,
    byStatus,
    // Convenience shape so the UI never has to re-derive these.
    active: byStatus.find((r) => r.status === 'active')?.count ?? 0,
    inactive: byStatus.find((r) => r.status === 'inactive')?.count ?? 0,
    suspended: byStatus.find((r) => r.status === 'suspended')?.count ?? 0,
    graduated: byStatus.find((r) => r.status === 'graduated')?.count ?? 0,
  });
}));

/**
 * Server-side CSV export over the FULL filtered dataset (audit STU-H2).
 *
 * Built in the UI from `filteredStudents` — the loaded page — an export of a
 * 2,162-student branch silently produces 2,000 rows, financial columns
 * (Total Fee / Paid / Debt) included. Offline management records are then
 * incomplete with nothing indicating truncation.
 *
 * This endpoint applies exactly the same filters as the roster (shared via
 * buildStudentListWhere) and streams every matching row, joining the
 * authoritative balance definition rather than recomputing fees client-side.
 * It is bounded only by the filter, not by a page size.
 */
studentsRouter.get('/export', requirePermission('Student.View'), ah(async (req, res) => {
  const scope = resolveStudentReadScope(req);
  // EXACTLY the same filter and object-authority scope the roster uses — one
  // definition, so an export can never widen a class/own grant to a branch.
  const { whereSql, params } = buildStudentListWhere(req, scope);

  const rows = db.prepare(
    `SELECT id, student_code, full_name, phone, whatsapp, father_name, tazkira_no,
            email, gender, status, registration_date, branch_id
       FROM students ${whereSql}
      ORDER BY registration_date DESC`
  ).all(...params) as StudentRow[];

  // Financial columns require Payment.View correlated to every exported row.
  // A uniform CSV cannot safely mix financial and redacted row schemas, so a
  // partial multi-branch finance grant receives the redacted export.
  const includeFinance = rows.length > 0
    && rows.every((row) => mayViewStudentFinance(req, row.branch_id));
  const balances = new Map<string, { tuitionDue: number; tuitionPaid: number; outstanding: number }>();
  if (includeFinance) {
    for (const b of getStudentBalancesByIds(db, rows.map((row) => row.id), 'all')) {
      balances.set(b.studentId, { tuitionDue: b.tuitionDue, tuitionPaid: b.tuitionPaid, outstanding: b.outstanding });
    }
  }

  const classesByStudent = new Map<string, string>();
  if (rows.length) {
    for (const r of db.prepare(
      `SELECT student_id, GROUP_CONCAT(class_id, '; ') AS cls FROM enrollments
        WHERE student_id IN (SELECT value FROM json_each(?))
          AND status IN ('active','confirmed','pending') GROUP BY student_id`
    ).all(JSON.stringify(rows.map((row) => row.id))) as Array<{ student_id: string; cls: string }>) {
      classesByStudent.set(r.student_id, r.cls);
    }
  }

  // The shared serializer, so escaping is defined once. A second inline
  // implementation is how one export learns to quote an embedded comma and the
  // other does not.
  const header = [
    'Code', 'Full Name', 'Phone', 'WhatsApp', 'Father Name', 'Tazkira No', 'Email',
    'Gender', 'Status', 'Classes',
    ...(includeFinance ? ['Total Fee', 'Paid', 'Debt'] : []),
    'Registered',
  ];
  const csvRows = rows.map((r) => {
    const fin = balances.get(r.id) ?? { tuitionDue: 0, tuitionPaid: 0, outstanding: 0 };
    return [
      r.student_code, r.full_name, r.phone, r.whatsapp, r.father_name, r.tazkira_no, r.email,
      r.gender, r.status, classesByStudent.get(r.id) ?? '',
      ...(includeFinance ? [fin.tuitionDue, fin.tuitionPaid, fin.outstanding] : []),
      r.registration_date,
    ];
  });

  writeAudit(req, `Exported ${rows.length} students to CSV`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('X-Total-Count', String(rows.length));
  res.setHeader('Content-Disposition', `attachment; filename="students-${today()}.csv"`);
  res.send(toCsv(header, csvRows));
}));

studentsRouter.get('/', requirePermission('Student.View'), ah(async (req, res) => {
  const scope = resolveStudentReadScope(req);
  const { limit, offset } = parsePagination(req);
  // Server-side search + filters so the list stays correct beyond page 1:
  // q matches name / code / phone / tazkira / whatsapp / email / father.
  const { whereSql, params } = buildStudentListWhere(req, scope);

  // Authoritative totals (audit STU-H2). A bare array capped at MAX_PAGE_SIZE
  // with no total leaves a client unable to tell a full result from a
  // truncated one: with 2,162 students the UI renders 2,000 rows and captions
  // them "2000 of 2000". These headers mirror the
  // Visitors roster contract (X-Total-Count / X-Unfiltered-Count / X-Page-*),
  // which the frontend already knows how to consume.
  const filteredTotal = (db.prepare(`SELECT COUNT(*) AS c FROM students ${whereSql}`).get(...params) as { c: number }).c;
  const authority = studentAuthorityFilter(scope);
  const authorityWhere = authority.clauses.length ? `WHERE ${authority.clauses.join(' AND ')}` : '';
  const unfilteredTotal = (db.prepare(`SELECT COUNT(*) AS c FROM students ${authorityWhere}`)
    .get(...authority.params) as { c: number }).c;
  res.setHeader('X-Total-Count', String(filteredTotal));
  res.setHeader('X-Unfiltered-Count', String(unfilteredTotal));
  res.setHeader('X-Page-Limit', String(limit));
  res.setHeader('X-Page-Offset', String(offset));

  // `?view=lite` returns only the four fields a picker or lookup table needs.
  //
  // The full projection is 25 fields plus a nested `semesters` array, which
  // costs two extra batch queries and ~774 bytes per row — 1.4 MB for a
  // 2,000-student roster. Six of eight tabs (books, exams, attendance,
  // visitors, dashboard...) were downloading all of it just to render a name
  // in a dropdown. Lite is ~60 bytes per row and skips both joins.
  if (String(req.query.view || '') === 'lite') {
    const liteSql = `SELECT id, student_code, full_name, status, registration_date, gender, branch_id
                     FROM students ${whereSql} ORDER BY full_name ASC LIMIT ? OFFSET ?`;
    const liteRows = db.prepare(liteSql).all(...params, limit, offset) as Array<{
      id: string; student_code: string; full_name: string; status: string;
      registration_date: string; gender: string; branch_id: string;
    }>;
    res.json(liteRows.map((r) => ({
      id: r.id, studentCode: r.student_code, fullName: r.full_name, status: r.status,
      registrationDate: r.registration_date, gender: r.gender, branchId: r.branch_id,
      semesters: [],
    })));
    return;
  }

  const sql = `SELECT * FROM students ${whereSql} ORDER BY registration_date DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  const rows = db.prepare(sql).all(...params) as StudentRow[];
  res.json(mapStudents(rows, {
    includeFinance: (row) => mayViewStudentFinance(req, row.branch_id),
  }));
}));

/**
 * Student self-service portal: returns ONLY the caller's own profile.
 * Role 'student' carries no permissions, so this endpoint is the only
 * students.* route a student can reach; the object check guarantees the
 * account can never read another student's data.
 */
studentsRouter.get('/me', authorize('student'), ah(async (req, res) => {
  const user = req.user!;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.userId) as
    | { linked_student_id: string | null } | undefined;
  const studentId = row?.linked_student_id;
  if (!studentId) throw new HttpError(404, 'No linked student profile for this account.');
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId) as StudentRow | undefined;
  if (!student) throw new HttpError(404, 'Linked student profile not found.');
  if (student.branch_id !== user.branchId) throw new HttpError(403, 'Student profile is outside your scope.');
  // Same authoritative balance the staff-facing profile receives, so a student
  // and the registrar looking at the same record never see different numbers.
  res.json({
    ...mapStudents([student])[0],
    balance: {
      lifetime: getStudentBalance(db, student.id, 'all'),
      current: getStudentBalance(db, student.id, 'active'),
    },
  });
}));

studentsRouter.get('/:id', requirePermission('Student.View'), ah(async (req, res) => {
  const student = requireStudent(req, req.params.id, { objectView: true }) as StudentRow;
  const mayViewFinance = mayViewStudentFinance(req, student.branch_id);
  // The balance ships WITH the student so no client ever has to re-derive it.
  // Recomputing tuition in the profile drawer or the student portal from the
  // paginated payments array disagrees with this endpoint the moment a
  // semester is completed (server counts active semesters only, client counts
  // all) — the same student shows a 20,000 AFN different debt
  // on the roster and on the profile.
  res.json({
    ...mapStudents([student], { includeFinance: mayViewFinance })[0],
    ...(mayViewFinance ? {
      balance: {
        lifetime: getStudentBalance(db, student.id, 'all'),
        current: getStudentBalance(db, student.id, 'active'),
      },
    } : {}),
  });
}));

// ============================================================================
// §2 — CREATE (Manual Registration)
// ============================================================================
studentsRouter.post('/manual', requirePermission('Student.Create'), ah(async (req, res) => {
  const user = getUserContext(req);
  const body = req.body ?? {};
  const { tuitionAmount, amountPaidNow } = body;
  const classId = optionalText(body.classId, 'Class id', TEXT_LIMITS.short);
  const branchId = optionalText(body.branchId, 'Branch id', TEXT_LIMITS.short);
  const discountPercent = body.discountPercent ?? 0;
  if (typeof discountPercent !== 'number' || !Number.isFinite(discountPercent)) {
    throw new HttpError(400, 'Discount must be a finite number.');
  }
  // ONE validation authority, shared with PATCH (audit STU-H1). It type-checks,
  // trims and bounds every text field, validates gender against the same
  // allow-list the gender-policy engine enforces, and rejects impossible
  // calendar dates. A PATCH that skipped this would persist values this path
  // rejects.
  const input = normalizeStudentInput(body, 'create');
  const {
    fullName = null, phone = null, email = null, notes = null, fatherName = null,
    addressRegion = null, tazkiraNo = null, whatsapp = null, schoolOrUniversity = null,
    emergencyContactName = null, emergencyContactPhone = null,
  } = input.text;
  const gender = input.gender as string;
  const dob = input.dob ?? null;
  const safePhone = phone ?? '';
  const safeEmail = email ?? '';
  const safeTazkira = tazkiraNo ?? '';
  // Phone identity is compared on the NORMALIZED key (audit STU-H3), matching
  // migration 073's unique index.
  if (findStudentByPhoneKey(safePhone)) throw new HttpError(409, 'A student with this phone number already exists.');
  if (safeEmail && stmtFindStudentByEmail.get(safeEmail)) throw new HttpError(409, 'A student with this email already exists.');
  if (safeTazkira && stmtFindStudentByTazkira.get(safeTazkira)) throw new HttpError(409, 'A student with this Tazkira/ID number already exists.');
  if (safeTazkira && stmtFindVisitorByTazkira.get(safeTazkira, null)) {
    throw new HttpError(409, 'A visitor with this Tazkira/ID number already exists. Convert that lead instead.');
  }

  let effDiscount = Number(discountPercent ?? 0);
  if (!Number.isFinite(effDiscount) || effDiscount < 0) throw new HttpError(400, 'Discount must be zero or greater.');
  if (effDiscount > 0) {
    const cap = evaluateRules({ category: 'discount', branchId: branchId || user.branchId, data: { discountPercent: effDiscount } });
    if (typeof cap.finalOutputs.discountPercent === 'number') effDiscount = cap.finalOutputs.discountPercent;
  }
  // CFG-1: the Rule Engine computes a candidate; it is not authorization. The
  // student does not exist yet, so no authorization record can apply and
  // ordinary policy (<= 20%) governs. Without this, a manager rule
  // (`conditions: []`, `discountPercent: 95`) set the discount directly —
  // reproduced at every priority (1/10/199 -> 95, 201/999/10000 -> 30).
  effDiscount = resolveAuthorizedDiscount(db, null, effDiscount, { branchId: branchId || user.branchId }).percent;

  const studentCode = nextStudentCode();
  const studentBranchId = typeof branchId === 'string' && branchId.trim() ? branchId.trim() : user.branchId;
  const studentBranches = resolveBranchScope(req);
  if (!studentBranches.isAll && !studentBranchId) throw new HttpError(403, 'No branch scope is available for student registration.');
  if (!canAccessBranchResource(req, studentBranchId)) throw new HttpError(403, 'Target branch is outside your authorized scope.');
  if (classId) {
    const targetClass = stmtGetClassDetails.get(classId) as { id: string; branch_id: string; fee: number; status?: string; capacity?: number | null } | undefined;
    if (!targetClass) throw new HttpError(404, 'Class not found.');
    if (targetClass.branch_id !== studentBranchId) throw new HttpError(400, 'Class and student branch must match.');
    if (targetClass.status !== 'active') throw new HttpError(400, 'Selected class is not active.');
    const enrolledCount = countActiveStudentsInClass(db, classId);
    const capacity = Number((targetClass as any).capacity ?? 0);
    if (capacity > 0 && enrolledCount >= capacity) throw new HttpError(409, 'Selected class is full.');
    assertClassGenderAllowsStudent(classId, gender);
  }
  const newId = id('stu');
  const regDate = today();

  let resolvedTuition = tuitionAmount;
  if (resolvedTuition == null && classId) {
    const cls = stmtGetClassFee.get(classId) as any;
    resolvedTuition = cls ? cls.fee : 0;
  }
  // finite + non-negative was not enough: 1e15 passed and became a tuition of
  // one quadrillion. assertMoney adds the two-decimal rounding and the
  // safe-integer-cents ceiling used by every other money field.
  try { resolvedTuition = assertMoney(resolvedTuition ?? 0, 'tuition amount'); }
  catch { throw new HttpError(400, 'Tuition amount must be zero or greater.'); }

  let paidNow: number;
  try { paidNow = assertMoney(amountPaidNow ?? 0, 'amount paid'); }
  catch { throw new HttpError(400, 'Amount paid must be zero or greater.'); }
  const netTuitionDue = Math.max(0, resolvedTuition - Math.round((resolvedTuition * effDiscount) / 100));
  // The `&& netTuitionDue > 0` escape hatch let any sum be collected against a
  // zero-fee enrolment — the same hole already closed in the visitor
  // conversion path. Money may never exceed what is payable, including zero.
  if (paidNow > netTuitionDue) throw new HttpError(400, 'Amount received cannot exceed payable fee.');

  let receiptNumber: string | null = null;
  const tx = db.transaction(() => {
    stmtInsertStudent.run(newId, studentCode, fullName, phone || null, email || null, `${studentCode}-${String(fullName).toUpperCase().replace(/\s+/g, '-')}`, regDate, studentBranchId, effDiscount, gender, fatherName || null, addressRegion || null, tazkiraNo || null, whatsapp || null, dob || null, schoolOrUniversity || null, emergencyContactName || null, emergencyContactPhone || null, notes || null);
    if (classId) stmtInsertSemester.run(id('sem'), newId, 'Current Semester', classId, regDate, resolvedTuition, netTuitionDue);
    if (paidNow > 0) {
      const pid = id('pay');
      receiptNumber = nextReceiptNumber();
      // Registration is guarded by unique phone/email/tazkira, so this payment
      // cannot legitimately repeat; keying it on the new student makes that
      // explicit to the database rather than leaving the column NULL (which
      // silently disables uq_payments_idempotency).
      stmtInsertSimplePayment.run(pid, newId, paidNow, regDate, 'cash', 'fee', 'Class fee payment', receiptNumber, studentBranchId, `register:${newId}`);
      recordIncome({ category: 'fee', amount: paidNow, date: regDate, description: `Registration fee for ${fullName}`, referenceId: newId, paymentId: pid, operatorName: user.fullName, operatorRole: req.rbac?.primaryRole ?? null, branchId: studentBranchId });
    }
    stmtInsertRegistration.run(id('reg'), newId, classId || null, regDate, paidNow, receiptNumber, resolvedTuition - netTuitionDue, studentBranchId, 'manual', 'Current Semester');
    // Enrollment (and its capacity check) happens in the same transaction so
    // a full-class race rolls the whole student creation back — never an
    // orphan student with a committed semester but no enrollment. The
    // semester projection above is explicit (carries the real fee amounts),
    // so enroll() skips its own projection write.
    if (classId) getEnrollmentService(db).enroll({ studentId: newId, branchId: studentBranchId, semesterName: 'Current Semester', classId, enrollmentType: 'new', actorUserId: user.userId, actorName: user.fullName, startedAt: regDate, autoInvoice: resolvedTuition <= 0, writeSemester: false });
  });
  tx();

  try {
    const journey = getJourneyEngine(db);
    journey.appendEvent({ studentId: newId, eventType: JourneyEventType.STUDENT_REGISTERED, occurredAt: regDate, branchId: studentBranchId, actorUserId: user.userId, actorName: user.fullName, payload: { studentCode, fullName } });
  } catch (err) { log.warn('[journey] failed', err); }

  writeAudit(req, `Registered student ${fullName} (${studentCode})`, { newValue: JSON.stringify({ studentId: newId, branchId: studentBranchId, gender, discountPercent: effDiscount, receipt: receiptNumber }) });
  res.status(201).json({ id: newId, studentCode, receiptNumber });
}));

// ============================================================================
// §3 — CONCURRENT CLASS ENROLLMENT (Extra Classes)
// ============================================================================

studentsRouter.post('/:id/enroll-class', requirePermission('Class.Assign'), ah(async (req, res) => {
  const user = getUserContext(req);
  const student = requireStudent(req, req.params.id);
  // A graduated or suspended student may not take a new class (audit STU-C2).
  assertStudentOperable(student, 'enroll this student in a class');
  const { amountPaidNow = 0 } = req.body || {};
  const classId = requiredText(req.body?.classId, 'Class id', TEXT_LIMITS.short);
  const notes = optionalText(req.body?.notes, 'Enrollment notes', TEXT_LIMITS.notes);
  const cls = stmtGetClassDetails.get(classId) as any;
  if (!cls) throw new HttpError(404, 'Class not found.');
  if (cls.branch_id !== student.branch_id) throw new HttpError(400, 'Class belongs to another branch.');
  const classEnrollmentCount = countActiveStudentsInClass(db, classId);
  const classCapacity = Number(cls.capacity ?? 0);
  if (classCapacity > 0 && classEnrollmentCount >= classCapacity) throw new HttpError(409, 'Class is full.');
  
  // classes.status is a coarse projection of lifecycle_stage (see
  // core/academic/lifecycle-engine.ts) — 'scheduled' is a lifecycle_stage
  // value, not a status value, so it can never appear here; the projection
  // already maps it (and five other operating stages) onto 'active'. Use
  // GET /:id/lifecycle if a caller needs the finer-grained stage.
  if (cls.status !== 'active') {
    throw new HttpError(400, `Cannot enroll in a class that is ${cls.status}.`);
  }
  
  // Duplicate rule comes from the single domain authority (audit E-2). This
  // route must not carry its own narrower version keyed on status='active'
  // alone: that disagrees with the capacity predicate about what occupies a
  // seat. The shared rule covers active|confirmed|pending.
  assertNotAlreadySeatedInClass(db, student.id, classId);
  
  assertClassGenderAllowsStudent(classId, student.gender);
  // Extra-class enrollment writes the enrollment row directly rather than going
  // through EnrollmentService.enroll(), so it applies the same placement
  // invariant explicitly — otherwise it remains a bypass of the gate installed
  // for certification finding C-1. Same shared domain rule, no second
  // implementation of it.
  assertPlacementEligibleForClass(db, student.id, classId, student.branch_id);

  // Check Academic Hold
  checkAcademicHold(req, student.id);

  const enrollId = id('enr');
  const date = today();
  const baseFee = cls.fee || 0;
  // CFG-1: re-resolve authorization at the moment the charge is issued. The
  // stored `discount_percent` is a cached figure; if the authorization behind
  // it was revoked or expired since, it must not fund a NEW invoice. Proven:
  // a revoked 100% sponsorship still produced a zero-fee enrollment. Already
  // issued invoices are untouched — only this new document is re-derived.
  const discount = resolveAuthorizedDiscount(db, student.id, Number(student.discount_percent || 0), { branchId: student.branch_id }).percent;
  const netFee = Math.max(0, baseFee - Math.round(baseFee * discount / 100));
  let paidNow: number;
  try { paidNow = assertMoney(amountPaidNow ?? 0, 'amount paid'); }
  catch { throw new HttpError(400, 'Amount paid must be zero or greater.'); }
  if (paidNow > netFee) throw new HttpError(400, 'Amount paid cannot exceed the payable fee.');

  const tx = db.transaction(() => {
    stmtInsertEnrollment.run(enrollId, student.id, cls.program_id || null, 'Extra Class', cls.level, classId, student.branch_id, date, notes || 'Concurrent enrollment', JSON.stringify({ baseFee, discount, netFee }));

    const sessions = stmtGetClassSessions.all(classId) as any[];
    for (const sess of sessions) {
      if (!db.prepare('SELECT id FROM rosters WHERE session_id = ? AND student_id = ?').get(sess.id, student.id)) {
        stmtInsertRoster.run(id('ros'), sess.id, student.id, 'not_marked');
      }
    }

    if (paidNow > 0) {
      const pid = id('pay');
      // idempotency_key was NULL here, which migration 063's trigger rejects
      // ("payment idempotency_key is required"). Every paid extra-class
      // enrollment therefore failed with HTTP 500 and rolled back entirely —
      // the feature was unusable whenever money was collected with it, while
      // the unpaid path (amountPaidNow omitted) worked, which is why the gap
      // went unnoticed. Reproduced live against an ordinary numeric class fee,
      // so it is not a side effect of any other finding (audit C-6).
      //
      // KEYED ON THE ENROLLMENT, NOT ON (student, class).
      //
      // A (student, class) key looks tempting but is WRONG, and the audit's own
      // mutation testing caught it: a student who enrolls, pays, DROPS, and
      // later legitimately re-enrolls in the same class must be able to pay
      // again. With a (student, class) key that second, entirely valid payment
      // collided with the first and was refused 409 — silently destroying
      // billable revenue, the same class of mistake migration 074 documents for
      // the enrollment index.
      //
      // `enrollId` is minted once per enrollment above, so the key is unique per
      // real financial event and stays traceable back to it. Double-submit
      // protection does not depend on this key at all: it comes from the
      // duplicate-seat guard (assertNotAlreadySeatedInClass) backed by
      // uq_enrollment_active_seat_per_class (074) — verified live, 5 concurrent
      // submits yield exactly 1x201 and 4x409 "Already enrolled in this class."
      stmtInsertPayment.run(pid, student.id, paidNow, date, 'cash', 'fee', `Extra class fee: ${cls.name}`, nextReceiptNumber(), student.branch_id, null, null, null, `extra-class:${enrollId}`);
      recordIncome({ category: 'fee', amount: paidNow, date, description: `Extra class fee from ${student.full_name}`, referenceId: student.id, paymentId: pid, operatorName: user.fullName, operatorRole: req.rbac?.primaryRole ?? null, branchId: student.branch_id });
    }

    if (netFee - paidNow > 0) {
      const invId = id('inv');
      stmtInsertInvoice.run(invId, student.id, baseFee, (baseFee - netFee), netFee, paidNow >= netFee ? 'paid' : 'issued', date, date, student.branch_id, `Fee for extra class: ${cls.name}`, nextInvoiceNumber(student.branch_id), user.fullName);
    }
  });
  tx();

  try {
    getJourneyEngine(db).appendEvent({ studentId: student.id, eventType: JourneyEventType.ENROLLMENT_CREATED, occurredAt: date, branchId: student.branch_id, actorUserId: user.userId, actorName: user.fullName, payload: { classId, className: cls.name, type: 'extra_class', fee: netFee } });
  } catch (err) { log.warn('[journey] failed', err); }

  writeAudit(req, `Enrolled ${student.full_name} in extra class ${cls.name}`, { newValue: JSON.stringify({ classId, netFee, paidNow }) });
  res.status(201).json({ ok: true, message: 'Successfully enrolled in extra class.' });
}));

// ============================================================================
// §4 — SMART PAYMENTS & REFUNDS
// ============================================================================

studentsRouter.post('/:id/payments', requirePermission('Payment.Create'), ah(async (req, res) => {
  const user = getUserContext(req);
  const student = requireStudent(req, req.params.id);
  const { category, paymentMethod, amount } = req.body ?? {};
  const notes = optionalText(req.body?.notes, 'Payment notes', TEXT_LIMITS.notes);
  const semesterId = optionalText(req.body?.semesterId, 'Semester id', TEXT_LIMITS.short);
  const bookId = optionalText(req.body?.bookId, 'Book id', TEXT_LIMITS.short);
  const installmentId = optionalText(req.body?.installmentId, 'Installment id', TEXT_LIMITS.short);

  if (!category || !['fee', 'book', 'chapter', 'exam', 'card', 'placement', 'diploma', 'installment', 'other'].includes(category)) throw new HttpError(400, 'Invalid category.');
  if (paymentMethod != null && !['cash', 'card', 'bank_transfer'].includes(paymentMethod)) {
    throw new HttpError(400, 'Invalid payment method.');
  }
  const resolvedMethod = paymentMethod ?? 'cash';
  const date = today();
  // Idempotency is ALWAYS applied, never only when the client remembers to
  // send a key, because an un-keyed double-click otherwise creates one payment
  // per click. When no key is supplied a fingerprint of the business intent is
  // derived, so retries collapse while a genuinely new later charge (a
  // different time bucket, or an explicit client key) still goes through.
  // F-5: parse ONCE, before the idempotency fingerprint is derived, so the
  // fingerprint, the validation and the stored amount all describe the same
  // value. `Number()` here let non-amounts through as real charges:
  //     true -> 1 AFN, [500] -> 500 AFN, '0x10' -> 16 AFN, [[7]] -> 7 AFN
  //     (each with real cash movement), and 0.001 leaked a 500 from the
  //     two-decimal database trigger.
  // `null` still means "amount not supplied", which several categories rely on
  // to derive the charge themselves, so that contract is preserved exactly.
  const amountSupplied = !(amount === undefined || amount === null || amount === '');
  let parsedAmount: number | null = null;
  if (amountSupplied) {
    try { parsedAmount = assertMoney(amount, 'Amount'); }
    catch { throw new HttpError(400, 'Amount must be greater than 0.'); }
  }
  const { key: idempotencyKey, candidates: idempotencyCandidates, clientSupplied: clientSuppliedKey } = resolveIdempotency(req, {
    route: 'student-payment',
    studentId: student.id,
    category,
    amount: parsedAmount,
    semesterId: semesterId ?? null,
    installmentId: installmentId ?? null,
    bookId: bookId ?? null,
    method: resolvedMethod,
    actorUserId: user.userId,
  });
  // An EXPLICIT client key always replays immediately — the caller has stated
  // that this is one intent.
  //
  // A DERIVED key must not short-circuit here for categories that carry their
  // own business-event guard (fee/installment/book/card/diploma/placement).
  // Those guards return a precise, actionable error ("already fully paid",
  // "diploma fee already recorded"); replaying a stale success would hide it
  // and tell the operator the charge succeeded when it did not. For those
  // categories the guards run first and the unique index below is the
  // duplicate backstop. Free-amount categories have no such guard, so the
  // derived key is what protects them.
  //
  // CRITICAL: skipping the *pre-check* is safe; skipping the *persisted key*
  // is not. The key is always written (see stmtInsertPayment below) so that
  // uq_payments_idempotency can actually arbitrate concurrent requests. When
  // the key was written as NULL for guarded categories, SQLite treated every
  // NULL as distinct, the unique index never fired, and 12 concurrent un-keyed
  // `fee` payments produced 12 payments and 12 income rows from one intent.
  const GUARDED_CATEGORIES = ['fee', 'installment', 'book', 'card', 'diploma', 'placement'];
  const replayEligible = clientSuppliedKey || !GUARDED_CATEGORIES.includes(category);
  if (replayEligible) {
    for (const candidate of idempotencyCandidates) {
      const existing = stmtGetPaymentByIdempotency.get(candidate, student.id) as any;
      if (existing) return res.status(200).json({ receiptNumber: existing.receipt_number, amountCharged: existing.amount, idempotentReplay: true });
    }
  }
  const rc = nextReceiptNumber();
  const payId = id('pay');
  let resolvedAmount = 0;
  let semName: string | null = null;
  let bookRefId: string | null = null;
  const requestedAmount = parsedAmount;
  if (requestedAmount !== null && requestedAmount <= 0) throw new HttpError(400, 'Amount must be greater than 0.');

  if (category === 'fee') {
    if (!semesterId) throw new HttpError(400, 'semesterId is required when paying a class fee.');
    const sem = (stmtGetSemestersByStudent.all(student.id) as any[]).find(s => s.id === semesterId);
    if (!sem) throw new HttpError(404, 'Semester not found.');
    // One authority for "how much has this semester been paid" — charges and
    // the refunds that reverse them, both filtered by the semester itself.
    const totalPaidForSem = getSemesterTuitionSettled(db, student.id, sem.semester_name);
    const semDebt = Math.max(0, Number(sem.net_fee_amount ?? sem.fee_amount) - totalPaidForSem);
    if (semDebt <= 0) throw new HttpError(400, 'This semester is already fully paid.');
    resolvedAmount = semDebt;
    // An amount larger than the outstanding balance is REJECTED, never capped.
    // Silently charging semDebt instead of the requested figure told the
    // operator "payment registered" for a number they did not enter, so a
    // mistyped 30000 against a 3000 debt looked successful and the receipt
    // disagreed with the cash drawer. The caller must correct the amount.
    if (requestedAmount !== null) {
      if (requestedAmount > semDebt) {
        throw new HttpError(400, `Payment exceeds the remaining balance for this enrollment. Outstanding: ${semDebt} AFN.`);
      }
      resolvedAmount = requestedAmount;
    }
    semName = sem.semester_name;
  } 
  else if (category === 'installment') {
    if (!installmentId) throw new HttpError(400, 'installmentId is required.');
    // The instalment belongs to a tuition obligation, so the term it settles is
    // a fact of the plan rather than something the desk selects (owner
    // decisions D-117/D-125). While the plan was JSON on the student, an
    // instalment payment settled no term and the same tuition could be
    // collected twice.
    const payable = getPayableInstallment(db, student.id, installmentId);
    resolvedAmount = payable.installment.amount;
    if (requestedAmount !== null && requestedAmount !== resolvedAmount) throw new HttpError(400, 'Installment payment must match the installment amount.');
    if (resolvedAmount > payable.outstanding) {
      throw new HttpError(409, `That term has only ${payable.outstanding} AFN outstanding; the instalment plan no longer matches what is owed.`);
    }
    semName = payable.obligation.semesterName;
  }
  else if (category === 'book') {
    if (!bookId) throw new HttpError(400, 'bookId is required.');
    const book = stmtGetBookPrice.get(bookId, student.branch_id) as any;
    if (!book) throw new HttpError(404, 'Book not found.');
    if (book.stock <= 0) throw new HttpError(409, 'Book is out of stock.');
    resolvedAmount = Number(book.price || 0);
    if (requestedAmount !== null && requestedAmount !== resolvedAmount) throw new HttpError(400, 'Book payment must match the listed book price.');
    // Financial integrity: a book is charged once per student. The book-sale
    // desk (POST /books/:id/sell) and the payment desk are two writers for the
    // same business event; the manual payment must not duplicate a completed
    // sale (or an earlier payment) for this student+book.
    const alreadySold = db.prepare(
      `SELECT 1 FROM book_sales WHERE student_id = ? AND book_id = ? AND status = 'completed' LIMIT 1`
    ).get(student.id, bookId);
    if (alreadySold) throw new HttpError(409, 'This book was already sold to this student. No additional book payment is due.');
    const alreadyPaidBook = db.prepare(
      `SELECT 1 FROM payments WHERE student_id = ? AND book_id = ? AND category IN ('book','chapter') AND status = 'completed' LIMIT 1`
    ).get(student.id, bookId);
    if (alreadyPaidBook) throw new HttpError(409, 'This book was already paid for by this student.');
    bookRefId = bookId;
  }
  else if (['chapter', 'exam', 'other'].includes(category)) {
    // AD-HOC CHARGES. These three are deliberately not backed by a
    // pre-created obligation: they exist so the desk can take money for
    // something the catalogue does not model (a re-sit, a lab fee, a
    // replacement handout). The operator states the amount and it is recorded
    // EXACTLY as entered — never capped, never adjusted.
    //
    // Because there is no obligation to check the amount against, the reason
    // IS the control. Without it the payment reached the ledger as the
    // meaningless default "Smart Payment", so an auditor reviewing an
    // unexplained 7,777 AFN charge had nothing to review. A free-amount charge
    // with no stated purpose is not auditable, so the reason is mandatory.
    if (requestedAmount === null) throw new HttpError(400, 'Amount is required for this payment category.');
    const reason = typeof notes === 'string' ? notes.trim() : '';
    if (reason.length < 3) {
      throw new HttpError(400, 'A reason is required for an ad-hoc charge. Describe what this payment is for.');
    }
    resolvedAmount = requestedAmount;
  }
  else if (['card', 'diploma', 'placement'].includes(category)) {
    const feeKey = category === 'card' ? 'cardIssuanceFee' : category === 'diploma' ? 'diplomaFee' : 'placementTestFee';
    resolvedAmount = Number(resolveFee(db, student.branch_id, feeKey) || 0);
    if (requestedAmount !== null && requestedAmount !== resolvedAmount) throw new HttpError(400, 'This fee must be paid at its configured amount.');
    // Financial integrity: fixed fees are charged once per student.
    //  - placement: auto-booked at assessment completion (see below).
    //  - card: auto-booked on first ID-card issuance.
    //  - diploma: one diploma per student.
    // A manual/API payment of the same category would duplicate income.
    if (category === 'placement' && student.lead_id) {
      const booked = stmtHasBookedPlacementFee.get(student.lead_id);
      if (booked) throw new HttpError(409, 'The placement fee was already recorded for this candidate at assessment completion. No additional placement payment is due.');
    }
    if (category !== 'placement') {
      const paid = stmtHasPaidFixedFee.get(student.id, category, category, student.id);
      if (paid) throw new HttpError(409, `The ${category === 'card' ? 'ID card' : 'diploma'} fee was already recorded for this student. No additional ${category} payment is due.`);
    }
  }

  if (resolvedAmount <= 0) throw new HttpError(400, 'Amount must be greater than 0.');

  const tx = db.transaction(() => {
    if (category === 'fee') {
      const currentSem = (stmtGetSemestersByStudent.all(student.id) as any[]).find((s) => s.id === semesterId);
      if (!currentSem) throw new HttpError(404, 'Semester not found.');
      const currentPaid = getSemesterTuitionSettled(db, student.id, currentSem.semester_name);
      const currentDebt = Math.max(0, Number(currentSem.net_fee_amount ?? currentSem.fee_amount) - currentPaid);
      if (currentDebt <= 0) throw new HttpError(409, 'This semester is already fully paid.');
      // Authoritative re-read inside the transaction. This is the check that
      // actually holds under concurrency: two operators paying the last 5000
      // both pass the pre-check above, but only one can see currentDebt > 0
      // here. Reject rather than cap, for the same reason as the pre-check.
      if (requestedAmount !== null && requestedAmount > currentDebt) {
        throw new HttpError(400, `Payment exceeds the remaining balance for this enrollment. Outstanding: ${currentDebt} AFN.`);
      }
      resolvedAmount = requestedAmount === null ? currentDebt : requestedAmount;
      semName = currentSem.semester_name;
      if (resolvedAmount <= 0) throw new HttpError(400, 'Amount must be greater than 0.');
    }
    if (category === 'installment') {
      // Re-read inside the transaction: two desks paying one instalment both
      // pass the check above, and only one may mark it paid.
      const fresh = getPayableInstallment(db, student.id, String(installmentId));
      if (fresh.installment.amount !== resolvedAmount) throw new HttpError(409, 'The instalment changed while this payment was being taken.');
      if (resolvedAmount > fresh.outstanding) throw new HttpError(409, 'That term no longer has that much outstanding.');
    }
    // The idempotency key is ALWAYS persisted, for every category. It is the
    // only mechanism that serialises concurrent duplicates: the pre-checks
    // above are read-then-write and every concurrent request passes them
    // simultaneously. Writing NULL here for guarded categories would disable
    // the unique index, because SQLite considers each NULL distinct.
    stmtInsertPayment.run(payId, student.id, resolvedAmount, date, resolvedMethod, category, notes || 'Smart Payment', rc, student.branch_id, semName, null, bookRefId, idempotencyKey);
    if (category === 'installment') markInstallmentPaid(db, String(installmentId), payId);
    if (category === 'book') {
      const updated = stmtUpdateBookStock.run(bookRefId, student.branch_id);
      if (updated.changes !== 1) throw new HttpError(409, 'Book stock changed. Please retry.');
    }
    // Ad-hoc charges carry their stated reason into the ledger. Every other
    // category is self-describing (a 'fee' row is explained by its semester, a
    // 'book' row by its book), but an ad-hoc amount is only explicable by the
    // reason the operator gave, so the ledger must show it rather than a
    // generic "Received other payment from X".
    const adHoc = ['chapter', 'exam', 'other'].includes(category);
    const ledgerDescription = adHoc
      ? `${category === 'other' ? 'Ad-hoc charge' : `${category} charge`} for ${student.full_name}: ${String(notes).trim()}`
      : `Received ${category} payment from ${student.full_name}`;
    recordIncome({ category, amount: resolvedAmount, date, description: ledgerDescription, referenceId: student.id, paymentId: payId, operatorName: user.fullName, operatorRole: req.rbac?.primaryRole ?? null, branchId: student.branch_id });
  });
  try {
    tx();
  } catch (err) {
    // Atomic backstop. The pre-check above is a fast path; under true
    // concurrency several requests can pass it simultaneously. Only one can
    // win the unique index on payments.idempotency_key — the losers replay
    // the winner's result instead of surfacing a 500 or double-charging.
    if (isUniqueViolation(err)) {
      const winner = stmtGetPaymentByIdempotency.get(idempotencyKey, student.id) as any;
      if (winner) return res.status(200).json({ receiptNumber: winner.receipt_number, amountCharged: winner.amount, idempotentReplay: true });
      // The key is taken, but by a DIFFERENT student — the caller reused one
      // key for two distinct charges. Refuse loudly: replaying the other
      // student's receipt would silently lose this payment.
      throw new HttpError(409, 'This Idempotency-Key was already used for a different student. Use a unique key per payment.');
    }
    throw err;
  }

  try {
    getJourneyEngine(db).appendEvent({ studentId: student.id, eventType: JourneyEventType.PAYMENT_RECORDED, occurredAt: date, branchId: student.branch_id, actorUserId: user.userId, actorName: user.fullName, payload: { amount: resolvedAmount, category, receiptNumber: rc } });
  } catch (err) { log.warn('[journey] failed', err); }

  writeAudit(req, `Recorded ${category} payment ${resolvedAmount} AFN from ${student.full_name}`, { branchId: student.branch_id, newValue: JSON.stringify({ receipt: rc, amount: resolvedAmount, category, paymentId: payId, semester: semName, bookId: bookRefId }) });
  res.status(201).json({ receiptNumber: rc, amountCharged: resolvedAmount });
}));

/**
 * The payments this student still has money against, with the server's own
 * figure for how much of each is left to refund.
 *
 * The refund dialog needs to name a payment (D-113), and it must not work that
 * figure out for itself: a browser that subtracts refunds from a page of
 * payments is a second financial authority, and it is wrong the moment a
 * payment falls outside the page.
 */
studentsRouter.get('/:id/refundable-payments', requirePermission('Refund.Approve'), ah(async (req, res) => {
  const student = requireStudent(req, req.params.id);
  const rows = stmtListRefundablePayments.all(student.id) as Array<{
    id: string; amount: number; category: string; date: string; semester: string | null;
    receipt_number: string | null; payment_method: string | null; refunded: number;
  }>;
  res.json(
    rows
      .map((r) => ({
        id: r.id,
        amount: Number(r.amount),
        category: r.category,
        date: r.date,
        semester: r.semester ?? null,
        receiptNumber: r.receipt_number,
        paymentMethod: r.payment_method,
        refundedAmount: Number(r.refunded),
        refundableAmount: Math.max(0, Number(r.amount) - Number(r.refunded)),
      }))
      .filter((r) => r.refundableAmount > 0),
  );
}));

/**
 * Issue a refund against ONE named payment.
 *
 * Owner decisions D-113 and D-114: a refund reverses a specific payment, and a
 * tuition refund re-opens the debt of the semester that payment settled. The
 * refund therefore inherits both the target's identity and its semester rather
 * than accepting either from the caller — an unattributed refund cannot be
 * explained, and it was proven to create tuition debt out of a refunded exam
 * fee, which the enrolment debt-hold then acted on.
 */
/**
 * The instalment plan of ONE tuition obligation.
 *
 * A plan pays a term, so it is written against that term rather than onto the
 * student. Paying an instalment then settles the term the plan belongs to and
 * the desk never chooses a semester (owner decisions D-117 and D-125).
 */
studentsRouter.get('/:id/installment-plan', requirePermission('Payment.View'), ah(async (req, res) => {
  const student = requireStudent(req, req.params.id);
  res.json(listStudentInstallments(db, student.id).map((row) => ({
    id: row.id,
    obligationId: row.obligationId,
    semesterId: row.semesterId,
    semesterName: row.semesterName,
    sequence: row.sequence,
    amount: row.amount,
    dueDate: row.dueDate,
    status: row.status,
  })));
}));

studentsRouter.put('/:id/installment-plan', requirePermission('Payment.Create'), ah(async (req, res) => {
  const student = requireStudent(req, req.params.id);
  const { semesterId, installments } = req.body as { semesterId?: string; installments?: Array<{ amount: unknown; dueDate?: unknown }> };
  const semesterRef = typeof semesterId === 'string' ? semesterId.trim() : '';
  if (!semesterRef) throw new HttpError(400, 'The term this plan pays must be named (semesterId).');

  const semester = (stmtGetSemestersByStudent.all(student.id) as Array<{ id: string }>).find((row) => row.id === semesterRef);
  if (!semester) throw new HttpError(404, 'Semester not found for this student.');

  let plan: ReturnType<typeof setInstallmentPlan> = [];
  db.transaction(() => {
    const obligation = ensureTuitionObligation(db, semesterRef);
    plan = setInstallmentPlan(db, { obligationId: obligation.id, installments: installments ?? [] });
  })();

  writeAudit(req, `Set an instalment plan of ${plan.length} instalments for ${student.full_name}`, { branchId: student.branch_id, newValue: JSON.stringify({ semesterId: semesterRef, total: plan.reduce((sum, row) => sum + row.amount, 0) }) });
  res.json(plan);
}));

studentsRouter.post('/:id/refund', requirePermission('Refund.Approve'), ah(async (req, res) => {
  const user = getUserContext(req);
  const student = requireStudent(req, req.params.id);
  const { amount, paymentId } = req.body ?? {};
  const reason = requiredText(req.body?.reason, 'Refund reason', TEXT_LIMITS.notes);
  // A refund moves real money out, so the amount is parsed, never coerced:
  // `true`, `[500]` and `'0x10'` are not amounts.
  let refundAmount: number;
  try { refundAmount = assertMoney(amount, 'Refund amount'); }
  catch { throw new HttpError(400, 'Refund amount must be positive.'); }
  if (refundAmount <= 0) throw new HttpError(400, 'Refund amount must be positive.');

  const targetId = typeof paymentId === 'string' ? paymentId.trim() : '';
  if (!targetId) throw new HttpError(400, 'A refund must name the payment it reverses (paymentId).');
  const target = stmtGetRefundTarget.get(targetId) as
    | { id: string; student_id: string; branch_id: string; amount: number; category: string; semester: string | null; status: string; refunded: number }
    | undefined;
  if (!target) throw new HttpError(404, 'The payment being refunded was not found.');
  if (target.student_id !== student.id) throw new HttpError(403, 'That payment belongs to another student.');
  if (target.status !== 'completed') throw new HttpError(409, 'Only a completed payment can be refunded.');
  if (target.category === 'refund') throw new HttpError(400, 'A refund cannot be refunded.');
  const refundable = Math.max(0, Number(target.amount) - Number(target.refunded));
  if (refundable <= 0) throw new HttpError(409, 'That payment has already been fully refunded.');
  if (refundAmount > refundable) {
    throw new HttpError(400, `Refund exceeds the ${refundable} AFN still refundable on that payment.`);
  }

  const date = today();
  // Refunds move real money out; the same mandatory idempotency applies.
  const { key: idempotencyKey, candidates: idempotencyCandidates } = resolveIdempotency(req, {
    route: 'student-refund',
    studentId: student.id,
    paymentId: target.id,
    amount: refundAmount,
    reason: String(reason).trim(),
    // Two different operators each issuing a refund of the same amount are
    // two distinct business events, not a retry of one.
    actorUserId: user.userId,
  });
  for (const candidate of idempotencyCandidates) {
    const existing = stmtGetPaymentByIdempotency.get(candidate, student.id) as any;
    if (existing) return res.status(200).json({ receiptNumber: existing.receipt_number, idempotentReplay: true });
  }
  const rc = `REF-${nextReceiptNumber()}`;
  const payId = id('pay');

  const tx = db.transaction(() => {
    // Re-read inside the transaction: two refunds racing on one payment must
    // not both pass the cap they each read before the other committed.
    const fresh = stmtGetRefundTarget.get(target.id) as { amount: number; refunded: number };
    const stillRefundable = Math.max(0, Number(fresh.amount) - Number(fresh.refunded));
    if (refundAmount > stillRefundable) {
      throw new HttpError(409, `Only ${stillRefundable} AFN remains refundable on that payment.`);
    }
    stmtInsertRefundPayment.run(
      payId, student.id, -refundAmount, date, String(reason).trim(), rc, student.branch_id,
      idempotencyKey, target.id, target.semester ?? null,
    );
    recordIncome({
      category: 'refund', amount: -refundAmount, date,
      description: `Refund issued to ${student.full_name} against ${target.category} payment ${target.id}`,
      referenceId: student.id, paymentId: payId, operatorName: user.fullName,
      operatorRole: req.rbac?.primaryRole ?? null, branchId: student.branch_id,
    });
  });
  try {
    tx();
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winner = stmtGetPaymentByIdempotency.get(idempotencyKey, student.id) as any;
      if (winner) return res.status(200).json({ receiptNumber: winner.receipt_number, idempotentReplay: true });
      // Key already used by another student — refuse rather than lose the refund.
      throw new HttpError(409, 'This Idempotency-Key was already used for a different student. Use a unique key per refund.');
    }
    throw err;
  }

  try {
    getJourneyEngine(db).appendEvent({ studentId: student.id, eventType: JourneyEventType.PAYMENT_RECORDED, occurredAt: date, branchId: student.branch_id, actorUserId: user.userId, actorName: user.fullName, payload: { amount: -refundAmount, category: 'refund', receiptNumber: rc, refundsPaymentId: target.id } });
  } catch (err) { log.warn('[journey] failed', err); }

  writeAudit(req, `Refunded ${refundAmount} AFN to ${student.full_name}`, { branchId: student.branch_id, oldValue: JSON.stringify({ reason: String(reason), refundsPaymentId: target.id, refundsCategory: target.category }), newValue: JSON.stringify({ receipt: rc, amount: refundAmount, paymentId: payId }) });
  res.status(201).json({ receiptNumber: rc, refundsPaymentId: target.id, refundsCategory: target.category, semester: target.semester ?? null });
}));

// ============================================================================
// §5 — SEMESTER ENROLLMENT & LIFECYCLE
// ============================================================================

studentsRouter.post('/:id/enroll-semester', requirePermission('Class.Assign'), ah(async (req, res) => {
  const user = getUserContext(req);
  const student = requireStudent(req, req.params.id);
  assertStudentOperable(student, 'enroll this student in a semester');
  const { tuitionAmount, amountPaidNow } = req.body ?? {};
  const classId = optionalText(req.body?.classId, 'Class id', TEXT_LIMITS.short);
  const semesterName = requiredText(req.body?.semesterName, 'Semester name', TEXT_LIMITS.name);
  const notes = optionalText(req.body?.notes, 'Enrollment notes', TEXT_LIMITS.notes);
  if (student.status !== 'active') throw new HttpError(409, 'Only active students can be enrolled.');
  if (classId) {
    const cls = stmtGetClassDetails.get(classId) as any;
    if (!cls) throw new HttpError(404, 'Class not found.');
    if (cls.branch_id !== student.branch_id) throw new HttpError(400, 'Class belongs to another branch.');
    if (cls.status !== 'active') throw new HttpError(400, 'Selected class is not active.');
    assertClassGenderAllowsStudent(classId, student.gender);
  }

  // Check Academic Hold before starting a new semester
  checkAcademicHold(req, student.id);

  let resolvedTuition = tuitionAmount;
  if (resolvedTuition == null && classId) {
    const cls = stmtGetClassFee.get(classId) as any;
    resolvedTuition = cls ? cls.fee : 0;
  }
  try { resolvedTuition = assertMoney(resolvedTuition ?? 0, 'tuition amount'); }
  catch { throw new HttpError(400, 'Tuition amount must be zero or greater.'); }
  // CFG-1: same re-resolution as enroll-class — a revoked or expired grant
  // must not price a new semester.
  const effectivePercent = resolveAuthorizedDiscount(db, student.id, Math.max(0, Number(student.discount_percent || 0)), { branchId: student.branch_id }).percent;
  const discountAmount = Math.round(resolvedTuition * effectivePercent / 100);
  const netTuition = Math.max(0, resolvedTuition - discountAmount);
  let paidNow: number;
  try { paidNow = assertMoney(amountPaidNow ?? 0, 'amount received'); }
  catch { throw new HttpError(400, 'Amount received must be zero or greater.'); }
  if (paidNow > netTuition) throw new HttpError(400, 'Amount received cannot exceed the payable fee.');

  const date = today();
  const rc = nextReceiptNumber();
  const newSemId = id('sem');

  const tx = db.transaction(() => {
    // Idempotency guard (also enforced by uq_student_semester_active): a
    // double-click / retry must not create a second ACTIVE semester with the
    // same name and charge the tuition twice. Legitimate repeats of a
    // COMPLETED semester are unaffected (the guard only blocks active rows).
    const existingActiveSem = db.prepare(
      `SELECT 1 FROM student_semesters WHERE student_id = ? AND semester_name = ? AND status = 'active' LIMIT 1`
    ).get(student.id, semesterName);
    if (existingActiveSem) throw new HttpError(409, `Student is already enrolled in ${semesterName}.`);
    stmtInsertSemester.run(newSemId, student.id, semesterName, classId || null, date, resolvedTuition, netTuition);
    if (paidNow > 0) {
      const semPayId = id('pay');
      // Keyed on the semester enrolment itself: uq_student_semester_active
      // already forbids a second active semester of the same name, so this
      // payment cannot legitimately repeat. A NULL here would disable
      // uq_payments_idempotency for the row.
      stmtInsertPayment.run(semPayId, student.id, paidNow, date, 'cash', 'fee', `Semester fee for ${semesterName}`, rc, student.branch_id, semesterName, null, null, `enroll-semester:${newSemId}`);
      recordIncome({ category: 'fee', amount: paidNow, date, description: `Received ${semesterName} fee from ${student.full_name}`, referenceId: student.id, paymentId: semPayId, operatorName: user.fullName, operatorRole: req.rbac?.primaryRole ?? null, branchId: student.branch_id });
    }
    // Enrollment happens in the same transaction (see manual-add above).
    // writeSemester:false because the explicit semester row above carries the
    // real fee amounts.
    getEnrollmentService(db).enroll({ studentId: student.id, branchId: student.branch_id, semesterName, classId: classId || null, enrollmentType: 'new', notes: notes || null, actorUserId: user.userId, actorName: user.fullName, startedAt: date, autoInvoice: resolvedTuition <= 0 && paidNow <= 0, writeSemester: false });
  });
  tx();

  writeAudit(req, `Enrolled ${student.full_name} in semester ${semesterName}`, { newValue: JSON.stringify({ semesterId: newSemId, classId: classId || null, netTuition, paidNow, receipt: paidNow > 0 ? rc : null }) });
  res.status(201).json({ ok: true, semesterId: newSemId, receiptNumber: paidNow > 0 ? rc : null });
}));

studentsRouter.post('/:id/issue-card', requirePermission('Student.Print'), ah(async (req, res) => {
  const user = getUserContext(req);
  const student = requireStudent(req, req.params.id);
  // Chargeable service: must not bill a graduated student (audit STU-C2).
  assertStudentOperable(student, 'issue an ID card for this student');
  const cardDesign = req.body?.cardDesign;
  const notes = optionalText(req.body?.notes, 'Card notes', TEXT_LIMITS.notes);
  if (!cardDesign || typeof cardDesign !== 'object' || Array.isArray(cardDesign)) {
    throw new HttpError(400, 'Card design must be an object.');
  }
  const serializedCardDesign = JSON.stringify(cardDesign);
  if (serializedCardDesign.length > 3_000_000) {
    throw new HttpError(400, 'Card design and photo are too large.');
  }
  const isFirstIssuance = !student.card_design;
  const date = today();

  // Financial integrity: the card fee is charged once per student. If the
  // fee was already paid through the payment desk, issuing the card must not
  // charge it again — the student still gets their card (feeCharged = 0).
  const cardFeeAlreadyPaid = isFirstIssuance ? !!stmtHasPaidFixedFee.get(student.id, 'card', 'card', student.id) : false;
  const cardFee = isFirstIssuance && !cardFeeAlreadyPaid ? Number(resolveFee(db, student.branch_id, 'cardIssuanceFee') || 0) : 0;

  // The card fee is a once-per-student business event, so its idempotency key
  // is the event identity itself — not a time-bucketed fingerprint. Two
  // concurrent first-issuances therefore collide on uq_payments_idempotency
  // and exactly one books the fee, without relying on the read-then-write
  // `cardFeeAlreadyPaid` check winning the race.
  const cardFeeIdempotencyKey = `card-fee:${student.id}`;
  const tx = db.transaction(() => {
    stmtUpdateStudentCard.run(serializedCardDesign, notes ?? student.notes, student.id);
    if (isFirstIssuance && cardFee > 0) {
      const pid = id('pay');
      stmtInsertSimplePayment.run(pid, student.id, cardFee, date, 'cash', 'card', 'ID Card Issuance', nextReceiptNumber(), student.branch_id, cardFeeIdempotencyKey);
      recordIncome({ category: 'card', amount: cardFee, date, description: `ID card fee for ${student.full_name}`, referenceId: student.id, paymentId: pid, operatorName: user.fullName, operatorRole: req.rbac?.primaryRole ?? null, branchId: student.branch_id });
    }
  });
  try {
    tx();
  } catch (err) {
    // A concurrent issuance already booked the fee. The card itself is still
    // updated by the winning transaction, so this is a success for the caller.
    if (!isUniqueViolation(err)) throw err;
    writeAudit(req, `Reissued ID card for ${student.full_name}`, { newValue: JSON.stringify({ feeCharged: 0, concurrentIssuance: true }) });
    return res.status(201).json({ ok: true, feeCharged: 0 });
  }

  writeAudit(req, `${isFirstIssuance ? 'Issued' : 'Reissued'} ID card for ${student.full_name}`, { newValue: JSON.stringify({ feeCharged: isFirstIssuance ? cardFee : 0 }) });
  res.status(201).json({ ok: true, feeCharged: isFirstIssuance ? cardFee : 0 });
}));

studentsRouter.patch('/:id', requirePermission('Student.Edit'), ah(async (req, res) => {
  const existing = requireStudent(req, req.params.id);
  const body = req.body ?? {};
  // SAME validation authority as CREATE (audit STU-H1). A handler that
  // validated nothing and merged raw body fields straight into the UPDATE
  // would accept and persist gender "martian", a 5,000-character name, a
  // "9999-99-99" date and `phone: ["x"]` — values the CREATE
  // path rejects with 400. `mode: 'patch'` validates only the supplied keys,
  // but applies identical rules to them.
  const patchInput = normalizeStudentInput(body, 'patch');
  const f: Record<string, unknown> = { ...body };
  // Substitute the normalized/validated values so the merge below can never
  // reintroduce the raw payload.
  for (const [k, v] of Object.entries(patchInput.text)) f[k] = v;
  if (patchInput.gender !== undefined) f.gender = patchInput.gender;
  if (body.dob !== undefined) f.dob = patchInput.dob;

  const merge = <K extends keyof StudentRow>(k: string, c: K) => (f[k] !== undefined ? f[k] : existing[c]);

  const nextPhone = String(merge('phone', 'phone') ?? '').trim();
  const nextEmail = String(merge('email', 'email') ?? '').trim();
  const nextTazkira = String(merge('tazkiraNo', 'tazkira_no') ?? '').trim();
  // Normalized phone identity (audit STU-H3) — a formatting change must not
  // let one person occupy two student records.
  const phoneOwner = findStudentByPhoneKey(nextPhone);
  const emailOwner = nextEmail ? stmtFindStudentByEmail.get(nextEmail) as { id: string } | undefined : undefined;
  const tazkiraOwner = nextTazkira ? stmtFindStudentByTazkira.get(nextTazkira) as { id: string } | undefined : undefined;
  if (phoneOwner && phoneOwner.id !== existing.id) throw new HttpError(409, 'A student with this phone number already exists.');
  if (emailOwner && emailOwner.id !== existing.id) throw new HttpError(409, 'A student with this email already exists.');
  if (tazkiraOwner && tazkiraOwner.id !== existing.id) throw new HttpError(409, 'A student with this Tazkira/ID number already exists.');
  if (nextTazkira && stmtFindVisitorByTazkira.get(nextTazkira, existing.lead_id ?? null)) {
    throw new HttpError(409, 'A visitor with this Tazkira/ID number already exists.');
  }

  // Placement assessment results and ID-card designs have dedicated writers.
  // Accepting them through a general profile PATCH bypasses placement evidence
  // and suppresses the first-issuance card fee respectively.
  if (f.placementScore !== undefined) {
    throw new HttpError(400, 'Placement results must be recorded through the placement assessment workflow.');
  }
  if (f.cardDesign !== undefined) {
    throw new HttpError(400, 'ID-card designs must be saved through the issue-card workflow.');
  }

  // The instalment plan is no longer a field of the student profile: it is the
  // schedule of a tuition obligation and is written through
  // `PUT /api/students/:id/installment-plan` (owner decision D-125).
  if (f.installmentPlan !== undefined) {
    throw new HttpError(400, 'An instalment plan is set through PUT /api/students/:id/installment-plan, against the term it pays.');
  }

    let effDiscount = merge('discountPercent', 'discount_percent');
  if (typeof effDiscount !== 'number' || !Number.isFinite(effDiscount) || effDiscount < 0) throw new HttpError(400, 'Discount must be zero or greater.');
  if (effDiscount > 0) {
    const cap = evaluateRules({ category: 'discount', branchId: existing.branch_id, data: { discountPercent: effDiscount } });
    if (typeof cap.finalOutputs.discountPercent === 'number') effDiscount = cap.finalOutputs.discountPercent;
  }
  // CFG-1: bound the rule candidate by what this student is actually
  // authorized to receive. An authorized exception (ambassador, relative,
  // family, sponsorship) raises the ceiling; absent one, ordinary <= 20%.
  effDiscount = resolveAuthorizedDiscount(db, existing.id, Number(effDiscount), { branchId: existing.branch_id }).percent;

  stmtUpdateStudentDetails.run(
    merge('fullName', 'full_name'), merge('phone', 'phone'), merge('email', 'email'), effDiscount, merge('gender', 'gender'),
    merge('fatherName', 'father_name'), merge('addressRegion', 'address_region'), merge('tazkiraNo', 'tazkira_no'), merge('whatsapp', 'whatsapp'),
    merge('dob', 'dob'), merge('schoolOrUniversity', 'school_or_university'), merge('emergencyContactName', 'emergency_contact_name'),
    merge('emergencyContactPhone', 'emergency_contact_phone'), merge('notes', 'notes'),
    f.placementScore !== undefined ? JSON.stringify(f.placementScore) : existing.placement_score,
    f.cardDesign !== undefined ? JSON.stringify(f.cardDesign) : existing.card_design, req.params.id
  );

  // Identity / financial-relevant changes must be traceable: record the
  // before/after subset (name, contacts, gender, discount, placement result).
  const identitySnapshot = (r: any) => JSON.stringify({
    fullName: r.full_name, phone: r.phone, email: r.email, gender: r.gender,
    discountPercent: r.discount_percent, tazkiraNo: r.tazkira_no, dob: r.dob,
    placementScore: r.placement_score != null ? '(set)' : null,
  });
  writeAudit(req, `Updated student profile ${existing.full_name}`, { oldValue: identitySnapshot(existing), newValue: identitySnapshot({ ...existing, full_name: merge('fullName', 'full_name'), phone: merge('phone', 'phone'), email: merge('email', 'email'), gender: merge('gender', 'gender'), discount_percent: effDiscount, tazkira_no: merge('tazkiraNo', 'tazkira_no'), dob: merge('dob', 'dob'), placement_score: f.placementScore !== undefined ? JSON.stringify(f.placementScore) : existing.placement_score }) });
  res.json({ ok: true });
}));

studentsRouter.patch('/:id/status', requirePermission('Student.Edit'), ah(async (req, res) => {
  const existing = requireStudent(req, req.params.id);
  const { status } = req.body ?? {};
  // Vocabulary and transition legality both come from the single Student
  // lifecycle authority (audit STU-C1/C2). Accepting any of three values from
  // ANY current state would let `graduated → inactive → active` launder a
  // terminal state back into an active one.
  if (!isStudentStatus(status)) {
    throw new HttpError(400, `Status must be one of: ${STUDENT_STATUSES.join(', ')}.`);
  }
  if (status === 'suspended') {
    // Suspension has real side effects (enrollments deferred, semesters held).
    // It must go through the workflow that performs them.
    throw new HttpError(400, 'Use the suspend/resume workflow for suspended status.');
  }
  const from = (isStudentStatus(existing.status) ? existing.status : 'active') as StudentStatus;
  if (from === 'suspended') {
    // A suspended target was already routed to the workflow error above, so
    // every remaining request would strand enrollment and exact-semester state
    // behind a different profile status.
    throw new HttpError(409, 'Resume the suspended student before changing status.');
  }
  assertStudentTransition(from, status);
  if (from === status) return res.json({ ok: true, unchanged: true });
  applyStudentStatus(req, existing, status);
  res.json({ ok: true });
}));

studentsRouter.post('/:id/transfer', requirePermission('Student.Transfer'), ah(async (req, res) => {
  const user = getUserContext(req);
  const toClassId = requiredText(req.body?.toClassId, 'Destination class id', TEXT_LIMITS.short);
  const notes = optionalText(req.body?.notes, 'Transfer notes', TEXT_LIMITS.notes);
  const student = requireStudent(req, req.params.id);
  assertStudentOperable(student, 'transfer this student');
  const targetClass = stmtGetClassDetails.get(toClassId) as any;
  if (!targetClass) throw new HttpError(404, 'Target class not found.');
  if (targetClass.branch_id !== student.branch_id) throw new HttpError(400, 'Target class belongs to another branch.');
  if (targetClass.status !== 'active') throw new HttpError(400, 'Target class is not active.');
  assertClassGenderAllowsStudent(toClassId, student.gender);
  const source = stmtGetTransferSourceEnrollment.get(req.params.id) as { id: string } | undefined;
  if (!source) throw new HttpError(409, 'This student has no active primary enrollment to transfer.');
  try {
    const result = getEnrollmentService(db).transfer({ sourceEnrollmentId: source.id, toClassId, notes: notes || null, actorUserId: user.userId });
    writeAudit(req, `Transferred student ${student.full_name} to class ${targetClass.name}`, { newValue: JSON.stringify({ toClassId, notes: notes || null }) });
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    // The service now raises typed HttpErrors (audit E-4): a full class is a
    // 409, a missing student a 404, a bad request a 400. Re-wrapping everything
    // as 400 flattened that contract and — worse — would have relabelled a
    // genuine server fault as a client error. Pass domain errors through
    // untouched and let the error handler classify anything else.
    if (err instanceof HttpError) throw err;
    throw err;
  }
}));

studentsRouter.post('/:id/suspend', requirePermission('Student.Suspend'), ah(async (req, res) => {
  const user = getUserContext(req);
  const student = requireStudent(req, req.params.id);
  const notes = optionalText(req.body?.notes, 'Suspension notes', TEXT_LIMITS.notes);
  const result = getEnrollmentService(db).suspend({
    studentId: req.params.id,
    notes,
    actorUserId: user.userId,
    actorName: user.fullName,
  });
  writeAudit(req, `Suspended student ${student.full_name}`, { newValue: notes || undefined });
  res.json({ ok: true, ...result });
}));

studentsRouter.post('/:id/resume', requirePermission('Student.Resume'), ah(async (req, res) => {
  const user = getUserContext(req);
  const student = requireStudent(req, req.params.id);
  const classId = optionalText(req.body?.classId, 'Resume class', TEXT_LIMITS.short);
  const notes = optionalText(req.body?.notes, 'Resume notes', TEXT_LIMITS.notes);
  const result = getEnrollmentService(db).resume({
    studentId: req.params.id,
    classId,
    notes,
    actorUserId: user.userId,
    actorName: user.fullName,
  });
  writeAudit(req, `Resumed student ${student.full_name}`, { newValue: classId || undefined });
  res.json({ ok: true, ...result });
}));

export default studentsRouter;
