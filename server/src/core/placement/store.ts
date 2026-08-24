/**
 * Placement persistence and API projection authority.
 *
 * HTTP routes load placement rows through this module and never expose raw
 * attempt snapshots. Operational attempt projections intentionally exclude
 * answer keys while preserving the immutable assessment structure.
 */
import { db } from '../../db/connection.js';
import { id } from '../../utils/ids.js';
import { canAccessBranchResource } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { PLACEMENT_DEFAULTS } from '../configuration/policy-catalog.js';
import {
  type BlueprintBucket,
  type PlacementDeliveryMode,
  type PlacementDecisionRule,
  type PlacementComponentType,
  CANONICAL_COMPONENT_KEYS,
  CANONICAL_COMPONENT_WEIGHTS,
  componentSpec,
  DELIVERY_MODES,
} from './v1.js';
import { assertBlueprintComponentShape, type BlueprintComponent } from './blueprint-engine.js';

interface StmtLike {
  run(...args: any[]): any;
  get(...args: any[]): unknown;
  all(...args: any[]): unknown[];
}
type Stmt = StmtLike;

export { type PlacementComponentType, type PlacementDeliveryMode, type PlacementDecisionRule, type BlueprintBucket };

export type RequirementMode = 'required' | 'optional' | 'not_required';
export type ScoringMethod = 'auto' | 'manual';

export interface PlacementComponentConfig extends BlueprintComponent {
  order: number;
  scoringMethod: ScoringMethod;
}

export interface PolicyComponent extends PlacementComponentConfig {
  minScore?: number | null;
}

export const DEFAULT_COMPONENTS: PlacementComponentConfig[] = [...PLACEMENT_DEFAULTS.components].map((component: any, index) => ({
  ...component,
  order: index,
  timeLimitSeconds: component.durationMinutes ? Math.round(component.durationMinutes * 60) : null,
  scoringMethod: component.type === 'grammar' || component.type === 'reading' || component.type === 'listening' ? 'auto' : 'manual',
})) as PlacementComponentConfig[];

export const stmtVisitor: Stmt = db.prepare('SELECT * FROM visitors WHERE id = ?');
export const stmtProgramVersion: Stmt = db.prepare(`
  SELECT pv.*, p.name AS program_name, p.branch_id AS program_branch_id
  FROM program_versions pv
  JOIN programs p ON p.id = pv.program_id
  WHERE pv.id = ?
`);
export const stmtProfile: Stmt = db.prepare('SELECT * FROM placement_assessment_profiles WHERE program_version_id = ? AND branch_id = ?');
export const stmtGlobalProfile: Stmt = db.prepare('SELECT * FROM placement_assessment_profiles WHERE program_version_id = ? AND branch_id IS NULL LIMIT 1');
export const stmtAnyProfileForVersion: Stmt = db.prepare('SELECT 1 AS present FROM placement_assessment_profiles WHERE program_version_id = ? LIMIT 1');
export const stmtVersionLevels: Stmt = db.prepare(`
  SELECT id, name, code, "order", is_active FROM levels
  WHERE is_active = 1 AND (
    program_version_id = ?
    OR (program_id = (SELECT program_id FROM program_versions WHERE id = ?) AND program_version_id IS NULL)
  )
  ORDER BY "order"
`);

export const stmtAttempt: Stmt = db.prepare('SELECT * FROM placement_assessment_attempts WHERE id = ?');
export const stmtCurrentAttempt: Stmt = db.prepare(`
  SELECT * FROM placement_assessment_attempts
  WHERE visitor_id = ? AND status IN ('in_progress','paused')
  ORDER BY attempt_number DESC LIMIT 1
`);
export const stmtAttempts: Stmt = db.prepare(`
  SELECT id, visitor_id, program_version_id, profile_id, branch_id, attempt_number, status,
         started_at, completed_at, total_score, max_score, percentage, outcome,
         recommended_level_id, recommendation_text, examiner_user_id, notes,
         expires_at, paused_at, resumed_at, policy_version, decision_rule_id,
         override_level_id, override_reason, override_by, override_at, delivery_mode
  FROM placement_assessment_attempts WHERE visitor_id = ? ORDER BY attempt_number DESC
`);
export const stmtResults: Stmt = db.prepare('SELECT * FROM placement_assessment_results WHERE attempt_id = ? ORDER BY rowid');
export const stmtResponsesByAttempt: Stmt = db.prepare('SELECT * FROM placement_assessment_responses WHERE attempt_id = ? ORDER BY rowid');
export const stmtLastAttemptNumber: Stmt = db.prepare('SELECT COALESCE(MAX(attempt_number), 0) AS n FROM placement_assessment_attempts WHERE visitor_id = ?');
export const stmtInsertAttempt: Stmt = db.prepare(`
  INSERT INTO placement_assessment_attempts
    (id, visitor_id, program_version_id, profile_id, branch_id, attempt_number,
     status, started_at, snapshot_json, examiner_user_id, notes, expires_at, policy_version, delivery_mode)
  VALUES (?, ?, ?, ?, ?, ?, 'in_progress', datetime('now'), ?, ?, ?, ?, ?, ?)
`);
export const stmtUpsertResult: Stmt = db.prepare(`
  INSERT INTO placement_assessment_results
    (id, attempt_id, component_key, component_type, label, status, score, max_score,
     weight, selected_level_id, notes, result_text, payload_json, evaluator_user_id,
     completed_at, updated_at, raw_score, percentage, weighted_score, score_version,
     started_at, deadline_at, submitted_at, elapsed_seconds, timeout_flag, cefr_level, cefr_evidence_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          CASE WHEN ? = 'completed' THEN datetime('now') ELSE NULL END,
          datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    raw_score=excluded.raw_score,
    percentage=excluded.percentage,
    weighted_score=excluded.weighted_score,
    score_version=excluded.score_version,
    started_at=COALESCE(excluded.started_at, placement_assessment_results.started_at),
    deadline_at=COALESCE(excluded.deadline_at, placement_assessment_results.deadline_at),
    submitted_at=COALESCE(excluded.submitted_at, placement_assessment_results.submitted_at),
    elapsed_seconds=COALESCE(excluded.elapsed_seconds, placement_assessment_results.elapsed_seconds),
    timeout_flag=excluded.timeout_flag,
    cefr_level=excluded.cefr_level,
    cefr_evidence_json=excluded.cefr_evidence_json,
    completed_at=CASE WHEN excluded.status='completed' THEN datetime('now') ELSE placement_assessment_results.completed_at END,
    updated_at=datetime('now')
`);
export const stmtCompleteAttempt: Stmt = db.prepare(`
  UPDATE placement_assessment_attempts
  SET status='completed', completed_at=datetime('now'), total_score=?, max_score=?,
      percentage=?, recommended_level_id=?, recommendation_text=?, examiner_user_id=?,
      decision_rule_id=?, outcome=?, updated_at=datetime('now')
  WHERE id=? AND status='in_progress'
`);
export const stmtLatestCompletedAttempt: Stmt = db.prepare(`
  SELECT id, status, outcome, percentage, recommended_level_id, override_level_id, completed_at
  FROM placement_assessment_attempts
  WHERE visitor_id = ? AND status = 'completed'
  ORDER BY completed_at DESC, attempt_number DESC LIMIT 1
`);
export const stmtInsertPlacementFeePayment: Stmt = db.prepare(`
  INSERT INTO payments
    (id, student_id, amount, date, payment_method, status, category, notes,
     receipt_number, branch_id, idempotency_key)
  VALUES (?, NULL, ?, ?, 'cash', 'completed', 'placement', ?, ?, ?, ?)
`);
export const stmtUpdateVisitorPlacement: Stmt = db.prepare(`
  UPDATE visitors
  SET placement_score=?, placement_method=?, placement_status='completed',
      placement_status_at=datetime('now'), current_placement_attempt_id=?,
      stage=CASE WHEN stage IN ('placement_booking','placement_fee') THEN 'placement_completed' ELSE stage END
  WHERE id=?
`);
export const stmtVisitorCompletedCount: Stmt = db.prepare("SELECT COUNT(*) AS c FROM placement_assessment_attempts WHERE visitor_id = ? AND status='completed'");

export const stmtTestById: Stmt = db.prepare('SELECT * FROM placement_tests WHERE id = ?');
export const stmtInsertTest: Stmt = db.prepare(`
  INSERT INTO placement_tests
    (id, title, test_type, instructions, audio_url, transcript, passage, status,
     branch_id, created_by, difficulty, duration_seconds, rubric_id, word_target, content_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
export const stmtUpdateTest: Stmt = db.prepare(`
  UPDATE placement_tests
  SET title=?, test_type=?, instructions=?, audio_url=?, transcript=?, passage=?,
      status=?, difficulty=?, duration_seconds=?, rubric_id=?, word_target=?,
      content_json=?, version=version+1, updated_at=datetime('now')
  WHERE id=? AND version=?
`);
export const stmtQuestionsByTest: Stmt = db.prepare(`
  SELECT * FROM placement_test_questions WHERE test_id = ? ORDER BY order_index, rowid
`);
export const stmtDeleteQuestion: Stmt = db.prepare('DELETE FROM placement_test_questions WHERE id = ?');
export const stmtUpdateQuestion: Stmt = db.prepare(`
  UPDATE placement_test_questions
  SET qtype=?, prompt=?, options_json=?, answer_key=?, points=?, order_index=?, difficulty=?, section_key=?,
      cefr_level=?, topic=?, subskill=?, lifecycle_status=?, reviewed_by=?, approved_at=?, content_json=?,
      version=version+1
  WHERE id=?
`);
export const stmtInsertQuestion: Stmt = db.prepare(`
  INSERT INTO placement_test_questions
    (id, test_id, question_key, qtype, prompt, options_json, answer_key, points,
     order_index, difficulty, section_key, cefr_level, topic, subskill, lifecycle_status,
     version, created_by, reviewed_by, approved_at, content_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
export const stmtUpsertResponse: Stmt = db.prepare(`
  INSERT INTO placement_assessment_responses
    (id, attempt_id, test_id, question_id, question_key, response_json,
     auto_score, max_points, feedback, answered_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(attempt_id, question_id) DO UPDATE SET
    response_json=excluded.response_json,
    auto_score=excluded.auto_score,
    max_points=excluded.max_points,
    feedback=excluded.feedback,
    answered_at=datetime('now')
`);
export const stmtResponsesByAttemptTest: Stmt = db.prepare('SELECT * FROM placement_assessment_responses WHERE attempt_id = ? AND test_id = ? ORDER BY rowid');
export const stmtSectionsByTest: Stmt = db.prepare('SELECT * FROM placement_test_sections WHERE test_id = ? ORDER BY order_index, rowid');
export const stmtInsertSection: Stmt = db.prepare(`
  INSERT INTO placement_test_sections
    (id, test_id, section_key, title, kind, audio_url, transcript, body,
     duration_seconds, order_index)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
export const stmtDeleteSections: Stmt = db.prepare('DELETE FROM placement_test_sections WHERE test_id = ?');
export const stmtRubricById: Stmt = db.prepare('SELECT * FROM placement_rubrics WHERE id = ?');
export const stmtInsertRubric: Stmt = db.prepare('INSERT INTO placement_rubrics (id, title, kind, criteria_json, branch_id, created_by) VALUES (?, ?, ?, ?, ?, ?)');
export const stmtUpdateRubric: Stmt = db.prepare(`
  UPDATE placement_rubrics
  SET title=?, kind=?, criteria_json=?, version=version+1, updated_at=datetime('now')
  WHERE id=? AND version=?
`);
export const stmtRubricsByBranch: Stmt = db.prepare('SELECT * FROM placement_rubrics WHERE branch_id IS NULL OR branch_id = ? ORDER BY updated_at DESC');
export const stmtMediaById: Stmt = db.prepare('SELECT * FROM placement_media WHERE id = ?');
export const stmtInsertMedia: Stmt = db.prepare('INSERT INTO placement_media (id, filename, mime, size_bytes, sha256, storage_path, kind, branch_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
export const stmtMediaByBranch: Stmt = db.prepare('SELECT * FROM placement_media WHERE branch_id IS NULL OR branch_id = ? ORDER BY created_at DESC');

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function serializeQuestion(question: any) {
  return {
    id: question.id,
    key: question.question_key,
    qtype: question.qtype,
    prompt: question.prompt,
    options: parseJson(question.options_json, null),
    answerKey: question.answer_key,
    points: question.points,
    orderIndex: question.order_index,
    difficulty: question.difficulty ?? null,
    sectionKey: question.section_key ?? null,
    cefrLevel: question.cefr_level ?? null,
    topic: question.topic ?? null,
    subskill: question.subskill ?? null,
    lifecycleStatus: question.lifecycle_status,
    version: Number(question.version ?? 1),
    reviewedBy: question.reviewed_by ?? null,
    approvedAt: question.approved_at ?? null,
    contentJson: parseJson(question.content_json, null),
  };
}

export function serializeTest(test: any) {
  return {
    id: test.id,
    title: test.title,
    testType: test.test_type,
    instructions: test.instructions,
    audioUrl: test.audio_url,
    transcript: test.transcript,
    passage: test.passage,
    status: test.status,
    branchId: test.branch_id,
    createdBy: test.created_by,
    createdAt: test.created_at,
    updatedAt: test.updated_at,
    difficulty: test.difficulty ?? null,
    durationSeconds: test.duration_seconds ?? null,
    version: Number(test.version ?? 1),
    rubricId: test.rubric_id ?? null,
    wordTarget: test.word_target ?? null,
    contentJson: parseJson(test.content_json, null),
    sections: (stmtSectionsByTest.all(test.id) as any[]).map((section) => ({
      id: section.id,
      key: section.section_key,
      title: section.title,
      kind: section.kind,
      audioUrl: section.audio_url,
      transcript: section.transcript,
      body: section.body,
      durationSeconds: section.duration_seconds,
      orderIndex: section.order_index,
    })),
    questions: (stmtQuestionsByTest.all(test.id) as any[]).map(serializeQuestion),
  };
}

function normalizeStoredComponents(profile: any): PolicyComponent[] {
  const raw = parseJson<any[]>(profile.components_json, null as any);
  if (!Array.isArray(raw)) throw new HttpError(409, 'Stored placement blueprint is invalid.');
  const seen = new Set<string>();
  const components = raw.map((item, index): PolicyComponent => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new HttpError(409, 'Stored placement blueprint is invalid.');
    const type = String(item.type || item.key || '').trim() as PlacementComponentType;
    if (!(CANONICAL_COMPONENT_KEYS as readonly string[]).includes(type)) throw new HttpError(409, 'Stored placement blueprint uses a non-canonical component.');
    const spec = componentSpec(type);
    const key = String(item.key || type).trim();
    if (key !== type) throw new HttpError(409, 'Stored placement component key must equal its canonical component type.');
    if (seen.has(key)) throw new HttpError(409, 'Stored placement blueprint contains a duplicate component key.');
    seen.add(key);
    const bankIds = Array.isArray(item.bankIds) ? item.bankIds.map((bankId: unknown) => String(bankId).trim()).filter(Boolean) : [];
    const blueprintBuckets = Array.isArray(item.blueprintBuckets) ? item.blueprintBuckets as BlueprintBucket[] : [];
    const component: PolicyComponent = {
      key,
      type,
      label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : spec.label,
      required: item.required !== false,
      order: typeof item.order === 'number' && Number.isSafeInteger(item.order) ? item.order : index,
      weight: typeof item.weight === 'number' ? item.weight : CANONICAL_COMPONENT_WEIGHTS[type],
      maxScore: typeof item.maxScore === 'number' ? item.maxScore : spec.maxScore,
      durationMinutes: item.durationMinutes == null ? spec.defaultDurationMinutes : Number(item.durationMinutes),
      timeLimitSeconds: item.timeLimitSeconds == null ? Math.round((item.durationMinutes == null ? spec.defaultDurationMinutes : Number(item.durationMinutes)) * 60) : Number(item.timeLimitSeconds),
      instructions: typeof item.instructions === 'string' ? item.instructions : spec.label,
      bankIds,
      blueprintBuckets,
      scoringMethod: type === 'grammar' || type === 'reading' || type === 'listening' ? 'auto' : 'manual',
      minScore: item.minScore == null ? null : Number(item.minScore),
    };
    assertBlueprintComponentShape(component);
    if (component.maxScore !== spec.maxScore) throw new HttpError(409, `${component.label} maxScore must remain ${spec.maxScore}.`);
    if (Math.abs(component.weight - CANONICAL_COMPONENT_WEIGHTS[type]) > 0.01) throw new HttpError(409, `${component.label} weight is not canonical.`);
    return component;
  });
  for (const key of CANONICAL_COMPONENT_KEYS) {
    if (!components.some((component) => component.key === key)) {
      throw new HttpError(409, `Stored placement blueprint is missing the canonical ${key} component.`);
    }
  }
  return components.sort((left, right) => left.order - right.order);
}

export function parseComponents(profile: any): PolicyComponent[] {
  return normalizeStoredComponents(profile);
}

function parseDecisionRules(profile: any): PlacementDecisionRule[] {
  const parsed = parseJson<any[]>(profile.decision_rules_json, []);
  return Array.isArray(parsed) ? parsed as PlacementDecisionRule[] : [];
}

function serializeBankPreview(bankId: string) {
  const bank = stmtTestById.get(bankId) as any;
  return bank ? serializeTest(bank) : null;
}

export function mapProfile(profile: any, version: any, levels: any[]) {
  const components = parseComponents(profile);
  const requirementMode = String(profile.requirement_mode) as RequirementMode;
  const decisionRules = parseDecisionRules(profile);
  return {
    configured: true,
    enabled: requirementMode !== 'not_required',
    required: requirementMode === 'required',
    requirementMode,
    firstLevelExempt: Boolean(profile.first_level_exempt),
    expiresMinutes: profile.expires_minutes == null ? null : Number(profile.expires_minutes),
    decisionRules,
    deliveryModes: [...DELIVERY_MODES],
    method: 'canonical_v1',
    programVersionId: version.id,
    programId: version.program_id,
    programName: version.program_name,
    versionLabel: version.version_label,
    components,
    levels,
    allowRetake: Boolean(profile.allow_retake),
    maxAttempts: profile.max_attempts == null ? null : Number(profile.max_attempts),
    firstAttemptBillable: profile.first_attempt_billable == null ? true : Boolean(Number(profile.first_attempt_billable)),
    retakeBillable: Boolean(Number(profile.retake_billable ?? 0)),
    retakeFeeAmount: profile.retake_fee_amount == null ? null : Number(profile.retake_fee_amount),
    passScore: Number(profile.pass_score ?? PLACEMENT_DEFAULTS.passScore),
    instructions: profile.instructions ?? null,
    scoringModel: String(profile.scoring_model || 'canonical'),
    profileId: profile.id,
    policyVersion: Number(profile.version ?? 1),
    banks: components.flatMap((component) => component.bankIds).map(serializeBankPreview).filter(Boolean),
  };
}

function sanitizeSnapshot(rawSnapshot: unknown): Record<string, unknown> {
  const snapshot = typeof rawSnapshot === 'string'
    ? parseJson(rawSnapshot, {}) as Record<string, unknown>
    : {};
  if (Array.isArray((snapshot as any).tests)) {
    (snapshot as any).tests = (snapshot as any).tests.map((test: any) => ({
      ...test,
      questions: (test.questions || []).map((question: any) => {
        const safeQuestion = { ...question };
        delete safeQuestion.answer_key;
        return safeQuestion;
      }),
    }));
  }
  return snapshot;
}

export function mapAttempt(attempt: any, includeResponses = false) {
  const { snapshot_json: rawSnapshot, ...row } = attempt ?? {};
  const mapped: Record<string, unknown> = {
    ...row,
    results: stmtResults.all(attempt.id),
  };
  if (rawSnapshot !== undefined) mapped.snapshot = sanitizeSnapshot(rawSnapshot);
  if (includeResponses) {
    mapped.responses = (stmtResponsesByAttempt.all(attempt.id) as any[]).map((response) => ({
      testId: response.test_id,
      questionId: response.question_id,
      questionKey: response.question_key,
      response: parseJson(response.response_json, null),
      autoScore: response.auto_score,
      maxPoints: response.max_points,
      feedback: response.feedback,
      answeredAt: response.answered_at,
    }));
  }
  return mapped;
}

export function getVisitorOr404(visitorId: string) {
  const visitor = stmtVisitor.get(visitorId) as any;
  if (!visitor) throw new HttpError(404, 'Visitor not found.');
  return visitor;
}

export function assertVisitorBranchAccess(req: import('express').Request, visitor: any) {
  if (!visitor.branch_id || canAccessBranchResource(req, visitor.branch_id)) return;
  throw new HttpError(403, 'Visitor belongs to another branch.');
}

export function getUserContext(req: import('express').Request) {
  const user = req.user;
  if (!user?.userId || !user?.branchId || !user?.fullName) throw new HttpError(403, 'User context missing.');
  return user;
}

export function normalizeScore(value: unknown, maxScore: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maxScore) {
    throw new HttpError(400, `Score must be a number between 0 and ${maxScore}.`);
  }
  return Math.round(value * 100) / 100;
}

export function componentScore(component: PlacementComponentConfig, body: any): { score: number | null; payload: any } {
  const score = normalizeScore(body?.score, component.maxScore);
  return {
    score,
    payload: {
      mode: 'manual_entry',
      deliveryMode: body?.deliveryMode ?? null,
      selectedLevelId: body?.selectedLevelId ?? null,
      answerSummary: body?.answerSummary ?? null,
      rubric: body?.rubric ?? null,
    },
  };
}

export function getRequiredMissing(components: PlacementComponentConfig[], results: any[]) {
  const done = new Set(results
    .filter((result) => result.status === 'completed' || result.status === 'waived')
    .map((result) => result.component_key));
  return components.filter((component) => component.required && !done.has(component.key)).map((component) => component.key);
}

export interface UpsertResultArgs {
  attemptId: string;
  key: string;
  type: PlacementComponentType;
  label: string;
  status: 'pending' | 'in_progress' | 'completed' | 'waived' | 'timed_out';
  score: number | null;
  maxScore: number;
  weight: number;
  selectedLevelId?: string | null;
  notes?: string | null;
  resultText?: string | null;
  payloadJson?: string | null;
  evaluatorUserId: string | null;
  rawScore?: number | null;
  percentage?: number | null;
  weightedScore?: number | null;
  scoreVersion?: number;
  startedAt?: string | null;
  deadlineAt?: string | null;
  submittedAt?: string | null;
  elapsedSeconds?: number | null;
  timeoutFlag?: number;
  cefrLevel?: string | null;
  cefrEvidenceJson?: string | null;
}

export function upsertResult(args: UpsertResultArgs) {
  return stmtUpsertResult.run(
    id('par'), args.attemptId, args.key, args.type, args.label, args.status,
    args.score, args.maxScore, args.weight, args.selectedLevelId ?? null,
    args.notes ?? null, args.resultText ?? null, args.payloadJson ?? null,
    args.evaluatorUserId, args.status, args.rawScore ?? null,
    args.percentage ?? null, args.weightedScore ?? null, args.scoreVersion ?? 1,
    args.startedAt ?? null, args.deadlineAt ?? null, args.submittedAt ?? null,
    args.elapsedSeconds ?? null, args.timeoutFlag ?? 0, args.cefrLevel ?? null,
    args.cefrEvidenceJson ?? null,
  );
}
