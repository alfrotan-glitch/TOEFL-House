/**
 * Academic Catalog API — versions, subjects, modules, rules, class generation
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, requirePermission, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { assertMoney } from '../utils/money.js';
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

const stmtInsertPlacementRule = db.prepare(
  `INSERT INTO placement_rules (id, program_version_id, name, min_score, max_score, recommended_level_id, recommended_level_code, branch_id, sort_order, is_active, version, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, datetime('now'))`
);
const stmtGetPlacementRuleById = db.prepare('SELECT * FROM placement_rules WHERE id = ?');

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
const stmtDeletePlacementRule = db.prepare('DELETE FROM placement_rules WHERE id = ?');

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

function assertFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(400, `${field} must be a finite number.`);
  }
  return value;
}

function assertOptionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be a boolean.`);
  return value;
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

catalogRouter.post('/placement-rules', requirePermission('Curriculum.PlacementPolicy'), ah(async (req, res) => {
  const b = req.body ?? {};
  if (typeof b.programVersionId !== 'string' || typeof b.name !== 'string' || !b.name.trim()) {
    throw new HttpError(400, 'programVersionId and name required.');
  }
  const version = requireVersionScope(req, b.programVersionId);
  if (b.branchId !== undefined && b.branchId !== null &&
      (typeof b.branchId !== 'string' || !b.branchId)) {
    throw new HttpError(400, 'Placement-rule branch must be a branch id.');
  }
  const branchId = b.branchId ?? version.branch_id;
  if (branchId !== version.branch_id) throw new HttpError(403, 'Placement rule branch is outside the program scope.');
  requireCatalogBranch(req, branchId);
  const minScore = b.minScore == null ? 0 : assertPercent(b.minScore, 'minimum score');
  const maxScore = b.maxScore == null ? 100 : assertPercent(b.maxScore, 'maximum score');
  if (maxScore < minScore) throw new HttpError(400, 'Placement rule score range must be within 0–100.');
  const recommendedLevelId = b.recommendedLevelId === '' ? null : b.recommendedLevelId;
  if (recommendedLevelId !== undefined && recommendedLevelId !== null && typeof recommendedLevelId !== 'string') {
    throw new HttpError(400, 'Recommended level must be a level id.');
  }
  if (recommendedLevelId) {
    const level = db.prepare(`SELECT id FROM levels WHERE id=? AND program_version_id=?`).get(recommendedLevelId, b.programVersionId);
    if (!level) throw new HttpError(400, 'Recommended level must belong to the selected program version.');
  }
  const recommendedLevelCode = assertOptionalText(b.recommendedLevelCode, 'Recommended level code');
  const sortOrder = b.sortOrder == null ? 0 : assertWholeNumber(b.sortOrder, 'Placement-rule sort order');
  const overlap = db.prepare(`SELECT 1 FROM placement_rules WHERE program_version_id=? AND (branch_id=? OR branch_id IS NULL) AND is_active=1 AND NOT (max_score < ? OR min_score > ?) LIMIT 1`).get(b.programVersionId, branchId, minScore, maxScore);
  if (overlap) throw new HttpError(409, 'Placement rule range overlaps an existing active rule.');
  const newId = id('place');
  stmtInsertPlacementRule.run(newId, b.programVersionId, b.name.trim(), minScore, maxScore, recommendedLevelId ?? null, recommendedLevelCode, branchId, sortOrder);
  writeAudit(req, `Created placement rule: ${b.name.trim()}`);
  res.status(201).json(stmtGetPlacementRuleById.get(newId));
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

catalogRouter.delete('/placement-rules/:id', requirePermission('Curriculum.PlacementPolicy'), ah(async (req, res) => {
  const rule = stmtGetPlacementRuleById.get(req.params.id) as { id: string; program_version_id: string; branch_id: string | null; name: string } | undefined;
  if (!rule) throw new HttpError(404, 'Placement rule not found.');
  requireVersionScope(req, rule.program_version_id);
  if (rule.branch_id) requireCatalogBranch(req, rule.branch_id);
  else if (!isOrganizationOwner(req)) throw new HttpError(403, 'Only an organization-scoped owner may delete a global placement rule.');
  stmtDeletePlacementRule.run(rule.id);
  writeAudit(req, `Deleted placement rule: ${rule.name}`);
  res.json({ ok: true });
}));

catalogRouter.post('/placement/recommend', requirePermission('Lead.Edit', 'Student.Edit', 'Exam.View'), ah(async (req, res) => {
  const { programVersionId, totalScore, branchId } = req.body ?? {};
  if (typeof programVersionId !== 'string' || totalScore == null) throw new HttpError(400, 'programVersionId and totalScore required.');
  const effectiveBranchId = branchId ?? req.user?.branchId;
  requireCatalogBranch(req, effectiveBranchId);
  const version = requireVersionScope(req, programVersionId);
  if (version.branch_id !== effectiveBranchId) {
    throw new HttpError(400, 'Placement branch must match the program version branch.');
  }
  const score = assertFiniteNumber(totalScore, 'totalScore');
  res.json(catalog().recommendLevel(programVersionId, score, effectiveBranchId));
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

catalogRouter.post('/fee-rules', requirePermission('FeeStructure.Edit'), ah(async () => {
  throw new HttpError(409, 'Fee rules are legacy compatibility data. Configure fees only in the Academic Catalog and branch level fee override screens.');
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
  res.json(row);
}));

/**
 * Fee fields on a branch profile are MONEY, so they are validated by the same
 * canonical authority Finance uses (`assertMoney`) rather than a second,
 * divergent validator. Configuration is the right place to reject a bad
 * amount. Unvalidated, `-100`, `0.001`, `1e20` and even the text `"abc"` reach
 * the stored columns, and `resolveFee()` could then hand them to downstream
 * money writers long after the bad configuration was accepted.
 *
 * Invalid configuration must never become authoritative money. `assertMoney`
 * enforces the canonical whole-AFN representation and rejects fractions rather
 * than rounding them into a different fee (for example, 0.001 into a free fee).
 */
const FEE_FIELDS = [
  ['placementTestFee', 'placement test fee'],
  ['registrationFee', 'registration fee'],
  ['cardFee', 'card fee'],
  ['diplomaFee', 'diploma fee'],
] as const;

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

  // Validate BEFORE any write. An omitted field means "leave unchanged" and
  // is skipped; a field that is present must be valid.
  const fees: Record<string, number | null> = {};
  for (const [key, label] of FEE_FIELDS) {
    if (b[key] === undefined || b[key] === null) { fees[key] = null; continue; }
    // assertMoney rejects a value that is not exact money, so a fee is never
    // silently substituted with one the operator did not enter.
    fees[key] = assertMoney(b[key], label);
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

  // CFG-4: the UPSERT cannot express "leave unchanged" for a NOT NULL column.
  // SQLite validates the INSERT tuple's NOT NULL constraints BEFORE the
  // ON CONFLICT clause runs, so a NULL placeholder aborts the statement even
  // when the COALESCE in DO UPDATE would have preserved the old value —
  // proven by execution. That is why the first write for a branch, and every
  // partial payload, returned HTTP 500.
  //
  // Resolving each value against the existing row in code (rather than in SQL)
  // keeps PUT's established semantics: a supplied field is written, an omitted
  // field keeps its current value, and a brand new profile falls back to the
  // column defaults.
  const existing = stmtGetBranchProfile.get(req.params.branchId) as
    | Record<string, unknown>
    | undefined;
  const keep = <T>(supplied: T | null, column: string, fallback: T): T =>
    supplied !== null ? supplied : ((existing?.[column] as T | undefined) ?? fallback);

  stmtUpsertBranchProfile.run(
    req.params.branchId,
    b.defaultProgramVersionId ?? existing?.default_program_version_id ?? null,
    keep(fees.placementTestFee, 'placement_test_fee', 0),
    keep(fees.registrationFee, 'registration_fee', 0),
    keep(fees.cardFee, 'card_fee', 0),
    keep(fees.diplomaFee, 'diploma_fee', 0),
    keep(passMark, 'default_pass_mark', 60),
    keep(minAttendance, 'default_min_attendance', 75),
    b.academicYearLabel ?? existing?.academic_year_label ?? null,
    b.notes ?? existing?.notes ?? null
  );
  writeAudit(req, `Updated branch academic profile ${req.params.branchId}`);
  res.json(stmtGetBranchProfile.get(req.params.branchId));
}));

export default catalogRouter;