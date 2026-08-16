/**
 * TOEFL House ERP — Visitors Routes (BC #2: CRM)
 * Handles lead pipeline, follow-ups, placement tests, and conversion to student.
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { assertTextLengths, TEXT_LIMITS } from '../utils/textInput.js';
import { parsePagination as parsePaginationShared } from '../utils/pagination.js';
import { authenticate, requirePermission, resolveBranchScope, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { resolvePlacementRequirement } from '../core/placement/policy-engine.js';
import { addNotification } from '../utils/notifications.js';
import { recordIncome } from '../utils/income.js';
import { getNumberSetting } from '../utils/settings.js';
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
const stmtGetProgramVersionForVisitor = db.prepare(`SELECT pv.id, pv.program_id, pv.status, p.name AS program_name, p.branch_id FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.id = ?`);
const stmtGetAllVisitors = db.prepare('SELECT * FROM visitors ORDER BY visit_date DESC LIMIT ? OFFSET ?');
const stmtGetVisitorsByBranch = db.prepare('SELECT * FROM visitors WHERE branch_id = ? ORDER BY visit_date DESC LIMIT ? OFFSET ?');
const stmtCountAllVisitors = db.prepare('SELECT COUNT(*) as c FROM visitors');
const stmtCountVisitorsByBranch = db.prepare('SELECT COUNT(*) as c FROM visitors WHERE branch_id = ?');

const stmtGetFollowupsBatch = db.prepare(
  `SELECT * FROM visitor_followups WHERE visitor_id IN (SELECT value FROM json_each(?)) ORDER BY date DESC`
);

const stmtGetMaxVisitorSerial = db.prepare("SELECT serial_no FROM visitors WHERE serial_no LIKE 'V-%' ORDER BY CAST(SUBSTR(serial_no, 3) AS INTEGER) DESC LIMIT 1");
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
visitorsRouter.get('/', requirePermission('Lead.View'), ah(async (req, res) => {
  const { branchId, isAll } = resolveBranchScope(req);
  const { limit, offset } = parsePagination(req);
  const countRow = isAll ? stmtCountAllVisitors.get() as { c: number } : stmtCountVisitorsByBranch.get(branchId) as { c: number };
  const rows = isAll ? stmtGetAllVisitors.all(limit, offset) : stmtGetVisitorsByBranch.all(branchId, limit, offset);
  res.setHeader('X-Total-Count', String(countRow.c));
  res.setHeader('X-Page-Limit', String(limit));
  res.setHeader('X-Page-Offset', String(offset));
  res.json(mapVisitors(rows as any[]));
}));

// ============================================================================ 
// §2 — PIPELINE VIEW 
// ============================================================================ 
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

  const totalLeads = stageCounts.get('lead') || 0;
  const totalRegistrations = stageCounts.get('registration') || 0;
  res.json({ stages, totalLeads, totalRegistrations, overallConversion: totalLeads > 0 ? Math.round((totalRegistrations / totalLeads) * 1000) / 10 : 0 });
}));

// ============================================================================ 
// §3 — CREATE 
// ============================================================================ 
visitorsRouter.post('/', requirePermission('Lead.Create'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { fullName, phone, email, gender, source, notes, interestedCourse, followUpStatus, nextContactDate, fatherName, addressRegion, tazkiraNo, whatsapp, dob, schoolOrUniversity, emergencyContactName, emergencyContactPhone, campaignId, stage, assignedTo, branchId, programVersionId } = req.body;
  if (!fullName || !gender || !source) throw new HttpError(400, 'Full name, gender, and source are required.');
  assertVisitorGender(gender);
  assertVisitorSource(source);
  // Bound free text (see utils/textInput.ts — S16).
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
    [interestedCourse, 'Interested course', TEXT_LIMITS.line],
    [notes, 'Notes', TEXT_LIMITS.notes],
  ]);
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
  let serialNo = 'V-1001';

  const tx = db.transaction(() => {
    const maxRow = stmtGetMaxVisitorSerial.get() as any;
    const maxNum = maxRow ? parseInt(String(maxRow.serial_no).replace('V-', ''), 10) : 1000;
    serialNo = `V-${maxNum + 1}`;
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
  if (f.programVersionId !== undefined && f.programVersionId !== null) { const pv = stmtGetProgramVersionById.get(f.programVersionId) as any; if (!pv) throw new HttpError(404, 'Selected program version not found.'); if (pv.branch_id !== existing.branch_id) throw new HttpError(400, 'Selected program belongs to another branch.'); if (pv.status !== 'published') throw new HttpError(400, 'Selected program version is not published.'); }
  if (f.assignedTo) { const assignee = db.prepare('SELECT id, branch_id, status FROM users WHERE id = ?').get(f.assignedTo) as any; if (!assignee || assignee.status === 'inactive') throw new HttpError(400, 'Assigned user is not active.'); if (assignee.branch_id !== existing.branch_id && !canAccessBranchResource(req, assignee.branch_id)) throw new HttpError(403, 'Assigned user is outside the visitor branch scope.'); }
  if (f.campaignId) { const campaign = db.prepare('SELECT id, branch_id, status FROM campaigns WHERE id = ?').get(f.campaignId) as any; if (!campaign) throw new HttpError(400, 'Campaign not found.'); if (campaign.branch_id !== existing.branch_id) throw new HttpError(400, 'Campaign does not belong to the visitor branch.'); if (campaign.status !== 'active') throw new HttpError(400, 'Campaign is not active.'); }
  if (f.programVersionId !== undefined && String(f.programVersionId || '') !== String(existing.program_version_id || '')) {
    db.transaction(() => {
      db.prepare(`UPDATE placement_assessment_attempts SET status='cancelled', updated_at=datetime('now'), notes=COALESCE(notes,'') || ? WHERE visitor_id=? AND status='in_progress'`).run(' Program changed; attempt invalidated.', existing.id);
      db.prepare(`UPDATE visitors SET placement_score=NULL, placement_method=NULL, placement_status='not_started', current_placement_attempt_id=NULL, stage=CASE WHEN stage IN ('placement_booking','placement_fee','placement_completed') THEN 'follow_up' ELSE stage END WHERE id=?`).run(existing.id);
    })();
  }
  const merge = (k: string, c: string) => (f[k] !== undefined ? f[k] : existing[c]);
  
  stmtUpdateVisitor.run(
    merge('fullName', 'full_name'), merge('phone', 'phone'), merge('email', 'email'), merge('gender', 'gender'), merge('source', 'source'), 
    merge('campaignId', 'campaign_id'), merge('stage', 'stage'), merge('assignedTo', 'assigned_to'), merge('notes', 'notes'),
    merge('interestedCourse', 'interested_course'), merge('followUpStatus', 'follow_up_status'), merge('nextContactDate', 'next_contact_date'),
    merge('fatherName', 'father_name'), merge('addressRegion', 'address_region'), merge('tazkiraNo', 'tazkira_no'), merge('whatsapp', 'whatsapp'),
    merge('dob', 'dob'), merge('schoolOrUniversity', 'school_or_university'), merge('emergencyContactName', 'emergency_contact_name'),
    merge('emergencyContactPhone', 'emergency_contact_phone'), f.programVersionId !== undefined ? f.programVersionId : existing.program_version_id, req.params.id
  );
  writeAudit(req, `Updated visitor details: ${existing.full_name}`);
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
  if (stmtGetStudentByLeadId.get(visitor.id)) throw new HttpError(409, 'A student record already exists for this visitor.');

  const { classId, amountPaid, discountPercent, notes, semesterFee, branchId, programVersionId, levelId, paymentMethod } = req.body ?? {};
  if (!classId) throw new HttpError(400, 'Class is required.');
  if (amountPaid == null || Number(amountPaid) < 0) throw new HttpError(400, 'Received fee amount is required.');

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
    // Placement policy gate (configuration-driven: required / optional /
    // not_required + first-level exemption). The visitor's target level comes
    // from the selected class's level when available.
    const requirement = resolvePlacementRequirement(effectiveProgramVersionId, requestedStudentBranchId, classItem.level_id || null);
    db.prepare(`UPDATE visitors SET placement_requirement_mode=? WHERE id=?`).run(requirement.mode, visitor.id);
    if (requirement.mode === 'required' && visitor.placement_status !== 'completed') {
      throw new HttpError(400, 'Placement assessment is required for the selected program before enrollment.');
    }
    if (requirement.mode === 'optional' && !['completed', 'exempt'].includes(visitor.placement_status)) {
      throw new HttpError(400, 'Placement is optional for this program: complete it or record an exemption before enrollment.');
    }
    if (classItem.program_version_id && String(classItem.program_version_id) !== String(effectiveProgramVersionId)) throw new HttpError(400, 'Selected class belongs to a different program version.');
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
  const grossTuition = Number(semesterFee != null ? semesterFee : classItem.fee != null ? classItem.fee : 0);
  const requestedDiscount = Math.max(0, Math.min(100, Number(discountPercent) || 0));
  const discountRule = evaluateRules({ category: 'discount', branchId: studentBranchId, data: { discountPercent: requestedDiscount, leadSource: visitor.source }, dryRun: false });
  const effectiveDiscount = Math.min(30, Number(discountRule.finalOutputs.discountPercent ?? requestedDiscount));
  const netTuition = Math.max(0, Math.round(grossTuition - (grossTuition * effectiveDiscount) / 100));
  const paidNow = Number(amountPaid);
  if (paidNow > netTuition && netTuition > 0) throw new HttpError(400, `Amount received cannot exceed payable fee: ${netTuition} AFN.`);

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
  if (!next) next = VISITOR_TRANSITIONS[current];
  if (!next) throw new HttpError(400, `Cannot auto-advance from stage "${current}".`);
  assertVisitorStage(next);
  if (next !== VISITOR_TRANSITIONS[current] && next !== 'lost') {
    throw new HttpError(400, `Invalid transition from "${current}" to "${next}".`);
  }
  const changed = stmtUpdateVisitorStage.run(next, req.params.id, current);
  if (changed.changes !== 1) throw new HttpError(409, 'Visitor stage changed concurrently; reload and retry.');
  writeAudit(req, `Visitor ${row.full_name} stage: ${current} → ${next}`);
  res.json({ ok: true, from: current, to: next });
}));

export default visitorsRouter;
