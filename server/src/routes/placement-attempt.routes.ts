/**
 * Placement Attempt Router — canonical Placement Test V1 lifecycle.
 */
import { Router } from 'express';
import { db } from '../db/connection.js';
import { authorize, requirePermission, resolveBranchScope } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { hasAnyRole } from '../core/rbac/rbac-service.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';
import { addNotification } from '../utils/notifications.js';
import { resolveFee } from '../core/configuration/policy-resolver.js';
import { nextInvoiceNumber } from '../utils/invoice.js';
import { getJourneyEngine } from '../core/journey/journey-engine.js';
import { JourneyEventType } from '../core/journey/event-types.js';
import {
  stmtAttempt,
  stmtCurrentAttempt,
  stmtAttempts,
  stmtResults,
  stmtInsertAttempt,
  stmtLastAttemptNumber,
  stmtCompleteAttempt,
  stmtUpdateVisitorPlacement,
  stmtVisitorCompletedCount,
  stmtUpsertResponse,
  stmtResponsesByAttemptTest,
  stmtTestById,
  stmtQuestionsByTest,
  stmtSectionsByTest,
  stmtRubricById,
  stmtVersionLevels,
  getVisitorOr404,
  assertVisitorBranchAccess,
  getUserContext,
  mapProfile,
  mapAttempt,
  parseComponents,
  upsertResult,
  getRequiredMissing,
  type PolicyComponent,
  type PlacementDecisionRule,
  type PlacementDeliveryMode,
} from '../core/placement/store.js';
import {
  resolvePlacementRequirement,
  resolvePolicyForVisitor,
  validateDecisionRules,
  validateMoney,
  validatePositiveInteger,
  validateScoringModel,
} from '../core/placement/policy-engine.js';
import {
  assertAttemptEditable,
  expireAttemptIfNeeded,
  enforceComponentTimeout,
  recordSubmissionTiming,
  startComponentTimer,
  pauseAttempt,
  resumeAttempt,
  componentTimingView,
  computeDeadline,
  nowIso,
  componentTimeLimitSeconds,
} from '../core/placement/timing-engine.js';
import { autoScoreQuestion, normalizeAutoScore, scoreProvenance, scoreComponentBody } from '../core/placement/scoring-engine.js';
import { evaluateDecision, assertNoConflictingLevels, evaluateOutcome } from '../core/placement/decision-engine.js';
import { readRetakePolicy, evaluateStartEligibility, evaluateBilling, WAIVED_STATUS } from '../core/placement/placement-policy.js';
import { placementActivityReport } from '../core/placement/reporting.js';
import { assembleComponentSnapshot, type SnapshotTest } from '../core/placement/blueprint-engine.js';
import { placementPercentageFromResults } from '../core/placement/v1.js';

export const placementAttemptRouter = Router();

type SnapshotShape = {
  profile: ReturnType<typeof mapProfile>;
  components: PolicyComponent[];
  tests: SnapshotTest[];
  requirementMode: string;
  policyVersion: number;
  decisionRules: PlacementDecisionRule[];
  deliveryMode: PlacementDeliveryMode;
  billingTerms: { baseFee: number; priorCompletedAttempts: number };
  capturedAt: string;
};

type SnapshotBankRow = {
  id: string;
  title: string;
  test_type: string;
  instructions: string | null;
  audio_url: string | null;
  transcript: string | null;
  passage: string | null;
  status: string;
  branch_id: string | null;
  difficulty: string | null;
  duration_seconds: number | null;
  version: number;
  rubric_id: string | null;
  word_target: number | null;
  sections: any[];
  questions: any[];
  rubric: { id: string; title: string; kind: string; version: number; criteria: unknown[] } | null;
};

const stmtGetStudentByLeadId = db.prepare('SELECT id, student_code, full_name, branch_id FROM students WHERE lead_id = ? LIMIT 1');

function linkedStudentForVisitor(visitorId: string) {
  return (stmtGetStudentByLeadId.get(visitorId) as { id: string; student_code: string; full_name: string; branch_id: string } | undefined) ?? null;
}

function syncStudentPlacementFromVisitor(visitorId: string) {
  const student = linkedStudentForVisitor(visitorId);
  if (!student) return null;
  const visitor = getVisitorOr404(visitorId);
  db.prepare('UPDATE students SET placement_score = ? WHERE id = ?').run(visitor.placement_score ?? null, student.id);
  return student;
}

function placementJourneyPayload(resultSnapshot: string, recommendationText: string, outcome: 'passed' | 'failed') {
  const parsed = JSON.parse(resultSnapshot) as Record<string, any>;
  return {
    overall: parsed.percentage ?? parsed.totalScore ?? null,
    overallCefr: parsed.overallCefr ?? null,
    outcome,
    recommendedLevel: parsed.recommendation?.text ?? recommendationText,
    recommendedLevelId: parsed.recommendation?.levelId ?? null,
    deliveryMode: parsed.deliveryMode ?? null,
    assessedAt: nowIso(),
    scores: Object.fromEntries(
      Array.isArray(parsed.results)
        ? parsed.results.flatMap((result: Record<string, unknown>) => {
            const key = String(result.component_key ?? result.key ?? '');
            const value = typeof result.score === 'number' ? result.score : null;
            return key && value != null ? [[key, value]] : [];
          })
        : [],
    ),
    componentEvidence: Array.isArray(parsed.componentEvidence) ? parsed.componentEvidence : [],
  };
}

function placementInvoiceExistsForAttempt(studentId: string, attemptId: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM invoices
      WHERE student_id = ? AND charge_kind = 'placement' AND notes = ?
      LIMIT 1`,
  ).get(studentId, `Placement assessment fee — attempt ${attemptId}`);
  return Boolean(row);
}

function loadAttemptContext(req: any, visitorId: string, attemptId: string) {
  const visitor = getVisitorOr404(visitorId);
  assertVisitorBranchAccess(req, visitor);
  const attempt = stmtAttempt.get(attemptId) as any;
  if (!attempt || attempt.visitor_id !== visitor.id) throw new HttpError(404, 'Placement attempt not found.');
  return { visitor, attempt };
}

function parseSnapshot(attempt: any): SnapshotShape {
  try {
    const snapshot = JSON.parse(attempt.snapshot_json || '{}') as Partial<SnapshotShape>;
    if (!snapshot || !Array.isArray(snapshot.components) || !Array.isArray(snapshot.tests) || !snapshot.profile) {
      throw new Error('invalid shape');
    }
    return snapshot as SnapshotShape;
  } catch {
    throw new HttpError(409, 'Placement attempt snapshot is corrupted.');
  }
}

function validateStoredProfileForAttempt(profile: any, components: PolicyComponent[], levels: any[]) {
  try {
    const booleanFacts = [profile.allow_retake, profile.first_attempt_billable, profile.retake_billable, profile.first_level_exempt];
    if (booleanFacts.some((value) => value !== 0 && value !== 1)) throw new Error('invalid boolean');
    validatePositiveInteger(profile.max_attempts, 'maxAttempts', true, 100);
    validatePositiveInteger(profile.expires_minutes, 'expiresMinutes', true, 525600);
    validateMoney(profile.retake_fee_amount, 'retakeFeeAmount');
    validateScoringModel(profile.scoring_model);
    if (typeof profile.pass_score !== 'number' || !Number.isFinite(profile.pass_score) || profile.pass_score < 0 || profile.pass_score > 120) {
      throw new Error('invalid pass score');
    }
    const decisionRules = profile.decision_rules_json == null ? [] : JSON.parse(profile.decision_rules_json);
    return validateDecisionRules(decisionRules, components, new Set(levels.map((level) => String(level.id))));
  } catch {
    throw new HttpError(409, 'Stored placement policy is invalid. Correct it in Academic Setup before starting an attempt.');
  }
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function boundedText(value: unknown, field: string, maxLength: number, required = false): string | null {
  if (value == null) {
    if (required) throw new HttpError(400, `${field} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text.`);
  const normalized = value.trim();
  if (required && !normalized) throw new HttpError(400, `${field} is required.`);
  if (normalized.length > maxLength) throw new HttpError(400, `${field} must be no longer than ${maxLength} characters.`);
  return normalized || null;
}

function parseDeliveryMode(value: unknown): PlacementDeliveryMode {
  if (value !== 'DIGITAL' && value !== 'PHYSICAL') throw new HttpError(400, 'deliveryMode must be DIGITAL or PHYSICAL.');
  return value;
}

function findComponent(snapshot: SnapshotShape, componentKey: string): PolicyComponent {
  const component = snapshot.components.find((candidate) => candidate.key === componentKey);
  if (!component) throw new HttpError(404, 'Assessment component not found.');
  return component;
}

function findResult(attemptId: string, componentKey: string): any {
  const result = (stmtResults.all(attemptId) as any[]).find((candidate) => candidate.component_key === componentKey);
  if (!result) throw new HttpError(404, 'Component result not found.');
  return result;
}

function findSnapshotTest(snapshot: SnapshotShape, component: PolicyComponent): SnapshotTest {
  const test = snapshot.tests.find((candidate) => candidate.component_key === component.key || candidate.id === component.testId);
  if (!test) throw new HttpError(404, 'Test content not found in the attempt snapshot.');
  return test;
}

function loadSnapshotBank(bankId: string): SnapshotBankRow {
  const bank = stmtTestById.get(bankId) as any;
  if (!bank) throw new HttpError(409, `Configured placement bank ${bankId} no longer exists.`);
  const rubric = bank.rubric_id ? stmtRubricById.get(bank.rubric_id) as any : null;
  return {
    ...bank,
    sections: stmtSectionsByTest.all(bank.id) as any[],
    questions: stmtQuestionsByTest.all(bank.id) as any[],
    rubric: rubric ? {
      id: rubric.id,
      title: rubric.title,
      kind: rubric.kind,
      version: Number(rubric.version ?? 1),
      criteria: JSON.parse(rubric.criteria_json || '[]'),
    } : null,
  };
}

function requireStartedTimer(component: PolicyComponent, result: any) {
  if (componentTimeLimitSeconds(component) != null && !result?.started_at) {
    throw new HttpError(409, `Start the server timer for "${component.label}" before submitting it.`);
  }
}

function manualEntryAllowed(deliveryMode: PlacementDeliveryMode, component: PolicyComponent): boolean {
  if (component.type === 'writing' || component.type === 'speaking') return true;
  return deliveryMode === 'PHYSICAL';
}

function buildDecisionRulesJson(snapshot: SnapshotShape): string {
  return JSON.stringify(snapshot.decisionRules || []);
}

function attemptMaxScore(components: PolicyComponent[]): number {
  return Math.round(components.reduce((sum, component) => sum + Number(component.maxScore || 0), 0) * 100) / 100;
}

function computeAttemptTotalScore(results: any[]): number | null {
  const scored = results.filter((result) => result.status === 'completed' && result.score != null);
  if (scored.length === 0) return null;
  return Math.round(scored.reduce((sum, result) => sum + Number(result.score || 0), 0) * 100) / 100;
}

function persistComponentCefrEvidence(attemptId: string, componentEvidence: Array<{ componentKey: string; cefrLevel: string | null }>) {
  const update = db.prepare(`
    UPDATE placement_assessment_results
    SET cefr_level=?,
        cefr_evidence_json=?,
        updated_at=datetime('now')
    WHERE attempt_id=? AND component_key=?
  `);
  for (const evidence of componentEvidence) {
    const result = findResult(attemptId, evidence.componentKey);
    const payload = JSON.stringify({
      componentKey: evidence.componentKey,
      score: result.score == null ? null : Number(result.score),
      maxScore: result.max_score == null ? null : Number(result.max_score),
      cefrLevel: evidence.cefrLevel,
    });
    update.run(evidence.cefrLevel, payload, attemptId, evidence.componentKey);
  }
}

function updateVisitorPlacementFailure(profile: any, attemptId: string, visitorId: string, resultSnapshot: string) {
  db.prepare(`
    UPDATE visitors
    SET placement_score=?, placement_method=?, placement_status='scheduled',
        placement_status_at=datetime('now'), current_placement_attempt_id=NULL,
        stage=CASE WHEN stage IN ('placement_completed','placement_fee') THEN 'placement_booking' ELSE stage END
    WHERE id=?
  `).run(resultSnapshot, String(profile.method || 'canonical_v1'), visitorId);
}

function normalizeResponseByType(question: any, response: unknown, visitorBranchId: string) {
  if (question.qtype === 'mcq') {
    const options = JSON.parse(String(question.options_json || '[]')) as Array<{ key: string }>;
    const optionKeys = options.map((option) => String(option.key));
    if (typeof response !== 'string' || !optionKeys.includes(response)) {
      throw new HttpError(400, `Invalid option for question "${question.question_key}".`);
    }
    return response;
  }
  if (['short_answer', 'fill_blank', 'sentence_completion', 'error_identification', 'essay'].includes(String(question.qtype))) {
    if (typeof response !== 'string' || !response.trim()) {
      throw new HttpError(400, `Question "${question.question_key}" requires a text response.`);
    }
    return response.trim();
  }
  if (question.qtype === 'speaking') {
    if (!response || typeof response !== 'object' || Array.isArray(response) || typeof (response as any).audioMediaId !== 'string') {
      throw new HttpError(400, `Speaking question "${question.question_key}" requires an audio recording.`);
    }
    const media = db.prepare('SELECT id, branch_id, kind, mime FROM placement_media WHERE id = ?').get((response as any).audioMediaId) as { id: string; branch_id: string | null; kind: string; mime: string } | undefined;
    if (!media) throw new HttpError(400, `Unknown audio media id "${(response as any).audioMediaId}" for speaking question "${question.question_key}".`);
    if (media.branch_id && media.branch_id !== visitorBranchId) throw new HttpError(403, 'Audio media belongs to another branch.');
    if (media.kind !== 'audio' || !String(media.mime).startsWith('audio/')) throw new HttpError(400, `Media id "${(response as any).audioMediaId}" is not an audio recording.`);
    return response;
  }
  throw new HttpError(400, `Unsupported question type "${question.qtype}".`);
}

placementAttemptRouter.get('/visitors/:visitorId/placement', authorize('owner', 'receptionist', 'general_manager', 'counselor'), ah(async (req, res) => {
  const visitor = getVisitorOr404(req.params.visitorId);
  assertVisitorBranchAccess(req, visitor);
  const targetLevelId = typeof req.query.targetLevelId === 'string' ? req.query.targetLevelId : null;
  const { version, profile, requirement } = resolvePolicyForVisitor(visitor, targetLevelId);
  const levels = version ? stmtVersionLevels.all(version.id, version.id) as any[] : [];
  const openAttempt = stmtCurrentAttempt.get(visitor.id) as any;
  if (openAttempt) expireAttemptIfNeeded(openAttempt);
  const current = stmtCurrentAttempt.get(visitor.id) as any;
  const linkedStudent = linkedStudentForVisitor(visitor.id);
  res.json({
    visitorId: visitor.id,
    programVersionId: visitor.program_version_id,
    linkedStudentId: linkedStudent?.id ?? null,
    admissionRequired: !linkedStudent,
    requirement: {
      mode: requirement.mode,
      decision: requirement.decision,
      reason: requirement.reason,
      firstLevelExemptApplied: requirement.firstLevelExemptApplied,
      policySource: requirement.policySource,
    },
    profile: profile
      ? mapProfile(profile, version, levels)
      : {
          configured: false,
          enabled: false,
          required: false,
          requirementMode: 'not_required',
          components: [],
          levels,
          decisionRules: [],
          allowRetake: true,
          passScore: 0,
          maxScore: 120,
          instructions: null,
          scoringModel: 'canonical',
          deliveryModes: ['DIGITAL', 'PHYSICAL'],
        },
    attempts: (stmtAttempts.all(visitor.id) as any[]).map((attempt) => mapAttempt(attempt)),
    current: current ? mapAttempt(current, true) : null,
  });
}));

placementAttemptRouter.post('/visitors/:visitorId/placement/attempts', authorize('owner', 'receptionist', 'general_manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const visitor = getVisitorOr404(req.params.visitorId);
  assertVisitorBranchAccess(req, visitor);
  if (!linkedStudentForVisitor(visitor.id)) {
    throw new HttpError(409, 'Admit this candidate to a student record before starting placement. Placement fees and balance authority now require the student financial identity first.');
  }
  const targetLevelId = typeof req.body?.targetLevelId === 'string' ? req.body.targetLevelId : null;
  const deliveryMode = parseDeliveryMode(req.body?.deliveryMode ?? 'DIGITAL');
  const requirement = resolvePlacementRequirement(visitor.program_version_id, visitor.branch_id, targetLevelId);

  if (requirement.decision === 'CONFIGURATION_ERROR') {
    throw new HttpError(409, 'Placement policy exists for this program but does not apply to the candidate branch.');
  }
  if (requirement.mode === 'not_required') {
    throw new HttpError(400, `Placement is not required for this program (${requirement.reason}).`);
  }
  if (requirement.mode === 'optional' && req.body?.skip === true) {
    const reason = boundedText(req.body?.reason, 'Waiver reason', 500, true)!;
    const current = stmtCurrentAttempt.get(visitor.id) as any;
    db.transaction(() => {
      if (current) {
        db.prepare(`
          UPDATE placement_assessment_attempts
          SET status='cancelled', completed_at=datetime('now'), paused_at=NULL,
              notes=COALESCE(notes, '') || ?, updated_at=datetime('now')
          WHERE id=? AND status IN ('in_progress','paused')
        `).run(` Optional placement waived: ${reason}`, current.id);
      }
      db.prepare(`
        UPDATE visitors
        SET placement_status=?, placement_status_at=datetime('now'), placement_requirement_mode='optional',
            placement_score=?, current_placement_attempt_id=NULL
        WHERE id=?
      `).run(WAIVED_STATUS, JSON.stringify({ mode: 'optional', skipped: true, waived: true, reason, at: nowIso(), by: user.userId }), visitor.id);
    })();
    writeAudit(req, `Placement waived (optional policy) for ${visitor.full_name}`, { newValue: JSON.stringify({ mode: 'optional', reason, cancelledAttemptId: current?.id ?? null, operatorId: user.userId }) });
    res.json({ skipped: true, mode: 'optional', reason, cancelledAttemptId: current?.id ?? null });
    return;
  }

  const { version, profile } = resolvePolicyForVisitor(visitor, targetLevelId);
  if (!profile || !version) throw new HttpError(409, 'Placement is required but no placement policy is configured for this program.');
  const levels = stmtVersionLevels.all(version.id, version.id) as any[];
  const components = parseComponents(profile);
  if (components.length === 0) throw new HttpError(409, 'Placement policy has no assessment components.');
  const validatedDecisionRules = validateStoredProfileForAttempt(profile, components, levels);
  const retakePolicy = readRetakePolicy(profile);
  const eligibility = evaluateStartEligibility(retakePolicy, Number((stmtVisitorCompletedCount.get(visitor.id) as any).c || 0));
  if (!eligibility.allowed) throw new HttpError(409, eligibility.reason);

  const startedAt = nowIso();
  const expiresMinutes = profile.expires_minutes ? Number(profile.expires_minutes) : null;
  const expiresAt = expiresMinutes ? computeDeadline(startedAt, expiresMinutes * 60) : null;
  const attemptNumber = Number((stmtLastAttemptNumber.get(visitor.id) as any).n || 0) + 1;
  const attemptId = id('pat');

  const snapshotTests: SnapshotTest[] = [];
  const snapshotComponents: PolicyComponent[] = [];
  for (const component of components) {
    const banks = component.bankIds.map(loadSnapshotBank);
    for (const bank of banks) {
      if (bank.status !== 'active') throw new HttpError(409, `${component.label} bank "${bank.title}" is not active.`);
      if (bank.test_type !== component.type) throw new HttpError(409, `${component.label} bank "${bank.title}" has the wrong component type.`);
      if (bank.branch_id && bank.branch_id !== visitor.branch_id && bank.branch_id !== profile.branch_id) {
        throw new HttpError(409, `${component.label} bank "${bank.title}" belongs to another branch.`);
      }
    }
    const assembled = assembleComponentSnapshot({ attemptId, deliveryMode, component, banks });
    snapshotComponents.push(assembled.component as PolicyComponent);
    snapshotTests.push(assembled.test);
  }

  const priorCompletedAttempts = Number((stmtVisitorCompletedCount.get(visitor.id) as any).c || 0);
  const resolvedBaseFee = resolveFee(db, visitor.branch_id, 'placementTestFee', {
    programVersionId: version.id,
  });
  if (resolvedBaseFee != null && (!Number.isInteger(resolvedBaseFee) || resolvedBaseFee < 0)) {
    throw new HttpError(409, 'The configured placement fee is invalid.');
  }
  const requiresBasePlacementFee =
    (priorCompletedAttempts === 0 && retakePolicy.firstAttemptBillable) ||
    (priorCompletedAttempts > 0 && retakePolicy.retakeBillable && retakePolicy.retakeFeeAmount == null);
  if (requiresBasePlacementFee && resolvedBaseFee == null) {
    throw new HttpError(409, 'No active placement fee is configured for this branch/program. Configure it in Academic Control Center before starting a billable attempt.');
  }
  const profileSnapshot = mapProfile(profile, version, levels);
  const snapshot = JSON.stringify({
    profile: profileSnapshot,
    components: snapshotComponents,
    tests: snapshotTests,
    requirementMode: requirement.mode,
    policyVersion: Number(profile.version ?? 1),
    decisionRules: validatedDecisionRules,
    deliveryMode,
    billingTerms: { baseFee: resolvedBaseFee ?? 0, priorCompletedAttempts },
    capturedAt: startedAt,
  } satisfies SnapshotShape);

  const insertAttempt = db.transaction(() => {
    stmtInsertAttempt.run(
      attemptId,
      visitor.id,
      visitor.program_version_id,
      profile.id,
      visitor.branch_id,
      attemptNumber,
      snapshot,
      user.userId,
      null,
      expiresAt,
      Number(profile.version ?? 1),
      deliveryMode,
    );
    for (const component of snapshotComponents) {
      upsertResult({
        attemptId,
        key: component.key,
        type: component.type,
        label: component.label,
        status: 'pending',
        score: null,
        maxScore: component.maxScore,
        weight: component.weight,
        evaluatorUserId: user.userId,
        startedAt: null,
        deadlineAt: null,
      });
    }
    db.prepare(`
      UPDATE visitors
      SET placement_status='in_progress', placement_status_at=datetime('now'), placement_requirement_mode=?,
          placement_method=?, current_placement_attempt_id=?,
          stage=CASE WHEN stage IN ('lead','inquiry','follow_up','placement_booking') THEN 'placement_booking' ELSE stage END
      WHERE id=?
    `).run(requirement.mode, profileSnapshot.method, attemptId, visitor.id);
  });
  try {
    insertAttempt();
  } catch (err) {
    const e = err as { code?: string; message?: string } | null;
    if (e?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const message = String(e.message ?? '');
      if (message.includes('attempt_number')) {
        throw new HttpError(409, 'Another placement attempt was created for this candidate at the same moment. Please retry.');
      }
      if (message.includes('visitor_id')) {
        throw new HttpError(409, 'This candidate already has an open placement attempt. Complete, cancel or expire it before starting another.');
      }
    }
    throw err;
  }

  writeAudit(req, `Started placement assessment for ${visitor.full_name} (policy v${profile.version ?? 1}, mode ${requirement.mode}, delivery ${deliveryMode})`, { newValue: JSON.stringify({ attemptId, policyVersion: profile.version ?? 1, expiresAt, deliveryMode }) });
  res.status(201).json(mapAttempt(stmtAttempt.get(attemptId)));
}));

placementAttemptRouter.put('/visitors/:visitorId/placement/attempts/:attemptId/tests/:componentKey/start', authorize('owner', 'receptionist', 'general_manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  assertAttemptEditable(attempt);
  const snapshot = parseSnapshot(attempt);
  const component = findComponent(snapshot, req.params.componentKey);
  const result = findResult(attempt.id, component.key);
  if (['completed', 'waived', 'timed_out'].includes(String(result.status))) throw new HttpError(409, 'This assessment component is already closed.');
  startComponentTimer(attempt.id, component.key, component, result, user.userId);
  writeAudit(req, `Started placement component timer "${component.label}" for ${visitor.full_name}`);
  const updated = findResult(attempt.id, component.key);
  res.json({ componentKey: component.key, ...componentTimingView(component, updated) });
}));

placementAttemptRouter.put('/visitors/:visitorId/placement/attempts/:attemptId/tests/:componentKey/responses', authorize('owner', 'receptionist', 'general_manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  assertAttemptEditable(attempt);
  const snapshot = parseSnapshot(attempt);
  const component = findComponent(snapshot, req.params.componentKey);
  if (!['grammar', 'reading', 'listening', 'writing', 'speaking'].includes(component.type)) {
    throw new HttpError(404, 'Content assessment component not found.');
  }
  if (attempt.delivery_mode !== 'DIGITAL') throw new HttpError(409, 'Direct response capture is only available for DIGITAL delivery mode.');
  const test = findSnapshotTest(snapshot, component);
  const result = findResult(attempt.id, component.key);
  if (['completed', 'waived', 'timed_out'].includes(String(result.status))) throw new HttpError(409, 'This assessment component is already closed.');
  requireStartedTimer(component, result);

  const { elapsedSeconds } = recordSubmissionTiming(attempt.id, component.key, component, result);
  if (!Array.isArray(req.body?.answers)) throw new HttpError(400, 'answers must be an array.');
  const answers = req.body.answers as Array<{ questionKey?: string; response?: unknown }>;
  if (answers.length === 0) throw new HttpError(400, 'Submit at least one answer.');
  const submittedKeys = answers.map((answer) => String(answer?.questionKey ?? ''));
  if (submittedKeys.some((key) => !key) || new Set(submittedKeys).size !== submittedKeys.length) {
    throw new HttpError(400, 'Each submitted answer must have a unique questionKey.');
  }

  let stored: any[] = [];
  let earned = 0;
  let max = 0;
  let answered = 0;
  let complete = false;
  const feedbacks: Record<string, string> = {};
  const applySubmission = db.transaction(() => {
    for (const answer of answers) {
      const question = test.questions.find((candidate) => String(candidate.question_key) === String(answer.questionKey));
      if (!question) throw new HttpError(400, `Unknown question key "${answer.questionKey}" in test "${test.title}".`);
      const normalizedResponse = normalizeResponseByType(question, answer.response, visitor.branch_id);
      const graded = autoScoreQuestion(question, normalizedResponse);
      feedbacks[String(question.question_key)] = graded.feedback;
      stmtUpsertResponse.run(
        id('pr'),
        attempt.id,
        test.id,
        question.id,
        question.question_key,
        JSON.stringify(normalizedResponse),
        graded.score,
        Number(question.points || 0),
        graded.feedback,
      );
    }

    stored = stmtResponsesByAttemptTest.all(attempt.id, test.id) as any[];
    const storedByKey = new Map(stored.map((row) => [String(row.question_key), row]));
    earned = 0;
    max = 0;
    answered = 0;
    for (const question of test.questions) {
      const points = Number(question.points || 0);
      max += points;
      const row = storedByKey.get(String(question.question_key));
      if (row) {
        answered += 1;
        earned += Number(row.auto_score || 0);
      }
    }
    const allAnswered = answered === test.questions.length;
    const requiresHumanScoring = component.type === 'writing' || component.type === 'speaking' || test.questions.some((question) => question.qtype === 'essay' || question.qtype === 'speaking');
    complete = allAnswered && !requiresHumanScoring;

    if (complete) {
      const normalizedScore = normalizeAutoScore(earned, max, component.maxScore);
      const provenance = scoreProvenance(normalizedScore, component.maxScore, component.weight);
      upsertResult({
        attemptId: attempt.id,
        key: component.key,
        type: component.type,
        label: component.label,
        status: 'completed',
        score: normalizedScore,
        maxScore: component.maxScore,
        weight: component.weight,
        evaluatorUserId: user.userId,
        rawScore: earned,
        percentage: provenance.percentage,
        weightedScore: provenance.weightedScore,
        payloadJson: JSON.stringify({ mode: 'auto', earned, max, answered, total: test.questions.length, testId: test.id, testVersion: test.version }),
        submittedAt: nowIso(),
        elapsedSeconds,
      });
    } else {
      upsertResult({
        attemptId: attempt.id,
        key: component.key,
        type: component.type,
        label: component.label,
        status: result.started_at ? 'in_progress' : 'pending',
        score: null,
        maxScore: component.maxScore,
        weight: component.weight,
        evaluatorUserId: user.userId,
        payloadJson: JSON.stringify({ mode: 'capture', earned, max, answered, total: test.questions.length, testId: test.id, testVersion: test.version }),
        submittedAt: allAnswered ? nowIso() : null,
        elapsedSeconds: allAnswered ? elapsedSeconds : null,
      });
    }
  });
  applySubmission();

  writeAudit(req, `Recorded placement responses for ${visitor.full_name} on ${component.label} (${answered}/${test.questions.length} answered)`);
  const updated = findResult(attempt.id, component.key);
  res.json({
    componentKey: component.key,
    answered,
    total: test.questions.length,
    autoScore: earned,
    maxScore: max,
    complete,
    timing: componentTimingView(component, updated),
    feedback: feedbacks,
    responses: stored.map((row) => ({
      questionKey: row.question_key,
      response: JSON.parse(row.response_json || 'null'),
      autoScore: row.auto_score,
      feedback: row.feedback,
    })),
  });
}));

placementAttemptRouter.put('/visitors/:visitorId/placement/attempts/:attemptId/components/:componentKey', authorize('owner', 'receptionist', 'general_manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  assertAttemptEditable(attempt);
  const snapshot = parseSnapshot(attempt);
  const component = findComponent(snapshot, req.params.componentKey);
  const selectedLevelId = req.body?.selectedLevelId == null || req.body.selectedLevelId === ''
    ? null
    : boundedText(req.body.selectedLevelId, 'selectedLevelId', 160, true);
  if (selectedLevelId && !(snapshot.profile.levels || []).some((level: any) => level.id === selectedLevelId)) {
    throw new HttpError(400, 'Selected level is not part of this program.');
  }
  const notes = boundedText(req.body?.notes, 'notes', 1000);
  const resultText = boundedText(req.body?.resultText, 'resultText', 4000);
  const result = findResult(attempt.id, component.key);

  const status = req.body?.status === 'waived' ? 'waived' : 'completed';
  if (status === 'waived') {
    const canWaive = !!req.rbac && hasAnyRole(req.rbac, ['owner', 'general_manager']);
    if (component.required && !canWaive) throw new HttpError(403, 'Only management can waive a required assessment section.');
    if (!notes) throw new HttpError(400, 'A reason is required when waiving an assessment section.');
    upsertResult({
      attemptId: attempt.id,
      key: component.key,
      type: component.type,
      label: component.label,
      status: 'waived',
      score: null,
      maxScore: component.maxScore,
      weight: component.weight,
      selectedLevelId,
      notes,
      evaluatorUserId: user.userId,
      payloadJson: JSON.stringify({ waived: true }),
    });
    res.json(stmtResults.all(attempt.id));
    return;
  }

  if (!manualEntryAllowed(attempt.delivery_mode as PlacementDeliveryMode, component)) {
    throw new HttpError(409, `${component.label} is scored from captured DIGITAL responses and cannot be manually entered.`);
  }
  if (result.status === 'completed' || result.status === 'waived') {
    throw new HttpError(409, 'This component result is already final. Use the audited correction workflow after attempt completion.');
  }
  if (result.timeout_flag || result.status === 'timed_out') {
    throw new HttpError(409, `Component "${component.label}" timed out; it can only be waived with management approval.`);
  }
  requireStartedTimer(component, result);
  const submissionTiming = recordSubmissionTiming(attempt.id, component.key, component, result);
  const scored = scoreComponentBody(component, req.body ?? {}, snapshot.tests, attempt.id);
  const provenance = scoreProvenance(scored.score ?? 0, component.maxScore, component.weight);

  upsertResult({
    attemptId: attempt.id,
    key: component.key,
    type: component.type,
    label: component.label,
    status: 'completed',
    score: scored.score,
    maxScore: component.maxScore,
    weight: component.weight,
    selectedLevelId,
    notes,
    resultText,
    evaluatorUserId: user.userId,
    rawScore: scored.rawScore ?? scored.score,
    percentage: provenance.percentage,
    weightedScore: provenance.weightedScore,
    payloadJson: JSON.stringify(scored.payload),
    submittedAt: nowIso(),
    elapsedSeconds: submissionTiming.elapsedSeconds,
  });
  writeAudit(req, `Scored placement component "${component.label}" for ${visitor.full_name} (${scored.score}/${component.maxScore})`);
  res.json(stmtResults.all(attempt.id));
}));

placementAttemptRouter.post('/visitors/:visitorId/placement/attempts/:attemptId/complete', authorize('owner', 'receptionist', 'general_manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  assertAttemptEditable(attempt);
  const snapshot = parseSnapshot(attempt);
  const components = snapshot.components;
  const results = stmtResults.all(attempt.id) as any[];
  for (const result of results) enforceComponentTimeout(attempt.id, result.component_key, result);
  const finalResults = stmtResults.all(attempt.id) as any[];
  const missing = getRequiredMissing(components, finalResults);
  if (missing.length > 0) throw new HttpError(400, `Complete all required assessment sections first: ${missing.join(', ')}`);
  assertNoConflictingLevels(finalResults);

  const decision = evaluateDecision({
    components,
    results: finalResults,
    rules: [],
    decisionRulesJson: buildDecisionRulesJson(snapshot),
    levels: snapshot.profile.levels || [],
    scoringModel: String(snapshot.profile.scoringModel || 'canonical'),
    passScore: Number(snapshot.profile.passScore ?? 0),
  });
  const totalScore = computeAttemptTotalScore(finalResults);
  const maxScore = attemptMaxScore(components);
  const percentage = decision.percentage ?? placementPercentageFromResults(finalResults.filter((result) => result.status === 'completed' && result.score != null));
  const { outcome, reasons } = evaluateOutcome(decision);

  const retakePolicy = readRetakePolicy(snapshot.profile);
  const priorCompleted = Number(snapshot.billingTerms?.priorCompletedAttempts);
  const baseFee = Number(snapshot.billingTerms?.baseFee);
  if (!Number.isInteger(priorCompleted) || priorCompleted < 0 || !Number.isInteger(baseFee) || baseFee < 0) {
    throw new HttpError(409, 'The attempt billing snapshot is invalid.');
  }
  const billing = evaluateBilling(retakePolicy, priorCompleted, baseFee);
  const placementFee = billing.amount;
  const date = today();
  const resultSnapshot = JSON.stringify({
    totalScore,
    maxScore,
    percentage,
    outcome,
    overallCefr: decision.overallCefr,
    unmetRequirements: decision.unmetRequirements,
    recommendation: {
      levelId: decision.recommendedLevelId,
      text: decision.recommendationText,
      ruleId: decision.decisionRuleId,
    },
    componentEvidence: decision.componentEvidence,
    results: finalResults,
    policyVersion: snapshot.policyVersion,
    deliveryMode: snapshot.deliveryMode,
  });

  const linkedStudent = linkedStudentForVisitor(visitor.id);
  if (billing.billable && placementFee > 0 && !linkedStudent) {
    throw new HttpError(409, 'Admit this candidate to a student record before completing a billable placement. Placement billing now uses the canonical invoice and student-balance architecture.');
  }

  const tx = db.transaction(() => {
    let placementInvoice: { id: string; invoiceNumber: string; amount: number; status: 'issued' } | null = null;
    persistComponentCefrEvidence(attempt.id, decision.componentEvidence);
    const updated = stmtCompleteAttempt.run(
      totalScore,
      maxScore,
      percentage,
      decision.recommendedLevelId,
      decision.recommendationText,
      user.userId,
      decision.decisionRuleId,
      outcome,
      attempt.id,
    ) as any;
    if (updated.changes !== 1) throw new HttpError(409, 'This placement attempt is already closed.');
    if (outcome === 'passed') {
      stmtUpdateVisitorPlacement.run(resultSnapshot, snapshot.profile.method, attempt.id, visitor.id);
    } else {
      updateVisitorPlacementFailure(snapshot.profile, attempt.id, visitor.id, resultSnapshot);
    }
    const stage = billing.billable && placementFee > 0 ? 'placement_fee' : 'placement_completed';
    db.prepare('UPDATE visitors SET stage = ? WHERE id = ?').run(stage, visitor.id);

    if (billing.billable && placementFee > 0 && linkedStudent && !placementInvoiceExistsForAttempt(linkedStudent.id, attempt.id)) {
      const invoiceId = id('inv');
      const invoiceNumber = nextInvoiceNumber(linkedStudent.branch_id);
      const dueDate = date;
      db.prepare(`
        INSERT INTO invoices
          (id, student_id, total_amount, discount_amount, net_amount, status, issue_date, due_date, branch_id, notes, invoice_number, issued_by, student_name, student_code, charge_kind, purpose)
        VALUES (?, ?, ?, 0, ?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, 'placement', 'other')
      `).run(
        invoiceId,
        linkedStudent.id,
        placementFee,
        placementFee,
        date,
        dueDate,
        linkedStudent.branch_id,
        `Placement assessment fee — attempt ${attempt.id}`,
        invoiceNumber,
        user.fullName,
        linkedStudent.full_name,
        linkedStudent.student_code,
      );
      db.prepare(`
        INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount)
        VALUES (?, ?, 'Placement assessment fee', 1, ?, ?)
      `).run(id('ii'), invoiceId, placementFee, placementFee);
      placementInvoice = { id: invoiceId, invoiceNumber, amount: placementFee, status: 'issued' };
    }

    const syncedStudent = syncStudentPlacementFromVisitor(visitor.id);
    if (syncedStudent) {
      const payload = placementJourneyPayload(resultSnapshot, decision.recommendationText, outcome);
      getJourneyEngine(db).appendEvent({
        studentId: syncedStudent.id,
        eventType: JourneyEventType.PLACEMENT_TEST_RECORDED,
        occurredAt: nowIso(),
        branchId: syncedStudent.branch_id,
        actorUserId: user.userId,
        actorName: user.fullName,
        payload,
      });
      getJourneyEngine(db).appendEvent({
        studentId: syncedStudent.id,
        eventType: outcome === 'passed' ? JourneyEventType.PLACEMENT_PASSED : JourneyEventType.PLACEMENT_FAILED,
        occurredAt: nowIso(),
        branchId: syncedStudent.branch_id,
        actorUserId: user.userId,
        actorName: user.fullName,
        payload,
      });
      if (placementInvoice) {
        getJourneyEngine(db).appendEvent({
          studentId: syncedStudent.id,
          eventType: JourneyEventType.INVOICE_ISSUED,
          occurredAt: nowIso(),
          branchId: syncedStudent.branch_id,
          actorUserId: user.userId,
          actorName: user.fullName,
          payload: { invoiceId: placementInvoice.id, invoiceNumber: placementInvoice.invoiceNumber, amount: placementInvoice.amount, category: 'placement', label: 'Placement assessment fee', chargeKind: 'placement', attemptId: attempt.id },
        });
      }
    }
    return placementInvoice;
  });
  const issuedPlacementInvoice = tx();
  if (issuedPlacementInvoice) {
    addNotification('Placement Assessment Recorded', `Placement completed for ${visitor.full_name}. Placement invoice ${issuedPlacementInvoice.invoiceNumber} was issued for ${issuedPlacementInvoice.amount} AFN.`, 'success', visitor.branch_id);
  }
  writeAudit(req, `Completed placement assessment for ${visitor.full_name}: ${decision.recommendationText} — ${outcome.toUpperCase()}`, {
    newValue: JSON.stringify({ ...JSON.parse(resultSnapshot), fee: { amount: placementFee, invoice: issuedPlacementInvoice, attemptId: attempt.id, reason: billing.reason } }),
  });
  res.json({
    ok: true,
    outcome,
    passed: outcome === 'passed',
    unmetRequirements: decision.unmetRequirements,
    failureReasons: reasons,
    feeCharged: placementFee,
    placementInvoice: issuedPlacementInvoice,
    decision: {
      totalScore,
      maxScore,
      percentage,
      overallCefr: decision.overallCefr,
      recommendedLevelId: decision.recommendedLevelId,
      decisionRuleId: decision.decisionRuleId,
      recommendationText: decision.recommendationText,
      componentEvidence: decision.componentEvidence,
    },
    attempt: mapAttempt(stmtAttempt.get(attempt.id)),
  });
}));

placementAttemptRouter.post('/visitors/:visitorId/placement/attempts/:attemptId/pause', authorize('owner', 'general_manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  assertAttemptEditable(attempt);
  const reason = boundedText(req.body?.reason, 'Pause reason', 500);
  const { pausedAt } = pauseAttempt(attempt, reason);
  writeAudit(req, `Paused placement attempt for ${visitor.full_name}`, { newValue: JSON.stringify({ attemptId: attempt.id, pausedAt, reason, operatorId: user.userId }) });
  res.json({ ok: true, status: 'paused', pausedAt });
}));

placementAttemptRouter.post('/visitors/:visitorId/placement/attempts/:attemptId/resume', authorize('owner', 'general_manager', 'counselor'), ah(async (req, res) => {
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  const { resumedAt, pauseSeconds } = resumeAttempt(attempt);
  writeAudit(req, `Resumed placement attempt for ${visitor.full_name} (${pauseSeconds}s pause applied)`, { newValue: JSON.stringify({ attemptId: attempt.id, resumedAt, pauseSeconds }) });
  res.json({ ok: true, status: 'in_progress', resumedAt, pauseSeconds });
}));

placementAttemptRouter.post('/visitors/:visitorId/placement/attempts/:attemptId/cancel', authorize('owner', 'receptionist', 'general_manager', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  if (!['in_progress', 'paused'].includes(String(attempt.status))) throw new HttpError(409, 'Only an in-progress placement attempt can be cancelled.');
  const reason = req.body?.reason == null ? 'Cancelled by operator' : boundedText(req.body.reason, 'Cancellation reason', 500, true)!;
  db.transaction(() => {
    db.prepare(`UPDATE placement_assessment_attempts SET status='cancelled', completed_at=datetime('now'), updated_at=datetime('now'), notes=? WHERE id=?`).run(reason, attempt.id);
    db.prepare(`UPDATE visitors SET placement_status='scheduled', placement_status_at=datetime('now'), current_placement_attempt_id=NULL WHERE id=? AND current_placement_attempt_id=?`).run(visitor.id, attempt.id);
  })();
  writeAudit(req, `Cancelled placement assessment for ${visitor.full_name}`, { newValue: JSON.stringify({ attemptId: attempt.id, reason, operatorId: user.userId }) });
  res.json({ ok: true, status: 'cancelled' });
}));

placementAttemptRouter.post('/visitors/:visitorId/placement/attempts/:attemptId/override', authorize('owner', 'general_manager'), requirePermission('Placement.Override'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  if (attempt.status !== 'completed') throw new HttpError(409, 'Only a completed placement attempt can be overridden.');
  const levelId = boundedText(req.body?.levelId, 'levelId', 160, true)!;
  const reason = boundedText(req.body?.reason, 'Override reason', 500, true)!;
  const snapshot = parseSnapshot(attempt);
  const level = (snapshot.profile.levels || []).find((candidate: any) => candidate.id === levelId);
  if (!level) throw new HttpError(400, 'Override level is not part of this program.');
  const before = { recommendedLevelId: attempt.recommended_level_id, recommendationText: attempt.recommendation_text };
  const visitorRow = getVisitorOr404(req.params.visitorId);
  let visitorScore: Record<string, any> | null = null;
  if (visitorRow.placement_score) {
    try {
      const parsed = JSON.parse(visitorRow.placement_score);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid placement score');
      visitorScore = parsed;
    } catch {
      throw new HttpError(409, 'Stored visitor placement result is corrupted. Correct it before applying an override.');
    }
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE placement_assessment_attempts
      SET override_level_id=?, override_reason=?, override_by=?, override_at=datetime('now'),
          recommended_level_id=?, recommendation_text=?, updated_at=datetime('now')
      WHERE id=?
    `).run(levelId, reason, user.userId, levelId, `${level.name} — manual override: ${reason}`, attempt.id);
    if (visitorScore) {
      const previousRecommendation = visitorScore.recommendation && typeof visitorScore.recommendation === 'object' && !Array.isArray(visitorScore.recommendation)
        ? visitorScore.recommendation
        : {};
      visitorScore.recommendation = { ...previousRecommendation, levelId, text: `${level.name} — manual override: ${reason}`, overridden: true, overrideBy: user.userId, overrideAt: nowIso() };
      db.prepare('UPDATE visitors SET placement_score=? WHERE id=?').run(JSON.stringify(visitorScore), visitorRow.id);
      syncStudentPlacementFromVisitor(visitorRow.id);
    }
  })();
  writeAudit(req, `Manual placement override for ${visitor.full_name}: ${before.recommendedLevelId} → ${levelId}`, { oldValue: JSON.stringify(before), newValue: JSON.stringify({ recommendedLevelId: levelId, reason, operatorId: user.userId, attemptId: attempt.id }) });
  res.json({ ok: true, recommendedLevelId: levelId, recommendationText: `${level.name} — manual override: ${reason}` });
}));

placementAttemptRouter.post('/visitors/:visitorId/placement/attempts/:attemptId/components/:componentKey/correct', authorize('owner', 'general_manager'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { visitor, attempt } = loadAttemptContext(req, req.params.visitorId, req.params.attemptId);
  if (attempt.status !== 'completed') throw new HttpError(409, 'Only a completed placement attempt can have scores corrected.');
  const reason = boundedText(req.body?.reason, 'Correction reason', 500, true)!;
  const resultText = req.body?.resultText === undefined ? null : boundedText(req.body.resultText, 'resultText', 4000);
  const snapshot = parseSnapshot(attempt);
  const component = findComponent(snapshot, req.params.componentKey);
  const existingResults = stmtResults.all(attempt.id) as any[];
  const existing = existingResults.find((result) => result.component_key === component.key);
  if (!existing || existing.status !== 'completed') throw new HttpError(409, 'Only completed components can be corrected.');

  const scored = scoreComponentBody(component, req.body ?? {}, snapshot.tests, attempt.id);
  const provenance = scoreProvenance(scored.score ?? 0, component.maxScore, component.weight);
  const nextVersion = Number(existing.score_version || 1) + 1;
  const visitorRow = getVisitorOr404(req.params.visitorId);

  let decision!: ReturnType<typeof evaluateDecision>;
  let outcome!: 'passed' | 'failed';
  let finalRecommendedLevelId: string | null = null;
  let finalRecommendationText = '';
  db.transaction(() => {
    upsertResult({
      attemptId: attempt.id,
      key: component.key,
      type: component.type,
      label: component.label,
      status: 'completed',
      score: scored.score,
      maxScore: component.maxScore,
      weight: component.weight,
      notes: existing.notes,
      resultText: resultText ?? existing.result_text ?? null,
      evaluatorUserId: user.userId,
      rawScore: scored.rawScore ?? scored.score,
      percentage: provenance.percentage,
      weightedScore: provenance.weightedScore,
      scoreVersion: nextVersion,
      payloadJson: JSON.stringify(scored.payload),
    });
    db.prepare(`
      UPDATE placement_assessment_results
      SET corrected_at=datetime('now'), corrected_by=?, correction_reason=?, updated_at=datetime('now')
      WHERE attempt_id=? AND component_key=?
    `).run(user.userId, reason.slice(0, 500), attempt.id, component.key);

    const updatedResults = stmtResults.all(attempt.id) as any[];
    decision = evaluateDecision({
      components: snapshot.components,
      results: updatedResults,
      rules: [],
      decisionRulesJson: buildDecisionRulesJson(snapshot),
      levels: snapshot.profile.levels || [],
      scoringModel: String(snapshot.profile.scoringModel || 'canonical'),
      passScore: Number(snapshot.profile.passScore ?? 0),
    });
    outcome = evaluateOutcome(decision).outcome;
    finalRecommendedLevelId = attempt.override_level_id ?? decision.recommendedLevelId;
    finalRecommendationText = attempt.override_level_id
      ? String(attempt.recommendation_text || decision.recommendationText)
      : decision.recommendationText;

    persistComponentCefrEvidence(attempt.id, decision.componentEvidence);
    db.prepare(`
      UPDATE placement_assessment_attempts
      SET total_score=?, max_score=?, percentage=?, recommended_level_id=?, recommendation_text=?,
          decision_rule_id=?, outcome=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      computeAttemptTotalScore(updatedResults),
      attemptMaxScore(snapshot.components),
      decision.percentage,
      finalRecommendedLevelId,
      finalRecommendationText,
      decision.decisionRuleId,
      outcome,
      attempt.id,
    );

    const resultSnapshot = JSON.stringify({
      totalScore: computeAttemptTotalScore(updatedResults),
      maxScore: attemptMaxScore(snapshot.components),
      percentage: decision.percentage,
      outcome,
      overallCefr: decision.overallCefr,
      unmetRequirements: decision.unmetRequirements,
      recommendation: { levelId: finalRecommendedLevelId, text: finalRecommendationText, ruleId: decision.decisionRuleId, overridden: Boolean(attempt.override_level_id) },
      componentEvidence: decision.componentEvidence,
      results: updatedResults,
      policyVersion: snapshot.policyVersion,
      deliveryMode: snapshot.deliveryMode,
    });

    if (outcome === 'passed') {
      db.prepare(`
        UPDATE visitors
        SET placement_score=?, placement_method=?, placement_status='completed', placement_status_at=datetime('now'),
            current_placement_attempt_id=?, stage=CASE WHEN stage IN ('placement_booking','placement_fee') THEN 'placement_completed' ELSE stage END
        WHERE id=?
      `).run(resultSnapshot, snapshot.profile.method, attempt.id, visitorRow.id);
    } else {
      updateVisitorPlacementFailure(snapshot.profile, attempt.id, visitorRow.id, resultSnapshot);
    }
  })();

  writeAudit(req, `Score correction for ${visitor.full_name} component "${component.label}" (v${existing.score_version || 1} → v${nextVersion})`, {
    oldValue: JSON.stringify({ score: existing.score, percentage: existing.percentage, resultText: existing.result_text }),
    newValue: JSON.stringify({ score: scored.score, percentage: provenance.percentage, outcome, reason, operatorId: user.userId }),
  });
  res.json({
    ok: true,
    score: scored.score,
    percentage: provenance.percentage,
    scoreVersion: nextVersion,
    outcome,
    decision: {
      percentage: decision.percentage,
      overallCefr: decision.overallCefr,
      recommendedLevelId: finalRecommendedLevelId,
      decisionRuleId: decision.decisionRuleId,
      recommendationText: finalRecommendationText,
      componentEvidence: decision.componentEvidence,
    },
  });
}));

placementAttemptRouter.get('/visitors/:visitorId/placement/attempts', authorize('owner', 'receptionist', 'general_manager', 'counselor'), ah(async (req, res) => {
  const visitor = getVisitorOr404(req.params.visitorId);
  assertVisitorBranchAccess(req, visitor);
  res.json((stmtAttempts.all(visitor.id) as any[]).map((attempt) => mapAttempt(attempt)));
}));

placementAttemptRouter.post('/maintenance/expire', authorize('owner', 'general_manager'), ah(async (req, res) => {
  const user = getUserContext(req);
  const now = nowIso();
  let expiredCount = 0;
  const scope = resolveBranchScope(req);
  db.transaction(() => {
    const due = (scope.isAll
      ? db.prepare(`SELECT id, visitor_id FROM placement_assessment_attempts WHERE status IN ('in_progress','paused') AND expires_at IS NOT NULL AND expires_at < ?`).all(now)
      : db.prepare(`SELECT id, visitor_id FROM placement_assessment_attempts WHERE status IN ('in_progress','paused') AND expires_at IS NOT NULL AND expires_at < ? AND branch_id = ?`).all(now, scope.branchId)
    ) as Array<{ id: string; visitor_id: string }>;
    expiredCount = due.length;
    for (const attempt of due) {
      db.prepare(`UPDATE placement_assessment_attempts SET status='expired', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND status IN ('in_progress','paused')`).run(attempt.id);
      db.prepare(`UPDATE visitors SET placement_status='not_started', placement_status_at=datetime('now'), current_placement_attempt_id=NULL WHERE id=? AND current_placement_attempt_id=?`).run(attempt.visitor_id, attempt.id);
    }
  })();
  writeAudit(req, `Placement expiry sweep: ${expiredCount} attempt(s) marked expired`, { newValue: JSON.stringify({ count: expiredCount, operatorId: user.userId, scope: scope.isAll ? 'all_branches' : scope.branchId }) });
  res.json({ ok: true, expired: expiredCount });
}));

placementAttemptRouter.get('/report', requirePermission('Report.View', 'Finance.Report'), ah(async (req, res) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  if (!from || !to || !validDate(from) || !validDate(to)) throw new HttpError(400, 'from and to must be valid YYYY-MM-DD dates.');
  if (from > to) throw new HttpError(400, 'from must be on or before to.');
  if (req.query.programVersionId != null && typeof req.query.programVersionId !== 'string') {
    throw new HttpError(400, 'programVersionId must be a single program version id.');
  }
  const scope = resolveBranchScope(req);
  res.json(placementActivityReport({
    from,
    to,
    branchId: scope.isAll ? null : scope.branchId,
    programVersionId: typeof req.query.programVersionId === 'string' ? req.query.programVersionId : null,
  }));
}));
