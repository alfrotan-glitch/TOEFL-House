/**
 * TOEFL House ERP — Visitors Routes (BC #2: CRM)
 * Handles lead pipeline, follow-ups, placement tests, and conversion to student.
 */
import { assertMoney } from '../utils/money.js';
import { Router } from 'express';
import { db } from '../db/connection.js';
import { TEXT_LIMITS, optionalText, requiredText } from '../utils/textInput.js';
import { parsePagination as parsePaginationShared } from '../utils/pagination.js';
import { authenticate, requirePermission, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { resolvePlacementRequirement } from '../core/placement/policy-engine.js';
import { resolveGoverningProgramVersionId } from '../core/placement/enrollment-gate.js';
import { buildVisitorSummary, queryVisitorPage, type VisitorFilters } from '../core/visitors/visitor-query.js';
import { evaluateConversionEligibilityForVisitor } from '../core/visitors/conversion-eligibility.js';
import { LEAD_CONVERTED_SQL } from '../core/visitors/lead-lifecycle.js';
import { addNotification } from '../utils/notifications.js';
import { recordIncome } from '../utils/income.js';
import { getNumberSetting, incrementNumberSetting } from '../utils/settings.js';
import { evaluateRules } from '../core/configuration/rule-engine.js';
import { resolveFee } from '../core/configuration/policy-resolver.js';
import { assertClassGenderAllowsStudent } from './classes.routes.js';
import { getEnrollmentService } from '../core/academic/enrollment-service.js';
import { countActiveStudentsInClass } from '../core/academic/class-capacity.js';
import { getJourneyEngine } from '../core/journey/journey-engine.js';
import { JourneyEventType } from '../core/journey/event-types.js';
import { nextReceiptNumber, nextStudentCode } from '../utils/receipt.js';
import { nextInvoiceNumber } from '../utils/invoice.js';
import { SYSTEM_DEFAULTS } from '../core/configuration/policy-catalog.js';

export const visitorsRouter = Router();
visitorsRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetVisitorById = db.prepare('SELECT * FROM visitors WHERE id = ?');
const stmtFindVisitorByTazkira = db.prepare("SELECT id FROM visitors WHERE tazkira_no = ? LIMIT 1");
const stmtFindVisitorByTazkiraExcluding = db.prepare("SELECT id FROM visitors WHERE tazkira_no = ? AND id <> ? LIMIT 1");
const stmtFindStudentByTazkiraNo = db.prepare("SELECT id FROM students WHERE tazkira_no = ? LIMIT 1");
const stmtGetProgramVersionForVisitor = db.prepare(`SELECT pv.id, pv.program_id, pv.status, p.name AS program_name, p.branch_id FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.id = ?`);
const stmtGetAllVisitors = db.prepare('SELECT * FROM visitors ORDER BY visit_date DESC LIMIT ? OFFSET ?');
const stmtGetVisitorsByBranch = db.prepare('SELECT * FROM visitors WHERE branch_id = ? ORDER BY visit_date DESC LIMIT ? OFFSET ?');
const stmtCountAllVisitors = db.prepare('SELECT COUNT(*) as c FROM visitors');
const stmtCountVisitorsByBranch = db.prepare('SELECT COUNT(*) as c FROM visitors WHERE branch_id = ?');

const stmtGetFollowupsBatch = db.prepare(
  `SELECT * FROM visitor_followups WHERE visitor_id IN (SELECT value FROM json_each(?)) ORDER BY date DESC`
);

const stmtInsertVisitor = db.prepare(
  `INSERT INTO visitors (id, serial_no, full_name, phone, email, gender, source, campaign_id, stage, assigned_to, visit_date, status, notes, branch_id, interested_course, follow_up_status, next_contact_date, father_name, address_region, tazkira_no, whatsapp, dob, school_or_university, emergency_contact_name, emergency_contact_phone, program_version_id, placement_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'visited', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_started')`
);
const stmtUpdateVisitor = db.prepare(
  `UPDATE visitors SET full_name=?, phone=?, email=?, gender=?, source=?, campaign_id=?, stage=?, assigned_to=?, notes=?, interested_course=?, follow_up_status=?, next_contact_date=?, father_name=?, address_region=?, tazkira_no=?, whatsapp=?, dob=?, school_or_university=?, emergency_contact_name=?, emergency_contact_phone=?, program_version_id=? WHERE id=?`
);
const stmtInsertFollowup = db.prepare('INSERT INTO visitor_followups (id, visitor_id, date, notes, operator, outcome) VALUES (?, ?, ?, ?, ?, ?)');
const stmtUpdateVisitorPlacement = db.prepare("UPDATE visitors SET placement_score = ?, placement_method = ?, placement_status = 'completed', stage = ? WHERE id = ?");
const stmtUpdateVisitorCRM = db.prepare(`UPDATE visitors SET interested_course=?, follow_up_status=?, next_contact_date=?, stage=?, notes=COALESCE(?, notes) WHERE id=?`);
const stmtUpdateVisitorStage = db.prepare('UPDATE visitors SET stage = ? WHERE id = ? AND stage = ?');
const stmtGetPlacementProfile = db.prepare(`SELECT pap.*, pv.program_id, p.name AS program_name FROM placement_assessment_profiles pap JOIN program_versions pv ON pv.id = pap.program_version_id JOIN programs p ON p.id = pv.program_id WHERE pap.program_version_id = ? AND (pap.branch_id = ? OR pap.branch_id IS NULL) AND pap.enabled = 1 ORDER BY pap.branch_id IS NOT NULL DESC LIMIT 1`);
const stmtGetLevelProgramVersion = db.prepare('SELECT program_version_id FROM levels WHERE id = ?');
const stmtGetProgramVersionById = db.prepare(`SELECT pv.*, p.branch_id, p.name AS program_name FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.id = ?`);

// Pipeline aggregation statements
const stmtGetPipelineAll = db.prepare('SELECT stage, COUNT(*) as count FROM visitors GROUP BY stage');
const stmtGetPipelineByBranch = db.prepare('SELECT stage, COUNT(*) as count FROM visitors WHERE branch_id = ? GROUP BY stage');

// Convert statements
const stmtGetClassForConvert = db.prepare('SELECT * FROM classes WHERE id = ?');
const stmtGetStudentByLeadId = db.prepare('SELECT id FROM students WHERE lead_id = ?');
const stmtUpdateVisitorConverted = db.prepare("UPDATE visitors SET status = 'registered', stage = 'enrollment' WHERE id = ?");
const stmtInsertConvertedStudent = db.prepare(
  `INSERT INTO students (id, student_code, full_name, phone, email, qr_code, status, registration_date, branch_id, discount_percent, gender, placement_score, notes, father_name, address_region, tazkira_no, whatsapp, dob, school_or_university, emergency_contact_name, emergency_contact_phone, lead_id) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtInsertConvertedSemester = db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, net_fee_amount) VALUES (?, ?, 'Current Semester', ?, ?, ?, ?)`);
const stmtInsertConvertedRegistration = db.prepare(`INSERT INTO registrations (id, student_id, class_id, date, amount_paid, receipt_number, discount_applied, branch_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const stmtInsertConvertedInvoice = db.prepare(`INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, notes, invoice_number, issued_by, student_name, student_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const stmtInsertInvoiceItem = db.prepare(`INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount) VALUES (?, ?, ?, 1, ?, ?)`);
const stmtInsertConvertedPayment = db.prepare(`INSERT INTO payments (id, student_id, invoice_id, amount, date, payment_method, status, category, notes, receipt_number, branch_id, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, 'completed', 'fee', ?, ?, ?, ?)`);

const VISITOR_FLOW = ['lead', 'inquiry', 'follow_up', 'placement_booking', 'placement_fee', 'placement_completed', 'class_fee', 'card_issued', 'book_issued', 'registration', 'enrollment', 'active', 'graduated', 'alumni', 'lost'] as const;

const VISITOR_SOURCES = new Set(['ads', 'friend', 'social', 'other', 'referral', 'event', 'organic', 'walk_in', 'facebook']);
const VISITOR_GENDERS = new Set(['male', 'female']);
const FOLLOW_UP_STATUSES = new Set(['high_interest', 'medium_interest', 'low_interest', 'not_answering', 'no_interest', 'hot', 'warm', 'cold']);
const FOLLOW_UP_OUTCOMES = new Set(['interested', 'not_interested', 'callback', 'registered']);
const VISITOR_TRANSITIONS: Record<string, string> = Object.fromEntries(VISITOR_FLOW.slice(0, -1).map((stage, index) => [stage, VISITOR_FLOW[index + 1]]));

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

// ============================================================================
// SHARED FIELD AUTHORITY (audit V-2, V-4)
// ============================================================================
/**
 * The bounded text fields of a visitor, with their ceilings. CREATE and PATCH
 * both drive off this one table, because the audit found them diverging:
 * CREATE rejected a 100,000-character name with 400 while PATCH stored it in
 * full, along with unbounded notes, tazkira, email and every other free-text
 * field. Validation written inline per handler is validation that drifts.
 */
const VISITOR_TEXT_FIELDS: ReadonlyArray<readonly [string, string, number]> = [
  ['fullName', 'Full name', TEXT_LIMITS.name],
  ['fatherName', "Father's name", TEXT_LIMITS.name],
  ['phone', 'Phone', TEXT_LIMITS.short],
  ['whatsapp', 'WhatsApp', TEXT_LIMITS.short],
  ['tazkiraNo', 'Tazkira number', TEXT_LIMITS.short],
  ['email', 'Email', TEXT_LIMITS.email],
  ['addressRegion', 'Address', TEXT_LIMITS.line],
  ['schoolOrUniversity', 'School or university', TEXT_LIMITS.line],
  ['emergencyContactName', 'Emergency contact name', TEXT_LIMITS.name],
  ['emergencyContactPhone', 'Emergency contact phone', TEXT_LIMITS.short],
  ['interestedCourse', 'Interested course', TEXT_LIMITS.line],
  ['notes', 'Notes', TEXT_LIMITS.notes],
] as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate an optional calendar date. A malformed value used to be stored
 * verbatim ("9999-99-99", "not-a-date"), which then silently loses every
 * subsequent date comparison it takes part in.
 */
function assertOptionalIsoDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value.trim())) {
    throw new HttpError(400, `${field} must be a valid date in YYYY-MM-DD format.`);
  }
  const iso = value.trim();
  const [y, m, d] = iso.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new HttpError(400, `${field} is not a real calendar date.`);
  }
  return iso;
}

/**
 * Type-check, trim and bound every supplied text field, returning only the keys
 * actually present in the payload. `optionalText` throws 400 on a non-string,
 * so `phone: ["injected"]` can no longer be coerced into the string "injected".
 */
function normalizeVisitorText(body: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, label, max] of VISITOR_TEXT_FIELDS) {
    if (!(key in body)) continue;
    if (key === 'fullName') {
      out[key] = requiredText(body[key], label, max);
    } else {
      out[key] = optionalText(body[key], label, max);
    }
  }
  return out;
}

/**
 * National ID uniqueness — the institutional policy, matching students.
 *
 * `uq_students_tazkira_no` has long been GLOBAL (not per-branch) and excludes
 * NULL/empty. A person is the same person in either table, so visitors adopt
 * the identical rule. The database enforces it (migration 072); this check
 * exists to return a clear 409 instead of a raw constraint error, exactly as
 * students.routes.ts already does.
 */
function assertTazkiraAvailable(tazkira: string | null, excludeVisitorId?: string): void {
  if (!tazkira) return;
  const clash = excludeVisitorId
    ? stmtFindVisitorByTazkiraExcluding.get(tazkira, excludeVisitorId)
    : stmtFindVisitorByTazkira.get(tazkira);
  if (clash) throw new HttpError(409, 'A visitor with this Tazkira/ID number already exists.');
  const asStudent = stmtFindStudentByTazkiraNo.get(tazkira);
  if (asStudent) throw new HttpError(409, 'A student with this Tazkira/ID number already exists.');
}

/**
 * Build a compact, non-sensitive audit diff (audit V-8).
 *
 * Records WHICH fields changed and their before/after values, so a change like
 * detaching a placement-governed program is reconstructable. Free-text and
 * contact fields are reported as a redacted marker with their length rather
 * than their content: the forensic question is "what changed", not "what is
 * this person's phone number", and the audit log has a wider readership than
 * the visitor record itself.
 */
const AUDIT_REDACTED_FIELDS = new Set([
  'phone', 'whatsapp', 'email', 'tazkiraNo', 'addressRegion',
  'emergencyContactName', 'emergencyContactPhone', 'notes', 'dob', 'fatherName',
]);

function summariseChange(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '∅';
  if (AUDIT_REDACTED_FIELDS.has(field)) return `«set:${String(value).length}»`;
  return String(value).slice(0, 120);
}

function buildAuditDiff(
  fields: ReadonlyArray<readonly [string, unknown, unknown]>
): { oldValue: string; newValue: string; changed: string[] } | null {
  const changed = fields.filter(([, before, after]) => String(before ?? '') !== String(after ?? ''));
  if (changed.length === 0) return null;
  return {
    oldValue: changed.map(([f, before]) => `${f}=${summariseChange(f, before)}`).join('; '),
    newValue: changed.map(([f, , after]) => `${f}=${summariseChange(f, after)}`).join('; '),
    changed: changed.map(([f]) => f),
  };
}

function assertVisitorSource(source: string): void {
  if (!VISITOR_SOURCES.has(source)) throw new HttpError(400, 'Invalid visitor source.');
}

function assertVisitorGender(gender: string): void {
  if (!VISITOR_GENDERS.has(gender)) throw new HttpError(400, 'Invalid visitor gender.');
}

function assertFollowUpStatus(status: string): void {
  if (!FOLLOW_UP_STATUSES.has(status)) throw new HttpError(400, 'Invalid follow-up status.');
}

function assertVisitorStage(stage: string): void {
  if (!(VISITOR_FLOW as readonly string[]).includes(stage)) throw new HttpError(400, `Invalid visitor stage "${stage}".`);
}

function assertBranchTargetAccess(req: import('express').Request, branchId: string, ownerBranchId: string): void {
  if (branchId !== ownerBranchId && !canAccessBranchResource(req, branchId)) {
    throw new HttpError(403, 'Target branch is outside your authorized scope.');
  }
}


/** Safely extract user context */
export function getUserContext(req: import('express').Request) {
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

/**
 * Read list filters off the query string.
 *
 * Values are passed straight to `buildVisitorFilterClause`, which binds every
 * one of them as a SQL parameter — nothing here is interpolated into SQL. An
 * unknown value simply matches nothing rather than erroring, because a filter
 * is a view preference, not a command.
 */
function readVisitorFilters(req: import('express').Request): VisitorFilters {
  const str = (key: string): string | undefined => {
    const raw = req.query[key];
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
  };
  return {
    search: str('search'),
    status: str('status'),
    source: str('source'),
    interest: str('interest'),
    placement: str('placement'),
    overdueOnly: req.query.overdue === 'true' || req.query.overdue === '1',
  };
}

function requireVisitor(req: import('express').Request, visitorId: string): any {
  const visitor = stmtGetVisitorById.get(visitorId) as any;
  if (!visitor) throw new HttpError(404, 'Visitor not found.');
  const { branchId, isAll } = resolveBranchScope(req);
  if (!isAll && branchId && visitor.branch_id && visitor.branch_id !== branchId) {
    const cross = !!visitor.branch_id && canAccessBranchResource(req, visitor.branch_id);
    if (!cross) throw new HttpError(403, 'Visitor belongs to another branch.');
  }
  return visitor;
}

function mapVisitorBase(row: any) {
  return {
    id: row.id, serialNo: row.serial_no, fullName: row.full_name, phone: row.phone, email: row.email, gender: row.gender, source: row.source,
    campaignId: row.campaign_id, stage: row.stage, assignedTo: row.assigned_to, visitDate: row.visit_date, status: row.status, notes: row.notes,
    branchId: row.branch_id, interestedCourse: row.interested_course, followUpStatus: row.follow_up_status, nextContactDate: row.next_contact_date,
    placementScore: row.placement_score ? JSON.parse(row.placement_score) : undefined, programVersionId: row.program_version_id ?? null, placementMethod: row.placement_method ?? null, placementStatus: row.placement_status ?? 'not_started', fatherName: row.father_name, addressRegion: row.address_region,
    tazkiraNo: row.tazkira_no, whatsapp: row.whatsapp, dob: row.dob, schoolOrUniversity: row.school_or_university,
    emergencyContactName: row.emergency_contact_name, emergencyContactPhone: row.emergency_contact_phone, createdAt: row.created_at,
  };
}

function mapVisitors(rows: any[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const followUps = stmtGetFollowupsBatch.all(JSON.stringify(ids)) as any[];
  const byVisitor = new Map<string, any[]>();
  for (const f of followUps) {
    if (!byVisitor.has(f.visitor_id)) byVisitor.set(f.visitor_id, []);
    byVisitor.get(f.visitor_id)!.push(f);
  }
  return rows.map((row) => ({
    ...mapVisitorBase(row),
    followUpHistory: (byVisitor.get(row.id) || []).map((f) => ({ id: f.id, date: f.date, notes: f.notes, operator: f.operator, outcome: f.outcome })),
  }));
}

// ============================================================================ 
// §1 — LIST / READ 
// ============================================================================ 
/**
 * Visitor list — server-side search, filter and pagination (UX-1).
 *
 * Filtering happens in SQL so that page N is a page of the FILTERED set. When
 * the client filtered a fetched page in JavaScript, a search for lead #101 of
 * 250 returned "no matches" for a person who existed, and every KPI was
 * computed from the truncated array. `X-Total-Count` now reports the count of
 * rows matching the caller's filters (the paginator's denominator) and
 * `X-Unfiltered-Count` the whole scoped population, so the UI can say
 * "showing 20 of 137 matching / 250 total" without counting anything itself.
 */
visitorsRouter.get('/', requirePermission('Lead.View'), ah(async (req, res) => {
  const scope = resolveBranchScope(req);
  const { limit, offset } = parsePagination(req);
  const filters = readVisitorFilters(req);
  const todayStr = today();

  const { rows, filteredTotal } = queryVisitorPage(db, scope, filters, { limit, offset }, todayStr);
  const unfiltered = scope.isAll
    ? (stmtCountAllVisitors.get() as { c: number }).c
    : (stmtCountVisitorsByBranch.get(scope.branchId) as { c: number }).c;

  res.setHeader('X-Total-Count', String(filteredTotal));
  res.setHeader('X-Unfiltered-Count', String(unfiltered));
  res.setHeader('X-Page-Limit', String(limit));
  res.setHeader('X-Page-Offset', String(offset));
  res.json(mapVisitors(rows as any[]));
}));

/**
 * Authoritative visitor KPIs (UX-1).
 *
 * Same authority model as `/dashboard/summary`: SQL aggregates over the whole
 * scoped population, never a page. The client renders these and derives none
 * of them. `Lead.View` is the permission every lead-viewing role already holds,
 * so this adds no new access.
 */
visitorsRouter.get('/summary', requirePermission('Lead.View'), ah(async (req, res) => {
  const scope = resolveBranchScope(req);
  res.json(buildVisitorSummary(db, scope, readVisitorFilters(req), today()));
}));

// ============================================================================ 
// §2 — PIPELINE VIEW 
// ============================================================================ 
/**
 * Conversion eligibility preview (UX-3).
 *
 * Read-only: it calls INTO the same placement authority the write path uses,
 * so it can never green-light a conversion the write path would refuse.
 *
 * Guarded by `Lead.View`, NOT `Lead.Convert`. It was originally the stricter
 * permission, on the reasoning that a preview should require the right to
 * perform the action it previews. That was wrong in this domain: counselors
 * hold Lead.View/Edit and are authorized to RUN placement assessments (verified
 * against /api/placement/visitors/:id/placement), but not Lead.Convert. Gating
 * the preview on Lead.Convert therefore hid "placement assessment required"
 * from the very role whose job is to clear it, while the registrar who could
 * see the message could not act on it.
 *
 * The payload is safe at this level: it exposes only lead lifecycle state and
 * the placement requirement for a class, both of which a Lead.View holder can
 * already read from the visitor record and the program catalogue. It exposes
 * no financial data and grants no capability — `POST /:id/convert` remains
 * gated on `Lead.Convert`.
 *
 * `requireVisitor` enforces the same branch isolation as every other route here.
 */
visitorsRouter.get('/:id/conversion-eligibility', requirePermission('Lead.View'), ah(async (req, res) => {
  const visitor = requireVisitor(req, req.params.id);
  const rawClassId = req.query.classId;
  const classId = typeof rawClassId === 'string' && rawClassId.trim() !== '' ? rawClassId.trim() : null;
  const { branchId } = resolveBranchScope(req);
  res.json(
    evaluateConversionEligibilityForVisitor(db, visitor, classId, visitor.branch_id ?? branchId ?? null)
  );
}));

visitorsRouter.get('/pipeline', requirePermission('Lead.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  const stageRows = isAll ? stmtGetPipelineAll.all() : stmtGetPipelineByBranch.all(branchId) as any[];
  
  const stageCounts = new Map<string, number>();
  for (const r of stageRows) stageCounts.set(r.stage, r.count);

  const stages = VISITOR_FLOW.map((stage, i) => {
    const count = stageCounts.get(stage) || 0;
    const prevCount = i > 0 ? (stageCounts.get(VISITOR_FLOW[i - 1]) || 0) : count;
    return { stage, count, conversionRate: prevCount > 0 ? Math.round((count / prevCount) * 1000) / 10 : 100 };
  });

  // `stages` above is a genuine per-stage funnel and is left untouched.
  //
  // The two scalar metrics were not. They read:
  //   totalLeads         = COUNT(stage='lead')          -- leads STILL IN 'lead'
  //   totalRegistrations = COUNT(stage='registration')
  // Conversion writes stage='enrollment' and never passes through
  // 'registration', so a converted lead was never counted: with 27 real
  // conversions in the database this endpoint reported 0 registrations and a
  // 0% conversion rate. Worse, the denominator SHRANK as leads progressed out
  // of 'lead', so the metric moved the wrong way as the business improved.
  //
  // Both now use the shared lifecycle authority, so this endpoint agrees with
  // /visitors/summary, /dashboard/summary, BOS and reports.
  const totals = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN ${LEAD_CONVERTED_SQL} THEN 1 ELSE 0 END) AS converted
     FROM visitors WHERE 1=1${isAll ? '' : ' AND branch_id = ?'}`
  ).get(...(isAll ? [] : [branchId])) as { total: number; converted: number };

  const totalLeads = Number(totals.total || 0);
  const totalRegistrations = Number(totals.converted || 0);
  res.json({ stages, totalLeads, totalRegistrations, overallConversion: totalLeads > 0 ? Math.round((totalRegistrations / totalLeads) * 1000) / 10 : 0 });
}));

// ============================================================================ 
// §3 — CREATE 
// ============================================================================ 
visitorsRouter.post('/', requirePermission('Lead.Create'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { gender, source, campaignId, stage, assignedTo, branchId, programVersionId } = req.body;
  if (!gender || !source) throw new HttpError(400, 'Full name, gender, and source are required.');
  assertVisitorGender(gender);
  assertVisitorSource(source);
  // One normalization/validation authority, shared with PATCH (audit V-4).
  // Type-checks, trims and bounds every text field; throws 400 on a non-string.
  const text = normalizeVisitorText(req.body as Record<string, unknown>);
  const fullName = requiredText(req.body?.fullName, 'Full name', TEXT_LIMITS.name);
  const { phone = null, email = null, notes = null, interestedCourse = null, fatherName = null,
          addressRegion = null, tazkiraNo = null, whatsapp = null, schoolOrUniversity = null,
          emergencyContactName = null, emergencyContactPhone = null } = text;
  const followUpStatus = req.body?.followUpStatus;
  const nextContactDate = assertOptionalIsoDate(req.body?.nextContactDate, 'Next contact date');
  const dob = assertOptionalIsoDate(req.body?.dob, 'Date of birth');
  // National ID uniqueness — same policy as students (audit V-2).
  assertTazkiraAvailable(tazkiraNo);
  const targetBranchId = branchId || user.branchId;
  assertBranchTargetAccess(req, targetBranchId, user.branchId);
  const targetStage = stage || 'lead';
  let selectedProgramVersionId: string | null = null;
  let resolvedProgramVersionId = programVersionId || null;
  if (!resolvedProgramVersionId) {
    const fallback = db.prepare(`SELECT pv.id FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE p.branch_id = ? AND pv.status = 'published' ORDER BY pv.is_default DESC, pv.version_number DESC LIMIT 1`).get(targetBranchId) as { id: string } | undefined;
    resolvedProgramVersionId = fallback?.id ?? null;
  }
  if (resolvedProgramVersionId) {
    const pv = stmtGetProgramVersionById.get(resolvedProgramVersionId) as any;
    if (!pv) throw new HttpError(404, 'Selected program version not found.');
    if (pv.branch_id && pv.branch_id !== targetBranchId) throw new HttpError(400, 'Selected program belongs to another branch.');
    if (pv.status !== 'published') throw new HttpError(400, 'Selected program version is not published.');
    selectedProgramVersionId = resolvedProgramVersionId;
  }
  assertVisitorStage(targetStage);
  assertFollowUpStatus(followUpStatus || 'medium_interest');
  if (assignedTo) {
    const assignee = db.prepare('SELECT id, branch_id, status FROM users WHERE id = ?').get(assignedTo) as any;
    if (!assignee || assignee.status === 'inactive') throw new HttpError(400, 'Assigned user is not active.');
    if (assignee.branch_id !== targetBranchId && !canAccessBranchResource(req, assignee.branch_id)) throw new HttpError(403, 'Assigned user is outside the target branch scope.');
  }
  if (campaignId) {
    const campaign = db.prepare('SELECT id, branch_id, status FROM campaigns WHERE id = ?').get(campaignId) as any;
    if (!campaign) throw new HttpError(400, 'Campaign not found.');
    if (campaign.branch_id !== targetBranchId) throw new HttpError(400, 'Campaign does not belong to the target branch.');
    if (campaign.status !== 'active') throw new HttpError(400, 'Campaign is not active.');
  }
  const newId = id('v');
  // V-3: allocate from the same atomic counter that issues receipt and student
  // codes (`INSERT … ON CONFLICT DO UPDATE … RETURNING`, one statement). The
  // previous `SELECT MAX(serial)+1` was a read-then-write: two connections both
  // read V-1031 and both inserts were accepted, because nothing in the schema
  // said otherwise. `uq_visitors_serial_no` (migration 072) is the backstop.
  const serialNo = `V-${incrementNumberSetting('visitor_serial_counter', 1, 1000)}`;

  const tx = db.transaction(() => {
    stmtInsertVisitor.run(
      newId, serialNo, fullName, phone || null, email || null, gender, source, campaignId || null, targetStage, assignedTo || null,
      today(), notes || null, targetBranchId, interestedCourse || (selectedProgramVersionId ? (stmtGetProgramVersionById.get(selectedProgramVersionId) as any)?.program_name : null) || null, followUpStatus || 'medium_interest', nextContactDate || null,
      fatherName || null, addressRegion || null, tazkiraNo || null, whatsapp || null, dob || null, schoolOrUniversity || null, emergencyContactName || null, emergencyContactPhone || null, selectedProgramVersionId
    );
  });
  tx();

  writeAudit(req, `Created new visitor: ${fullName} (${source})`);
  res.status(201).json({ id: newId, serialNo });
}));

// ============================================================================ 
// §4 — UPDATE 
// ============================================================================ 
visitorsRouter.patch('/:id', requirePermission('Lead.Edit'), ah(async (req, res) => {
  const existing = requireVisitor(req, req.params.id);
  const f = req.body;
  if (f.stage !== undefined && f.stage !== existing.stage) {
    throw new HttpError(400, 'Stage changes must use the stage workflow endpoint.');
  }
  if (f.source !== undefined) assertVisitorSource(f.source);
  if (f.gender !== undefined) assertVisitorGender(f.gender);
  if (f.followUpStatus !== undefined) assertFollowUpStatus(f.followUpStatus);
  // V-4: the SAME normalization authority CREATE uses. Previously PATCH
  // validated enums but nothing else, so a 100,000-character name, a
  // non-string phone and "9999-99-99" as a date were all accepted and stored.
  const text = normalizeVisitorText(f as Record<string, unknown>);
  if (f.nextContactDate !== undefined) assertOptionalIsoDate(f.nextContactDate, 'Next contact date');
  if (f.dob !== undefined) assertOptionalIsoDate(f.dob, 'Date of birth');
  if ('tazkiraNo' in text) assertTazkiraAvailable(text.tazkiraNo, existing.id);
  if (f.programVersionId !== undefined && f.programVersionId !== null) { const pv = stmtGetProgramVersionById.get(f.programVersionId) as any; if (!pv) throw new HttpError(404, 'Selected program version not found.'); if (pv.branch_id !== existing.branch_id) throw new HttpError(400, 'Selected program belongs to another branch.'); if (pv.status !== 'published') throw new HttpError(400, 'Selected program version is not published.'); }
  if (f.assignedTo) { const assignee = db.prepare('SELECT id, branch_id, status FROM users WHERE id = ?').get(f.assignedTo) as any; if (!assignee || assignee.status === 'inactive') throw new HttpError(400, 'Assigned user is not active.'); if (assignee.branch_id !== existing.branch_id && !canAccessBranchResource(req, assignee.branch_id)) throw new HttpError(403, 'Assigned user is outside the visitor branch scope.'); }
  if (f.campaignId) { const campaign = db.prepare('SELECT id, branch_id, status FROM campaigns WHERE id = ?').get(f.campaignId) as any; if (!campaign) throw new HttpError(400, 'Campaign not found.'); if (campaign.branch_id !== existing.branch_id) throw new HttpError(400, 'Campaign does not belong to the visitor branch.'); if (campaign.status !== 'active') throw new HttpError(400, 'Campaign is not active.'); }
  if (f.programVersionId !== undefined && String(f.programVersionId || '') !== String(existing.program_version_id || '')) {
    db.transaction(() => {
      db.prepare(`UPDATE placement_assessment_attempts SET status='cancelled', updated_at=datetime('now'), notes=COALESCE(notes,'') || ? WHERE visitor_id=? AND status='in_progress'`).run(' Program changed; attempt invalidated.', existing.id);
      db.prepare(`UPDATE visitors SET placement_score=NULL, placement_method=NULL, placement_status='not_started', current_placement_attempt_id=NULL, stage=CASE WHEN stage IN ('placement_booking','placement_fee','placement_completed') THEN 'follow_up' ELSE stage END WHERE id=?`).run(existing.id);
    })();
  }
  // Normalized values win over the raw body for every text field.
  const merge = (k: string, c: string) => (k in text ? text[k] : f[k] !== undefined ? f[k] : existing[c]);
  
  stmtUpdateVisitor.run(
    merge('fullName', 'full_name'), merge('phone', 'phone'), merge('email', 'email'), merge('gender', 'gender'), merge('source', 'source'), 
    merge('campaignId', 'campaign_id'), merge('stage', 'stage'), merge('assignedTo', 'assigned_to'), merge('notes', 'notes'),
    merge('interestedCourse', 'interested_course'), merge('followUpStatus', 'follow_up_status'), merge('nextContactDate', 'next_contact_date'),
    merge('fatherName', 'father_name'), merge('addressRegion', 'address_region'), merge('tazkiraNo', 'tazkira_no'), merge('whatsapp', 'whatsapp'),
    merge('dob', 'dob'), merge('schoolOrUniversity', 'school_or_university'), merge('emergencyContactName', 'emergency_contact_name'),
    merge('emergencyContactPhone', 'emergency_contact_phone'), f.programVersionId !== undefined ? f.programVersionId : existing.program_version_id, req.params.id
  );
  // V-8: record WHAT changed. The audit previously wrote
  // `old_value=NULL, new_value=NULL`, so the V-1 exploit step — detaching a
  // placement-governed program — was indistinguishable from any other edit.
  // Contact/free-text values are redacted to a length marker: the forensic
  // question is which field moved, not the lead's phone number.
  const diff = buildAuditDiff([
    ['fullName', existing.full_name, merge('fullName', 'full_name')],
    ['phone', existing.phone, merge('phone', 'phone')],
    ['email', existing.email, merge('email', 'email')],
    ['gender', existing.gender, merge('gender', 'gender')],
    ['source', existing.source, merge('source', 'source')],
    ['campaignId', existing.campaign_id, merge('campaignId', 'campaign_id')],
    ['assignedTo', existing.assigned_to, merge('assignedTo', 'assigned_to')],
    ['notes', existing.notes, merge('notes', 'notes')],
    ['interestedCourse', existing.interested_course, merge('interestedCourse', 'interested_course')],
    ['followUpStatus', existing.follow_up_status, merge('followUpStatus', 'follow_up_status')],
    ['nextContactDate', existing.next_contact_date, merge('nextContactDate', 'next_contact_date')],
    ['fatherName', existing.father_name, merge('fatherName', 'father_name')],
    ['addressRegion', existing.address_region, merge('addressRegion', 'address_region')],
    ['tazkiraNo', existing.tazkira_no, merge('tazkiraNo', 'tazkira_no')],
    ['whatsapp', existing.whatsapp, merge('whatsapp', 'whatsapp')],
    ['dob', existing.dob, merge('dob', 'dob')],
    ['schoolOrUniversity', existing.school_or_university, merge('schoolOrUniversity', 'school_or_university')],
    ['emergencyContactName', existing.emergency_contact_name, merge('emergencyContactName', 'emergency_contact_name')],
    ['emergencyContactPhone', existing.emergency_contact_phone, merge('emergencyContactPhone', 'emergency_contact_phone')],
    ['programVersionId', existing.program_version_id, f.programVersionId !== undefined ? f.programVersionId : existing.program_version_id],
  ]);
  writeAudit(
    req,
    `Updated visitor details: ${existing.full_name}${diff ? ` [${diff.changed.join(', ')}]` : ' (no change)'}`,
    diff ? { oldValue: diff.oldValue, newValue: diff.newValue } : undefined
  );
  res.json({ ok: true });
}));

// ============================================================================ 
// §5 — FOLLOW-UPS 
// ============================================================================ 
visitorsRouter.post('/:id/followups', requirePermission('Lead.Edit'), ah(async (req, res) => {
  const user = getUserContext(req);
  const visitor = requireVisitor(req, req.params.id);
  const { notes, outcome } = req.body;
  if (!notes) throw new HttpError(400, 'Follow-up note text is required.');
  if (outcome != null && !FOLLOW_UP_OUTCOMES.has(outcome)) throw new HttpError(400, 'Invalid follow-up outcome.');
  if (outcome === 'callback' && !req.body.nextContactDate) throw new HttpError(400, 'Callback follow-ups require a next contact date.');
  const tx = db.transaction(() => {
    stmtInsertFollowup.run(id('f'), visitor.id, today(), notes, user.fullName, outcome || null);
    if (outcome === 'interested') stmtUpdateVisitorCRM.run(visitor.interested_course, 'high_interest', req.body.nextContactDate ?? visitor.next_contact_date, visitor.stage, null, visitor.id);
    if (outcome === 'not_interested') stmtUpdateVisitorCRM.run(visitor.interested_course, 'no_interest', null, 'lost', null, visitor.id);
    if (outcome === 'callback') stmtUpdateVisitorCRM.run(visitor.interested_course, 'medium_interest', req.body.nextContactDate, visitor.stage, null, visitor.id);
  });
  tx();
  writeAudit(req, `Added follow-up note for visitor ${visitor.full_name}`);
  res.status(201).json({ ok: true });
}));

// ============================================================================
// §6 — PLACEMENT WORKSPACE
// The unified Placement Assessment Workspace lives under /api/placement.
// ============================================================================

// ============================================================================ 
// §7 — CRM UPDATE 
// ============================================================================ 
visitorsRouter.patch('/:id/crm', requirePermission('Lead.Edit'), ah(async (req, res) => {
  const visitor = requireVisitor(req, req.params.id);
  const { interestedCourse, followUpStatus, nextContactDate, notes, stage } = req.body;
  if (followUpStatus !== undefined) assertFollowUpStatus(followUpStatus);
  if (stage !== undefined && stage !== visitor.stage) throw new HttpError(400, 'Stage changes must use the stage workflow endpoint.');
  stmtUpdateVisitorCRM.run(interestedCourse ?? visitor.interested_course, followUpStatus ?? visitor.follow_up_status, nextContactDate ?? visitor.next_contact_date, visitor.stage, notes ?? null, req.params.id);
  writeAudit(req, `Updated CRM info for visitor: ${visitor.full_name}`);
  res.json({ ok: true });
}));

// ============================================================================ 
// §8 — CONVERT TO STUDENT 
// ============================================================================ 
visitorsRouter.post('/:id/convert', requirePermission('Lead.Convert'), ah(async (req, res) => {
  const user = getUserContext(req);
  const visitor = requireVisitor(req, req.params.id);
  
  // Idempotency check
  if (visitor.status === 'registered') throw new HttpError(409, 'This visitor has already been converted.');
  // V-6: closure means the same thing at every endpoint. The stage workflow
  // refuses `lost -> inquiry`, yet conversion used to rewrite the stage
  // straight to 'enrollment', silently resurrecting a closed lead. Reopening
  // is a deliberate, audited act — it must not be a side effect of converting.
  if (visitor.stage === 'lost') {
    throw new HttpError(409, 'This lead is closed (lost). Reopen it before converting.');
  }
  if (stmtGetStudentByLeadId.get(visitor.id)) throw new HttpError(409, 'A student record already exists for this visitor.');

  const { classId, amountPaid, discountPercent, notes, semesterFee, branchId, programVersionId, levelId, paymentMethod } = req.body ?? {};
  if (!classId) throw new HttpError(400, 'Class is required.');
  // `Number(x) < 0` is a coercion, not a validation: NaN < 0 is false, so
  // "abc" sailed through and reached SQLite as a NOT NULL violation. Both
  // figures are money and must clear the same bar as every other monetary
  // input. Reproduced before this guard existed: semesterFee "abc" surfaced a
  // raw constraint error, semesterFee -6000 wrote an invoice with
  // total_amount -6000 and discount_amount -6000, and a 0 fee accepted a
  // 50,000 AFN payment against it.
  if (amountPaid == null) throw new HttpError(400, 'Received fee amount is required.');
  const validatedAmountPaid = assertMoney(amountPaid, 'received fee amount');

  const resolvedPaymentMethod = ['cash', 'card', 'bank_transfer'].includes(paymentMethod) ? paymentMethod : 'cash';
  const requestedStudentBranchId = branchId || visitor.branch_id || user.branchId;
  assertBranchTargetAccess(req, requestedStudentBranchId, visitor.branch_id || user.branchId);
  const classItem = stmtGetClassForConvert.get(classId) as any;
  if (!classItem) throw new HttpError(404, 'Class not found.');
  const effectiveProgramVersionId = visitor.program_version_id || programVersionId || null;
  if (visitor.program_version_id && programVersionId && String(programVersionId) !== String(visitor.program_version_id)) throw new HttpError(409, 'The enrollment program must match the visitor program.');
  if (programVersionId && !visitor.program_version_id) {
    const requestedProgram = stmtGetProgramVersionById.get(programVersionId) as any;
    if (!requestedProgram) throw new HttpError(404, 'Selected program version not found.');
    if (requestedProgram.branch_id !== requestedStudentBranchId) throw new HttpError(400, 'Selected program does not belong to the target branch.');
  }
  if (effectiveProgramVersionId) {
    const pv = stmtGetProgramVersionById.get(effectiveProgramVersionId) as any;
    if (!pv) throw new HttpError(409, 'The visitor program version no longer exists.');
    if (pv.branch_id !== requestedStudentBranchId) throw new HttpError(400, 'Visitor program does not belong to the target branch.');
  }

  // ── PLACEMENT ELIGIBILITY ──────────────────────────────────────────────────
  // Deliberately NOT evaluated here. `EnrollmentService.enroll()` below is the
  // single placement authority for every enrollment path, and it resolves the
  // governing program from the CLASS's level rather than from the visitor row.
  //
  // This route used to run its own copy of the rule inside
  // `if (effectiveProgramVersionId)`. Because that condition reads the
  // visitor's program, detaching it with a Lead.Edit PATCH skipped the check
  // entirely (audit V-1) — a candidate with a completed 'failed' attempt was
  // enrolled into the program version they had failed. A second implementation
  // of an invariant is a second answer to it.
  //
  // The requirement mode is still denormalised onto the visitor for reporting,
  // resolved the same way the authority resolves it: class level first.
  {
    const governingProgramVersionId = resolveGoverningProgramVersionId(
      classItem,
      effectiveProgramVersionId,
      (levelId) => (stmtGetLevelProgramVersion.get(levelId) as { program_version_id: string | null } | undefined)?.program_version_id ?? null
    );
    if (governingProgramVersionId) {
      const requirement = resolvePlacementRequirement(governingProgramVersionId, requestedStudentBranchId, classItem.level_id || null);
      db.prepare(`UPDATE visitors SET placement_requirement_mode=? WHERE id=?`).run(requirement.mode, visitor.id);
    }
  }
  if (classItem.status && classItem.status !== 'active') throw new HttpError(400, 'Cannot enroll into an inactive class.');
  assertClassGenderAllowsStudent(classId, visitor.gender);

  // Check capacity — single authoritative rule (enrollments-based), see
  // core/academic/class-capacity.ts.
  if (classItem.capacity && classItem.capacity > 0) {
    const enrolledCount = countActiveStudentsInClass(db, classId);
    if (enrolledCount >= classItem.capacity) throw new HttpError(400, `Class "${classItem.name}" is full.`);
  }

  const studentBranchId = requestedStudentBranchId;
  if (classItem.branch_id && classItem.branch_id !== studentBranchId) throw new HttpError(400, 'Selected class does not belong to the target branch.');
  const grossTuition = assertMoney(semesterFee != null ? semesterFee : classItem.fee != null ? classItem.fee : 0, 'semester fee');
  const requestedDiscount = Math.max(0, Math.min(100, Number(discountPercent) || 0));
  const discountRule = evaluateRules({ category: 'discount', branchId: studentBranchId, data: { discountPercent: requestedDiscount, leadSource: visitor.source }, dryRun: false });
  // The rule engine IS the discount authority — `rule_default_discount_cap`
  // holds the institutional ceiling and is editable at runtime by an admin.
  // This line used to re-cap the engine's answer at a hardcoded 30, so raising
  // the configured cap to 50% silently had no effect here: the engine returned
  // 50 and the route quietly clamped it back to 30. A policy that cannot be
  // changed from the place it is configured is not a policy.
  const effectiveDiscount = Math.max(0, Math.min(100, Number(discountRule.finalOutputs.discountPercent ?? requestedDiscount)));
  const netTuition = Math.max(0, Math.round(grossTuition - (grossTuition * effectiveDiscount) / 100));
  const paidNow = validatedAmountPaid;
  // The `&& netTuition > 0` escape hatch let any amount be collected against a
  // zero-fee enrolment (50,000 AFN against a 0 fee was accepted and stored).
  // Money may never exceed what is actually payable, including when nothing is.
  if (paidNow > netTuition) throw new HttpError(400, `Amount received cannot exceed payable fee: ${netTuition} AFN.`);

  const studentCode = nextStudentCode();
  const qrCode = `${studentCode}-${String(visitor.full_name).toUpperCase().replace(/\s+/g, '-')}`;
  const newStudentId = id('stu');
  const date = today();
  const receiptNumber = nextReceiptNumber();
  const invoiceNumber = nextInvoiceNumber(studentBranchId);
  const dueDays = getNumberSetting('invoice_due_days', SYSTEM_DEFAULTS.invoiceDueDays);
  const due = new Date(date); due.setDate(due.getDate() + dueDays);
  const dueDate = due.toISOString().slice(0, 10);
  const invoiceId = id('inv');
  const invoiceStatus = paidNow >= netTuition && netTuition > 0 ? 'paid' : paidNow > 0 ? 'partial' : 'issued';
  const discountAmount = grossTuition - netTuition;

  const journey = getJourneyEngine(db);

  const tx = db.transaction(() => {
    stmtUpdateVisitorConverted.run(visitor.id);
    stmtInsertConvertedStudent.run(
      newStudentId, studentCode, visitor.full_name, visitor.phone, visitor.email || null, qrCode, date, studentBranchId, effectiveDiscount, visitor.gender, visitor.placement_score, notes || `Converted from visitor. Class: ${classItem.name}`,
      visitor.father_name, visitor.address_region, visitor.tazkira_no, visitor.whatsapp, visitor.dob, visitor.school_or_university, visitor.emergency_contact_name, visitor.emergency_contact_phone, visitor.id
    );
    stmtInsertConvertedSemester.run(id('sem'), newStudentId, classId, date, grossTuition, netTuition);
    stmtInsertConvertedRegistration.run(id('reg'), newStudentId, classId, date, paidNow, receiptNumber, effectiveDiscount, studentBranchId, visitor.source);
    
    stmtInsertConvertedInvoice.run(invoiceId, newStudentId, grossTuition, discountAmount, netTuition, invoiceStatus, date, dueDate, studentBranchId, `Registration invoice — ${visitor.full_name}`, invoiceNumber, user.fullName, visitor.full_name, studentCode);
    stmtInsertInvoiceItem.run(id('invit'), invoiceId, `Tuition fee — ${classItem.name}${effectiveDiscount > 0 ? ` (${effectiveDiscount}% discount)` : ''}`, grossTuition, grossTuition);
    if (discountAmount > 0) stmtInsertInvoiceItem.run(id('invit'), invoiceId, `Discount (${effectiveDiscount}%)`, -discountAmount, -discountAmount);

    if (paidNow > 0) {
      const paymentId = id('pay');
      // Conversion is already serialised by uq_students_lead_id (one student
      // per visitor), so this payment can never legitimately repeat. Keying it
      // on the visitor makes that invariant explicit at the database level
      // instead of depending only on the enclosing uniqueness check.
      stmtInsertConvertedPayment.run(paymentId, newStudentId, invoiceId, paidNow, date, resolvedPaymentMethod, `Registration payment for ${classItem.name}`, receiptNumber, studentBranchId, `visitor-convert:${visitor.id}`);
      recordIncome({ category: 'fee', amount: paidNow, date, description: `Registration fee for ${visitor.full_name} (${studentCode})`, referenceId: invoiceId, operatorName: user.fullName, operatorRole: user.role ?? null, branchId: studentBranchId, paymentId });
    }

    journey.appendEvent({ studentId: newStudentId, eventType: JourneyEventType.STUDENT_REGISTERED, occurredAt: date, branchId: studentBranchId, actorUserId: user.userId, actorName: user.fullName, payload: { studentCode, fromVisitorId: visitor.id, classId, source: visitor.source } });
    
    getEnrollmentService(db).enroll({ studentId: newStudentId, branchId: studentBranchId, semesterName: 'Current Semester', classId, enrollmentType: 'new', programVersionId: effectiveProgramVersionId, levelId: levelId || classItem.level_id || null, actorUserId: user.userId, actorName: user.fullName, startedAt: date, autoInvoice: false, notes: notes || null, writeSemester: false });

    journey.appendEvent({ studentId: newStudentId, eventType: JourneyEventType.INVOICE_ISSUED, occurredAt: date, branchId: studentBranchId, actorUserId: user.userId, actorName: user.fullName, payload: { invoiceId, invoiceNumber, amount: netTuition, category: 'fee', label: 'Registration invoice' } });
    if (paidNow > 0) journey.appendEvent({ studentId: newStudentId, eventType: JourneyEventType.PAYMENT_RECORDED, occurredAt: date, branchId: studentBranchId, actorUserId: user.userId, actorName: user.fullName, payload: { amount: paidNow, category: 'fee', receiptNumber, label: 'Conversion payment' } });
  });
  tx();

  addNotification('New Registration Successful', `Student ${visitor.full_name} registered in ${classItem.name}. Invoice: ${invoiceNumber}. Fee received: ${paidNow} AFN of ${netTuition} AFN.`, 'success', studentBranchId);
  writeAudit(req, `Converted visitor ${visitor.full_name} to student ${studentCode}`, { newValue: `studentId=${newStudentId}, invoice=${invoiceNumber}, paid=${paidNow}/${netTuition}` });

  res.status(201).json({ studentId: newStudentId, studentCode, receiptNumber, invoiceId, invoiceNumber, netAmount: netTuition, status: invoiceStatus });
}));

// ============================================================================ 
// §9 — ADVANCE STAGE 
// ============================================================================ 
visitorsRouter.post('/:id/advance-stage', requirePermission('Lead.Edit'), ah(async (req, res) => {
  const row = requireVisitor(req, req.params.id);
  const current = row.stage || 'lead';
  let next = req.body?.stage as string | undefined;
  // V-7: a stage advance is one business transition per user action.
  //
  // Each request was already individually correct — the UPDATE is a
  // compare-and-swap on the current stage — but ten parallel bodyless calls
  // each won their own CAS in sequence and walked a lead from 'lead' all the
  // way to 'enrollment', straight through placement_booking, placement_fee and
  // placement_completed. Ten HTTP requests are not ten deliberate decisions.
  //
  // The caller must therefore state which stage it believes it is leaving, and
  // that token is checked against the row inside the same transaction as the
  // write. `fromStage` is REQUIRED rather than optional: an optional guard
  // protects only the callers that already thought about the problem.
  const fromStage = req.body?.fromStage as string | undefined;
  if (!fromStage) {
    throw new HttpError(400, 'fromStage is required: send the stage you are advancing from.');
  }
  if (fromStage !== current) {
    throw new HttpError(409, 'Visitor stage changed concurrently; reload and retry.');
  }
  if (!next) next = VISITOR_TRANSITIONS[current];
  if (!next) throw new HttpError(400, `Cannot auto-advance from stage "${current}".`);
  assertVisitorStage(next);
  if (next !== VISITOR_TRANSITIONS[current] && next !== 'lost') {
    throw new HttpError(400, `Invalid transition from "${current}" to "${next}".`);
  }
  if (current === 'lost') {
    throw new HttpError(409, 'This lead is closed (lost) and cannot be advanced.');
  }
  const changed = stmtUpdateVisitorStage.run(next, req.params.id, current);
  if (changed.changes !== 1) throw new HttpError(409, 'Visitor stage changed concurrently; reload and retry.');
  writeAudit(req, `Visitor ${row.full_name} stage: ${current} → ${next}`);
  res.json({ ok: true, from: current, to: next });
}));

export default visitorsRouter;
