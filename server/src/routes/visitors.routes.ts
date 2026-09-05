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
import { isGlobalOwner, hasAnyPermission, hasRole } from '../core/rbac/rbac-service.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { assertOptionalIsoDate } from '../utils/isoDate.js';
import { id, today, addDaysISO } from '../utils/ids.js';
import { resolvePlacementRequirement } from '../core/placement/policy-engine.js';
import { readRetakePolicy, evaluateBilling } from '../core/placement/placement-policy.js';
import { buildVisitorSummary, queryVisitorPage, type VisitorFilters } from '../core/visitors/visitor-query.js';
import { describeVisitorWorkflow, summarizeVisitorWorkflow } from '../core/visitors/visitor-workflow.js';
import { evaluateConversionEligibilityForVisitor } from '../core/visitors/conversion-eligibility.js';
import { LEAD_CONVERTED_SQL } from '../core/visitors/lead-lifecycle.js';
import { findDuplicateCandidates } from '../core/visitors/duplicate-lookup.js';
import { eventBus } from '../core/events/event-bus.js';
import { addNotification } from '../utils/notifications.js';
import { getNumberSetting, incrementNumberSetting } from '../utils/settings.js';
import { resolveFeeRule } from '../core/configuration/policy-resolver.js';
import { getJourneyEngine } from '../core/journey/journey-engine.js';
import { JourneyEventType } from '../core/journey/event-types.js';
import { nextStudentCode } from '../utils/receipt.js';
import { nextInvoiceNumber } from '../utils/invoice.js';
import { SYSTEM_DEFAULTS } from '../core/configuration/policy-catalog.js';
import { assertStudentPhoneSyntax, studentPhoneKey } from '../core/students/student-input.js';

export const visitorsRouter = Router();
visitorsRouter.use(authenticate);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtGetVisitorById = db.prepare('SELECT * FROM visitors WHERE id = ?');
const stmtFindVisitorByTazkira = db.prepare("SELECT id FROM visitors WHERE tazkira_no = ? LIMIT 1");
const stmtFindVisitorByTazkiraExcluding = db.prepare("SELECT id FROM visitors WHERE tazkira_no = ? AND id <> ? LIMIT 1");
const stmtFindStudentByTazkiraNo = db.prepare("SELECT id, lead_id FROM students WHERE tazkira_no = ? LIMIT 1");
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
const stmtUpdateVisitorCRM = db.prepare(`UPDATE visitors SET interested_course=?, follow_up_status=?, next_contact_date=?, stage=?, notes=COALESCE(?, notes) WHERE id=?`);
const stmtUpdateVisitorStage = db.prepare('UPDATE visitors SET stage = ? WHERE id = ? AND stage = ?');
const stmtGetProgramVersionById = db.prepare(`SELECT pv.*, p.branch_id, p.name AS program_name FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.id = ?`);

// Pipeline aggregation statements
const stmtGetPipelineAll = db.prepare('SELECT stage, COUNT(*) as count FROM visitors GROUP BY stage');
const stmtGetPipelineByBranch = db.prepare('SELECT stage, COUNT(*) as count FROM visitors WHERE branch_id = ? GROUP BY stage');

// Convert statements
const stmtGetClassForConvert = db.prepare('SELECT * FROM classes WHERE id = ?');
const stmtGetStudentByLeadId = db.prepare('SELECT id FROM students WHERE lead_id = ?');
const stmtGetStudentByPhoneKey = db.prepare(
  `SELECT id FROM students
    WHERE phone IS NOT NULL AND TRIM(phone) <> ''
      AND SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'(',''),')',''),'+',''),'.',''),'/',''), -9) = ?
    LIMIT 1`,
);
const stmtGetStudentByEmail = db.prepare("SELECT id FROM students WHERE lower(trim(email)) = lower(trim(?)) LIMIT 1");
const stmtGetStudentByTazkira = db.prepare('SELECT id FROM students WHERE tazkira_no = ? LIMIT 1');
const stmtUpdateVisitorConverted = db.prepare("UPDATE visitors SET status = 'registered', stage = ?, placement_requirement_mode = COALESCE(?, placement_requirement_mode) WHERE id = ?");
const stmtInsertConvertedStudent = db.prepare(
  `INSERT INTO students (id, student_code, full_name, phone, email, qr_code, status, registration_date, branch_id, discount_percent, gender, placement_score, notes, father_name, address_region, tazkira_no, whatsapp, dob, school_or_university, emergency_contact_name, emergency_contact_phone, lead_id) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const stmtInsertConvertedRegistration = db.prepare(`INSERT INTO registrations (id, student_id, class_id, date, branch_id, source) VALUES (?, ?, ?, ?, ?, ?)`);
const stmtInsertRegistrationFeeInvoice = db.prepare(`INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, notes, invoice_number, issued_by, student_name, student_code, charge_kind, purpose, obligation_id) VALUES (?, ?, ?, 0, ?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, 'registration', 'other', NULL)`);
const stmtInsertPlacementFeeInvoice = db.prepare(`INSERT INTO invoices (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, notes, invoice_number, issued_by, student_name, student_code, charge_kind, purpose, obligation_id) VALUES (?, ?, ?, 0, ?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, 'placement', 'other', NULL)`);
const stmtInsertInvoiceItem = db.prepare(`INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount) VALUES (?, ?, ?, 1, ?, ?)`);

const VISITOR_FLOW = ['lead', 'inquiry', 'follow_up', 'placement_booking', 'placement_fee', 'placement_completed', 'class_fee', 'card_issued', 'book_issued', 'registration', 'enrollment', 'active', 'graduated', 'alumni', 'lost'] as const;

const VISITOR_SOURCES = new Set(['ads', 'friend', 'social', 'other', 'referral', 'event', 'organic', 'walk_in', 'facebook']);
const VISITOR_GENDERS = new Set(['male', 'female']);
const FOLLOW_UP_STATUSES = new Set(['high_interest', 'medium_interest', 'low_interest', 'not_answering', 'no_interest', 'hot', 'warm', 'cold']);
const FOLLOW_UP_OUTCOMES = new Set(['interested', 'not_interested', 'callback', 'registered']);
const VISITOR_TRANSITIONS: Record<string, string> = Object.fromEntries(VISITOR_FLOW.slice(0, -1).map((stage, index) => [stage, VISITOR_FLOW[index + 1]]));

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

// ============================================================================
// SHARED FIELD AUTHORITY
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

// Calendar-date validation lives in `utils/isoDate.ts` so the academic term
// routes enforce exactly the same rule. See that module for the rationale.

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
  const asStudent = stmtFindStudentByTazkiraNo.get(tazkira) as { id: string; lead_id: string | null } | undefined;
  if (asStudent && (!excludeVisitorId || asStudent.lead_id !== excludeVisitorId)) {
    throw new HttpError(409, 'A student with this Tazkira/ID number already exists.');
  }
}

/**
 * Build a compact, non-sensitive audit diff.
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

function assertBranchTargetAccess(req: import('express').Request, branchId: string): void {
  // A user's home branch is an identity attribute, never an authorization
  // fallback. The permission supplying this request must itself reach the
  // target branch (D-60/D-67).
  if (!canAccessBranchResource(req, branchId)) {
    throw new HttpError(403, 'Target branch is outside your authorized scope.');
  }
}


/** Safely extract user context */
export function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId || !user?.branchId || !user?.fullName) throw new HttpError(403, 'User context missing.');
  return user;
}

function resolveAdmissionRegistrationRule(branchId: string, scope: { programVersionId?: string | null; levelId?: string | null }) {
  const rule = resolveFeeRule(db, branchId, 'registration', scope);
  if (!rule) {
    throw new HttpError(409, 'No active registration fee is configured for this branch/program. Configure it in Academic Control Center before continuing.');
  }
  return rule;
}

function invoiceDueDate(issueDate: string): string {
  const dueDays = getNumberSetting('invoice_due_days', SYSTEM_DEFAULTS.invoiceDueDays);
  // UTC-pure due-date arithmetic (see addDaysISO in utils/ids).
  return addDaysISO(issueDate, dueDays);
}

function latestCompletedPlacementAttempt(visitorId: string): { id: string; snapshot_json: string | null } | null {
  return (db.prepare(
    `SELECT id, snapshot_json
       FROM placement_assessment_attempts
      WHERE visitor_id = ? AND status = 'completed'
      ORDER BY completed_at DESC, attempt_number DESC LIMIT 1`,
  ).get(visitorId) as { id: string; snapshot_json: string | null } | undefined) ?? null;
}

function resolvePlacementInvoiceRequirement(visitorId: string): { attemptId: string; amount: number } | null {
  const attempt = latestCompletedPlacementAttempt(visitorId);
  if (!attempt?.snapshot_json) return null;
  let snapshot: any;
  try { snapshot = JSON.parse(attempt.snapshot_json); } catch { return null; }
  const retakePolicy = readRetakePolicy(snapshot?.profile ?? null);
  const priorCompleted = Number(snapshot?.billingTerms?.priorCompletedAttempts);
  const baseFee = Number(snapshot?.billingTerms?.baseFee);
  if (!Number.isInteger(priorCompleted) || priorCompleted < 0 || !Number.isInteger(baseFee) || baseFee < 0) return null;
  const billing = evaluateBilling(retakePolicy, priorCompleted, baseFee);
  if (!billing.billable || billing.amount <= 0) return null;
  return { attemptId: attempt.id, amount: billing.amount };
}

function placementInvoiceExists(studentId: string, attemptId: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM invoices
      WHERE student_id = ? AND charge_kind = 'placement' AND notes = ?
      LIMIT 1`,
  ).get(studentId, `Placement assessment fee — attempt ${attemptId}`);
  return Boolean(row);
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
  const status = str('status');
  const source = str('source');
  const interest = str('interest');
  const placement = str('placement');
  if (status && !['all', 'pending', 'registered', 'lost'].includes(status)) {
    throw new HttpError(400, 'Invalid visitor status filter.');
  }
  if (source && source !== 'all' && !VISITOR_SOURCES.has(source)) {
    throw new HttpError(400, 'Invalid visitor source filter.');
  }
  if (interest && interest !== 'all' && !FOLLOW_UP_STATUSES.has(interest)) {
    throw new HttpError(400, 'Invalid visitor interest filter.');
  }
  if (placement && !['all', 'not_started', 'scheduled', 'in_progress', 'completed', 'waived', 'needs_assessment'].includes(placement)) {
    throw new HttpError(400, 'Invalid visitor placement filter.');
  }
  return {
    search: str('search'), status, source, interest, placement,
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

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A next-contact date describes FUTURE work. A date in the past is either a
 * typo or an attempt to backdate the pipeline, and both are refused here —
 * the server boundary is the authority; the client's date picker is courtesy.
 * Applies to every writer that can set the field.
 */
function assertContactDateForward(value: string | null): string | null {
  if (value && value < today()) {
    throw new HttpError(400, 'Next contact date must be today or a future date.');
  }
  return value;
}

function mapVisitorBase(row: any) {
  return {
    id: row.id, serialNo: row.serial_no, fullName: row.full_name, phone: row.phone, email: row.email, gender: row.gender, source: row.source,
    campaignId: row.campaign_id, stage: row.stage, assignedTo: row.assigned_to, visitDate: row.visit_date, status: row.status, notes: row.notes,
    branchId: row.branch_id, interestedCourse: row.interested_course, followUpStatus: row.follow_up_status, nextContactDate: row.next_contact_date,
    placementScore: parseJsonObject(row.placement_score), programVersionId: row.program_version_id ?? null, placementMethod: row.placement_method ?? null, placementStatus: row.placement_status ?? 'not_started', fatherName: row.father_name, addressRegion: row.address_region,
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
    workflow: summarizeVisitorWorkflow(db, row),
  }));
}

// ============================================================================ 
// LIST / READ 
// ============================================================================ 
/**
 * Visitor list — server-side search, filter and pagination.
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
 * Authoritative visitor KPIs.
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
// PIPELINE VIEW 
// ============================================================================ 
/**
 * Conversion eligibility preview.
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
/**
 * Possible-duplicate lookup.
 *
 * Advisory only: it returns candidates and never refuses anything. The hard
 * identity rule remains the Tazkira unique index (migration 072); phone is
 * deliberately NOT unique because household and office lines are legitimately
 * shared, and blocking those at the front desk would be worse than a duplicate.
 *
 * Gated on `Lead.Create` — the action it assists — and branch-scoped, so it
 * cannot be used to enumerate another branch's leads.
 */
visitorsRouter.get('/duplicate-check', requirePermission('Lead.Create'), ah(async (req, res) => {
  const scope = resolveBranchScope(req);
  const str = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined);
  res.json({
    candidates: findDuplicateCandidates(db, scope, {
      phone: str('phone'),
      tazkiraNo: str('tazkiraNo'),
      fullName: str('fullName'),
      excludeVisitorId: str('excludeVisitorId'),
    }),
  });
}));

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
// SINGLE LEAD + RECEPTION WORKFLOW READ MODEL
// ============================================================================
/**
 * One lead, with its derived reception workflow. The workspace that follows a
 * person from first visit to enrollment loads this — it never re-derives the
 * stage from scattered fields client-side.
 */
visitorsRouter.get('/:id', requirePermission('Lead.View'), ah(async (req, res) => {
  const visitor = requireVisitor(req, req.params.id);
  res.json({
    ...mapVisitors([visitor])[0],
    workflow: summarizeVisitorWorkflow(db, visitor),
  });
}));

/**
 * The authoritative front-desk state for one person: where they are, what is
 * blocking them, what happens next, and which of those actions the CURRENT
 * caller may perform. Read-only — the write authorities are unchanged.
 */
visitorsRouter.get('/:id/workflow', requirePermission('Lead.View'), ah(async (req, res) => {
  const visitor = requireVisitor(req, req.params.id);
  const rbac = req.rbac;
  const can = (code: string) => Boolean(rbac && isGlobalOwner(rbac)) || Boolean(rbac && hasAnyPermission(rbac, [code]));
  const workflow = describeVisitorWorkflow(db, visitor);
  res.json({
    visitorId: visitor.id,
    ...workflow,
    capabilities: {
      canFollowUp: can('Lead.Edit'),
      canAdmit: can('Lead.Convert'),
      canAssess: Boolean(
        rbac &&
          (isGlobalOwner(rbac) ||
            hasRole(rbac, 'owner') ||
            hasRole(rbac, 'receptionist') ||
            hasRole(rbac, 'general_manager') ||
            hasRole(rbac, 'counselor')),
      ),
      canEnroll: can('Class.Assign'),
      canSettleInvoices: Boolean(
        rbac && (isGlobalOwner(rbac) || hasRole(rbac, 'finance_manager') || hasRole(rbac, 'general_manager')),
      ),
    },
  });
}));

// ============================================================================ 
// CREATE 
// ============================================================================ 
visitorsRouter.post('/', requirePermission('Lead.Create'), ah(async (req, res) => {
  const user = getUserContext(req);
  const body = req.body ?? {};
  const { gender, source, stage } = body;
  const campaignId = optionalText(body.campaignId, 'Campaign id', TEXT_LIMITS.short);
  const assignedTo = optionalText(body.assignedTo, 'Assigned user id', TEXT_LIMITS.short);
  const branchId = optionalText(body.branchId, 'Branch id', TEXT_LIMITS.short);
  const programVersionId = optionalText(body.programVersionId, 'Program version id', TEXT_LIMITS.short);
  // Name the field that is ACTUALLY missing. Throwing
  // "Full name, gender, and source are required." while testing only gender and
  // source tells a request that supplied a full name that the full name is
  // missing — the exact class of unactionable message this guard removes. (`fullName` itself is validated by `requiredText` below, which
  // raises its own precise error.)
  if (!gender) throw new HttpError(400, 'Gender is required.');
  if (!source) throw new HttpError(400, 'Lead source is required.');
  assertVisitorGender(gender);
  assertVisitorSource(source);
  // One normalization/validation authority, shared with PATCH.
  // Type-checks, trims and bounds every text field; throws 400 on a non-string.
  const text = normalizeVisitorText(body);
  const fullName = requiredText(body.fullName, 'Full name', TEXT_LIMITS.name);
  const { phone = null, email = null, notes = null, interestedCourse = null, fatherName = null,
          addressRegion = null, tazkiraNo = null, whatsapp = null, schoolOrUniversity = null,
          emergencyContactName = null, emergencyContactPhone = null } = text;
  if (phone) assertStudentPhoneSyntax(phone);
  const followUpStatus = body.followUpStatus;
  const nextContactDate = assertContactDateForward(assertOptionalIsoDate(body.nextContactDate, 'Next contact date'));
  const dob = assertOptionalIsoDate(body.dob, 'Date of birth');
  // National ID uniqueness — same policy as students.
  assertTazkiraAvailable(tazkiraNo);
  const targetBranchId = branchId || user.branchId;
  assertBranchTargetAccess(req, targetBranchId);
  if (stage != null && stage !== 'lead') {
    throw new HttpError(400, 'New visitors must start at the lead stage.');
  }
  const targetStage = 'lead';
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
    if (assignee.branch_id !== targetBranchId) throw new HttpError(400, 'Assigned user must belong to the target branch.');
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
// UPDATE 
// ============================================================================ 
visitorsRouter.patch('/:id', requirePermission('Lead.Edit'), ah(async (req, res) => {
  const existing = requireVisitor(req, req.params.id);
  const f = { ...(req.body ?? {}) } as Record<string, unknown>;
  for (const [key, label] of [
    ['campaignId', 'Campaign id'],
    ['assignedTo', 'Assigned user id'],
    ['programVersionId', 'Program version id'],
  ] as const) {
    if (f[key] !== undefined) f[key] = optionalText(f[key], label, TEXT_LIMITS.short);
  }
  if (f.stage !== undefined && f.stage !== existing.stage) {
    throw new HttpError(400, 'Stage changes must use the stage workflow endpoint.');
  }
  if (f.source !== undefined) {
    if (typeof f.source !== 'string') throw new HttpError(400, 'Invalid lead source.');
    assertVisitorSource(f.source);
  }
  if (f.gender !== undefined) {
    if (typeof f.gender !== 'string') throw new HttpError(400, 'Invalid gender.');
    assertVisitorGender(f.gender);
  }
  if (f.followUpStatus !== undefined) {
    if (typeof f.followUpStatus !== 'string') throw new HttpError(400, 'Invalid follow-up status.');
    assertFollowUpStatus(f.followUpStatus);
  }
  // V-4: the SAME normalization authority CREATE uses. Validating enums alone
  // lets a 100,000-character name, a non-string phone and "9999-99-99" as a
  // date through to storage.
  const text = normalizeVisitorText(f as Record<string, unknown>);
  if (text.phone) assertStudentPhoneSyntax(text.phone);
  if (f.nextContactDate !== undefined) assertContactDateForward(assertOptionalIsoDate(f.nextContactDate, 'Next contact date'));
  if (f.dob !== undefined) assertOptionalIsoDate(f.dob, 'Date of birth');
  if ('tazkiraNo' in text) assertTazkiraAvailable(text.tazkiraNo, existing.id);
  if (f.programVersionId !== undefined && f.programVersionId !== null) { const pv = stmtGetProgramVersionById.get(f.programVersionId) as any; if (!pv) throw new HttpError(404, 'Selected program version not found.'); if (pv.branch_id !== existing.branch_id) throw new HttpError(400, 'Selected program belongs to another branch.'); if (pv.status !== 'published') throw new HttpError(400, 'Selected program version is not published.'); }
  if (f.assignedTo) { const assignee = db.prepare('SELECT id, branch_id, status FROM users WHERE id = ?').get(f.assignedTo) as any; if (!assignee || assignee.status === 'inactive') throw new HttpError(400, 'Assigned user is not active.'); if (assignee.branch_id !== existing.branch_id) throw new HttpError(400, 'Assigned user must belong to the visitor branch.'); }
  if (f.campaignId) { const campaign = db.prepare('SELECT id, branch_id, status FROM campaigns WHERE id = ?').get(f.campaignId) as any; if (!campaign) throw new HttpError(400, 'Campaign not found.'); if (campaign.branch_id !== existing.branch_id) throw new HttpError(400, 'Campaign does not belong to the visitor branch.'); if (campaign.status !== 'active') throw new HttpError(400, 'Campaign is not active.'); }
  const programChanged = f.programVersionId !== undefined
    && String(f.programVersionId || '') !== String(existing.program_version_id || '');
  const nextStage = programChanged && ['placement_booking', 'placement_fee', 'placement_completed'].includes(existing.stage)
    ? 'follow_up'
    : existing.stage;
  // Normalized values win over the raw body for every text field.
  const merge = (k: string, c: string) => (k in text ? text[k] : f[k] !== undefined ? f[k] : existing[c]);
  
  db.transaction(() => {
    if (programChanged) {
      db.prepare(`
        UPDATE placement_assessment_attempts
        SET status='cancelled', completed_at=datetime('now'), paused_at=NULL,
            updated_at=datetime('now'), notes=COALESCE(notes,'') || ?
        WHERE visitor_id=? AND status IN ('in_progress','paused')
      `).run(' Program changed; attempt invalidated.', existing.id);
      db.prepare(`UPDATE visitors SET placement_score=NULL, placement_method=NULL, placement_status='not_started', current_placement_attempt_id=NULL, stage=CASE WHEN stage IN ('placement_booking','placement_fee','placement_completed') THEN 'follow_up' ELSE stage END WHERE id=?`).run(existing.id);
    }
    stmtUpdateVisitor.run(
      merge('fullName', 'full_name'), merge('phone', 'phone'), merge('email', 'email'), merge('gender', 'gender'), merge('source', 'source'),
      merge('campaignId', 'campaign_id'), nextStage, merge('assignedTo', 'assigned_to'), merge('notes', 'notes'),
      merge('interestedCourse', 'interested_course'), merge('followUpStatus', 'follow_up_status'), merge('nextContactDate', 'next_contact_date'),
      merge('fatherName', 'father_name'), merge('addressRegion', 'address_region'), merge('tazkiraNo', 'tazkira_no'), merge('whatsapp', 'whatsapp'),
      merge('dob', 'dob'), merge('schoolOrUniversity', 'school_or_university'), merge('emergencyContactName', 'emergency_contact_name'),
      merge('emergencyContactPhone', 'emergency_contact_phone'), f.programVersionId !== undefined ? f.programVersionId : existing.program_version_id, req.params.id
    );
  })();
  // V-8: record WHAT changed. An audit row carrying
  // `old_value=NULL, new_value=NULL` makes the V-1 exploit step — detaching a
  // placement-governed program — indistinguishable from any other edit.
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
// FOLLOW-UPS 
// ============================================================================ 
visitorsRouter.post('/:id/followups', requirePermission('Lead.Edit'), ah(async (req, res) => {
  const user = getUserContext(req);
  const visitor = requireVisitor(req, req.params.id);
  const outcome = req.body?.outcome;
  const notes = requiredText(req.body?.notes, 'Follow-up note text', TEXT_LIMITS.notes);
  if (outcome != null && !FOLLOW_UP_OUTCOMES.has(outcome)) throw new HttpError(400, 'Invalid follow-up outcome.');
  const nextContactDate = req.body?.nextContactDate !== undefined
    ? assertContactDateForward(assertOptionalIsoDate(req.body.nextContactDate, 'Next contact date'))
    : null;
  if (outcome === 'callback' && !nextContactDate) throw new HttpError(400, 'Callback follow-ups require a next contact date.');
  const tx = db.transaction(() => {
    stmtInsertFollowup.run(id('f'), visitor.id, today(), notes, user.fullName, outcome || null);
    if (outcome === 'interested') stmtUpdateVisitorCRM.run(visitor.interested_course, 'high_interest', nextContactDate ?? visitor.next_contact_date, visitor.stage, null, visitor.id);
    if (outcome === 'not_interested') stmtUpdateVisitorCRM.run(visitor.interested_course, 'no_interest', null, 'lost', null, visitor.id);
    if (outcome === 'callback') stmtUpdateVisitorCRM.run(visitor.interested_course, 'medium_interest', nextContactDate, visitor.stage, null, visitor.id);
  });
  tx();
  writeAudit(req, `Added follow-up note for visitor ${visitor.full_name}`);
  res.status(201).json({ ok: true });
}));

// ============================================================================
// PLACEMENT WORKSPACE
// The unified Placement Assessment Workspace lives under /api/placement.
// ============================================================================

// ============================================================================ 
// CRM UPDATE 
// ============================================================================ 
visitorsRouter.patch('/:id/crm', requirePermission('Lead.Edit'), ah(async (req, res) => {
  const visitor = requireVisitor(req, req.params.id);
  const body = req.body ?? {};
  const { followUpStatus, stage } = body;
  if (followUpStatus !== undefined) assertFollowUpStatus(followUpStatus);
  if (stage !== undefined && stage !== visitor.stage) throw new HttpError(400, 'Stage changes must use the stage workflow endpoint.');
  const text = normalizeVisitorText(body);
  const nextContactDate = body.nextContactDate !== undefined
    ? assertContactDateForward(assertOptionalIsoDate(body.nextContactDate, 'Next contact date'))
    : visitor.next_contact_date;
  stmtUpdateVisitorCRM.run(
    'interestedCourse' in text ? text.interestedCourse : visitor.interested_course,
    followUpStatus ?? visitor.follow_up_status,
    nextContactDate,
    visitor.stage,
    'notes' in text ? text.notes : null,
    req.params.id,
  );
  writeAudit(req, `Updated CRM info for visitor: ${visitor.full_name}`);
  res.json({ ok: true });
}));

// ============================================================================ 
// CONVERT TO STUDENT 
// ============================================================================ 
visitorsRouter.post('/:id/convert', requirePermission('Lead.Convert'), ah(async (req, res) => {
  const user = getUserContext(req);
  const visitor = requireVisitor(req, req.params.id);
  
  // Idempotency check
  if (visitor.status === 'registered') throw new HttpError(409, 'This visitor has already been converted.');
  // V-6: closure means the same thing at every endpoint. The stage workflow
  // refuses `lost -> inquiry`, so conversion must not rewrite the stage
  // straight to 'enrollment' and silently resurrect a closed lead. Reopening
  // is a deliberate, audited act — never a side effect of converting.
  if (visitor.stage === 'lost') {
    throw new HttpError(409, 'This lead is closed (lost). Reopen it before converting.');
  }
  if (stmtGetStudentByLeadId.get(visitor.id)) throw new HttpError(409, 'A student record already exists for this visitor.');
  if (visitor.phone) assertStudentPhoneSyntax(visitor.phone);
  const visitorPhoneKey = studentPhoneKey(visitor.phone);
  if (visitorPhoneKey && stmtGetStudentByPhoneKey.get(visitorPhoneKey)) {
    throw new HttpError(409, 'A student with this phone number already exists. Update the lead identity before conversion.');
  }
  if (visitor.email && stmtGetStudentByEmail.get(visitor.email)) {
    throw new HttpError(409, 'A student with this email address already exists.');
  }
  if (visitor.tazkira_no && stmtGetStudentByTazkira.get(visitor.tazkira_no)) {
    throw new HttpError(409, 'A student with this Tazkira/ID number already exists.');
  }

  const { amountPaid, discountPercent, semesterFee, paymentMethod } = req.body ?? {};
  if (amountPaid != null || discountPercent != null || semesterFee != null || paymentMethod != null) {
    throw new HttpError(409, 'Visitor admission no longer collects payment or creates enrollment directly. Admit the student first, run placement, settle invoices, then enroll from the student workspace.');
  }

  const classId = optionalText(req.body?.classId, 'Class', TEXT_LIMITS.short);
  const branchId = optionalText(req.body?.branchId, 'Branch id', TEXT_LIMITS.short);
  const programVersionId = optionalText(req.body?.programVersionId, 'Program version id', TEXT_LIMITS.short);
  const levelId = optionalText(req.body?.levelId, 'Level id', TEXT_LIMITS.short);
  const notes = optionalText(req.body?.notes, 'Conversion notes', TEXT_LIMITS.notes);

  const requestedStudentBranchId = branchId || visitor.branch_id || user.branchId;
  if (visitor.branch_id && requestedStudentBranchId !== visitor.branch_id) {
    throw new HttpError(400, 'Converted student must remain in the visitor branch.');
  }
  assertBranchTargetAccess(req, requestedStudentBranchId);

  const targetClassEligibility = classId
    ? evaluateConversionEligibilityForVisitor(db, visitor, classId, requestedStudentBranchId)
    : null;
  if (targetClassEligibility?.code === 'class_not_found') {
    throw new HttpError(404, targetClassEligibility.reason);
  }
  if (targetClassEligibility && ['class_wrong_branch', 'class_inactive'].includes(targetClassEligibility.code)) {
    throw new HttpError(400, targetClassEligibility.reason);
  }
  if (targetClassEligibility?.code === 'placement_policy_unconfigured') {
    throw new HttpError(409, targetClassEligibility.reason);
  }
  const classItem = classId ? (stmtGetClassForConvert.get(classId) as any) : null;

  const effectiveProgramVersionId = visitor.program_version_id || programVersionId || null;
  if (visitor.program_version_id && programVersionId && String(programVersionId) !== String(visitor.program_version_id)) {
    throw new HttpError(409, 'The admission program must match the visitor program.');
  }
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

  const effectiveLevelId = levelId || classItem?.level_id || null;
  const studentBranchId = requestedStudentBranchId;
  const placementRequirementMode = effectiveProgramVersionId
    ? resolvePlacementRequirement(effectiveProgramVersionId, studentBranchId, effectiveLevelId).mode
    : null;
  const registrationRule = resolveAdmissionRegistrationRule(studentBranchId, {
    programVersionId: effectiveProgramVersionId,
    levelId: effectiveLevelId,
  });
  const registrationFeeAmount = assertMoney(registrationRule.amount, 'registration fee');
  const placementInvoiceRequirement = resolvePlacementInvoiceRequirement(visitor.id);

  const studentCode = nextStudentCode();
  const qrCode = `${studentCode}-${String(visitor.full_name).toUpperCase().replace(/\s+/g, '-')}`;
  const newStudentId = id('stu');
  const date = today();
  const dueDate = invoiceDueDate(date);
  const registrationInvoiceId = registrationFeeAmount > 0 ? id('inv') : null;
  const registrationInvoiceNumber = registrationFeeAmount > 0 ? nextInvoiceNumber(studentBranchId) : null;
  const placementInvoiceId = placementInvoiceRequirement ? id('inv') : null;
  const placementInvoiceNumber = placementInvoiceRequirement ? nextInvoiceNumber(studentBranchId) : null;
  const admissionStage = placementInvoiceRequirement
    ? 'placement_fee'
    : (visitor.placement_status === 'completed' || visitor.placement_status === 'waived' ? 'placement_completed' : 'placement_booking');

  const journey = getJourneyEngine(db);
  const issuedInvoices: Array<{ id: string; invoiceNumber: string | null; chargeKind: 'registration' | 'placement'; amount: number; status: string }> = [];

  const tx = db.transaction(() => {
    stmtUpdateVisitorConverted.run(admissionStage, placementRequirementMode, visitor.id);
    stmtInsertConvertedStudent.run(
      newStudentId, studentCode, visitor.full_name, visitor.phone, visitor.email || null, qrCode, date, studentBranchId, 0, visitor.gender, visitor.placement_score, notes || 'Admitted from visitor record. Enrollment occurs after placement and payment.',
      visitor.father_name, visitor.address_region, visitor.tazkira_no, visitor.whatsapp, visitor.dob, visitor.school_or_university, visitor.emergency_contact_name, visitor.emergency_contact_phone, visitor.id
    );
    // Admission remains enrollment-free. When the operator supplied a valid
    // target class, record it here as the intended class on the registration
    // document so the UI/API contract stays truthful without creating an
    // enrollment prematurely.
    stmtInsertConvertedRegistration.run(id('reg'), newStudentId, classItem?.id ?? null, date, studentBranchId, visitor.source);

    if (registrationFeeAmount > 0 && registrationInvoiceId && registrationInvoiceNumber) {
      stmtInsertRegistrationFeeInvoice.run(
        registrationInvoiceId,
        newStudentId,
        registrationFeeAmount,
        registrationFeeAmount,
        date,
        dueDate,
        studentBranchId,
        registrationRule.name,
        registrationInvoiceNumber,
        user.fullName,
        visitor.full_name,
        studentCode,
      );
      stmtInsertInvoiceItem.run(id('invit'), registrationInvoiceId, registrationRule.name, registrationFeeAmount, registrationFeeAmount);
      issuedInvoices.push({ id: registrationInvoiceId, invoiceNumber: registrationInvoiceNumber, chargeKind: 'registration', amount: registrationFeeAmount, status: 'issued' });
      journey.appendEvent({ studentId: newStudentId, eventType: JourneyEventType.INVOICE_ISSUED, occurredAt: date, branchId: studentBranchId, actorUserId: user.userId, actorName: user.fullName, payload: { invoiceId: registrationInvoiceId, invoiceNumber: registrationInvoiceNumber, amount: registrationFeeAmount, category: 'other', label: registrationRule.name, chargeKind: 'registration' } });
    }

    if (placementInvoiceRequirement && placementInvoiceId && placementInvoiceNumber) {
      if (!placementInvoiceExists(newStudentId, placementInvoiceRequirement.attemptId)) {
        stmtInsertPlacementFeeInvoice.run(
          placementInvoiceId,
          newStudentId,
          placementInvoiceRequirement.amount,
          placementInvoiceRequirement.amount,
          date,
          dueDate,
          studentBranchId,
          `Placement assessment fee — attempt ${placementInvoiceRequirement.attemptId}`,
          placementInvoiceNumber,
          user.fullName,
          visitor.full_name,
          studentCode,
        );
        stmtInsertInvoiceItem.run(id('invit'), placementInvoiceId, 'Placement assessment fee', placementInvoiceRequirement.amount, placementInvoiceRequirement.amount);
        issuedInvoices.push({ id: placementInvoiceId, invoiceNumber: placementInvoiceNumber, chargeKind: 'placement', amount: placementInvoiceRequirement.amount, status: 'issued' });
        journey.appendEvent({ studentId: newStudentId, eventType: JourneyEventType.INVOICE_ISSUED, occurredAt: date, branchId: studentBranchId, actorUserId: user.userId, actorName: user.fullName, payload: { invoiceId: placementInvoiceId, invoiceNumber: placementInvoiceNumber, amount: placementInvoiceRequirement.amount, category: 'placement', label: 'Placement assessment fee', chargeKind: 'placement', attemptId: placementInvoiceRequirement.attemptId } });
      }
    }

    journey.appendEvent({ studentId: newStudentId, eventType: JourneyEventType.STUDENT_REGISTERED, occurredAt: date, branchId: studentBranchId, actorUserId: user.userId, actorName: user.fullName, payload: { studentCode, fromVisitorId: visitor.id, source: visitor.source, targetClassId: classItem?.id ?? null, workflow: 'admission_before_placement' } });

    // Outbox row committed atomically with the conversion (audit F-A2: this
    // is a student registration and must feed the same `student.registered`
    // automations as the manual path).
    return {
      registrationEvent: eventBus.emit(
        'student.registered', 'student', newStudentId,
        { fullName: visitor.full_name, studentCode, branchId: studentBranchId },
        { operatorId: user.userId, branchId: studentBranchId },
      ),
    };
  });
  const { registrationEvent } = tx();
  if (registrationEvent) void eventBus.dispatch(registrationEvent);

  addNotification('Student Admission Created', `Student ${visitor.full_name} admitted. Complete placement, settle invoices, then enroll from the student workspace.`, 'success', studentBranchId);
  writeAudit(req, `Converted visitor ${visitor.full_name} to student ${studentCode}`, { newValue: JSON.stringify({ studentId: newStudentId, stage: admissionStage, targetClassId: classItem?.id ?? null, invoices: issuedInvoices, workflow: 'admission_before_placement' }) });

  res.status(201).json({ studentId: newStudentId, studentCode, invoices: issuedInvoices, nextStep: placementInvoiceRequirement ? 'Settle placement and registration invoices, then enroll from the student workspace.' : 'Run placement, settle invoices, then enroll from the student workspace.' });
}));

// ============================================================================ 
// ADVANCE STAGE 
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
