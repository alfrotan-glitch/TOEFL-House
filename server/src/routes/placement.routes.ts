/**
 * Placement Assessment Workspace
 * Program-specific assessment blueprints, candidate attempts, component results,
 * recommendation and finalization. The profile is the source of truth; an attempt
 * snapshots the profile so historical results never change when a program is edited.
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authenticate, authorize, requirePermission, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { nextReceiptNumber } from '../utils/receipt.js';
import { addNotification } from '../utils/notifications.js';
import { recordIncome } from '../utils/income.js';
import { resolveFee } from '../core/configuration/policy-resolver.js';
import { PLACEMENT_DEFAULTS } from '../core/configuration/policy-catalog.js';

export type PlacementComponentType = 'skill_scores' | 'written_test' | 'interview' | 'level_assessment' | 'custom_score';

interface PlacementComponentConfig {
  key: string;
  type: PlacementComponentType;
  label: string;
  required: boolean;
  weight: number;
  maxScore: number;
  durationMinutes?: number;
  instructions?: string | null;
  skills?: readonly ('grammar' | 'vocabulary' | 'reading' | 'listening' | 'writing' | 'speaking')[];
}

const router = Router();
router.use(authenticate);

const DEFAULT_COMPONENTS: PlacementComponentConfig[] = [...PLACEMENT_DEFAULTS.components] as PlacementComponentConfig[];

const stmtVisitor = db.prepare('SELECT * FROM visitors WHERE id = ?');
const stmtProgramVersion = db.prepare(`
  SELECT pv.*, p.name AS program_name, p.branch_id AS program_branch_id
  FROM program_versions pv
  JOIN programs p ON p.id = pv.program_id
  WHERE pv.id = ?
`);
const stmtProfile = db.prepare('SELECT * FROM placement_assessment_profiles WHERE program_version_id = ? AND branch_id = ?');
const stmtGlobalProfile = db.prepare('SELECT * FROM placement_assessment_profiles WHERE program_version_id = ? AND branch_id IS NULL ORDER BY updated_at DESC, version DESC LIMIT 1');
const stmtLevels = db.prepare('SELECT id, name, code, "order", is_active FROM levels WHERE program_version_id = ? ORDER BY "order"');
const stmtPlacementRules = db.prepare(`
  SELECT id, name, min_score, max_score, recommended_level_id, recommended_level_code, sort_order, is_active
  FROM placement_rules
  WHERE program_version_id = ? AND (branch_id = ? OR branch_id IS NULL) AND is_active = 1
  ORDER BY sort_order, min_score
`);
const stmtAttempt = db.prepare('SELECT * FROM placement_assessment_attempts WHERE id = ?');
const stmtCurrentAttempt = db.prepare(`
  SELECT * FROM placement_assessment_attempts
  WHERE visitor_id = ? AND status = 'in_progress'
  ORDER BY attempt_number DESC LIMIT 1
`);
const stmtAttempts = db.prepare(`
  SELECT id, visitor_id, program_version_id, profile_id, attempt_number, status, started_at, completed_at,
         total_score, max_score, percentage, recommended_level_id, recommendation_text, examiner_user_id, notes
  FROM placement_assessment_attempts WHERE visitor_id = ? ORDER BY attempt_number DESC
`);
const stmtResults = db.prepare(`SELECT * FROM placement_assessment_results WHERE attempt_id = ? ORDER BY rowid`);
const stmtExistingAttemptCount = db.prepare("SELECT COUNT(*) AS c FROM placement_assessment_attempts WHERE visitor_id = ? AND status = 'completed'");
const stmtLastAttemptNumber = db.prepare('SELECT COALESCE(MAX(attempt_number), 0) AS n FROM placement_assessment_attempts WHERE visitor_id = ?');
const stmtInsertAttempt = db.prepare(`
  INSERT INTO placement_assessment_attempts
  (id, visitor_id, program_version_id, profile_id, branch_id, attempt_number, status, started_at, snapshot_json, examiner_user_id, notes)
  VALUES (?, ?, ?, ?, ?, ?, 'in_progress', datetime('now'), ?, ?, ?)
`);
const stmtUpsertResult = db.prepare(`
  INSERT INTO placement_assessment_results
  (id, attempt_id, component_key, component_type, label, status, score, max_score, weight, selected_level_id, notes, result_text, payload_json, evaluator_user_id, completed_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'completed' THEN datetime('now') ELSE NULL END, datetime('now'))
  ON CONFLICT(attempt_id, component_key) DO UPDATE SET
    status=excluded.status,
    score=excluded.score,
    max_score=excluded.max_score,
    weight=excluded.weight,
    selected_level_id=excluded.selected_level_id,
    notes=excluded.notes,
    result_text=excluded.result_text,
    payload_json=excluded.payload_json,
    evaluator_user_id=excluded.evaluator_user_id,
    completed_at=CASE WHEN excluded.status='completed' THEN datetime('now') ELSE placement_assessment_results.completed_at END,
    updated_at=datetime('now')
`);
const stmtCompleteAttempt = db.prepare(`
  UPDATE placement_assessment_attempts
  SET status='completed', completed_at=datetime('now'), total_score=?, max_score=?, percentage=?, recommended_level_id=?, recommendation_text=?, examiner_user_id=?, updated_at=datetime('now')
  WHERE id=? AND status='in_progress'
`);
const stmtInsertPlacementFeePayment = db.prepare(
  `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, notes, receipt_number, branch_id, idempotency_key)
   VALUES (?, NULL, ?, ?, 'cash', 'completed', 'placement', ?, ?, ?, ?)`
);
const stmtUpdateVisitorPlacement = db.prepare(`
  UPDATE visitors
  SET placement_score=?, placement_method=?, placement_status='completed', current_placement_attempt_id=?,
      stage=CASE WHEN stage IN ('placement_booking','placement_fee') THEN 'placement_completed' ELSE stage END
  WHERE id=?
`);
const stmtVisitorCompletedCount = db.prepare(`SELECT COUNT(*) AS c FROM placement_assessment_attempts WHERE visitor_id = ? AND status='completed'`);

function parseComponents(profile: any): PlacementComponentConfig[] {
  let parsed: unknown;
  try { parsed = JSON.parse(profile.components_json || '[]'); } catch { parsed = []; }
  if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_COMPONENTS;
  const components = parsed.map((raw: any) => ({
    key: String(raw.key || '').trim(),
    type: raw.type as PlacementComponentType,
    label: String(raw.label || '').trim(),
    required: raw.required !== false,
    weight: Number(raw.weight),
    maxScore: Number(raw.maxScore),
    durationMinutes: raw.durationMinutes == null ? undefined : Number(raw.durationMinutes),
    instructions: raw.instructions == null ? null : String(raw.instructions),
    skills: Array.isArray(raw.skills) ? raw.skills.map(String) : undefined,
  }));
  const validTypes = new Set<PlacementComponentType>(['skill_scores','written_test','interview','level_assessment','custom_score']);
  const keys = new Set<string>();
  let total = 0;
  for (const c of components) {
    if (!c.key || !c.label || keys.has(c.key) || !validTypes.has(c.type)) throw new HttpError(500, 'Stored placement blueprint is invalid.');
    if (!Number.isFinite(c.weight) || c.weight < 0 || !Number.isFinite(c.maxScore) || c.maxScore <= 0) throw new HttpError(500, 'Stored placement blueprint contains invalid scoring configuration.');
    keys.add(c.key); total += c.weight;
  }
  if (Math.abs(total - 100) > 0.01) throw new HttpError(500, 'Stored placement blueprint weights must total 100%.');
  return components;
}

function getVisitorOr404(visitorId: string) {
  const visitor = stmtVisitor.get(visitorId) as any;
  if (!visitor) throw new HttpError(404, 'Visitor not found.');
  return visitor;
}

function assertVisitorBranchAccess(req: import('express').Request, visitor: any) {
  if (!visitor.branch_id || canAccessBranchResource(req, visitor.branch_id)) return;
  throw new HttpError(403, 'Visitor belongs to another branch.');
}

function mapProfile(profile: any, version: any, levels: any[], rules: any[]) {
  const components = parseComponents(profile);
  return {
    configured: true,
    enabled: Boolean(profile.enabled),
    required: Boolean(profile.required),
    method: String(profile.method || (components.length > 1 ? 'hybrid' : components[0]?.type || PLACEMENT_DEFAULTS.method)),
    programVersionId: version.id,
    programId: version.program_id,
    programName: version.program_name,
    versionLabel: version.version_label,
    components,
    levels,
    placementRules: rules,
    allowRetake: Boolean(profile.allow_retake),
    passScore: Number(profile.pass_score ?? PLACEMENT_DEFAULTS.passScore),
    maxScore: Number(profile.max_score ?? PLACEMENT_DEFAULTS.maxScore),
    instructions: profile.instructions ?? null,
    scoringModel: String(profile.scoring_model || 'weighted_average'),
    profileId: profile.id,
  };
}

function getProgramAssessment(visitor: any) {
  if (!visitor.program_version_id) throw new HttpError(400, 'Select a program before starting placement assessment.');
  const version = stmtProgramVersion.get(visitor.program_version_id) as any;
  if (!version) throw new HttpError(409, 'The visitor program version no longer exists.');
  if (version.program_branch_id !== visitor.branch_id) throw new HttpError(409, 'The visitor program belongs to another branch.');
  let profile = stmtProfile.get(visitor.program_version_id, visitor.branch_id) as any;
  if (!profile) profile = stmtGlobalProfile.get(visitor.program_version_id) as any;
  const levels = stmtLevels.all(visitor.program_version_id) as any[];
  const rules = stmtPlacementRules.all(visitor.program_version_id, visitor.branch_id) as any[];
  return { version, profile, levels, rules };
}

function normalizeScore(value: unknown, maxScore: number): number {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > maxScore) throw new HttpError(400, `Score must be between 0 and ${maxScore}.`);
  return score;
}

function componentScore(component: PlacementComponentConfig, body: any): { score: number | null; payload: any } {
  if (component.type === 'skill_scores') {
    const skills = Array.isArray(component.skills) && component.skills.length > 0 ? component.skills : ['grammar', 'vocabulary', 'reading', 'listening', 'writing', 'speaking'];
    const perSkillMax = 25;
    const normalized: Record<string, number> = {};
    for (const skill of skills) {
      if (body?.skills?.[skill] == null || body?.skills?.[skill] === '') throw new HttpError(400, `Score for ${skill} is required.`);
      normalized[skill] = normalizeScore(body.skills[skill], perSkillMax);
    }
    const score = Math.round((Object.values(normalized).reduce((a, b) => a + b, 0) / (skills.length * perSkillMax)) * component.maxScore * 100) / 100;
    return { score, payload: { skills: normalized } };
  }
  if (component.type === 'level_assessment' && (body?.score === '' || body?.score == null) && body?.selectedLevelId) {
    return { score: null, payload: { selectedLevelId: body.selectedLevelId } };
  }
  const score = normalizeScore(body?.score, component.maxScore);
  return {
    score,
    payload: {
      selectedLevelId: body?.selectedLevelId ?? null,
      answerSummary: body?.answerSummary ?? null,
      rubric: body?.rubric ?? null,
    },
  };
}

function getRequiredMissing(components: PlacementComponentConfig[], results: any[]) {
  const done = new Set(results.filter((r) => r.status === 'completed' || r.status === 'waived').map((r) => r.component_key));
  return components.filter((c) => c.required && !done.has(c.key)).map((c) => c.key);
}

router.get('/visitors/:visitorId/placement', authorize('owner', 'registrar', 'manager', 'counselor'), ah(async (req, res) => {
  const visitor = getVisitorOr404(req.params.visitorId);
  assertVisitorBranchAccess(req, visitor);
  const { profile, version, levels, rules } = getProgramAssessment(visitor);
  const attempts = stmtAttempts.all(visitor.id) as any[];
  const mappedAttempts = attempts.map((a) => ({ ...a, components: stmtResults.all(a.id) }));
  const profileView = profile ? mapProfile(profile, version, levels, rules) : { configured:false, enabled:PLACEMENT_DEFAULTS.enabled, required:PLACEMENT_DEFAULTS.required, method:null, programVersionId:visitor.program_version_id, programName:version.program_name, versionLabel:version.version_label, components:[], levels, placementRules:rules, allowRetake:PLACEMENT_DEFAULTS.allowRetake, passScore:PLACEMENT_DEFAULTS.passScore, maxScore:PLACEMENT_DEFAULTS.maxScore, instructions:null };
  res.json({ visitorId: visitor.id, programVersionId: visitor.program_version_id, profile: profileView, attempts: mappedAttempts, current: stmtCurrentAttempt.get(visitor.id) ? mapAttempt(stmtCurrentAttempt.get(visitor.id) as any) : null });
}));

function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId || !user?.branchId || !user?.fullName || !user?.role) throw new HttpError(403, 'User context missing.');
  return user;
}

function mapAttempt(attempt: any) {
  const snapshot: Record<string, unknown> = (() => {
    try { return JSON.parse(attempt.snapshot_json || '{}') as Record<string, unknown>; }
    catch { return {}; }
  })();
  return { ...attempt, snapshot, results: stmtResults.all(attempt.id) };
}

router.post('/visitors/:visitorId/placement/attempts', authorize('owner', 'registrar', 'manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const visitor = getVisitorOr404(req.params.visitorId);
  assertVisitorBranchAccess(req, visitor);
  const { profile, version, levels, rules } = getProgramAssessment(visitor);
  if (!profile || !profile.enabled) throw new HttpError(400, !profile ? 'This program has no placement assessment configured.' : 'Placement assessment is disabled for this program.');
  const current = stmtCurrentAttempt.get(visitor.id) as any;
  if (current) return res.json(mapAttempt(current));
  const completedCount = Number((stmtExistingAttemptCount.get(visitor.id) as any).c || 0);
  if (completedCount > 0 && !profile.allow_retake) throw new HttpError(409, 'This program allows only one placement attempt for this visitor.');
  const lastAttemptNumber = Number((stmtLastAttemptNumber.get(visitor.id) as any).n || 0);
  const attemptNumber = lastAttemptNumber + 1;
  const snapshot = JSON.stringify({ profile: mapProfile(profile, version, levels, rules), capturedAt: new Date().toISOString() });
  const attemptId = id('pat');
  const tx = db.transaction(() => {
    stmtInsertAttempt.run(attemptId, visitor.id, visitor.program_version_id, profile.id, visitor.branch_id, attemptNumber, snapshot, user.userId, null);
    const components = parseComponents(profile);
    for (const c of components) {
      stmtUpsertResult.run(id('par'), attemptId, c.key, c.type, c.label, 'pending', null, c.maxScore, c.weight, null, null, null, null, user.userId, 'pending');
    }
    db.prepare(`UPDATE visitors SET placement_status='in_progress', placement_method=?, current_placement_attempt_id=?, stage=CASE WHEN stage IN ('lead','inquiry','follow_up','placement_booking') THEN 'placement_booking' ELSE stage END WHERE id=?`).run(profile.method, attemptId, visitor.id);
  });
  try {
    tx();
  } catch (error: any) {
    if (String(error?.message || '').includes('UNIQUE constraint failed: placement_assessment_attempts.visitor_id, placement_assessment_attempts.attempt_number')) {
      const existingAttempt = stmtCurrentAttempt.get(visitor.id) as any;
      if (existingAttempt) return res.status(200).json(mapAttempt(existingAttempt));
    }
    throw error;
  }
  writeAudit(req, `Started placement assessment for visitor ${visitor.full_name} (${version.program_name} ${version.version_label})`);
  res.status(201).json(mapAttempt(stmtAttempt.get(attemptId)));
}));

router.put('/visitors/:visitorId/placement/attempts/:attemptId/components/:componentKey', authorize('owner', 'registrar', 'manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const visitor = getVisitorOr404(req.params.visitorId);
  assertVisitorBranchAccess(req, visitor);
  const attempt = stmtAttempt.get(req.params.attemptId) as any;
  if (!attempt || attempt.visitor_id !== visitor.id) throw new HttpError(404, 'Placement attempt not found.');
  if (attempt.status !== 'in_progress') throw new HttpError(409, 'This placement attempt is no longer editable.');
  const snapshot = JSON.parse(attempt.snapshot_json || '{}');
  const component = (snapshot.profile?.components || []).find((c: PlacementComponentConfig) => c.key === req.params.componentKey);
  if (!component) throw new HttpError(404, 'Assessment component not found.');
  const selectedLevelId = req.body?.selectedLevelId || null;
  if (selectedLevelId && !(snapshot.profile.levels || []).some((l: any) => l.id === selectedLevelId)) throw new HttpError(400, 'Selected level is not part of this program.');
  const status = req.body?.status === 'waived' ? 'waived' : 'completed';
  const result = status === 'waived'
    ? { score: null, payload: { waived: true } }
    : componentScore(component, req.body ?? {});
  if (status === 'waived') {
    const role = String(req.user?.role || '');
    if (component.required && !['owner', 'manager'].includes(role)) throw new HttpError(403, 'Only management can waive a required assessment section.');
    if (!String(req.body?.notes || '').trim()) throw new HttpError(400, 'A reason is required when waiving an assessment section.');
  }
  stmtUpsertResult.run(id('par'), attempt.id, component.key, component.type, component.label, status, status === 'waived' ? null : result.score, component.maxScore, component.weight, selectedLevelId, req.body?.notes || null, req.body?.resultText || null, JSON.stringify(result.payload), user.userId, status);
  res.json(stmtResults.all(attempt.id));
}));

router.post('/visitors/:visitorId/placement/attempts/:attemptId/complete', authorize('owner', 'registrar', 'manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const visitor = getVisitorOr404(req.params.visitorId);
  assertVisitorBranchAccess(req, visitor);
  const attempt = stmtAttempt.get(req.params.attemptId) as any;
  if (!attempt || attempt.visitor_id !== visitor.id || attempt.branch_id !== visitor.branch_id) throw new HttpError(404, 'Placement attempt not found.');
  if (attempt.status !== 'in_progress') throw new HttpError(409, 'This placement attempt is already closed.');
  const snapshot: any = (() => {
    try { return JSON.parse(attempt.snapshot_json || '{}'); }
    catch { throw new HttpError(409, 'Placement attempt snapshot is corrupted.'); }
  })();
  const components: PlacementComponentConfig[] = snapshot.profile?.components || [];
  const results: any[] = (() => {
    try { return stmtResults.all(attempt.id) as any[]; }
    catch { throw new HttpError(409, 'Placement results are unavailable because the attempt data is inconsistent.'); }
  })();
  const profile = snapshot.profile || {};
  const missing = getRequiredMissing(components, results);
  if (missing.length > 0) throw new HttpError(400, `Complete all required assessment sections first: ${missing.join(', ')}`);

  const scored = results.filter((r) => r.status === 'completed' && Number(r.weight) > 0 && r.score != null);
  const explicitLevels = [...new Set(results.filter((r) => (r.status === 'completed' || r.status === 'waived') && r.selected_level_id).map((r) => String(r.selected_level_id)))];
  if (explicitLevels.length > 1) throw new HttpError(400, 'Assessment sections contain conflicting level recommendations.');
  const explicitLevel = explicitLevels[0] || null;
  if (scored.length === 0 && !explicitLevel) throw new HttpError(400, 'At least one scored section or an explicit level assessment is required.');
  const weightTotal = scored.reduce((sum, r) => sum + Number(r.weight), 0);
  const scoringModel = String(profile.scoringModel || 'weighted_average');
  const normalizedScores = scored.map((r) => (Number(r.score) / Number(r.max_score || 100)) * 100);
  const percentage = scored.length > 0 && weightTotal > 0
    ? Math.round((scoringModel === 'average'
      ? normalizedScores.reduce((sum, value) => sum + value, 0) / normalizedScores.length
      // weighted_average: each score is normalized to 0..1, weighted, summed,
      // then expressed as a 0..100 percentage (same scale as 'average').
      : (scored.reduce((sum, r) => sum + ((Number(r.score) / Number(r.max_score || 100)) * Number(r.weight)), 0) / weightTotal) * 100) * 100) / 100
    : null;
  const totalScore = percentage == null ? null : Math.round(percentage * 100) / 100;
  const maxScore = 100;
  const rules = profile.placementRules || [];
  const match = [...rules].sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).find((r: any) => percentage != null && percentage >= Number(r.min_score) && percentage <= Number(r.max_score));
  const recommendedLevelId = match?.recommended_level_id || explicitLevel || null;
  const recommendedLevel = (profile.levels || []).find((l: any) => l.id === recommendedLevelId);
  const recommendationText = recommendedLevel
    ? `${recommendedLevel.name}${percentage != null && percentage < Number(profile.passScore ?? 60) ? ' — below the configured pass threshold' : ''}`
    : (percentage != null ? `Overall assessment ${percentage}%` : 'Level recommendation recorded');
  const resultSnapshot = JSON.stringify({ percentage, totalScore, maxScore, recommendation: { levelId: recommendedLevelId, text: recommendationText }, results });

  const firstCompleted = Number((stmtVisitorCompletedCount.get(visitor.id) as any).c || 0) === 0;
  const placementFee = firstCompleted ? Number(resolveFee(db, visitor.branch_id, 'placementTestFee') || 0) : 0;
  const date = today();

  let feeReceipt: string | null = null;
  let feePaymentId: string | null = null;
  const tx = db.transaction(() => {
    // Status-guarded update: a concurrent/duplicate completion changes zero rows
    // and is rejected instead of booking the fee twice.
    const updated = stmtCompleteAttempt.run(totalScore, maxScore, percentage, recommendedLevelId, recommendationText, user.userId, attempt.id);
    if (updated.changes !== 1) throw new HttpError(409, 'This placement attempt is already closed.');
    stmtUpdateVisitorPlacement.run(resultSnapshot, profile.method, attempt.id, visitor.id);
    if (firstCompleted && placementFee > 0) {
      // The placement fee becomes a receipted, payment-backed income entry: a
      // payments row (category 'placement', idempotency keyed to the attempt) is
      // created so the ledger income reconciles with an actual payment record.
      const paymentId = id('pay');
      const receiptNumber = nextReceiptNumber();
      stmtInsertPlacementFeePayment.run(
        paymentId, placementFee, date,
        `Placement assessment fee — ${visitor.full_name}`,
        receiptNumber, visitor.branch_id, `placement:${attempt.id}`
      );
      recordIncome({ category: 'placement', amount: placementFee, date, description: `Placement assessment fee for ${visitor.full_name}`, referenceId: attempt.id, paymentId, operatorName: user.fullName, operatorRole: user.role ?? null, branchId: visitor.branch_id });
      feeReceipt = receiptNumber;
      feePaymentId = paymentId;
    }
  });
  tx();
  if (firstCompleted && placementFee > 0) addNotification('Placement Assessment Recorded', `Placement assessment completed for ${visitor.full_name}. Fee: ${placementFee} AFN.`, 'success', visitor.branch_id);
  // Audit the completion with the full result snapshot AND the financial
  // reference (receipt + payment id) so the fee is traceable from the audit row.
  writeAudit(req, `Completed placement assessment for ${visitor.full_name}: ${percentage}% — ${recommendationText}`, {
    newValue: JSON.stringify({ ...JSON.parse(resultSnapshot), fee: { amount: firstCompleted ? placementFee : 0, receipt: feeReceipt, paymentId: feePaymentId, attemptId: attempt.id } }),
  });
  res.json({ ok: true, feeCharged: firstCompleted ? placementFee : 0, attempt: mapAttempt(stmtAttempt.get(attempt.id)) });
}));

router.post('/visitors/:visitorId/placement/attempts/:attemptId/cancel', authorize('owner', 'registrar', 'manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const visitor = getVisitorOr404(req.params.visitorId);
  assertVisitorBranchAccess(req, visitor);
  const attempt = stmtAttempt.get(req.params.attemptId) as any;
  if (!attempt || attempt.visitor_id !== visitor.id || attempt.branch_id !== visitor.branch_id) throw new HttpError(404, 'Placement attempt not found.');
  if (attempt.status !== 'in_progress') throw new HttpError(409, 'Only an in-progress placement attempt can be cancelled.');
  db.transaction(() => {
    db.prepare("UPDATE placement_assessment_attempts SET status='cancelled', updated_at=datetime('now'), notes=? WHERE id=?")
      .run(String(req.body?.reason || 'Cancelled by operator').trim().slice(0, 500), attempt.id);
    db.prepare("UPDATE visitors SET placement_status='scheduled', current_placement_attempt_id=NULL WHERE id=? AND current_placement_attempt_id=?")
      .run(visitor.id, attempt.id);
  })();
  writeAudit(req, `Cancelled placement assessment for ${visitor.full_name}`, { newValue: JSON.stringify({ attemptId: attempt.id, reason: String(req.body?.reason || 'Cancelled by operator').trim().slice(0, 500), operatorId: user.userId }) });
  res.json({ ok: true, status: 'cancelled' });
}));

router.get('/visitors/:visitorId/placement/attempts', authorize('owner', 'registrar', 'manager', 'counselor'), ah(async (req, res) => {
  const visitor = getVisitorOr404(req.params.visitorId);
  assertVisitorBranchAccess(req, visitor);
  const attempts = stmtAttempts.all(visitor.id) as any[];
  res.json(attempts.map((a) => ({ ...a, results: stmtResults.all(a.id) })));
}));

export default router;
