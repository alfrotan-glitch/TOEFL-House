/**
 * Placement Engine — shared store: types, prepared statements, serializers.
 * Single source of truth for placement data access used by the attempt and
 * test-bank routers and by the policy/timing/scoring/decision engines.
 */
import { db } from '../../db/connection.js';
import { id } from '../../utils/ids.js';
import { canAccessBranchResource } from '../../middleware/auth.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { PLACEMENT_DEFAULTS } from '../configuration/policy-catalog.js';

interface StmtLike {
  run(...args: any[]): unknown;
  get(...args: any[]): unknown;
  all(...args: any[]): unknown[];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

/** Policy component config: every field the Placement Policy defines per component. */
export interface PolicyComponent extends PlacementComponentConfig {
  enabled: boolean;
  order: number;
  timeLimitSeconds?: number | null;
  minScore?: number | null;
  scoringMethod?: ScoringMethod;
  retryPolicy?: 'none' | 'once' | 'unlimited';
  passFail?: 'none' | 'pass' | 'fail';
}

export const DEFAULT_COMPONENTS: PlacementComponentConfig[] = [...PLACEMENT_DEFAULTS.components] as PlacementComponentConfig[];

// ── Prepared statements ─────────────────────────────────────────────────────
export const stmtVisitor: Stmt = db.prepare('SELECT * FROM visitors WHERE id = ?');
export const stmtProgramVersion: Stmt = db.prepare(`
  SELECT pv.*, p.name AS program_name, p.branch_id AS program_branch_id
  FROM program_versions pv
  JOIN programs p ON p.id = pv.program_id
  WHERE pv.id = ?
`);
export const stmtProfile: Stmt = db.prepare('SELECT * FROM placement_assessment_profiles WHERE program_version_id = ? AND branch_id = ?');
export const stmtGlobalProfile: Stmt = db.prepare('SELECT * FROM placement_assessment_profiles WHERE program_version_id = ? AND branch_id IS NULL ORDER BY updated_at DESC, version DESC LIMIT 1');
/** Does ANY placement profile exist for this program version, on any branch? */
export const stmtAnyProfileForVersion: Stmt = db.prepare('SELECT 1 AS present FROM placement_assessment_profiles WHERE program_version_id = ? LIMIT 1');
export const stmtLevels: Stmt = db.prepare('SELECT id, name, code, "order", is_active FROM levels WHERE program_version_id = ? ORDER BY "order"');
export const stmtVersionLevels: Stmt = db.prepare(`
  SELECT id, name, code, "order", is_active FROM levels
  WHERE program_version_id = ? OR (program_id = (SELECT program_id FROM program_versions WHERE id = ?) AND program_version_id IS NULL)
  ORDER BY "order"
`);
export const stmtPlacementRules: Stmt = db.prepare(`
  SELECT id, name, min_score, max_score, recommended_level_id, recommended_level_code, sort_order, is_active, conditions_json
  FROM placement_rules
  WHERE program_version_id = ? AND (branch_id = ? OR branch_id IS NULL) AND is_active = 1
  ORDER BY sort_order, min_score
`);
export const stmtAttempt: Stmt = db.prepare('SELECT * FROM placement_assessment_attempts WHERE id = ?');
export const stmtCurrentAttempt: Stmt = db.prepare(`
  SELECT * FROM placement_assessment_attempts
  WHERE visitor_id = ? AND status IN ('in_progress','paused')
  ORDER BY attempt_number DESC LIMIT 1
`);
export const stmtAttempts: Stmt = db.prepare(`
  SELECT id, visitor_id, program_version_id, profile_id, attempt_number, status, started_at, completed_at,
         total_score, max_score, percentage, recommended_level_id, recommendation_text, examiner_user_id, notes,
         expires_at, paused_at, resumed_at, policy_version, decision_rule_id, override_level_id, override_reason, override_by, override_at
  FROM placement_assessment_attempts WHERE visitor_id = ? ORDER BY attempt_number DESC
`);
export const stmtResults: Stmt = db.prepare(`SELECT * FROM placement_assessment_results WHERE attempt_id = ? ORDER BY rowid`);
export const stmtExistingAttemptCount: Stmt = db.prepare("SELECT COUNT(*) AS c FROM placement_assessment_attempts WHERE visitor_id = ? AND status = 'completed'");
export const stmtLastAttemptNumber: Stmt = db.prepare('SELECT COALESCE(MAX(attempt_number), 0) AS n FROM placement_assessment_attempts WHERE visitor_id = ?');
export const stmtInsertAttempt: Stmt = db.prepare(`
  INSERT INTO placement_assessment_attempts
  (id, visitor_id, program_version_id, profile_id, branch_id, attempt_number, status, started_at, snapshot_json, examiner_user_id, notes, expires_at, policy_version)
  VALUES (?, ?, ?, ?, ?, ?, 'in_progress', datetime('now'), ?, ?, ?, ?, ?)
`);
export const stmtUpdateAttemptTiming: Stmt = db.prepare(`
  UPDATE placement_assessment_attempts SET expires_at=?, updated_at=datetime('now') WHERE id=?
`);
export const stmtUpsertResult: Stmt = db.prepare(`
  INSERT INTO placement_assessment_results
  (id, attempt_id, component_key, component_type, label, status, score, max_score, weight, selected_level_id, notes, result_text, payload_json, evaluator_user_id, completed_at, updated_at,
   raw_score, percentage, weighted_score, score_version, started_at, deadline_at, submitted_at, elapsed_seconds, timeout_flag)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'completed' THEN datetime('now') ELSE NULL END, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    elapsed_seconds=excluded.elapsed_seconds,
    timeout_flag=excluded.timeout_flag,
    completed_at=CASE WHEN excluded.status='completed' THEN datetime('now') ELSE placement_assessment_results.completed_at END,
    updated_at=datetime('now')
`);
export const stmtCompleteAttempt: Stmt = db.prepare(`
  UPDATE placement_assessment_attempts
  SET status='completed', completed_at=datetime('now'), total_score=?, max_score=?, percentage=?, recommended_level_id=?, recommendation_text=?, examiner_user_id=?, decision_rule_id=?, outcome=?, updated_at=datetime('now')
  WHERE id=? AND status IN ('in_progress','paused')
`);
/** Latest completed sitting for a visitor — the row conversion is judged on. */
export const stmtLatestCompletedAttempt: Stmt = db.prepare(`
  SELECT id, status, outcome, percentage, recommended_level_id, override_level_id, completed_at
  FROM placement_assessment_attempts
  WHERE visitor_id = ? AND status = 'completed'
  ORDER BY completed_at DESC, attempt_number DESC
  LIMIT 1
`);
/** Rewrite the persisted outcome after an audited correction/override. */
export const stmtSetAttemptOutcome: Stmt = db.prepare(
  `UPDATE placement_assessment_attempts SET outcome=?, updated_at=datetime('now') WHERE id=?`
);
export const stmtInsertPlacementFeePayment: Stmt = db.prepare(
  `INSERT INTO payments (id, student_id, amount, date, payment_method, status, category, notes, receipt_number, branch_id, idempotency_key)
   VALUES (?, NULL, ?, ?, 'cash', 'completed', 'placement', ?, ?, ?, ?)`
);
export const stmtUpdateVisitorPlacement: Stmt = db.prepare(`
  UPDATE visitors
  SET placement_score=?, placement_method=?, placement_status='completed', placement_status_at=datetime('now'), current_placement_attempt_id=?,
      stage=CASE WHEN stage IN ('placement_booking','placement_fee') THEN 'placement_completed' ELSE stage END
  WHERE id=?
`);
export const stmtVisitorCompletedCount: Stmt = db.prepare(`SELECT COUNT(*) AS c FROM placement_assessment_attempts WHERE visitor_id = ? AND status='completed'`);

// ── Content test bank ───────────────────────────────────────────────────────
export const stmtTestById: Stmt = db.prepare('SELECT * FROM placement_tests WHERE id = ?');
export const stmtInsertTest: Stmt = db.prepare(`INSERT INTO placement_tests (id, title, test_type, instructions, audio_url, transcript, passage, status, branch_id, created_by, difficulty, duration_seconds, rubric_id, word_target, content_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
export const stmtUpdateTest: Stmt = db.prepare(`UPDATE placement_tests SET title=?, test_type=?, instructions=?, audio_url=?, transcript=?, passage=?, status=?, difficulty=?, duration_seconds=?, rubric_id=?, word_target=?, content_json=?, version=version+1, updated_at=datetime('now') WHERE id=?`);
export const stmtBumpTestVersion: Stmt = db.prepare(`UPDATE placement_tests SET version=version+1, updated_at=datetime('now') WHERE id=?`);
export const stmtQuestionsByTest: Stmt = db.prepare('SELECT * FROM placement_test_questions WHERE test_id = ? ORDER BY order_index, rowid');
export const stmtDeleteQuestion: Stmt = db.prepare('DELETE FROM placement_test_questions WHERE id = ?');
export const stmtUpdateQuestion: Stmt = db.prepare('UPDATE placement_test_questions SET qtype=?, prompt=?, options_json=?, answer_key=?, points=?, order_index=?, difficulty=?, section_key=? WHERE id=?');
export const stmtInsertQuestion: Stmt = db.prepare(`INSERT INTO placement_test_questions (id, test_id, question_key, qtype, prompt, options_json, answer_key, points, order_index, difficulty, section_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
export const stmtUpsertResponse: Stmt = db.prepare(`INSERT INTO placement_assessment_responses (id, attempt_id, test_id, question_id, question_key, response_json, auto_score, max_points, feedback, answered_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(attempt_id, question_id) DO UPDATE SET
    response_json=excluded.response_json, auto_score=excluded.auto_score, max_points=excluded.max_points,
    feedback=excluded.feedback, answered_at=datetime('now')`);
export const stmtResponsesByAttemptTest: Stmt = db.prepare('SELECT * FROM placement_assessment_responses WHERE attempt_id = ? AND test_id = ? ORDER BY rowid');
export const stmtSectionsByTest: Stmt = db.prepare('SELECT * FROM placement_test_sections WHERE test_id = ? ORDER BY order_index, rowid');
export const stmtInsertSection: Stmt = db.prepare(`INSERT INTO placement_test_sections (id, test_id, section_key, title, kind, audio_url, transcript, body, duration_seconds, order_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
export const stmtDeleteSections: Stmt = db.prepare('DELETE FROM placement_test_sections WHERE test_id = ?');
export const stmtRubricById: Stmt = db.prepare('SELECT * FROM placement_rubrics WHERE id = ?');
export const stmtInsertRubric: Stmt = db.prepare(`INSERT INTO placement_rubrics (id, title, kind, criteria_json, branch_id, created_by) VALUES (?, ?, ?, ?, ?, ?)`);
export const stmtUpdateRubric: Stmt = db.prepare(`UPDATE placement_rubrics SET title=?, kind=?, criteria_json=?, updated_at=datetime('now') WHERE id=?`);
export const stmtRubricsByBranch: Stmt = db.prepare(`SELECT * FROM placement_rubrics WHERE branch_id IS NULL OR branch_id = ? ORDER BY updated_at DESC`);
export const stmtMediaById: Stmt = db.prepare('SELECT * FROM placement_media WHERE id = ?');
export const stmtInsertMedia: Stmt = db.prepare(`INSERT INTO placement_media (id, filename, mime, size_bytes, sha256, storage_path, kind, branch_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
export const stmtMediaByBranch: Stmt = db.prepare(`SELECT * FROM placement_media WHERE branch_id IS NULL OR branch_id = ? ORDER BY created_at DESC`);

// ── Serializers ─────────────────────────────────────────────────────────────
export function serializeTest(test: any) {
  return {
    id: test.id, title: test.title, testType: test.test_type, instructions: test.instructions,
    audioUrl: test.audio_url, transcript: test.transcript, passage: test.passage, status: test.status,
    branchId: test.branch_id, createdBy: test.created_by, createdAt: test.created_at, updatedAt: test.updated_at,
    difficulty: test.difficulty ?? null, durationSeconds: test.duration_seconds ?? null,
    version: Number(test.version ?? 1), rubricId: test.rubric_id ?? null, wordTarget: test.word_target ?? null,
    contentJson: test.content_json ? JSON.parse(test.content_json) : null,
    sections: (stmtSectionsByTest.all(test.id) as any[]).map((s) => ({
      id: s.id, key: s.section_key, title: s.title, kind: s.kind, audioUrl: s.audio_url,
      transcript: s.transcript, body: s.body, durationSeconds: s.duration_seconds, orderIndex: s.order_index,
    })),
    questions: (stmtQuestionsByTest.all(test.id) as any[]).map((q) => ({
      id: q.id, key: q.question_key, qtype: q.qtype, prompt: q.prompt,
      options: q.options_json ? JSON.parse(q.options_json) : null,
      answerKey: q.answer_key, points: q.points, orderIndex: q.order_index,
      difficulty: q.difficulty ?? null, sectionKey: q.section_key ?? null,
    })),
  };
}

export function parseComponents(profile: any): PolicyComponent[] {
  let parsed: unknown;
  try { parsed = JSON.parse(profile.components_json || '[]'); } catch { parsed = []; }
  if (!Array.isArray(parsed) || parsed.length === 0) return normalizePolicyComponents({ components_json: JSON.stringify(DEFAULT_COMPONENTS) });
  return parsed.map((raw: any, index: number) => ({
    key: String(raw.key || '').trim(),
    type: raw.type as PlacementComponentType,
    label: String(raw.label || '').trim(),
    required: raw.required !== false,
    enabled: raw.enabled !== false,
    order: raw.order == null ? index : Number(raw.order),
    weight: Number(raw.weight),
    maxScore: Number(raw.maxScore),
    durationMinutes: raw.durationMinutes == null ? undefined : Number(raw.durationMinutes),
    timeLimitSeconds: raw.timeLimitSeconds == null ? (raw.durationMinutes == null ? null : Number(raw.durationMinutes) * 60) : Number(raw.timeLimitSeconds),
    minScore: raw.minScore == null ? null : Number(raw.minScore),
    scoringMethod: (['auto', 'manual', 'hybrid'].includes(raw.scoringMethod) ? raw.scoringMethod : raw.type === 'content_test' ? 'hybrid' : 'manual') as ScoringMethod,
    retryPolicy: (['none', 'once', 'unlimited'].includes(raw.retryPolicy) ? raw.retryPolicy : 'none') as 'none' | 'once' | 'unlimited',
    passFail: (['none', 'pass', 'fail'].includes(raw.passFail) ? raw.passFail : 'none') as 'none' | 'pass' | 'fail',
    instructions: raw.instructions == null ? null : String(raw.instructions),
    skills: Array.isArray(raw.skills) ? raw.skills.map(String) : undefined,
    testId: raw.testId == null ? undefined : String(raw.testId),
  }));
}

function normalizePolicyComponents(profile: any): PolicyComponent[] {
  let raw: unknown;
  try { raw = JSON.parse(profile.components_json || '[]'); } catch { raw = []; }
  const parsed: any[] = Array.isArray(raw) && raw.length > 0 ? raw : (DEFAULT_COMPONENTS as any[]);
  const components = parsed.map((raw: any, index: number) => ({
    key: String(raw.key || '').trim(),
    type: raw.type as PlacementComponentType,
    label: String(raw.label || '').trim(),
    required: raw.required !== false,
    enabled: raw.enabled !== false,
    order: raw.order == null ? index : Number(raw.order),
    weight: Number(raw.weight),
    maxScore: Number(raw.maxScore),
    durationMinutes: raw.durationMinutes == null ? undefined : Number(raw.durationMinutes),
    timeLimitSeconds: raw.timeLimitSeconds == null ? (raw.durationMinutes == null ? null : Number(raw.durationMinutes) * 60) : Number(raw.timeLimitSeconds),
    minScore: raw.minScore == null ? null : Number(raw.minScore),
    scoringMethod: (['auto', 'manual', 'hybrid'].includes(raw.scoringMethod) ? raw.scoringMethod : raw.type === 'content_test' ? 'hybrid' : 'manual') as ScoringMethod,
    retryPolicy: (['none', 'once', 'unlimited'].includes(raw.retryPolicy) ? raw.retryPolicy : 'none') as 'none' | 'once' | 'unlimited',
    passFail: (['none', 'pass', 'fail'].includes(raw.passFail) ? raw.passFail : 'none') as 'none' | 'pass' | 'fail',
    instructions: raw.instructions == null ? null : String(raw.instructions),
    skills: Array.isArray(raw.skills) ? raw.skills.map(String) : undefined,
    testId: raw.testId == null ? undefined : String(raw.testId),
  }));
  const validTypes = new Set<PlacementComponentType>(['skill_scores','written_test','interview','level_assessment','custom_score','content_test']);
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
  if (!user?.userId || !user?.branchId || !user?.fullName || !user?.role) throw new HttpError(403, 'User context missing.');
  return user;
}

export function mapProfile(profile: any, version: any, levels: any[], rules: any[]) {
  const components = parseComponents(profile);
  return {
    contentTests: components.filter((c) => c.type === 'content_test' && c.testId).map((c) => {
      const test = stmtTestById.get(c.testId!) as any;
      if (!test) return null;
      // Answer keys never leave the server in the read view; they are only in
      // the immutable attempt snapshot used by the auto-scorer.
      return {
        id: test.id, title: test.title, testType: test.test_type, instructions: test.instructions,
        audioUrl: test.audio_url, transcript: test.transcript, passage: test.passage, status: test.status,
        difficulty: test.difficulty ?? null, durationSeconds: test.duration_seconds ?? null, version: Number(test.version ?? 1),
        rubric: test.rubric_id ? (() => { try { const r = stmtRubricById.get(test.rubric_id) as any; return r ? { id: r.id, title: r.title, criteria: JSON.parse(r.criteria_json || '[]') } : null; } catch { return null; } })() : null,
        sections: (stmtSectionsByTest.all(test.id) as any[]).map((s: any) => ({ key: s.section_key, title: s.title, kind: s.kind, audioUrl: s.audio_url, transcript: s.transcript, body: s.body, durationSeconds: s.duration_seconds, orderIndex: s.order_index })),
        questions: (stmtQuestionsByTest.all(test.id) as any[]).map((q) => ({ id: q.id, questionKey: q.question_key, qtype: q.qtype, prompt: q.prompt, options: q.options_json ? JSON.parse(q.options_json) : null, points: q.points, orderIndex: q.order_index, difficulty: q.difficulty ?? null, sectionKey: q.section_key ?? null })),
      };
    }).filter(Boolean),
    configured: true,
    enabled: Boolean(profile.enabled),
    required: Boolean(profile.required),
    requirementMode: String(profile.requirement_mode || (profile.required ? 'required' : 'not_required')),
    firstLevelExempt: Boolean(profile.first_level_exempt),
    expiresMinutes: profile.expires_minutes == null ? null : Number(profile.expires_minutes),
    decisionRules: profile.decision_rules_json ? JSON.parse(profile.decision_rules_json) : [],
    method: String(profile.method || (components.length > 1 ? 'hybrid' : components[0]?.type || PLACEMENT_DEFAULTS.method)),
    programVersionId: version.id,
    programId: version.program_id,
    programName: version.program_name,
    versionLabel: version.version_label,
    components,
    levels,
    placementRules: rules,
    allowRetake: Boolean(profile.allow_retake),
    // Retake + billing terms travel with the attempt snapshot so that changing
    // the academic configuration mid-flight cannot alter the eligibility or the
    // price of an already-started sitting (migration 070).
    maxAttempts: profile.max_attempts == null ? null : Number(profile.max_attempts),
    firstAttemptBillable: profile.first_attempt_billable == null ? true : Boolean(Number(profile.first_attempt_billable)),
    retakeBillable: Boolean(Number(profile.retake_billable ?? 0)),
    retakeFeeAmount: profile.retake_fee_amount == null ? null : Number(profile.retake_fee_amount),
    passScore: Number(profile.pass_score ?? PLACEMENT_DEFAULTS.passScore),
    maxScore: Number(profile.max_score ?? PLACEMENT_DEFAULTS.maxScore),
    instructions: profile.instructions ?? null,
    scoringModel: String(profile.scoring_model || 'weighted_average'),
    profileId: profile.id,
    policyVersion: Number(profile.version ?? 1),
  };
}

export function mapAttempt(attempt: any) {
  // The raw column is destructured OUT here and never re-attached. Previously
  // this function sanitised `snapshot` and then spread `...attempt` over the
  // result, which re-added the untouched `snapshot_json` string — so every
  // answer key shipped to the client anyway (certification finding C-4).
  // `stmtAttempt` and `stmtCurrentAttempt` are `SELECT *`, so the raw column is
  // present on most rows reaching this serializer.
  const { snapshot_json: rawSnapshot, ...row } = attempt ?? {};
  const snapshot = (() => {
    try { return JSON.parse(rawSnapshot || '{}') as Record<string, unknown>; }
    catch { return {}; }
  })();
  // Answer keys never leave the server through the read views: strip them from
  // the attempt snapshot before it reaches the client (auto-scoring reads the
  // raw snapshot_json from the database internally, so stripping here is safe).
  if (Array.isArray((snapshot as any).tests)) {
    (snapshot as any).tests = ((snapshot as any).tests as any[]).map((t: any) => ({
      ...t,
      questions: (t.questions || []).map((q: any) => {
        const { answer_key: _ak, ...rest } = q;
        return rest;
      }),
    }));
  }
  return { ...row, snapshot, results: stmtResults.all(attempt.id) };
}

export function getProgramAssessment(visitor: any) {
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

export function normalizeScore(value: unknown, maxScore: number): number {
  const score = Number(value);
  if (!Number.isFinite(score) || score < 0 || score > maxScore) throw new HttpError(400, `Score must be between 0 and ${maxScore}.`);
  return score;
}

export function componentScore(component: PlacementComponentConfig, body: any): { score: number | null; payload: any } {
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

export function getRequiredMissing(components: PlacementComponentConfig[], results: any[]) {
  const done = new Set(results.filter((r) => r.status === 'completed' || r.status === 'waived').map((r) => r.component_key));
  return components.filter((c) => c.required && !done.has(c.key)).map((c) => c.key);
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

/** Safe wrapper around stmtUpsertResult (24 positional params — see store). */
export function upsertResult(a: UpsertResultArgs) {
  stmtUpsertResult.run(
    id('par'), a.attemptId, a.key, a.type, a.label, a.status, a.score, a.maxScore, a.weight,
    a.selectedLevelId ?? null, a.notes ?? null, a.resultText ?? null, a.payloadJson ?? null,
    a.evaluatorUserId, a.status,
    a.rawScore ?? null, a.percentage ?? null, a.weightedScore ?? null, a.scoreVersion ?? 1,
    a.startedAt ?? null, a.deadlineAt ?? null, a.submittedAt ?? null, a.elapsedSeconds ?? null,
    a.timeoutFlag ?? 0
  );
}
