import { nextInvoiceNumber } from '../utils/invoice.js';
/**
 * TOEFL House ERP — Student Routes (BC #4)
 * Handles student lifecycle, concurrent enrollments, smart payments, installments, and refunds.
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { assertTextLengths, TEXT_LIMITS } from '../utils/textInput.js';
import { parsePagination as parsePaginationShared } from '../utils/pagination.js';
import { getStudentBalance, getStudentBalancesPage } from '../utils/studentBalance.js';
import { authenticate, authorize, requirePermission, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { hasAnyRole } from '../core/rbac/rbac-service.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { recordIncome } from '../utils/income.js';
import { getNumberSetting, incrementNumberSetting } from '../utils/settings.js';
import { evaluateRules } from '../core/configuration/rule-engine.js';
import { resolveFee } from '../core/configuration/policy-resolver.js';
import { nextReceiptNumber, nextStudentCode } from '../utils/receipt.js';
import { getJourneyEngine } from '../core/journey/journey-engine.js';
import { getEnrollmentService } from '../core/academic/enrollment-service.js';
import { countActiveStudentsInClass } from '../core/academic/class-capacity.js';
import { assertClassGenderAllowsStudent } from './classes.routes.js';
import { JourneyEventType } from '../core/journey/event-types.js';
import { SYSTEM_DEFAULTS } from '../core/configuration/policy-catalog.js';
import { resolveIdempotency, isUniqueViolation } from '../utils/idempotency.js';

export const studentsRouter = Router();
studentsRouter.use(authenticate);

export const paymentsRouter = Router();
paymentsRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetStudentById = db.prepare('SELECT * FROM students WHERE id = ?');
const stmtGetStudentsAll = db.prepare('SELECT * FROM students ORDER BY registration_date DESC LIMIT ? OFFSET ?');
const stmtGetStudentsByBranch = db.prepare('SELECT * FROM students WHERE branch_id = ? ORDER BY registration_date DESC LIMIT ? OFFSET ?');
const stmtGetSemestersBatch = db.prepare(`SELECT * FROM student_semesters WHERE student_id IN (SELECT value FROM json_each(?)) ORDER BY enroll_date`);
const stmtGetSemestersByStudent = db.prepare('SELECT * FROM student_semesters WHERE student_id = ? ORDER BY enroll_date DESC');
const stmtGetPrimaryEnrollmentsBatch = db.prepare(`SELECT e.* FROM enrollments e WHERE e.status IN ('active','confirmed','pending') AND e.enrollment_type != 'extra' AND e.student_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM enrollments e2 WHERE e2.student_id = e.student_id AND e2.status IN ('active','confirmed','pending') AND e2.enrollment_type != 'extra' AND e2.started_at > e.started_at)`);
interface PaymentRow { id: string; student_id: string; amount: number; date: string; category: string; receipt_number: string | null; semester: string | null; status: string; payment_method: string | null; notes: string | null; branch_id: string; invoice_id: string | null; book_id: string | null; }

const stmtGetPaymentsAll = db.prepare<[number, number], PaymentRow>('SELECT * FROM payments ORDER BY date DESC LIMIT ? OFFSET ?');
const stmtGetPaymentsByBranch = db.prepare<[string, number, number], PaymentRow>('SELECT * FROM payments WHERE branch_id = ? ORDER BY date DESC LIMIT ? OFFSET ?');
const stmtGetPaymentsByStudent = db.prepare('SELECT * FROM payments WHERE student_id = ? ORDER BY date DESC');

const stmtGetClassDetails = db.prepare('SELECT * FROM classes WHERE id = ?');
const stmtGetClassFee = db.prepare('SELECT fee FROM classes WHERE id = ?');
const stmtGetBookPrice = db.prepare('SELECT id, title, price, stock FROM books WHERE id = ? AND branch_id = ?');
const stmtUpdateBookStock = db.prepare('UPDATE books SET stock = stock - 1 WHERE id = ? AND branch_id = ? AND stock > 0');
const stmtFindStudentByPhone = db.prepare("SELECT id, full_name FROM students WHERE phone = ? LIMIT 1");
const stmtFindStudentByEmail = db.prepare("SELECT id, full_name FROM students WHERE lower(email) = lower(?) LIMIT 1");
const stmtFindStudentByTazkira = db.prepare("SELECT id, full_name FROM students WHERE tazkira_no = ? LIMIT 1");
const stmtInsertRegistration = db.prepare(
  `INSERT INTO registrations (id, student_id, class_id, date, amount_paid, receipt_number, discount_applied, branch_id, source, semester) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtGetActiveSemesterBalances = db.prepare(`SELECT s.id, s.semester_name, s.net_fee_amount, s.fee_amount FROM student_semesters s WHERE s.student_id = ? AND s.status = 'active'`);
const stmtGetStudentPaymentsBySemester = db.prepare("SELECT COALESCE(SUM(CASE WHEN category IN ('fee','installment') THEN amount WHEN category = 'refund' THEN amount ELSE 0 END), 0) AS paid FROM payments WHERE student_id = ? AND semester = ? AND status = 'completed'");

const stmtCheckActiveEnrollment = db.prepare("SELECT id FROM enrollments WHERE student_id = ? AND class_id = ? AND status = 'active'");
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
const stmtGetPaymentByIdempotency = db.prepare('SELECT id, receipt_number, amount FROM payments WHERE idempotency_key = ?');
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
const stmtUpdateStudentCard = db.prepare('UPDATE students SET card_design = ?, notes = ? WHERE id = ?');
const stmtUpdateStudentDetails = db.prepare(
  `UPDATE students SET full_name=?, phone=?, email=?, discount_percent=?, gender=?, father_name=?, address_region=?, tazkira_no=?, whatsapp=?, dob=?, school_or_university=?, emergency_contact_name=?, emergency_contact_phone=?, notes=?, placement_score=?, installment_plan=?, card_design=? WHERE id=?`
);
const stmtUpdateStudentStatus = db.prepare('UPDATE students SET status = ? WHERE id = ?');
const stmtUpdateStudentInstallments = db.prepare('UPDATE students SET installment_plan = ? WHERE id = ?');

// The frontend loads the student list once per workspace and filters/searchs
// client-side over the loaded set, so the default cap must cover the whole
// manageable roster (batch queries keep it fast). Explicit pagination still
// works for API consumers.
const DEFAULT_PAGE_SIZE = 2000;
const MAX_PAGE_SIZE = 2000;

/** The only student lifecycle states the schema permits. */
const STUDENT_STATUSES = ['active', 'inactive', 'graduated', 'suspended'] as const;

/** Rejects an unknown status filter instead of quietly returning everything. */
function assertStudentStatus(value: string): void {
  if (!(STUDENT_STATUSES as readonly string[]).includes(value)) {
    throw new HttpError(400, `Invalid status filter. Expected one of: ${STUDENT_STATUSES.join(', ')}.`);
  }
}

function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId || !user?.branchId || !user?.fullName || !user?.role) throw new HttpError(403, 'User context missing.');
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

function requireStudent(req: import('express').Request, studentId: string): StudentContextRow {
  const student = stmtGetStudentById.get(studentId) as StudentContextRow | undefined;
  if (!student) throw new HttpError(404, 'Student not found.');
  const { branchId, isAll } = resolveBranchScope(req);
  if (!isAll && branchId && student.branch_id && student.branch_id !== branchId) {
    const cross = !!student.branch_id && canAccessBranchResource(req, student.branch_id);
    if (!cross) throw new HttpError(403, 'Student belongs to another branch.');
  }
  return student;
}

interface StudentRow { id: string; student_code: string; full_name: string; phone: string | null; email: string | null; qr_code: string | null; status: string; registration_date: string; branch_id: string; discount_percent: number; gender: string; lead_id: string | null; father_name: string | null; address_region: string | null; tazkira_no: string | null; whatsapp: string | null; dob: string | null; school_or_university: string | null; emergency_contact_name: string | null; emergency_contact_phone: string | null; notes: string | null; placement_score: string | null; installment_plan: string | null; card_design: string | null; }

function mapStudentBase(row: StudentRow) {
  return {
    id: row.id, studentCode: row.student_code, fullName: row.full_name, phone: row.phone, email: row.email,
    qrCode: row.qr_code, status: row.status, registrationDate: row.registration_date, branchId: row.branch_id,
    discountPercent: row.discount_percent, gender: row.gender, leadId: row.lead_id || undefined,
    fatherName: row.father_name, addressRegion: row.address_region, tazkiraNo: row.tazkira_no,
    whatsapp: row.whatsapp, dob: row.dob, schoolOrUniversity: row.school_or_university,
    emergencyContactName: row.emergency_contact_name, emergencyContactPhone: row.emergency_contact_phone,
    notes: row.notes, placementScore: parseJson(row.placement_score, undefined),
    installmentPlan: parseJson(row.installment_plan, undefined),
    cardDesign: parseJson(row.card_design, undefined),
  };
}

function mapStudents(rows: StudentRow[]) {
  if (rows.length === 0) return [];
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
    const sems = (byStudent.get(row.id) || []).map((s) => ({ id: s.id, semesterName: s.semester_name, classId: s.class_id, enrollDate: s.enroll_date, feeAmount: s.fee_amount, netFeeAmount: s.net_fee_amount ?? null, status: s.status }));
    const enrollment = enrollmentByStudent.get(row.id);
    return {
      ...mapStudentBase(row),
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
  const role = req.user?.role;
  const canOverride = !!req.rbac && hasAnyRole(req.rbac, ['owner', 'general_manager', 'finance_manager']);
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
 * The roster used to derive every student's paid/owed figure by downloading
 * the payments list and reducing it client-side. That list is one page: with
 * 6,000 payments and a 2,000-row cap, two thirds never reached the browser and
 * those students were displayed as owing their FULL fee despite having paid.
 * It was also 379 KB of payload to compute a handful of numbers.
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
  // Delegates to the single authoritative definition. This endpoint used to
  // inline its own SQL, which summed only active semesters while the profile
  // summed all of them — the same student showed two different debts.
  res.json(getStudentBalancesPage(db, { branchId: isAll ? null : branchId, scope: 'all', limit, offset }));
}));

/**
 * Whole-database student search with pagination — works at any scale
 * (10k / 20k+ students). Returns { rows, total } so the UI can page and
 * show an exact match count. Filters: q (name/code/phone/tazkira/whatsapp/
 * email/father), status, classId.
 */
studentsRouter.get('/search', requirePermission('Student.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  const { limit, offset } = parsePagination(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const classId = typeof req.query.classId === 'string' ? req.query.classId.trim() : '';
  const where: string[] = [];
  const params: unknown[] = [];
  if (!isAll) { where.push('branch_id = ?'); params.push(branchId); }
  if (q) {
    where.push(`(full_name LIKE ? ESCAPE '\\' OR student_code LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
                OR COALESCE(tazkira_no,'') LIKE ? ESCAPE '\\' OR COALESCE(whatsapp,'') LIKE ? ESCAPE '\\'
                OR COALESCE(email,'') LIKE ? ESCAPE '\\' OR COALESCE(father_name,'') LIKE ? ESCAPE '\\')`);
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    for (let i = 0; i < 7; i++) params.push(like);
  }
  if (status) {
    // Reject rather than silently ignore. An unrecognised value used to be
    // dropped, so `?status=' OR '1'='1` (and any typo) returned the UNFILTERED
    // page: callers could not tell "no matches" from "filter discarded".
    assertStudentStatus(status);
    where.push('status = ?');
    params.push(status);
  }
  if (classId) { where.push(`EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = students.id AND e.class_id = ?)`); params.push(classId); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM students ${whereSql}`).get(...params) as { c: number }).c;
  const rows = db.prepare(`SELECT * FROM students ${whereSql} ORDER BY registration_date DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as StudentRow[];
  res.json({ rows: mapStudents(rows), total });
}));

studentsRouter.get('/', requirePermission('Student.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  const { limit, offset } = parsePagination(req);
  // Server-side search + filters so the list stays correct beyond page 1:
  // q matches name / code / phone / tazkira / whatsapp / email / father.
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const classId = typeof req.query.classId === 'string' ? req.query.classId.trim() : '';
  const where: string[] = [];
  const params: unknown[] = [];
  if (!isAll) { where.push('branch_id = ?'); params.push(branchId); }
  if (q) {
    where.push(`(full_name LIKE ? ESCAPE '\\' OR student_code LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
                OR COALESCE(tazkira_no,'') LIKE ? ESCAPE '\\' OR COALESCE(whatsapp,'') LIKE ? ESCAPE '\\'
                OR COALESCE(email,'') LIKE ? ESCAPE '\\' OR COALESCE(father_name,'') LIKE ? ESCAPE '\\')`);
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    for (let i = 0; i < 7; i++) params.push(like);
  }
  if (status) {
    // Reject rather than silently ignore. An unrecognised value used to be
    // dropped, so `?status=' OR '1'='1` (and any typo) returned the UNFILTERED
    // page: callers could not tell "no matches" from "filter discarded".
    assertStudentStatus(status);
    where.push('status = ?');
    params.push(status);
  }
  if (classId) {
    where.push(`EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = students.id AND e.class_id = ?)`);
    params.push(classId);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

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
  res.json(mapStudents(rows));
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
  const student = requireStudent(req, req.params.id) as StudentRow;
  // The balance ships WITH the student so no client ever has to re-derive it.
  // The profile drawer and the student portal each used to recompute tuition
  // from the paginated payments array, which disagreed with this endpoint the
  // moment a semester was completed (server counted active semesters only,
  // client counted all) — the same student showed a 20,000 AFN different debt
  // on the roster and on the profile.
  res.json({
    ...mapStudents([student])[0],
    balance: {
      lifetime: getStudentBalance(db, student.id, 'all'),
      current: getStudentBalance(db, student.id, 'active'),
    },
  });
}));

// ============================================================================
// §2 — CREATE (Manual Registration)
// ============================================================================
studentsRouter.post('/manual', requirePermission('Student.Create'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { fullName, phone, email, gender, discountPercent, notes, classId, fatherName, addressRegion, tazkiraNo, whatsapp, dob, schoolOrUniversity, emergencyContactName, emergencyContactPhone, tuitionAmount, amountPaidNow, branchId } = req.body;
  if (!fullName || !String(fullName).trim() || !gender) throw new HttpError(400, 'Full name and gender are required.');
  if (!['male', 'female'].includes(gender)) throw new HttpError(400, 'Invalid gender.');
  // Bound every free-text field. Without this a 1,000,000-character name was
  // accepted and stored, and any list endpoint returning that row became
  // megabytes of JSON. The only previous refusal was Express's body limit,
  // which answered 500 rather than 400.
  assertTextLengths([
    [fullName, 'Full name', TEXT_LIMITS.name],
    [fatherName, "Father's name", TEXT_LIMITS.name],
    [phone, 'Phone', TEXT_LIMITS.short],
    [whatsapp, 'WhatsApp', TEXT_LIMITS.short],
    [tazkiraNo, 'Tazkira number', TEXT_LIMITS.short],
    [email, 'Email', TEXT_LIMITS.email],
    [addressRegion, 'Address', TEXT_LIMITS.line],
    [schoolOrUniversity, 'School or university', TEXT_LIMITS.line],
    [emergencyContactName, 'Emergency contact name', TEXT_LIMITS.name],
    [emergencyContactPhone, 'Emergency contact phone', TEXT_LIMITS.short],
    [notes, 'Notes', TEXT_LIMITS.notes],
  ]);
  const safePhone = phone ? String(phone).trim() : '';
  const safeEmail = email ? String(email).trim() : '';
  const safeTazkira = tazkiraNo ? String(tazkiraNo).trim() : '';
  if (!safePhone) throw new HttpError(400, 'Phone is required.');
  if (stmtFindStudentByPhone.get(safePhone)) throw new HttpError(409, 'A student with this phone number already exists.');
  if (safeEmail && stmtFindStudentByEmail.get(safeEmail)) throw new HttpError(409, 'A student with this email already exists.');
  if (safeTazkira && stmtFindStudentByTazkira.get(safeTazkira)) throw new HttpError(409, 'A student with this Tazkira/ID number already exists.');

  let effDiscount = Number(discountPercent ?? 0);
  if (!Number.isFinite(effDiscount) || effDiscount < 0) throw new HttpError(400, 'Discount must be zero or greater.');
  if (effDiscount > 0) {
    const cap = evaluateRules({ category: 'discount', branchId: branchId || user.branchId, data: { discountPercent: effDiscount } });
    if (typeof cap.finalOutputs.discountPercent === 'number') effDiscount = cap.finalOutputs.discountPercent;
  }

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
  resolvedTuition = Number(resolvedTuition ?? 0);
  if (!Number.isFinite(resolvedTuition) || resolvedTuition < 0) throw new HttpError(400, 'Tuition amount must be zero or greater.');

  const paidNow = Number(amountPaidNow ?? 0);
  if (!Number.isFinite(paidNow) || paidNow < 0) throw new HttpError(400, 'Amount paid must be zero or greater.');
  const netTuitionDue = Math.max(0, resolvedTuition - Math.round((resolvedTuition * effDiscount) / 100));
  if (paidNow > netTuitionDue && netTuitionDue > 0) throw new HttpError(400, 'Amount received cannot exceed payable fee.');

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
      recordIncome({ category: 'fee', amount: paidNow, date: regDate, description: `Registration fee for ${fullName}`, referenceId: newId, paymentId: pid, operatorName: user.fullName, operatorRole: user.role ?? null, branchId: studentBranchId });
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
  } catch (err) { console.warn('[journey] failed', err); }

  writeAudit(req, `Registered student ${fullName} (${studentCode})`, { newValue: JSON.stringify({ studentId: newId, branchId: studentBranchId, gender, discountPercent: effDiscount, receipt: receiptNumber }) });
  res.status(201).json({ id: newId, studentCode, receiptNumber });
}));

// ============================================================================
// §3 — CONCURRENT CLASS ENROLLMENT (Extra Classes)
// ============================================================================

studentsRouter.post('/:id/enroll-class', requirePermission('Class.Assign', 'Student.Edit'), ah(async (req, res) => {
  const user = getUserContext(req);
  const student = requireStudent(req, req.params.id);
  const { classId, amountPaidNow = 0, notes } = req.body || {};

  if (!classId) throw new HttpError(400, 'classId is required.');
  const cls = stmtGetClassDetails.get(classId) as any;
  if (!cls) throw new HttpError(404, 'Class not found.');
  if (cls.branch_id !== student.branch_id) throw new HttpError(400, 'Class belongs to another branch.');
  const classEnrollmentCount = countActiveStudentsInClass(db, classId);
  const classCapacity = Number(cls.capacity ?? 0);
  if (classCapacity > 0 && classEnrollmentCount >= classCapacity) throw new HttpError(409, 'Class is full.');
  
  // classes.status is a coarse legacy projection of lifecycle_stage (see
  // core/academic/lifecycle-engine.ts) — 'scheduled' is a lifecycle_stage
  // value, not a status value, so it can never appear here; the projection
  // already maps it (and five other operating stages) onto 'active'. Use
  // GET /:id/lifecycle if a caller needs the finer-grained stage.
  if (cls.status !== 'active') {
    throw new HttpError(400, `Cannot enroll in a class that is ${cls.status}.`);
  }
  
  if (stmtCheckActiveEnrollment.get(student.id, classId)) throw new HttpError(409, 'Already enrolled in this class.');
  
  assertClassGenderAllowsStudent(classId, student.gender);

  // Check Academic Hold
  checkAcademicHold(req, student.id);

  const enrollId = id('enr');
  const date = today();
  const baseFee = cls.fee || 0;
  const discount = student.discount_percent || 0;
  const netFee = Math.max(0, baseFee - Math.round(baseFee * discount / 100));
  const paidNow = Number(amountPaidNow || 0);
  if (!Number.isFinite(paidNow) || paidNow < 0) throw new HttpError(400, 'Amount paid must be zero or greater.');
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
      stmtInsertPayment.run(pid, student.id, paidNow, date, 'cash', 'fee', `Extra class fee: ${cls.name}`, nextReceiptNumber(), student.branch_id, null, null, null, null);
      recordIncome({ category: 'fee', amount: paidNow, date, description: `Extra class fee from ${student.full_name}`, referenceId: student.id, paymentId: pid, operatorName: user.fullName, operatorRole: user.role ?? null, branchId: student.branch_id });
    }

    if (netFee - paidNow > 0) {
      const invId = id('inv');
      stmtInsertInvoice.run(invId, student.id, baseFee, (baseFee - netFee), netFee, paidNow >= netFee ? 'paid' : 'issued', date, date, student.branch_id, `Fee for extra class: ${cls.name}`, nextInvoiceNumber(student.branch_id), user.fullName);
    }
  });
  tx();

  try {
    getJourneyEngine(db).appendEvent({ studentId: student.id, eventType: JourneyEventType.ENROLLMENT_CREATED, occurredAt: date, branchId: student.branch_id, actorUserId: user.userId, actorName: user.fullName, payload: { classId, className: cls.name, type: 'extra_class', fee: netFee } });
  } catch (err) { console.warn('[journey] failed', err); }

  writeAudit(req, `Enrolled ${student.full_name} in extra class ${cls.name}`, { newValue: JSON.stringify({ classId, netFee, paidNow }) });
  res.status(201).json({ ok: true, message: 'Successfully enrolled in extra class.' });
}));

// ============================================================================
// §4 — SMART PAYMENTS & REFUNDS
// ============================================================================

studentsRouter.post('/:id/payments', requirePermission('Payment.Create'), ah(async (req, res) => {
  const user = getUserContext(req);
  const student = requireStudent(req, req.params.id);
  const { category, paymentMethod, notes, semesterId, bookId, installmentId, amount } = req.body;

  if (!category || !['fee', 'book', 'chapter', 'exam', 'card', 'placement', 'diploma', 'installment', 'other'].includes(category)) throw new HttpError(400, 'Invalid category.');
  const resolvedMethod = ['cash', 'card', 'bank_transfer'].includes(paymentMethod) ? paymentMethod : 'cash';
  const date = today();
  // Idempotency is ALWAYS applied, never only when the client remembers to
  // send a key: an un-keyed double-click previously created one payment per
  // click. When no key is supplied a fingerprint of the business intent is
  // derived, so retries collapse while a genuinely new later charge (a
  // different time bucket, or an explicit client key) still goes through.
  const { key: idempotencyKey, candidates: idempotencyCandidates, clientSupplied: clientSuppliedKey } = resolveIdempotency(req, {
    route: 'student-payment',
    studentId: student.id,
    category,
    amount: amount === undefined || amount === null || amount === '' ? null : Number(amount),
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
      const existing = stmtGetPaymentByIdempotency.get(candidate) as any;
      if (existing) return res.status(200).json({ receiptNumber: existing.receipt_number, amountCharged: existing.amount, idempotentReplay: true });
    }
  }
  const rc = nextReceiptNumber();
  const payId = id('pay');
  let resolvedAmount = 0;
  let semName: string | null = null;
  let bookRefId: string | null = null;
  const requestedAmount = amount === undefined || amount === null || amount === '' ? null : Number(amount);
  if (requestedAmount !== null && (!Number.isFinite(requestedAmount) || requestedAmount <= 0)) throw new HttpError(400, 'Amount must be greater than 0.');

  if (category === 'fee') {
    if (!semesterId) throw new HttpError(400, 'semesterId is required when paying a class fee.');
    const sem = (stmtGetSemestersByStudent.all(student.id) as any[]).find(s => s.id === semesterId);
    if (!sem) throw new HttpError(404, 'Semester not found.');
    // Refunds must count against the semester, otherwise a partially refunded
    // student is treated as fully paid and the academy is unable to collect a
    // debt they genuinely owe. Refunds are stored signed-negative and are not
    // tagged with a semester, so they are attributed to the student's tuition.
    const totalPaidForSem = (stmtGetPaymentsByStudent.all(student.id) as any[])
      .filter(p => p.status === 'completed' && ((p.semester === sem.semester_name && (p.category === 'fee' || p.category === 'installment')) || p.category === 'refund'))
      .reduce((acc, p) => acc + Number(p.amount || 0), 0);
    const semDebt = Math.max(0, Number(sem.net_fee_amount ?? sem.fee_amount) - totalPaidForSem);
    if (semDebt <= 0) throw new HttpError(400, 'This semester is already fully paid.');
    resolvedAmount = semDebt;
    if (requestedAmount !== null) resolvedAmount = Math.min(requestedAmount, semDebt);
    semName = sem.semester_name;
  } 
  else if (category === 'installment') {
    if (!installmentId) throw new HttpError(400, 'installmentId is required.');
    const plan = parseJson(student.installment_plan, [] as Array<{ id: string; amount: number; status: string; dueDate?: string }>);
    const inst = plan.find((i) => i.id === installmentId);
    if (!inst || inst.status === 'paid') throw new HttpError(409, 'Installment not found or already paid.');
    resolvedAmount = Number(inst.amount);
    if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) throw new HttpError(400, 'Installment amount is invalid.');
    if (requestedAmount !== null && requestedAmount !== resolvedAmount) throw new HttpError(400, 'Installment payment must match the installment amount.');
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
    if (requestedAmount === null) throw new HttpError(400, 'Amount is required for this payment category.');
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
      const currentPaid = (stmtGetPaymentsByStudent.all(student.id) as PaymentRow[])
        .filter((p) => p.status === 'completed' && ((p.semester === currentSem.semester_name && (p.category === 'fee' || p.category === 'installment')) || p.category === 'refund'))
        .reduce((sum, p) => sum + Number(p.amount || 0), 0);
      const currentDebt = Math.max(0, Number(currentSem.net_fee_amount ?? currentSem.fee_amount) - currentPaid);
      if (currentDebt <= 0) throw new HttpError(409, 'This semester is already fully paid.');
      resolvedAmount = requestedAmount === null ? currentDebt : Math.min(requestedAmount, currentDebt);
      semName = currentSem.semester_name;
      if (resolvedAmount <= 0) throw new HttpError(400, 'Amount must be greater than 0.');
    }
    if (category === 'installment') {
      const currentStudent = stmtGetStudentById.get(student.id) as any;
      const currentPlan = parseJson(currentStudent?.installment_plan, [] as Array<{ id: string; amount: number; status: string; dueDate?: string }>);
      const currentInst = currentPlan.find((item) => item.id === installmentId);
      if (!currentInst || currentInst.status === 'paid') throw new HttpError(409, 'Installment is no longer payable.');
      currentInst.status = 'paid';
      stmtUpdateStudentInstallments.run(JSON.stringify(currentPlan), student.id);
    }
    // The idempotency key is ALWAYS persisted, for every category. It is the
    // only mechanism that serialises concurrent duplicates: the pre-checks
    // above are read-then-write and every concurrent request passes them
    // simultaneously. Writing NULL here (previously done for guarded
    // categories) disabled the unique index, because SQLite considers each
    // NULL distinct.
    stmtInsertPayment.run(payId, student.id, resolvedAmount, date, resolvedMethod, category, notes || 'Smart Payment', rc, student.branch_id, semName, null, bookRefId, idempotencyKey);
    if (category === 'book') {
      const updated = stmtUpdateBookStock.run(bookRefId, student.branch_id);
      if (updated.changes !== 1) throw new HttpError(409, 'Book stock changed. Please retry.');
    }
    recordIncome({ category, amount: resolvedAmount, date, description: `Received ${category} payment from ${student.full_name}`, referenceId: student.id, paymentId: payId, operatorName: user.fullName, operatorRole: user.role ?? null, branchId: student.branch_id });
  });
  try {
    tx();
  } catch (err) {
    // Atomic backstop. The pre-check above is a fast path; under true
    // concurrency several requests can pass it simultaneously. Only one can
    // win the unique index on payments.idempotency_key — the losers replay
    // the winner's result instead of surfacing a 500 or double-charging.
    if (isUniqueViolation(err)) {
      const winner = stmtGetPaymentByIdempotency.get(idempotencyKey) as any;
      if (winner) return res.status(200).json({ receiptNumber: winner.receipt_number, amountCharged: winner.amount, idempotentReplay: true });
    }
    throw err;
  }

  try {
    getJourneyEngine(db).appendEvent({ studentId: student.id, eventType: JourneyEventType.PAYMENT_RECORDED, occurredAt: date, branchId: student.branch_id, actorUserId: user.userId, actorName: user.fullName, payload: { amount: resolvedAmount, category, receiptNumber: rc } });
  } catch (err) { console.warn('[journey] failed', err); }

  writeAudit(req, `Recorded ${category} payment ${resolvedAmount} AFN from ${student.full_name}`, { newValue: JSON.stringify({ receipt: rc, amount: resolvedAmount, category, paymentId: payId, semester: semName, bookId: bookRefId }) });
  res.status(201).json({ receiptNumber: rc, amountCharged: resolvedAmount });
}));

studentsRouter.post('/:id/refund', requirePermission('Refund.Approve'), ah(async (req, res) => {
  const user = getUserContext(req);
  const student = requireStudent(req, req.params.id);
  const { amount, reason } = req.body;
  const refundAmount = Number(amount);
  if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new HttpError(400, 'Refund amount must be positive.');
  if (!reason || !String(reason).trim()) throw new HttpError(400, 'Refund reason is required.');
  const date = today();
  // Refunds move real money out; the same mandatory idempotency applies.
  const { key: idempotencyKey, candidates: idempotencyCandidates } = resolveIdempotency(req, {
    route: 'student-refund',
    studentId: student.id,
    amount: refundAmount,
    reason: String(reason).trim(),
    // Two different operators each issuing a refund of the same amount are
    // two distinct business events, not a retry of one.
    actorUserId: user.userId,
  });
  for (const candidate of idempotencyCandidates) {
    const existing = stmtGetPaymentByIdempotency.get(candidate) as any;
    if (existing) return res.status(200).json({ receiptNumber: existing.receipt_number, idempotentReplay: true });
  }
  const rc = `REF-${nextReceiptNumber()}`;
  const payId = id('pay');

  const tx = db.transaction(() => {
    const paid = (stmtGetPaymentsByStudent.all(student.id) as PaymentRow[])
      .filter((p) => p.status === 'completed' && p.category !== 'refund')
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const refunded = (stmtGetPaymentsByStudent.all(student.id) as PaymentRow[])
      .filter((p) => p.status === 'completed' && p.category === 'refund')
      .reduce((sum, p) => sum + Math.abs(Number(p.amount || 0)), 0);
    const refundable = Math.max(0, paid - refunded);
    if (refundAmount > refundable) throw new HttpError(400, `Refund exceeds the refundable balance of ${refundable} AFN.`);
    stmtInsertSimplePayment.run(payId, student.id, -refundAmount, date, 'cash', 'refund', String(reason).trim(), rc, student.branch_id, idempotencyKey || null);
    recordIncome({ category: 'refund', amount: -refundAmount, date, description: `Refund issued to ${student.full_name}`, referenceId: student.id, paymentId: payId, operatorName: user.fullName, operatorRole: user.role ?? null, branchId: student.branch_id });
  });
  try {
    tx();
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winner = stmtGetPaymentByIdempotency.get(idempotencyKey) as any;
      if (winner) return res.status(200).json({ receiptNumber: winner.receipt_number, idempotentReplay: true });
    }
    throw err;
  }

  try {
    getJourneyEngine(db).appendEvent({ studentId: student.id, eventType: JourneyEventType.PAYMENT_RECORDED, occurredAt: date, branchId: student.branch_id, actorUserId: user.userId, actorName: user.fullName, payload: { amount: -refundAmount, category: 'refund', receiptNumber: rc } });
  } catch (err) { console.warn('[journey] failed', err); }

  writeAudit(req, `Refunded ${refundAmount} AFN to ${student.full_name}`, { oldValue: JSON.stringify({ reason: String(reason) }), newValue: JSON.stringify({ receipt: rc, amount: refundAmount, paymentId: payId }) });
  res.status(201).json({ receiptNumber: rc });
}));

// ============================================================================
// §5 — SEMESTER ENROLLMENT & LIFECYCLE
// ============================================================================

studentsRouter.post('/:id/enroll-semester', requirePermission('Class.Assign', 'Student.Edit'), ah(async (req, res) => {
  const user = getUserContext(req);
  const student = requireStudent(req, req.params.id);
  const { semesterName, classId, tuitionAmount, amountPaidNow, notes } = req.body ?? {};
  
  if (!semesterName || !String(semesterName).trim()) throw new HttpError(400, 'Semester name is required.');
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
  resolvedTuition = Number(resolvedTuition ?? 0);
  if (!Number.isFinite(resolvedTuition) || resolvedTuition < 0) throw new HttpError(400, 'Tuition amount must be zero or greater.');
  const discountAmount = Math.round(resolvedTuition * Math.max(0, Number(student.discount_percent || 0)) / 100);
  const netTuition = Math.max(0, resolvedTuition - discountAmount);
  const paidNow = Number(amountPaidNow ?? 0);
  if (!Number.isFinite(paidNow) || paidNow < 0) throw new HttpError(400, 'Amount received must be zero or greater.');
  if (paidNow > netTuition && netTuition > 0) throw new HttpError(400, 'Amount received cannot exceed the payable fee.');

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
      stmtInsertPayment.run(semPayId, student.id, paidNow, date, 'cash', 'fee', `Semester fee for ${semesterName}`, rc, student.branch_id, semesterName, null, null, `enroll-semester:${student.id}:${semesterName}`);
      recordIncome({ category: 'fee', amount: paidNow, date, description: `Received ${semesterName} fee from ${student.full_name}`, referenceId: student.id, paymentId: semPayId, operatorName: user.fullName, operatorRole: user.role ?? null, branchId: student.branch_id });
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

studentsRouter.post('/:id/issue-card', requirePermission('Student.Print', 'Payment.Create'), ah(async (req, res) => {
  const user = getUserContext(req);
  const student = requireStudent(req, req.params.id);
  const { cardDesign, notes } = req.body;
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
    stmtUpdateStudentCard.run(JSON.stringify(cardDesign), notes ?? student.notes, student.id);
    if (isFirstIssuance && cardFee > 0) {
      const pid = id('pay');
      stmtInsertSimplePayment.run(pid, student.id, cardFee, date, 'cash', 'card', 'ID Card Issuance', nextReceiptNumber(), student.branch_id, cardFeeIdempotencyKey);
      recordIncome({ category: 'card', amount: cardFee, date, description: `ID card fee for ${student.full_name}`, referenceId: student.id, paymentId: pid, operatorName: user.fullName, operatorRole: user.role ?? null, branchId: student.branch_id });
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
  const f = req.body;
  const merge = <K extends keyof StudentRow>(k: string, c: K) => (f[k] !== undefined ? f[k] : existing[c]);

  const nextPhone = String(merge('phone', 'phone') ?? '').trim();
  const nextEmail = String(merge('email', 'email') ?? '').trim();
  const nextTazkira = String(merge('tazkiraNo', 'tazkira_no') ?? '').trim();
  const phoneOwner = nextPhone ? stmtFindStudentByPhone.get(nextPhone) as { id: string } | undefined : undefined;
  const emailOwner = nextEmail ? stmtFindStudentByEmail.get(nextEmail) as { id: string } | undefined : undefined;
  const tazkiraOwner = nextTazkira ? stmtFindStudentByTazkira.get(nextTazkira) as { id: string } | undefined : undefined;
  if (phoneOwner && phoneOwner.id !== existing.id) throw new HttpError(409, 'A student with this phone number already exists.');
  if (emailOwner && emailOwner.id !== existing.id) throw new HttpError(409, 'A student with this email already exists.');
  if (tazkiraOwner && tazkiraOwner.id !== existing.id) throw new HttpError(409, 'A student with this Tazkira/ID number already exists.');
    let effDiscount = merge('discountPercent', 'discount_percent');
  if (typeof effDiscount !== 'number' || !Number.isFinite(effDiscount) || effDiscount < 0) throw new HttpError(400, 'Discount must be zero or greater.');
  if (effDiscount > 0) {
    const cap = evaluateRules({ category: 'discount', branchId: existing.branch_id, data: { discountPercent: effDiscount } });
    if (typeof cap.finalOutputs.discountPercent === 'number') effDiscount = cap.finalOutputs.discountPercent;
  }

  stmtUpdateStudentDetails.run(
    merge('fullName', 'full_name'), merge('phone', 'phone'), merge('email', 'email'), effDiscount, merge('gender', 'gender'),
    merge('fatherName', 'father_name'), merge('addressRegion', 'address_region'), merge('tazkiraNo', 'tazkira_no'), merge('whatsapp', 'whatsapp'),
    merge('dob', 'dob'), merge('schoolOrUniversity', 'school_or_university'), merge('emergencyContactName', 'emergency_contact_name'),
    merge('emergencyContactPhone', 'emergency_contact_phone'), merge('notes', 'notes'),
    f.placementScore !== undefined ? JSON.stringify(f.placementScore) : existing.placement_score,
    f.installmentPlan !== undefined ? JSON.stringify(f.installmentPlan) : existing.installment_plan,
    f.cardDesign !== undefined ? JSON.stringify(f.cardDesign) : existing.card_design, req.params.id
  );

  // Identity / financial-relevant changes must be traceable: record the
  // before/after subset (name, contacts, gender, discount, placement result).
  const identitySnapshot = (r: any) => JSON.stringify({
    fullName: r.full_name, phone: r.phone, email: r.email, gender: r.gender,
    discountPercent: r.discount_percent, tazkiraNo: r.tazkira_no, dob: r.dob,
    placementScore: r.placement_score != null ? '(set)' : null, installmentPlan: r.installment_plan != null ? '(set)' : null,
  });
  writeAudit(req, `Updated student profile ${existing.full_name}`, { oldValue: identitySnapshot(existing), newValue: identitySnapshot({ ...existing, full_name: merge('fullName', 'full_name'), phone: merge('phone', 'phone'), email: merge('email', 'email'), gender: merge('gender', 'gender'), discount_percent: effDiscount, tazkira_no: merge('tazkiraNo', 'tazkira_no'), dob: merge('dob', 'dob'), placement_score: f.placementScore !== undefined ? JSON.stringify(f.placementScore) : existing.placement_score, installment_plan: f.installmentPlan !== undefined ? JSON.stringify(f.installmentPlan) : existing.installment_plan }) });
  res.json({ ok: true });
}));

studentsRouter.patch('/:id/status', requirePermission('Student.Edit', 'Student.Suspend'), ah(async (req, res) => {
  const existing = requireStudent(req, req.params.id);
  const { status } = req.body;
  if (!['active', 'inactive', 'graduated'].includes(status)) throw new HttpError(400, 'Use the suspend/resume workflow for suspended status.');
  stmtUpdateStudentStatus.run(status, req.params.id);
  writeAudit(req, `Changed student ${existing.full_name} status to ${status}`);
  res.json({ ok: true });
}));

studentsRouter.post('/:id/transfer', authorize('registrar', 'manager', 'head_of_department', 'owner'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { toClassId, notes } = req.body || {};
  if (!toClassId) throw new HttpError(400, 'toClassId is required.');
  const student = requireStudent(req, req.params.id);
  const targetClass = stmtGetClassDetails.get(toClassId) as any;
  if (!targetClass) throw new HttpError(404, 'Target class not found.');
  if (targetClass.branch_id !== student.branch_id) throw new HttpError(400, 'Target class belongs to another branch.');
  if (targetClass.status !== 'active') throw new HttpError(400, 'Target class is not active.');
  assertClassGenderAllowsStudent(toClassId, student.gender);
  try {
    const result = getEnrollmentService(db).transfer({ studentId: req.params.id, toClassId, notes: notes || null, actorUserId: user.userId });
    writeAudit(req, `Transferred student ${student.full_name} to class ${targetClass.name}`, { newValue: JSON.stringify({ toClassId, notes: notes || null }) });
    res.json({ ok: true, ...result });
  } catch (err: any) { throw new HttpError(400, err?.message || 'Transfer failed.'); }
}));

studentsRouter.post('/:id/suspend', authorize('registrar', 'manager', 'head_of_department', 'owner'), ah(async (req, res) => {
  const user = getUserContext(req);
  const student = requireStudent(req, req.params.id);
  const { notes } = req.body || {};
  try {
    const result = getEnrollmentService(db).suspend({ studentId: req.params.id, notes: notes || null, actorUserId: user.userId });
    stmtUpdateStudentStatus.run('suspended', req.params.id);
    writeAudit(req, `Suspended student ${student.full_name}`, { newValue: notes || null });
    res.json({ ok: true, ...result });
  } catch (err: any) { throw new HttpError(400, err?.message || 'Suspend failed.'); }
}));

studentsRouter.post('/:id/resume', authorize('registrar', 'manager', 'head_of_department', 'owner'), ah(async (req, res) => {
  const user = getUserContext(req);
  const student = requireStudent(req, req.params.id);
  const { classId, notes } = req.body || {};
  try {
    const result = getEnrollmentService(db).resume({ studentId: req.params.id, classId: classId || null, notes: notes || null, actorUserId: user.userId });
    stmtUpdateStudentStatus.run('active', req.params.id);
    writeAudit(req, `Resumed student ${student.full_name}`, { newValue: classId || null });
    res.json({ ok: true, ...result });
  } catch (err: any) { throw new HttpError(400, err?.message || 'Resume failed.'); }
}));

export default studentsRouter;
