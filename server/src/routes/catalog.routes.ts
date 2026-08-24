/**
 * Academic Catalog API — versions, subjects, modules, rules, class generation
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, requirePermission, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { assertMoney } from '../utils/money.js';
import { assertDateRange, assertOptionalIsoDate } from '../utils/isoDate.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';
import { getCatalogService } from '../core/academic/catalog-service.js';
import { getClassGenerationEngine } from '../core/academic/class-generation-engine.js';
import { isGlobalOwner } from '../core/rbac/rbac-service.js';

export const catalogRouter = Router();
catalogRouter.use(authenticate);

const catalog = () => getCatalogService(db);
const classGen = () => getClassGenerationEngine(db);

// ── Performance Optimization: Prepared Statements ──────────────────────────
const stmtInsertSubject = db.prepare(
  `INSERT INTO subjects (id, program_version_id, level_id, code, name, description, hours, sort_order, is_active, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`
);
const stmtGetSubjectById = db.prepare('SELECT * FROM subjects WHERE id = ?');

const stmtInsertModule = db.prepare(
  `INSERT INTO modules (id, subject_id, code, name, description, hours, sort_order, assessment_type, is_active, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`
);
const stmtGetModuleById = db.prepare('SELECT * FROM modules WHERE id = ?');

const stmtGetPromotionRulesByVersion = db.prepare(
  `SELECT pr.*, p.branch_id AS program_branch_id
     FROM promotion_rules pr
     JOIN program_versions pv ON pv.id = pr.program_version_id
     JOIN programs p ON p.id = pv.program_id
    WHERE pr.program_version_id = ? ORDER BY pr.name`
);
const stmtGetAllPromotionRules = db.prepare(
  `SELECT pr.*, p.branch_id AS program_branch_id
     FROM promotion_rules pr
     JOIN program_versions pv ON pv.id = pr.program_version_id
     JOIN programs p ON p.id = pv.program_id
    ORDER BY pr.name`
);
const stmtInsertPromotionRule = db.prepare(
  `INSERT INTO promotion_rules (id, program_version_id, from_level_id, to_level_id, name, min_score, min_attendance_pct, require_all_subjects, auto_promote, branch_id, is_active, version, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, datetime('now'))`
);
const stmtGetPromotionRuleById = db.prepare('SELECT * FROM promotion_rules WHERE id = ?');

const stmtListFeeRules = db.prepare(
  `SELECT fr.*, pv.version_label, l.name AS level_name
     FROM fee_rules fr
     LEFT JOIN program_versions pv ON pv.id = fr.program_version_id
     LEFT JOIN levels l ON l.id = fr.level_id
    WHERE fr.branch_id = ?
      AND (? IS NULL OR fr.fee_type = ?)
      AND (? IS NULL OR fr.program_version_id = ?)
      AND (? IS NULL OR fr.level_id = ?)
    ORDER BY fr.fee_type, COALESCE(fr.program_version_id, ''), COALESCE(fr.level_id, ''), fr.version DESC, fr.created_at DESC, fr.id DESC`
);
const stmtGetFeeRuleById = db.prepare(
  `SELECT fr.*, pv.version_label, l.name AS level_name
     FROM fee_rules fr
     LEFT JOIN program_versions pv ON pv.id = fr.program_version_id
     LEFT JOIN levels l ON l.id = fr.level_id
    WHERE fr.id = ?`
);
const stmtInsertFeeRule = db.prepare(
  `INSERT INTO fee_rules
     (id, program_version_id, level_id, branch_id, fee_type, name, amount, currency, is_optional, effective_from, effective_to, version, is_active, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'AFN', ?, ?, ?, ?, ?, datetime('now'))`
);
const stmtUpdateFeeRule = db.prepare(
  `UPDATE fee_rules
      SET program_version_id = ?,
          level_id = ?,
          fee_type = ?,
          name = ?,
          amount = ?,
          is_optional = ?,
          effective_from = ?,
          effective_to = ?,
          version = ?,
          is_active = ?
    WHERE id = ?`
);
const stmtGetMaxFeeRuleVersion = db.prepare(
  `SELECT MAX(version) AS v
     FROM fee_rules
    WHERE branch_id = ?
      AND fee_type = ?
      AND COALESCE(program_version_id, '') = COALESCE(?, '')
      AND COALESCE(level_id, '') = COALESCE(?, '')`
);

const stmtGetBranchProfile = db.prepare('SELECT * FROM branch_academic_profiles WHERE branch_id = ?');
// OR IGNORE so seeding a default row is idempotent: the branch-profile PUT
// seeds first so its UPSERT always resolves through the COALESCE (update)
// path, which is what gives partial payloads "leave unchanged" semantics.
const stmtInsertDefaultBranchProfile = db.prepare(
  `INSERT OR IGNORE INTO branch_academic_profiles (branch_id, updated_at) VALUES (?, datetime('now'))`
);
const stmtUpsertBranchProfile = db.prepare(
  `INSERT INTO branch_academic_profiles (
     branch_id, default_program_version_id, placement_test_fee, registration_fee, card_fee, 
     diploma_fee, default_pass_mark, default_min_attendance, academic_year_label, notes, updated_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
   ON CONFLICT(branch_id) DO UPDATE SET
     default_program_version_id = COALESCE(excluded.default_program_version_id, branch_academic_profiles.default_program_version_id),
     placement_test_fee = COALESCE(excluded.placement_test_fee, branch_academic_profiles.placement_test_fee),
     registration_fee = COALESCE(excluded.registration_fee, branch_academic_profiles.registration_fee),
     card_fee = COALESCE(excluded.card_fee, branch_academic_profiles.card_fee),
     diploma_fee = COALESCE(excluded.diploma_fee, branch_academic_profiles.diploma_fee),
     default_pass_mark = COALESCE(excluded.default_pass_mark, branch_academic_profiles.default_pass_mark),
     default_min_attendance = COALESCE(excluded.default_min_attendance, branch_academic_profiles.default_min_attendance),
     academic_year_label = COALESCE(excluded.academic_year_label, branch_academic_profiles.academic_year_label),
     notes = COALESCE(excluded.notes, branch_academic_profiles.notes),
     updated_at = datetime('now')`
);

const stmtGetProgramScope = db.prepare('SELECT id, branch_id FROM programs WHERE id = ?');
const stmtGetVersionScope = db.prepare(
  `SELECT pv.id, pv.program_id, p.branch_id
     FROM program_versions pv JOIN programs p ON p.id = pv.program_id WHERE pv.id = ?`
);
const stmtGetSubjectScope = db.prepare(
  `SELECT s.id, s.program_version_id, p.branch_id
     FROM subjects s
     JOIN program_versions pv ON pv.id = s.program_version_id
     JOIN programs p ON p.id = pv.program_id
    WHERE s.id = ?`
);
const stmtGetRunScope = db.prepare('SELECT id, branch_id FROM class_generation_runs WHERE id = ?');
const stmtGetLevelVersion = db.prepare(
  `SELECT l.id, l.program_version_id, p.branch_id
     FROM levels l JOIN programs p ON p.id = l.program_id
    WHERE l.id = ?`
);
const stmtDeletePromotionRule = db.prepare('DELETE FROM promotion_rules WHERE id = ?');
function isOrganizationOwner(req: import('express').Request): boolean {
  return !!req.rbac && isGlobalOwner(req.rbac);
}

function requireCatalogBranch(req: import('express').Request, branchId: unknown): asserts branchId is string {
  if (typeof branchId !== 'string' || !branchId) throw new HttpError(400, 'A valid branch is required.');
  const exists = db.prepare('SELECT id FROM branches WHERE id = ?').get(branchId);
  if (!exists) throw new HttpError(404, 'Branch not found.');
  if (!canAccessBranchResource(req, branchId)) throw new HttpError(403, 'Branch is outside your authorized scope.');
}

function requireProgramScope(req: import('express').Request, programId: unknown) {
  if (typeof programId !== 'string' || !programId) throw new HttpError(400, 'A valid program is required.');
  const program = stmtGetProgramScope.get(programId) as { id: string; branch_id: string } | undefined;
  if (!program) throw new HttpError(404, 'Program not found.');
  requireCatalogBranch(req, program.branch_id);
  return program;
}

function requireVersionScope(req: import('express').Request, versionId: unknown) {
  if (typeof versionId !== 'string' || !versionId) throw new HttpError(400, 'A valid program version is required.');
  const version = stmtGetVersionScope.get(versionId) as { id: string; program_id: string; branch_id: string } | undefined;
  if (!version) throw new HttpError(404, 'Program version not found.');
  requireCatalogBranch(req, version.branch_id);
  return version;
}

function requireSubjectScope(req: import('express').Request, subjectId: unknown) {
  if (typeof subjectId !== 'string' || !subjectId) throw new HttpError(400, 'A valid subject is required.');
  const subject = stmtGetSubjectScope.get(subjectId) as { id: string; program_version_id: string; branch_id: string } | undefined;
  if (!subject) throw new HttpError(404, 'Subject not found.');
  requireCatalogBranch(req, subject.branch_id);
  return subject;
}

function requireRunScope(req: import('express').Request, runId: string) {
  const run = stmtGetRunScope.get(runId) as { id: string; branch_id: string } | undefined;
  if (!run) throw new HttpError(404, 'Class-generation run not found.');
  requireCatalogBranch(req, run.branch_id);
  return run;
}

function assertLevelInVersion(levelId: unknown, versionId: string, field: string): void {
  if (levelId === undefined || levelId === null || levelId === '') return;
  if (typeof levelId !== 'string') throw new HttpError(400, `${field} must be a level id.`);
  const level = stmtGetLevelVersion.get(levelId) as { id: string; program_version_id: string | null } | undefined;
  if (!level || level.program_version_id !== versionId) {
    throw new HttpError(400, `${field} must belong to the selected program version.`);
  }
}

function assertOptionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text.`);
  return value.trim() || null;
}

function assertWholeNumber(value: unknown, field: string, minimum?: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new HttpError(400, `${field} must be a whole number.`);
  }
  if (minimum !== undefined && value < minimum) {
    throw new HttpError(400, `${field} must be at least ${minimum}.`);
  }
  return value;
}

function assertOptionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be a boolean.`);
  return value;
}

const LEGACY_PROFILE_FEE_FIELDS = new Set(['placementTestFee', 'registrationFee', 'cardFee', 'diplomaFee']);
const FEE_RULE_COMPATIBILITY_BOUNDARY = 'Fee rules are legacy compatibility data only at the storage boundary.';
const MANAGED_FEE_TYPES = ['registration', 'placement', 'card', 'diploma', 'semester', 'retake'] as const;
type ManagedFeeType = (typeof MANAGED_FEE_TYPES)[number];

function assertFeeType(value: unknown): ManagedFeeType {
  if (typeof value !== 'string' || !(MANAGED_FEE_TYPES as readonly string[]).includes(value)) {
    throw new HttpError(400, `feeType must be one of: ${MANAGED_FEE_TYPES.join(', ')}.`);
  }
  return value as ManagedFeeType;
}

function formatFeeRule(row: any) {
  return {
    id: row.id,
    branchId: row.branch_id,
    feeType: row.fee_type,
    name: row.name,
    amount: row.amount,
    currency: row.currency,
    isOptional: !!row.is_optional,
    effectiveFrom: row.effective_from ?? null,
    effectiveTo: row.effective_to ?? null,
    version: Number(row.version ?? 1),
    isActive: !!row.is_active,
    programVersionId: row.program_version_id ?? null,
    versionLabel: row.version_label ?? null,
    levelId: row.level_id ?? null,
    levelName: row.level_name ?? null,
    createdAt: row.created_at,
  };
}

function formatBranchProfile(row: any) {
  if (!row) return row;
  const clone = { ...row };
  delete clone.placement_test_fee;
  delete clone.registration_fee;
  delete clone.card_fee;
  delete clone.diploma_fee;
  return clone;
}

function assertFeeRuleScope(req: import('express').Request, branchId: string, programVersionId: string | null, levelId: string | null) {
  requireCatalogBranch(req, branchId);
  if (programVersionId) {
    const version = requireVersionScope(req, programVersionId);
    if (version.branch_id !== branchId) throw new HttpError(400, 'Fee-rule branch must match the selected program version branch.');
  }
  if (levelId) {
    const level = stmtGetLevelVersion.get(levelId) as { branch_id: string; program_version_id: string | null } | undefined;
    if (!level) throw new HttpError(404, 'Level not found.');
    if (level.branch_id !== branchId) throw new HttpError(400, 'Fee-rule branch must match the selected level branch.');
    if (programVersionId && level.program_version_id !== programVersionId) {
      throw new HttpError(400, 'Fee-rule level must belong to the selected program version.');
    }
    if (!programVersionId && level.program_version_id) {
      throw new HttpError(400, 'Select the program version before scoping a fee rule to one of its levels.');
    }
  }
}

function parseFeeRuleBody(req: import('express').Request, body: Record<string, unknown>) {
  const branchId = typeof body.branchId === 'string' && body.branchId.trim()
    ? body.branchId.trim()
    : (typeof req.query.branchId === 'string' && req.query.branchId.trim() ? req.query.branchId.trim() : req.user?.branchId ?? null);
  if (!branchId) throw new HttpError(400, 'A branch is required.');
  const feeType = assertFeeType(body.feeType);
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim()
    : `${feeType.charAt(0).toUpperCase()}${feeType.slice(1)} fee`;
  const amount = assertMoney(body.amount ?? 0, `${feeType} fee amount`);
  const isOptional = assertOptionalBoolean(body.isOptional, 'isOptional', false);
  const isActive = assertOptionalBoolean(body.isActive, 'isActive', true);
  const effectiveFrom = assertOptionalIsoDate(body.effectiveFrom, 'effectiveFrom');
  const effectiveTo = assertOptionalIsoDate(body.effectiveTo, 'effectiveTo');
  assertDateRange(effectiveFrom, effectiveTo, 'effectiveFrom', 'effectiveTo');
  const programVersionId = typeof body.programVersionId === 'string' && body.programVersionId.trim() ? body.programVersionId.trim() : null;
  const levelId = typeof body.levelId === 'string' && body.levelId.trim() ? body.levelId.trim() : null;
  assertFeeRuleScope(req, branchId, programVersionId, levelId);
  return { branchId, feeType, name, amount, isOptional, isActive, effectiveFrom, effectiveTo, programVersionId, levelId };
}

// ── Program versions ──────────────────────────────────────────────────────

catalogRouter.get('/program-versions', requirePermission('AcademicSetup.View', 'Class.View'), ah(async (req, res) => {
  const programId = typeof req.query.programId === 'string' ? req.query.programId : undefined;
  const requestedBranchId = typeof req.query.branchId === 'string' ? req.query.branchId : undefined;
  if (programId) requireProgramScope(req, programId);
  if (requestedBranchId) requireCatalogBranch(req, requestedBranchId);
  const rows = catalog().listProgramVersions(programId) as Array<Record<string, unknown> & { branch_id: string }>;
  res.json(rows.filter((row) =>
    requestedBranchId ? row.branch_id === requestedBranchId : canAccessBranchResource(req, row.branch_id)
  ));
}));

catalogRouter.get('/program-versions/:id', requirePermission('AcademicSetup.View', 'Class.View'), ah(async (req, res) => {
  requireVersionScope(req, req.params.id);
  const tree = catalog().getVersionTree(req.params.id);
  if (!tree) throw new HttpError(404, 'Program version not found.');
  res.json(tree);
}));

catalogRouter.post('/program-versions', requirePermission('Curriculum.Author'), ah(async (req, res) => {
  const { programId, versionLabel, versionNumber, durationMonths, description, copyFromVersionId } = req.body ?? {};
  if (typeof programId !== 'string' || typeof versionLabel !== 'string' || !versionLabel.trim()) {
    throw new HttpError(400, 'programId and versionLabel are required.');
  }
  requireProgramScope(req, programId);
  if (copyFromVersionId !== undefined && copyFromVersionId !== null && typeof copyFromVersionId !== 'string') {
    throw new HttpError(400, 'copyFromVersionId must be a program version id or null.');
  }
  if (description !== undefined && description !== null && typeof description !== 'string') {
    throw new HttpError(400, 'description must be text.');
  }

  const userId = req.user?.userId;
  if (!userId) throw new HttpError(403, 'User context is missing.');

  try {
    const tree = catalog().createVersion({
      programId, versionLabel, versionNumber, durationMonths, description, copyFromVersionId,
      createdBy: userId,
    });
    writeAudit(req, `Created program version: ${versionLabel}`);
    res.status(201).json(tree);
  } catch (e: any) {
    throw new HttpError(400, e.message || 'Failed to create version');
  }
}));

catalogRouter.post('/program-versions/:id/publish', requirePermission('Curriculum.Author'), ah(async (req, res) => {
  requireVersionScope(req, req.params.id);
  try {
    const tree = catalog().publishVersion(req.params.id);
    writeAudit(req, `Published program version ${req.params.id}`);
    res.json(tree);
  } catch (e: any) {
    throw new HttpError(400, e.message || 'Publish failed');
  }
}));

// ── Subjects / modules ────────────────────────────────────────────────────

catalogRouter.post('/subjects', requirePermission('Curriculum.Author'), ah(async (req, res) => {
  const { programVersionId, levelId, code, name, description, hours, sortOrder } = req.body ?? {};
  if (typeof programVersionId !== 'string' || typeof code !== 'string' || !code.trim() || typeof name !== 'string' || !name.trim()) {
    throw new HttpError(400, 'programVersionId, code, name required.');
  }
  requireVersionScope(req, programVersionId);
  const subjectLevelId = levelId === '' ? null : levelId;
  assertLevelInVersion(subjectLevelId, programVersionId, 'Subject level');
  const subjectDescription = assertOptionalText(description, 'Subject description');
  const subjectHours = hours == null ? 0 : assertWholeNumber(hours, 'Subject hours', 0);
  const subjectSortOrder = sortOrder == null ? 0 : assertWholeNumber(sortOrder, 'Subject sort order');

  const newId = id('subj');
  stmtInsertSubject.run(
    newId, programVersionId, subjectLevelId, code.trim(), name.trim(),
    subjectDescription, subjectHours, subjectSortOrder,
  );
  writeAudit(req, `Created subject ${code.trim()}`);
  res.status(201).json(stmtGetSubjectById.get(newId));
}));

catalogRouter.post('/modules', requirePermission('Curriculum.Author'), ah(async (req, res) => {
  const { subjectId, code, name, description, hours, sortOrder, assessmentType } = req.body ?? {};
  if (typeof subjectId !== 'string' || typeof code !== 'string' || !code.trim() || typeof name !== 'string' || !name.trim()) {
    throw new HttpError(400, 'subjectId, code, name required.');
  }
  requireSubjectScope(req, subjectId);
  const moduleDescription = assertOptionalText(description, 'Module description');
  const moduleHours = hours == null ? 0 : assertWholeNumber(hours, 'Module hours', 0);
  const moduleSortOrder = sortOrder == null ? 0 : assertWholeNumber(sortOrder, 'Module sort order');
  const moduleAssessmentType = assessmentType == null
    ? 'continuous'
    : assertOptionalText(assessmentType, 'Module assessment type');
  if (!moduleAssessmentType) throw new HttpError(400, 'Module assessment type cannot be empty.');

  const newId = id('mod');
  stmtInsertModule.run(
    newId, subjectId, code.trim(), name.trim(), moduleDescription,
    moduleHours, moduleSortOrder, moduleAssessmentType,
  );
  writeAudit(req, `Created module ${code.trim()}`);
  res.status(201).json(stmtGetModuleById.get(newId));
}));

// ── Promotion / placement / fee rules ─────────────────────────────────────

catalogRouter.get('/promotion-rules', requirePermission('AcademicSetup.View', 'Exam.View'), ah(async (req, res) => {
  const versionId = typeof req.query.programVersionId === 'string' ? req.query.programVersionId : undefined;
  if (versionId) requireVersionScope(req, versionId);
  const rows = (versionId
    ? stmtGetPromotionRulesByVersion.all(versionId)
    : stmtGetAllPromotionRules.all()) as Array<{ branch_id: string | null; program_branch_id: string }>;
  res.json(rows.filter((row) =>
    canAccessBranchResource(req, row.program_branch_id) &&
    (!row.branch_id || canAccessBranchResource(req, row.branch_id))
  ));
}));

catalogRouter.post('/promotion-rules', requirePermission('Promotion.Approve'), ah(async (req, res) => {
  const b = req.body ?? {};
  if (typeof b.programVersionId !== 'string' || typeof b.name !== 'string' || !b.name.trim()) {
    throw new HttpError(400, 'programVersionId and name required.');
  }
  const version = requireVersionScope(req, b.programVersionId);
  const fromLevelId = b.fromLevelId === '' ? null : b.fromLevelId;
  const toLevelId = b.toLevelId === '' ? null : b.toLevelId;
  assertLevelInVersion(fromLevelId, b.programVersionId, 'Promotion source level');
  assertLevelInVersion(toLevelId, b.programVersionId, 'Promotion destination level');
  if (b.branchId !== undefined && b.branchId !== null &&
      (typeof b.branchId !== 'string' || !b.branchId)) {
    throw new HttpError(400, 'Promotion-rule branch must be a branch id.');
  }
  // Promotion rules are children of a program version. An omitted branch
  // inherits that version's branch, never users.branch_id, and a caller who is
  // authorized for two branches still cannot combine the two ownership graphs.
  const ruleBranchId = b.branchId || version.branch_id;
  requireCatalogBranch(req, ruleBranchId);
  if (ruleBranchId !== version.branch_id) {
    throw new HttpError(400, 'Promotion-rule branch must match the program version branch.');
  }

  // ACFG-1: these two are Layer 1 of the promotion authority — they OUTRANK
  // levels.pass_mark and the branch profile in
  // promotion-engine.resolvePromotionCriteria, and feed
  // `scoreOk = finalPercentage >= minScore`, whose outcome writes
  // student_semesters.status and drives enrollment transitions. Written raw,
  // they accepted -1, 101, 1e9 and 'abc' into columns with no CHECK. Bounded
  // with the same 0..100 discipline the branch profile (Layer 3) already used.
  // Omitted still means the documented default (60 / 75).
  const ruleMinScore = b.minScore == null ? 60 : assertPercent(b.minScore, 'minimum score');
  const ruleMinAttendance = b.minAttendancePct == null ? 75 : assertPercent(b.minAttendancePct, 'minimum attendance percentage');
  const requireAllSubjects = assertOptionalBoolean(b.requireAllSubjects, 'requireAllSubjects', true);
  const autoPromote = assertOptionalBoolean(b.autoPromote, 'autoPromote', false);

  const newId = id('promo');
  stmtInsertPromotionRule.run(
    newId, b.programVersionId, fromLevelId, toLevelId, b.name.trim(),
    ruleMinScore, ruleMinAttendance, requireAllSubjects ? 1 : 0,
    autoPromote ? 1 : 0, ruleBranchId
  );
  writeAudit(req, `Created promotion rule: ${b.name.trim()}`);
  res.status(201).json(stmtGetPromotionRuleById.get(newId));
}));




catalogRouter.delete('/promotion-rules/:id', requirePermission('Promotion.Approve'), ah(async (req, res) => {
  const rule = stmtGetPromotionRuleById.get(req.params.id) as { id: string; program_version_id: string; branch_id: string | null; name: string } | undefined;
  if (!rule) throw new HttpError(404, 'Promotion rule not found.');
  requireVersionScope(req, rule.program_version_id);
  if (rule.branch_id) requireCatalogBranch(req, rule.branch_id);
  else if (!isOrganizationOwner(req)) throw new HttpError(403, 'Only an organization-scoped owner may delete a global promotion rule.');
  stmtDeletePromotionRule.run(rule.id);
  writeAudit(req, `Deleted promotion rule: ${rule.name}`);
  res.json({ ok: true });
}));




catalogRouter.post('/promotion/evaluate', requirePermission('Promotion.Approve', 'Exam.View'), ah(async (req, res) => {
  const { programVersionId, fromLevelId, score, attendancePct, branchId } = req.body ?? {};
  if (typeof programVersionId !== 'string' || typeof fromLevelId !== 'string' || score == null || attendancePct == null) {
    throw new HttpError(400, 'programVersionId, fromLevelId, score, attendancePct required.');
  }
  const effectiveBranchId = branchId ?? req.user?.branchId;
  requireCatalogBranch(req, effectiveBranchId);
  const version = requireVersionScope(req, programVersionId);
  if (version.branch_id !== effectiveBranchId) {
    throw new HttpError(400, 'Promotion branch must match the program version branch.');
  }
  assertLevelInVersion(fromLevelId, programVersionId, 'Promotion source level');
  const normalizedScore = assertPercent(score, 'score');
  const normalizedAttendance = assertPercent(attendancePct, 'attendancePct');
  res.json(catalog().evaluatePromotion({
    programVersionId, fromLevelId, score: normalizedScore, attendancePct: normalizedAttendance,
    branchId: effectiveBranchId,
  }));
}));

catalogRouter.get('/fee-rules', requirePermission('AcademicSetup.View', 'FeeStructure.Edit'), ah(async (req, res) => {
  const branchId = typeof req.query.branchId === 'string' && req.query.branchId.trim()
    ? req.query.branchId.trim()
    : req.user?.branchId;
  if (!branchId) throw new HttpError(400, 'A branch is required.');
  requireCatalogBranch(req, branchId);
  const feeType = req.query.feeType == null ? null : assertFeeType(req.query.feeType);
  const programVersionId = typeof req.query.programVersionId === 'string' && req.query.programVersionId.trim()
    ? req.query.programVersionId.trim()
    : null;
  const levelId = typeof req.query.levelId === 'string' && req.query.levelId.trim()
    ? req.query.levelId.trim()
    : null;
  if (programVersionId) {
    const version = requireVersionScope(req, programVersionId);
    if (version.branch_id !== branchId) throw new HttpError(400, 'Fee-rule branch must match the selected program version branch.');
  }
  if (levelId) {
    const level = stmtGetLevelVersion.get(levelId) as { branch_id: string; program_version_id: string | null } | undefined;
    if (!level) throw new HttpError(404, 'Level not found.');
    if (level.branch_id !== branchId) throw new HttpError(400, 'Fee-rule branch must match the selected level branch.');
    if (programVersionId && level.program_version_id !== programVersionId) {
      throw new HttpError(400, 'Fee-rule level must belong to the selected program version.');
    }
  }
  const rows = stmtListFeeRules.all(branchId, feeType, feeType, programVersionId, programVersionId, levelId, levelId) as any[];
  const visibleRows = rows.filter((row) => (MANAGED_FEE_TYPES as readonly string[]).includes(row.fee_type));
  res.json(visibleRows.map(formatFeeRule));
}));

catalogRouter.post('/fee-rules', requirePermission('FeeStructure.Edit'), ah(async (req, res) => {
  const parsed = parseFeeRuleBody(req, (req.body ?? {}) as Record<string, unknown>);
  const nextVersion = ((stmtGetMaxFeeRuleVersion.get(
    parsed.branchId,
    parsed.feeType,
    parsed.programVersionId,
    parsed.levelId,
  ) as { v: number | null } | undefined)?.v ?? 0) + 1;
  const newId = id('fee');
  stmtInsertFeeRule.run(
    newId,
    parsed.programVersionId,
    parsed.levelId,
    parsed.branchId,
    parsed.feeType,
    parsed.name,
    parsed.amount,
    parsed.isOptional ? 1 : 0,
    parsed.effectiveFrom,
    parsed.effectiveTo,
    nextVersion,
    parsed.isActive ? 1 : 0,
  );
  const created = stmtGetFeeRuleById.get(newId) as any;
  writeAudit(req, `Created fee rule: ${parsed.name}`, { newValue: JSON.stringify(formatFeeRule(created)) });
  res.status(201).json(formatFeeRule(created));
}));

catalogRouter.put('/fee-rules/:id', requirePermission('FeeStructure.Edit'), ah(async (req, res) => {
  const existing = stmtGetFeeRuleById.get(req.params.id) as any;
  if (!existing) throw new HttpError(404, 'Fee rule not found.');
  requireCatalogBranch(req, existing.branch_id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const parsed = parseFeeRuleBody(req, {
    ...body,
    branchId: existing.branch_id,
    feeType: body.feeType ?? existing.fee_type,
    name: body.name ?? existing.name,
    amount: body.amount ?? existing.amount,
    isOptional: body.isOptional ?? !!existing.is_optional,
    isActive: body.isActive ?? !!existing.is_active,
    effectiveFrom: body.effectiveFrom ?? existing.effective_from,
    effectiveTo: body.effectiveTo ?? existing.effective_to,
    programVersionId: body.programVersionId ?? existing.program_version_id,
    levelId: body.levelId ?? existing.level_id,
  });
  const before = formatFeeRule(existing);
  const sameScope =
    parsed.branchId === existing.branch_id &&
    parsed.feeType === existing.fee_type &&
    (parsed.programVersionId ?? null) === (existing.program_version_id ?? null) &&
    (parsed.levelId ?? null) === (existing.level_id ?? null);
  const nextVersion = sameScope
    ? Number(existing.version ?? 1) + 1
    : ((stmtGetMaxFeeRuleVersion.get(
        parsed.branchId,
        parsed.feeType,
        parsed.programVersionId,
        parsed.levelId,
      ) as { v: number | null } | undefined)?.v ?? 0) + 1;
  stmtUpdateFeeRule.run(
    parsed.programVersionId,
    parsed.levelId,
    parsed.feeType,
    parsed.name,
    parsed.amount,
    parsed.isOptional ? 1 : 0,
    parsed.effectiveFrom,
    parsed.effectiveTo,
    nextVersion,
    parsed.isActive ? 1 : 0,
    req.params.id,
  );
  const updated = stmtGetFeeRuleById.get(req.params.id) as any;
  writeAudit(req, `Updated fee rule: ${updated.name}`, {
    oldValue: JSON.stringify(before),
    newValue: JSON.stringify(formatFeeRule(updated)),
  });
  res.json(formatFeeRule(updated));
}));

catalogRouter.post('/fees/snapshot', requirePermission('Payment.View', 'Invoice.Create', 'Student.Create'), ah(async (req, res) => {
  const { programVersionId, levelId, branchId, enrollmentType } = req.body ?? {};
  const effectiveBranchId = branchId ?? req.user?.branchId;
  requireCatalogBranch(req, effectiveBranchId);
  if (programVersionId !== undefined && programVersionId !== null && typeof programVersionId !== 'string') {
    throw new HttpError(400, 'programVersionId must be a program version id.');
  }
  if (programVersionId) {
    const version = requireVersionScope(req, programVersionId);
    if (version.branch_id !== effectiveBranchId) {
      throw new HttpError(400, 'Fee-snapshot branch must match the program version branch.');
    }
  }
  if (levelId !== undefined && levelId !== null) {
    if (typeof levelId !== 'string') throw new HttpError(400, 'levelId must be a level id.');
    if (programVersionId) {
      assertLevelInVersion(levelId, programVersionId, 'Fee snapshot level');
    } else {
      const level = stmtGetLevelVersion.get(levelId) as { branch_id: string } | undefined;
      if (!level) throw new HttpError(404, 'Level not found.');
      requireCatalogBranch(req, level.branch_id);
      if (level.branch_id !== effectiveBranchId) {
        throw new HttpError(400, 'Fee-snapshot branch must match the level branch.');
      }
    }
  }
  res.json(catalog().buildFeeSnapshot({
    programVersionId, levelId,
    branchId: effectiveBranchId,
    enrollmentType,
  }));
}));

// ── Class generation ──────────────────────────────────────────────────────

catalogRouter.post('/class-generation/preview', requirePermission('Class.Create', 'Curriculum.Author'), ah(async (req, res) => {
  const b = req.body ?? {};
  if (!b.branchId || (!b.programVersionId && !b.offeringId)) throw new HttpError(400, 'branchId and either offeringId or programVersionId are required.');
  requireCatalogBranch(req, b.branchId);
  try {
    res.json(classGen().preview(b));
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Class-generation preview failed.');
  }
}));

catalogRouter.post('/class-generation/drafts', requirePermission('Class.Create', 'Curriculum.Author'), ah(async (req, res) => {
  const b = req.body ?? {};
  if (!b.branchId || (!b.programVersionId && !b.offeringId)) throw new HttpError(400, 'branchId and either offeringId or programVersionId are required.');
  requireCatalogBranch(req, b.branchId);
  const userId = req.user?.userId;
  if (!userId) throw new HttpError(403, 'User context is missing.');

  try {
    const run = classGen().createDraft({ ...b, createdBy: userId });
    writeAudit(req, 'Created class generation draft');
    res.status(201).json(run);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Class-generation draft failed.');
  }
}));

catalogRouter.post('/class-generation/:runId/publish', requirePermission('Class.Create', 'Curriculum.Author'), ah(async (req, res) => {
  requireRunScope(req, req.params.runId);
  const userId = req.user?.userId;
  if (!userId) throw new HttpError(403, 'User context is missing.');
  
  try {
    const result = classGen().publish(req.params.runId, userId);
    writeAudit(req, `Published class generation ${req.params.runId}`, {
      newValue: `${result.createdClassIds.length} classes`,
    });
    res.json(result);
  } catch (e: any) {
    throw new HttpError(400, e.message || 'Publish failed');
  }
}));

catalogRouter.get('/class-generation/:runId', requirePermission('Class.View'), ah(async (req, res) => {
  requireRunScope(req, req.params.runId);
  res.json(classGen().getRun(req.params.runId));
}));

// ── Branch academic profile ───────────────────────────────────────────────

catalogRouter.get('/branch-profile/:branchId', requirePermission('AcademicSetup.View', 'Settings.View'), ah(async (req, res) => {
  requireCatalogBranch(req, req.params.branchId);
  let row = stmtGetBranchProfile.get(req.params.branchId);
  if (!row) {
    stmtInsertDefaultBranchProfile.run(req.params.branchId);
    row = stmtGetBranchProfile.get(req.params.branchId);
  }
  res.json(formatBranchProfile(row));
}));

/** Percentage-style profile fields: finite, 0..100, not money. */
function assertPercent(value: unknown, field: string): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new HttpError(400, `${field} must be a finite number.`);
  if (n < 0 || n > 100) throw new HttpError(400, `${field} must be between 0 and 100.`);
  return n;
}

catalogRouter.put('/branch-profile/:branchId', requirePermission('FeeStructure.Edit', 'Settings.Edit'), ah(async (req, res) => {
  requireCatalogBranch(req, req.params.branchId);
  const b = (req.body ?? {}) as Record<string, unknown>;
  for (const key of LEGACY_PROFILE_FEE_FIELDS) {
    if (b[key] !== undefined) {
      throw new HttpError(400, `${FEE_RULE_COMPATIBILITY_BOUNDARY} Fixed fees are configured through the canonical fee-rule registry, not through the branch profile.`);
    }
  }
  const passMark = b.defaultPassMark === undefined || b.defaultPassMark === null
    ? null : assertPercent(b.defaultPassMark, 'default pass mark');
  const minAttendance = b.defaultMinAttendance === undefined || b.defaultMinAttendance === null
    ? null : assertPercent(b.defaultMinAttendance, 'default minimum attendance');
  if (b.academicYearLabel !== undefined && b.academicYearLabel !== null && typeof b.academicYearLabel !== 'string') {
    throw new HttpError(400, 'Academic year label must be text.');
  }
  if (b.notes !== undefined && b.notes !== null && typeof b.notes !== 'string') {
    throw new HttpError(400, 'Branch profile notes must be text.');
  }
  if (b.defaultProgramVersionId !== undefined && b.defaultProgramVersionId !== null) {
    const version = typeof b.defaultProgramVersionId === 'string'
      ? stmtGetVersionScope.get(b.defaultProgramVersionId) as { branch_id: string } | undefined
      : undefined;
    if (!version) throw new HttpError(400, 'Default program version does not exist.');
    if (version.branch_id !== req.params.branchId) {
      throw new HttpError(400, 'Default program version must belong to the profile branch.');
    }
  }

  const existing = stmtGetBranchProfile.get(req.params.branchId) as
    | Record<string, unknown>
    | undefined;
  const keep = <T>(supplied: T | null, column: string, fallback: T): T =>
    supplied !== null ? supplied : ((existing?.[column] as T | undefined) ?? fallback);

  stmtUpsertBranchProfile.run(
    req.params.branchId,
    b.defaultProgramVersionId ?? existing?.default_program_version_id ?? null,
    keep(null, 'placement_test_fee', 0),
    keep(null, 'registration_fee', 0),
    keep(null, 'card_fee', 0),
    keep(null, 'diploma_fee', 0),
    keep(passMark, 'default_pass_mark', 60),
    keep(minAttendance, 'default_min_attendance', 75),
    b.academicYearLabel ?? existing?.academic_year_label ?? null,
    b.notes ?? existing?.notes ?? null
  );
  writeAudit(req, `Updated branch academic profile ${req.params.branchId}`);
  res.json(formatBranchProfile(stmtGetBranchProfile.get(req.params.branchId)));
}));

export default catalogRouter;