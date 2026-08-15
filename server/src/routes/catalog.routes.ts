/**
 * Academic Catalog API — versions, subjects, modules, rules, class generation
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, requirePermission, authorize, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';
import { getCatalogService } from '../core/academic/catalog-service.js';
import { getClassGenerationEngine } from '../core/academic/class-generation-engine.js';

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

const stmtGetPromotionRulesByVersion = db.prepare('SELECT * FROM promotion_rules WHERE program_version_id = ? ORDER BY name');
const stmtGetAllPromotionRules = db.prepare('SELECT * FROM promotion_rules ORDER BY name');
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

const stmtInsertFeeRule = db.prepare(
  `INSERT INTO fee_rules (id, program_version_id, level_id, branch_id, fee_type, name, amount, currency, is_optional, effective_from, effective_to, version, is_active, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, datetime('now'))`
);
const stmtGetFeeRuleById = db.prepare('SELECT * FROM fee_rules WHERE id = ?');

const stmtGetBranchProfile = db.prepare('SELECT * FROM branch_academic_profiles WHERE branch_id = ?');
const stmtInsertDefaultBranchProfile = db.prepare(
  `INSERT INTO branch_academic_profiles (branch_id, updated_at) VALUES (?, datetime('now'))`
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

// ── Program versions ──────────────────────────────────────────────────────

catalogRouter.get('/program-versions', requirePermission('AcademicSetup.View', 'Class.View'), ah(async (req, res) => {
  const programId = typeof req.query.programId === 'string' ? req.query.programId : undefined;
  res.json(catalog().listProgramVersions(programId));
}));

catalogRouter.get('/program-versions/:id', requirePermission('AcademicSetup.View', 'Class.View'), ah(async (req, res) => {
  const tree = catalog().getVersionTree(req.params.id);
  if (!tree) throw new HttpError(404, 'Program version not found.');
  res.json(tree);
}));

catalogRouter.post('/program-versions', requirePermission('AcademicSetup.Edit'), ah(async (req, res) => {
  const { programId, versionLabel, versionNumber, durationMonths, description, copyFromVersionId } = req.body ?? {};
  if (!programId || !versionLabel) throw new HttpError(400, 'programId and versionLabel are required.');
  
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

catalogRouter.post('/program-versions/:id/publish', requirePermission('AcademicSetup.Edit'), ah(async (req, res) => {
  try {
    const tree = catalog().publishVersion(req.params.id);
    writeAudit(req, `Published program version ${req.params.id}`);
    res.json(tree);
  } catch (e: any) {
    throw new HttpError(400, e.message || 'Publish failed');
  }
}));

// ── Subjects / modules ────────────────────────────────────────────────────

catalogRouter.post('/subjects', requirePermission('AcademicSetup.Edit'), ah(async (req, res) => {
  const { programVersionId, levelId, code, name, description, hours, sortOrder } = req.body ?? {};
  if (!programVersionId || !code || !name) throw new HttpError(400, 'programVersionId, code, name required.');
  
  const newId = id('subj');
  stmtInsertSubject.run(newId, programVersionId, levelId ?? null, code, name, description ?? null, hours ?? 0, sortOrder ?? 0);
  writeAudit(req, `Created subject ${code}`);
  res.status(201).json(stmtGetSubjectById.get(newId));
}));

catalogRouter.post('/modules', requirePermission('AcademicSetup.Edit'), ah(async (req, res) => {
  const { subjectId, code, name, description, hours, sortOrder, assessmentType } = req.body ?? {};
  if (!subjectId || !code || !name) throw new HttpError(400, 'subjectId, code, name required.');
  
  const newId = id('mod');
  stmtInsertModule.run(newId, subjectId, code, name, description ?? null, hours ?? 0, sortOrder ?? 0, assessmentType ?? 'continuous');
  writeAudit(req, `Created module ${code}`);
  res.status(201).json(stmtGetModuleById.get(newId));
}));

// ── Promotion / placement / fee rules ─────────────────────────────────────

catalogRouter.get('/promotion-rules', requirePermission('AcademicSetup.View', 'Exam.View'), ah(async (req, res) => {
  const versionId = req.query.programVersionId as string | undefined;
  const rows = versionId 
    ? stmtGetPromotionRulesByVersion.all(versionId) 
    : stmtGetAllPromotionRules.all();
  res.json(rows);
}));

catalogRouter.post('/promotion-rules', requirePermission('AcademicSetup.Edit', 'Promotion.Approve'), ah(async (req, res) => {
  const b = req.body ?? {};
  if (!b.programVersionId || !b.name) throw new HttpError(400, 'programVersionId and name required.');
  
  const newId = id('promo');
  stmtInsertPromotionRule.run(
    newId, b.programVersionId, b.fromLevelId ?? null, b.toLevelId ?? null, b.name, 
    b.minScore ?? 60, b.minAttendancePct ?? 75, b.requireAllSubjects !== false ? 1 : 0, 
    b.autoPromote ? 1 : 0, b.branchId ?? null
  );
  writeAudit(req, `Created promotion rule: ${b.name}`);
  res.status(201).json(stmtGetPromotionRuleById.get(newId));
}));

catalogRouter.post('/placement-rules', requirePermission('AcademicSetup.Edit'), ah(async (req, res) => {
  const b = req.body ?? {};
  if (!b.programVersionId || !b.name) throw new HttpError(400, 'programVersionId and name required.');
  const version = db.prepare(`SELECT pv.id, p.branch_id FROM program_versions pv JOIN programs p ON p.id=pv.program_id WHERE pv.id=?`).get(b.programVersionId) as any;
  if (!version) throw new HttpError(404, 'Program version not found.');
  const branchId = b.branchId ?? version.branch_id;
  if (branchId !== version.branch_id || !canAccessBranchResource(req, branchId)) throw new HttpError(403, 'Placement rule branch is outside the program scope.');
  const minScore = Number(b.minScore ?? 0);
  const maxScore = Number(b.maxScore ?? 100);
  if (!Number.isFinite(minScore) || !Number.isFinite(maxScore) || minScore < 0 || maxScore < minScore || maxScore > 100) throw new HttpError(400, 'Placement rule score range must be within 0–100.');
  if (b.recommendedLevelId) {
    const level = db.prepare(`SELECT id FROM levels WHERE id=? AND program_version_id=?`).get(b.recommendedLevelId, b.programVersionId);
    if (!level) throw new HttpError(400, 'Recommended level must belong to the selected program version.');
  }
  const overlap = db.prepare(`SELECT 1 FROM placement_rules WHERE program_version_id=? AND (branch_id=? OR branch_id IS NULL) AND is_active=1 AND NOT (max_score < ? OR min_score > ?) LIMIT 1`).get(b.programVersionId, branchId, minScore, maxScore);
  if (overlap) throw new HttpError(409, 'Placement rule range overlaps an existing active rule.');
  const newId = id('place');
  stmtInsertPlacementRule.run(newId, b.programVersionId, b.name, minScore, maxScore, b.recommendedLevelId ?? null, b.recommendedLevelCode ?? null, branchId, b.sortOrder ?? 0);
  writeAudit(req, `Created placement rule: ${b.name}`);
  res.status(201).json(stmtGetPlacementRuleById.get(newId));
}));

catalogRouter.post('/placement/recommend', requirePermission('Lead.Edit', 'Student.Edit', 'Exam.View'), ah(async (req, res) => {
  if (req.body?.branchId && !canAccessBranchResource(req, String(req.body.branchId))) throw new HttpError(403, 'Branch is outside your authorized scope.');
  const { programVersionId, totalScore, branchId } = req.body ?? {};
  if (!programVersionId || totalScore == null) throw new HttpError(400, 'programVersionId and totalScore required.');
  
  const userBranchId = req.user?.branchId;
  res.json(catalog().recommendLevel(programVersionId, Number(totalScore), branchId ?? userBranchId));
}));

catalogRouter.post('/promotion/evaluate', requirePermission('Promotion.Approve', 'Exam.View'), ah(async (req, res) => {
  if (req.body?.branchId && !canAccessBranchResource(req, String(req.body.branchId))) throw new HttpError(403, 'Branch is outside your authorized scope.');
  const { programVersionId, fromLevelId, score, attendancePct, branchId } = req.body ?? {};
  if (!programVersionId || !fromLevelId || score == null || attendancePct == null) {
    throw new HttpError(400, 'programVersionId, fromLevelId, score, attendancePct required.');
  }
  const userBranchId = req.user?.branchId;
  res.json(catalog().evaluatePromotion({
    programVersionId, fromLevelId, score: Number(score), attendancePct: Number(attendancePct),
    branchId: branchId ?? userBranchId,
  }));
}));

catalogRouter.post('/fee-rules', requirePermission('AcademicSetup.Edit', 'FeeStructure.Edit'), ah(async () => {
  throw new HttpError(409, 'Fee rules are legacy compatibility data. Configure fees only in the Academic Catalog and branch level fee override screens.');
}));

catalogRouter.post('/fees/snapshot', requirePermission('Payment.View', 'Invoice.Create', 'Student.Create'), ah(async (req, res) => {
  const { programVersionId, levelId, branchId, enrollmentType } = req.body ?? {};
  const userBranchId = req.user?.branchId;
  
  if (!branchId && !userBranchId) throw new HttpError(400, 'branchId required.');
  res.json(catalog().buildFeeSnapshot({
    programVersionId, levelId,
    branchId: branchId || userBranchId,
    enrollmentType,
  }));
}));

// ── Class generation ──────────────────────────────────────────────────────

catalogRouter.post('/class-generation/preview', requirePermission('Class.Create', 'AcademicSetup.Edit'), ah(async (req, res) => {
  if (req.body?.branchId && !canAccessBranchResource(req, String(req.body.branchId))) throw new HttpError(403, 'Branch is outside your authorized scope.');
  const b = req.body ?? {};
  if (!b.branchId || (!b.programVersionId && !b.offeringId)) throw new HttpError(400, 'branchId and either offeringId or programVersionId are required.');
  res.json(classGen().preview(b));
}));

catalogRouter.post('/class-generation/drafts', requirePermission('Class.Create', 'AcademicSetup.Edit'), ah(async (req, res) => {
  if (req.body?.branchId && !canAccessBranchResource(req, String(req.body.branchId))) throw new HttpError(403, 'Branch is outside your authorized scope.');
  const b = req.body ?? {};
  if (!b.branchId || (!b.programVersionId && !b.offeringId)) throw new HttpError(400, 'branchId and either offeringId or programVersionId are required.');
  const userId = req.user?.userId;
  if (!userId) throw new HttpError(403, 'User context is missing.');
  
  const run = classGen().createDraft({ ...b, createdBy: userId });
  writeAudit(req, 'Created class generation draft');
  res.status(201).json(run);
}));

catalogRouter.post('/class-generation/:runId/publish', requirePermission('Class.Create', 'AcademicSetup.Edit'), ah(async (req, res) => {
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
  res.json(classGen().getRun(req.params.runId));
}));

// ── Branch academic profile ───────────────────────────────────────────────

catalogRouter.get('/branch-profile/:branchId', requirePermission('AcademicSetup.View', 'Settings.View'), ah(async (req, res) => {
  if (!canAccessBranchResource(req, req.params.branchId)) throw new HttpError(403, 'Branch is outside your authorized scope.');
  let row = stmtGetBranchProfile.get(req.params.branchId);
  if (!row) {
    stmtInsertDefaultBranchProfile.run(req.params.branchId);
    row = stmtGetBranchProfile.get(req.params.branchId);
  }
  res.json(row);
}));

catalogRouter.put('/branch-profile/:branchId', requirePermission('AcademicSetup.Edit', 'Settings.Edit'), ah(async (req, res) => {
  if (!canAccessBranchResource(req, req.params.branchId)) throw new HttpError(403, 'Branch is outside your authorized scope.');
  const b = req.body ?? {};
  // Use atomic UPSERT to eliminate race conditions and extra queries
  stmtUpsertBranchProfile.run(
    req.params.branchId,
    b.defaultProgramVersionId ?? null, 
    b.placementTestFee ?? null, 
    b.registrationFee ?? null,
    b.cardFee ?? null, 
    b.diplomaFee ?? null, 
    b.defaultPassMark ?? null, 
    b.defaultMinAttendance ?? null,
    b.academicYearLabel ?? null, 
    b.notes ?? null
  );
  writeAudit(req, `Updated branch academic profile ${req.params.branchId}`);
  res.json(stmtGetBranchProfile.get(req.params.branchId));
}));

export default catalogRouter;