/**
 * Placement persistence and API projection authority.
 *
 * HTTP routes load placement rows through this module and never expose raw
 * attempt snapshots. Operational profile projections intentionally exclude
 * answer keys; the scorer reads the immutable database snapshot directly.
 */
import { db } from '../../db/connection.js';
import { id } from '../../utils/ids.js';
import { canAccessBranchResource } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { PLACEMENT_DEFAULTS } from '../configuration/policy-catalog.js';

interface StmtLike {
  run(...args: any[]): any;
  get(...args: any[]): unknown;
  all(...args: any[]): unknown[];
}
type Stmt = StmtLike;

export type PlacementComponentType = 'skill_scores' | 'written_test' | 'interview' | 'level_assessment' | 'custom_score' | 'content_test';
export type RequirementMode = 'required' | 'optional' | 'not_required';
export type ScoringMethod = 'auto' | 'manual' | 'hybrid';

export interface PlacementComponentConfig {
  key: string;
  type: PlacementComponentType;
  label: string;
  required: boolean;
  weight: number;
  maxScore: number;
  durationMinutes?: number;
  instructions?: string | null;
  skills?: readonly ('grammar' | 'vocabulary' | 'reading' | 'listening' | 'writing' | 'speaking')[];
  testId?: string;
}

export interface PolicyComponent extends PlacementComponentConfig {
  order: number;
  timeLimitSeconds?: number | null;
  minScore?: number | null;
  scoringMethod?: ScoringMethod;
}

export const DEFAULT_COMPONENTS: PlacementComponentConfig[] = [...PLACEMENT_DEFAULTS.components] as PlacementComponentConfig[];

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
export const stmtPlacementRules: Stmt = db.prepare(`
  SELECT id, name, min_score, max_score, recommended_level_id, recommended_level_code,
         branch_id, sort_order, is_active, conditions_json
  FROM placement_rules
  WHERE program_version_id = ? AND (branch_id = ? OR branch_id IS NULL) AND is_active = 1
  ORDER BY branch_id IS NULL, sort_order, min_score
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
         override_level_id, override_reason, override_by, override_at
  FROM placement_assessment_attempts WHERE visitor_id = ? ORDER BY attempt_number DESC
`);
export const stmtResults: Stmt = db.prepare('SELECT * FROM placement_assessment_results WHERE attempt_id = ? ORDER BY rowid');
export const stmtResponsesByAttempt: Stmt = db.prepare('SELECT * FROM placement_assessment_responses WHERE attempt_id = ? ORDER BY rowid');
export const stmtLastAttemptNumber: Stmt = db.prepare('SELECT COALESCE(MAX(attempt_number), 0) AS n FROM placement_assessment_attempts WHERE visitor_id = ?');
export const stmtInsertAttempt: Stmt = db.prepare(`
  INSERT INTO placement_assessment_attempts
    (id, visitor_id, program_version_id, profile_id, branch_id, attempt_number,
     status, started_at, snapshot_json, examiner_user_id, notes, expires_at, policy_version)
  VALUES (?, ?, ?, ?, ?, ?, 'in_progress', datetime('now'), ?, ?, ?, ?, ?)
`);
export const stmtUpsertResult: Stmt = db.prepare(`
  INSERT INTO placement_assessment_results
    (id, attempt_id, component_key, component_type, label, status, score, max_score,
     weight, selected_level_id, notes, result_text, payload_json, evaluator_user_id,
     completed_at, updated_at, raw_score, percentage, weighted_score, score_version,
     started_at, deadline_at, submitted_at, elapsed_seconds, timeout_flag)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          CASE WHEN ? = 'completed' THEN datetime('now') ELSE NULL END,
          datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
export const stmtQuestionsByTest: Stmt = db.prepare('SELECT * FROM placement_test_questions WHERE test_id = ? ORDER BY order_index, rowid');
export const stmtDeleteQuestion: Stmt = db.prepare('DELETE FROM placement_test_questions WHERE id = ?');
export const stmtUpdateQuestion: Stmt = db.prepare('UPDATE placement_test_questions SET qtype=?, prompt=?, options_json=?, answer_key=?, points=?, order_index=?, difficulty=?, section_key=? WHERE id=?');
export const stmtInsertQuestion: Stmt = db.prepare(`
  INSERT INTO placement_test_questions
    (id, test_id, question_key, qtype, prompt, options_json, answer_key, points,
     order_index, difficulty, section_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

function parseJson(value: unknown, fallback: unknown) {
  if (typeof value !== 'string' || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
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
    questions: (stmtQuestionsByTest.all(test.id) as any[]).map((question) => ({
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
    })),
  };
}

function normalizeStoredComponents(profile: any): PolicyComponent[] {
  const raw = parseJson(profile.components_json, null);
  if (!Array.isArray(raw)) throw new HttpError(409, 'Stored placement blueprint is invalid.');
  const components = raw.map((item: any, index: number): PolicyComponent => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || typeof item.key !== 'string' || typeof item.label !== 'string' || typeof item.type !== 'string'
        || (item.required !== undefined && typeof item.required !== 'boolean')
        || (item.order != null && (typeof item.order !== 'number' || !Number.isSafeInteger(item.order)))
        || typeof item.weight !== 'number' || typeof item.maxScore !== 'number'
        || (item.durationMinutes != null && typeof item.durationMinutes !== 'number')
        || (item.timeLimitSeconds != null && typeof item.timeLimitSeconds !== 'number')
        || (item.minScore != null && typeof item.minScore !== 'number')
        || (item.scoringMethod != null && typeof item.scoringMethod !== 'string')
        || (item.instructions != null && typeof item.instructions !== 'string')
        || (item.skills != null && (!Array.isArray(item.skills) || item.skills.some((skill: unknown) => typeof skill !== 'string')))
        || (item.testId != null && typeof item.testId !== 'string')) {
      throw new HttpError(409, 'Stored placement blueprint has invalid field types.');
    }
    return {
      key: item.key.trim(),
      type: item.type as PlacementComponentType,
      label: item.label.trim(),
      required: item.required !== false,
      order: item.order == null ? index : item.order,
      weight: item.weight,
      maxScore: item.maxScore,
      durationMinutes: item.durationMinutes == null ? undefined : item.durationMinutes,
      timeLimitSeconds: item.timeLimitSeconds == null
        ? (item.durationMinutes == null ? null : Math.round(item.durationMinutes * 60))
        : item.timeLimitSeconds,
      minScore: item.minScore == null ? null : item.minScore,
      scoringMethod: (item.scoringMethod == null
        ? (item.type === 'content_test' ? 'hybrid' : 'manual')
        : item.scoringMethod) as ScoringMethod,
      instructions: item.instructions == null ? null : item.instructions,
      skills: Array.isArray(item.skills) ? item.skills as PolicyComponent['skills'] : undefined,
      testId: item.testId == null ? undefined : item.testId.trim(),
    };
  });
  const validTypes = new Set<PlacementComponentType>(['skill_scores','written_test','interview','level_assessment','custom_score','content_test']);
  const validSkills = new Set(['grammar','vocabulary','reading','listening','writing','speaking']);
  const keys = new Set<string>();
  let totalWeight = 0;
  for (const component of components) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(component.key) || !component.label || component.label.length > 160
        || (component.instructions != null && component.instructions.length > 2000)
        || keys.has(component.key) || !validTypes.has(component.type)) {
      throw new HttpError(409, 'Stored placement blueprint is invalid.');
    }
    if (!Number.isFinite(component.order) || component.order < 0 ||
        !Number.isFinite(component.weight) || component.weight < 0 || component.weight > 100 ||
        !Number.isFinite(component.maxScore) || component.maxScore <= 0 ||
        (component.minScore != null && (!Number.isFinite(component.minScore) || component.minScore < 0 || component.minScore > component.maxScore)) ||
        (component.durationMinutes != null && (!Number.isFinite(component.durationMinutes) || component.durationMinutes <= 0)) ||
        (component.timeLimitSeconds != null && (!Number.isSafeInteger(component.timeLimitSeconds) || component.timeLimitSeconds <= 0))) {
      throw new HttpError(409, 'Stored placement blueprint contains invalid scoring or timing configuration.');
    }
    if (!['auto','manual','hybrid'].includes(String(component.scoringMethod)) ||
        (component.type !== 'content_test' && component.scoringMethod !== 'manual') ||
        (component.type === 'content_test' && !component.testId) ||
        (component.type !== 'content_test' && component.testId)) {
      throw new HttpError(409, 'Stored placement blueprint contains invalid content or scoring configuration.');
    }
    if (component.skills != null && (component.type !== 'skill_scores' || component.skills.length === 0 ||
        new Set(component.skills).size !== component.skills.length || component.skills.some((skill) => !validSkills.has(skill)))) {
      throw new HttpError(409, 'Stored placement blueprint contains invalid skill configuration.');
    }
    keys.add(component.key);
    totalWeight += component.weight;
  }
  if (components.length > 0 && Math.abs(totalWeight - 100) > 0.01) {
    throw new HttpError(409, 'Stored placement blueprint weights must total 100%.');
  }
  return components.sort((left, right) => left.order - right.order);
}

export function parseComponents(profile: any): PolicyComponent[] {
  return normalizeStoredComponents(profile);
}

function serializeContentTest(test: any) {
  const rubric = test.rubric_id ? stmtRubricById.get(test.rubric_id) as any : null;
  return {
    id: test.id,
    title: test.title,
    testType: test.test_type,
    instructions: test.instructions,
    audioUrl: test.audio_url,
    transcript: test.transcript,
    passage: test.passage,
    status: test.status,
    difficulty: test.difficulty ?? null,
    durationSeconds: test.duration_seconds ?? null,
    version: Number(test.version ?? 1),
    rubric: rubric ? {
      id: rubric.id,
      title: rubric.title,
      kind: rubric.kind,
      version: Number(rubric.version ?? 1),
      criteria: parseJson(rubric.criteria_json, []),
    } : null,
    sections: (stmtSectionsByTest.all(test.id) as any[]).map((section) => ({
      key: section.section_key,
      title: section.title,
      kind: section.kind,
      audioUrl: section.audio_url,
      transcript: section.transcript,
      body: section.body,
      durationSeconds: section.duration_seconds,
      orderIndex: section.order_index,
    })),
    questions: (stmtQuestionsByTest.all(test.id) as any[]).map((question) => ({
      id: question.id,
      questionKey: question.question_key,
      qtype: question.qtype,
      prompt: question.prompt,
      options: parseJson(question.options_json, null),
      points: question.points,
      orderIndex: question.order_index,
      difficulty: question.difficulty ?? null,
      sectionKey: question.section_key ?? null,
    })),
  };
}

export function mapProfile(profile: any, version: any, levels: any[], rules: any[]) {
  const components = parseComponents(profile);
  const requirementMode = String(profile.requirement_mode) as RequirementMode;
  const method = components.length > 1 ? 'hybrid' : (components[0]?.type ?? 'skill_scores');
  const decisionRules = profile.decision_rules_json == null
    ? []
    : parseJson(profile.decision_rules_json, null);
  if (!Array.isArray(decisionRules)) throw new HttpError(409, 'Stored placement decision rules are invalid.');
  return {
    contentTests: components
      .filter((component) => component.type === 'content_test' && component.testId)
      .map((component) => stmtTestById.get(component.testId!) as any)
      .filter(Boolean)
      .map(serializeContentTest),
    configured: true,
    enabled: requirementMode !== 'not_required',
    required: requirementMode === 'required',
    requirementMode,
    firstLevelExempt: Boolean(profile.first_level_exempt),
    expiresMinutes: profile.expires_minutes == null ? null : Number(profile.expires_minutes),
    decisionRules,
    method,
    programVersionId: version.id,
    programId: version.program_id,
    programName: version.program_name,
    versionLabel: version.version_label,
    components,
    levels,
    placementRules: rules,
    allowRetake: Boolean(profile.allow_retake),
    maxAttempts: profile.max_attempts == null ? null : Number(profile.max_attempts),
    firstAttemptBillable: profile.first_attempt_billable == null ? true : Boolean(Number(profile.first_attempt_billable)),
    retakeBillable: Boolean(Number(profile.retake_billable ?? 0)),
    retakeFeeAmount: profile.retake_fee_amount == null ? null : Number(profile.retake_fee_amount),
    passScore: Number(profile.pass_score ?? PLACEMENT_DEFAULTS.passScore),
    instructions: profile.instructions ?? null,
    scoringModel: String(profile.scoring_model || 'weighted_average'),
    profileId: profile.id,
    policyVersion: Number(profile.version ?? 1),
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
  return value;
}

export function componentScore(component: PlacementComponentConfig, body: any): { score: number | null; payload: any } {
  if (component.type === 'skill_scores') {
    const skills = Array.isArray(component.skills) && component.skills.length > 0
      ? component.skills
      : ['grammar', 'vocabulary', 'reading', 'listening', 'writing', 'speaking'];
    const perSkillMax = 25;
    const normalized: Record<string, number> = {};
    for (const skill of skills) {
      if (body?.skills?.[skill] == null || body?.skills?.[skill] === '') {
        throw new HttpError(400, `Score for ${skill} is required.`);
      }
      normalized[skill] = normalizeScore(body.skills[skill], perSkillMax);
    }
    const score = Math.round(
      (Object.values(normalized).reduce((sum, value) => sum + value, 0) / (skills.length * perSkillMax))
      * component.maxScore * 100,
    ) / 100;
    return { score, payload: { skills: normalized } };
  }
  if (component.type === 'level_assessment' && body?.score == null && body?.selectedLevelId) {
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
}

export function upsertResult(args: UpsertResultArgs) {
  return stmtUpsertResult.run(
    id('par'), args.attemptId, args.key, args.type, args.label, args.status,
    args.score, args.maxScore, args.weight, args.selectedLevelId ?? null,
    args.notes ?? null, args.resultText ?? null, args.payloadJson ?? null,
    args.evaluatorUserId, args.status, args.rawScore ?? null,
    args.percentage ?? null, args.weightedScore ?? null, args.scoreVersion ?? 1,
    args.startedAt ?? null, args.deadlineAt ?? null, args.submittedAt ?? null,
    args.elapsedSeconds ?? null, args.timeoutFlag ?? 0,
  );
}
