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

export type PlacementComponentType = 'skill_scores' | 'written_test' | 'interview' | 'level_assessment' | 'custom_score' | 'content_test';

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
  /** For content_test components: the reusable test-bank entry id. */
  testId?: string;
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

// ── Content test bank (reusable content-driven assessments) ──
const stmtTestById = db.prepare('SELECT * FROM placement_tests WHERE id = ?');
const stmtInsertTest = db.prepare(`INSERT INTO placement_tests (id, title, test_type, instructions, audio_url, transcript, passage, status, branch_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const stmtUpdateTest = db.prepare(`UPDATE placement_tests SET title=?, test_type=?, instructions=?, audio_url=?, transcript=?, passage=?, status=?, updated_at=datetime('now') WHERE id=?`);
const stmtQuestionsByTest = db.prepare('SELECT * FROM placement_test_questions WHERE test_id = ? ORDER BY order_index, rowid');
const stmtDeleteQuestion = db.prepare('DELETE FROM placement_test_questions WHERE id = ?');
const stmtUpdateQuestion = db.prepare('UPDATE placement_test_questions SET qtype=?, prompt=?, options_json=?, answer_key=?, points=?, order_index=? WHERE id=?');
const stmtInsertQuestion = db.prepare(`INSERT INTO placement_test_questions (id, test_id, question_key, qtype, prompt, options_json, answer_key, points, order_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const stmtUpsertResponse = db.prepare(`INSERT INTO placement_assessment_responses (id, attempt_id, test_id, question_id, question_key, response_json, auto_score, max_points, feedback, answered_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(attempt_id, question_id) DO UPDATE SET
    response_json=excluded.response_json, auto_score=excluded.auto_score, max_points=excluded.max_points,
    feedback=excluded.feedback, answered_at=datetime('now')`);

function serializeTest(test: any) {
  return {
    id: test.id, title: test.title, testType: test.test_type, instructions: test.instructions,
    audioUrl: test.audio_url, transcript: test.transcript, passage: test.passage, status: test.status,
    branchId: test.branch_id, createdBy: test.created_by, createdAt: test.created_at, updatedAt: test.updated_at,
    questions: (stmtQuestionsByTest.all(test.id) as any[]).map((q) => ({
      id: q.id, key: q.question_key, qtype: q.qtype, prompt: q.prompt,
      options: q.options_json ? JSON.parse(q.options_json) : null,
      answerKey: q.answer_key, points: q.points, orderIndex: q.order_index,
    })),
  };
}
const stmtResponsesByAttemptTest = db.prepare('SELECT * FROM placement_assessment_responses WHERE attempt_id = ? AND test_id = ? ORDER BY rowid');

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
    contentTests: components.filter((c) => c.type === 'content_test' && c.testId).map((c) => {
      const test = stmtTestById.get(c.testId!) as any;
      if (!test) return null;
      // Answer keys never leave the server in the read view; they are only in
      // the immutable attempt snapshot used by the auto-scorer.
      return {
        id: test.id, title: test.title, testType: test.test_type, instructions: test.instructions,
        audioUrl: test.audio_url, transcript: test.transcript, passage: test.passage, status: test.status,
        questions: (stmtQuestionsByTest.all(test.id) as any[]).map((q) => ({ id: q.id, questionKey: q.question_key, qtype: q.qtype, prompt: q.prompt, options: q.options_json ? JSON.parse(q.options_json) : null, points: q.points, orderIndex: q.order_index })),
      };
    }).filter(Boolean),
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

// ============================================================================
// §TEST-BANK — reusable content-driven placement tests (owner/manager/academic)
// ============================================================================
router.get('/test-bank', authorize('owner', 'manager', 'head_of_department', 'registrar', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  // Branch isolation: branch-scoped tests are visible only inside their branch;
  // global tests (branch_id NULL) are shared across branches.
  const rows = db.prepare(`SELECT * FROM placement_tests WHERE branch_id IS NULL OR branch_id = ? ORDER BY updated_at DESC`).all(user.branchId) as any[];
  res.json(rows.map((t) => serializeTest(t)));
}));

router.post('/test-bank', authorize('owner', 'manager', 'head_of_department'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { title, testType, instructions, audioUrl, transcript, passage, branchId, questions } = req.body ?? {};
  if (!title || !String(title).trim()) throw new HttpError(400, 'Test title is required.');
  if (!['listening', 'reading', 'writing', 'speaking'].includes(testType)) throw new HttpError(400, 'Invalid test type.');
  const qs = Array.isArray(questions) ? questions : [];
  for (const q of qs) {
    if (!q.key || !q.prompt || !['mcq', 'short_answer', 'essay', 'speaking'].includes(q.qtype)) throw new HttpError(400, 'Each question needs a key, prompt and valid type.');
    if (q.qtype === 'mcq' && (!Array.isArray(q.options) || q.options.length < 2)) throw new HttpError(400, `MCQ ${q.key} needs at least two options.`);
    if (q.qtype !== 'essay' && q.qtype !== 'speaking' && !q.answerKey) throw new HttpError(400, `Question ${q.key} needs an answer key.`);
    if (!Number.isFinite(Number(q.points)) || Number(q.points) <= 0) throw new HttpError(400, `Question ${q.key} needs positive points.`);
  }
  const testId = id('ptst');
  // Default to the caller's branch for isolation; a test becomes global only
  // when the caller explicitly passes branchId: null (e.g. a shared baseline).
  const resolvedBranch = branchId === null || branchId === undefined ? user.branchId : String(branchId);
  const tx = db.transaction(() => {
    stmtInsertTest.run(testId, String(title).trim(), testType, instructions || null, audioUrl || null, transcript || null, passage || null, 'draft', resolvedBranch, user.userId);
    let idx = 0;
    for (const q of qs) {
      stmtInsertQuestion.run(id('ptq'), testId, String(q.key), String(q.qtype), String(q.prompt),
        q.qtype === 'mcq' ? JSON.stringify(q.options) : null, q.answerKey || null, Number(q.points), idx++);
    }
  });
  tx();
  writeAudit(req, `Created placement test-bank entry "${String(title).trim()}" (${testType}) with ${qs.length} questions`);
  res.status(201).json(serializeTest(stmtTestById.get(testId)));
}));

router.put('/test-bank/:id', authorize('owner', 'manager', 'head_of_department'), ah(async (req, res) => {
  const existing = stmtTestById.get(req.params.id) as any;
  if (!existing) throw new HttpError(404, 'Test not found.');
  const { title, testType, instructions, audioUrl, transcript, passage, status, questions } = req.body ?? {};
  if (title !== undefined && !String(title).trim()) throw new HttpError(400, 'Test title is required.');
  if (testType !== undefined && !['listening', 'reading', 'writing', 'speaking'].includes(testType)) throw new HttpError(400, 'Invalid test type.');
  if (status !== undefined && !['draft', 'active', 'archived'].includes(status)) throw new HttpError(400, 'Invalid status.');
  const tx = db.transaction(() => {
    stmtUpdateTest.run(
      title !== undefined ? String(title).trim() : existing.title,
      testType !== undefined ? testType : existing.test_type,
      instructions !== undefined ? instructions : existing.instructions,
      audioUrl !== undefined ? audioUrl : existing.audio_url,
      transcript !== undefined ? transcript : existing.transcript,
      passage !== undefined ? passage : existing.passage,
      status !== undefined ? status : existing.status,
      existing.id
    );
    if (Array.isArray(questions)) {
      // Upsert by question key: existing question rows keep their id so any
      // answered question stays linked to its stored responses (FK RESTRICT
      // protects them from deletion — historical attempts are immutable).
      const existingQs = stmtQuestionsByTest.all(existing.id) as any[];
      const existingByKey = new Map(existingQs.map((q) => [String(q.question_key), q]));
      const newKeys = new Set(questions.map((q) => String(q.key)));
      let idx = 0;
      for (const q of questions) {
        if (!q.key || !q.prompt || !['mcq', 'short_answer', 'essay', 'speaking'].includes(q.qtype)) throw new HttpError(400, 'Invalid question in update.');
        const prior = existingByKey.get(String(q.key));
        const qid = prior ? prior.id : id('ptq');
        const payload = [String(q.qtype), String(q.prompt), q.qtype === 'mcq' ? JSON.stringify(q.options || []) : null, q.answerKey || null, Number(q.points || 1), idx++];
        if (prior) stmtUpdateQuestion.run(...payload, qid);
        else stmtInsertQuestion.run(qid, existing.id, String(q.key), ...payload);
      }
      for (const prior of existingQs) {
        if (!newKeys.has(String(prior.question_key))) {
          try { stmtDeleteQuestion.run(prior.id); } catch { /* referenced by responses → kept (immutability) */ }
        }
      }
    }
  });
  tx();
  writeAudit(req, `Updated placement test-bank entry "${existing.title}"`);
  res.json(serializeTest(stmtTestById.get(existing.id)));
}));

router.post('/test-bank/:id/activate', authorize('owner', 'manager', 'head_of_department'), ah(async (req, res) => {
  const existing = stmtTestById.get(req.params.id) as any;
  if (!existing) throw new HttpError(404, 'Test not found.');
  const qCount = (stmtQuestionsByTest.all(existing.id) as any[]).length;
  if (qCount === 0) throw new HttpError(400, 'Cannot activate a test with no questions.');
  stmtUpdateTest.run(existing.title, existing.test_type, existing.instructions, existing.audio_url, existing.transcript, existing.passage, 'active', existing.id);
  writeAudit(req, `Activated placement test-bank entry "${existing.title}"`);
  res.json({ ok: true });
}));

router.post('/test-bank/:id/archive', authorize('owner', 'manager', 'head_of_department'), ah(async (req, res) => {
  const existing = stmtTestById.get(req.params.id) as any;
  if (!existing) throw new HttpError(404, 'Test not found.');
  stmtUpdateTest.run(existing.title, existing.test_type, existing.instructions, existing.audio_url, existing.transcript, existing.passage, 'archived', existing.id);
  writeAudit(req, `Archived placement test-bank entry "${existing.title}"`);
  res.json({ ok: true });
}));

// ============================================================================
// §CONTENT ATTEMPT — candidate responses + server-side auto-scoring
// ============================================================================
router.put(
  '/visitors/:visitorId/placement/attempts/:attemptId/tests/:componentKey/responses',
  authorize('owner', 'registrar', 'manager', 'counselor'),
  ah(async (req, res) => {
    const user = getUserContext(req);
    const visitor = getVisitorOr404(req.params.visitorId);
    assertVisitorBranchAccess(req, visitor);
    const attempt = stmtAttempt.get(req.params.attemptId) as any;
    if (!attempt || attempt.visitor_id !== visitor.id) throw new HttpError(404, 'Placement attempt not found.');
    if (attempt.status !== 'in_progress') throw new HttpError(409, 'This placement attempt is no longer editable.');
    const snapshot = (() => { try { return JSON.parse(attempt.snapshot_json || '{}'); } catch { throw new HttpError(409, 'Placement attempt snapshot is corrupted.'); } })();
    const component = (snapshot.profile?.components || []).find((c: PlacementComponentConfig) => c.key === req.params.componentKey);
    if (!component || component.type !== 'content_test' || !component.testId) throw new HttpError(404, 'Content assessment component not found.');
    const test = (snapshot.tests || []).find((t: any) => t.id === component.testId);
    if (!test) throw new HttpError(404, 'Test content not found in the attempt snapshot.');

    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    // Every submission is a delta: score the provided answers, store them, then
    // derive the component state from ALL stored responses so partial or
    // repeated submissions never clobber previously auto-graded questions.
    const feedbacks: Record<string, string> = {};
    for (const a of answers) {
      const q = test.questions.find((tq: any) => String(tq.question_key) === String(a?.questionKey));
      if (!q) throw new HttpError(400, `Unknown question key "${a?.questionKey}" in test "${test.title}".`);
      const response = a?.response;
      if (response === undefined || response === null || response === '') continue;
      let score = 0;
      let fb = '';
      if (q.qtype === 'mcq' || q.qtype === 'short_answer') {
        const expected = String(q.answer_key || '').trim().toLowerCase();
        const given = String(response).trim().toLowerCase();
        score = expected && given === expected ? Number(q.points) : 0;
        fb = score > 0 ? 'Correct' : `Expected: ${q.answer_key}`;
      }
      feedbacks[String(q.question_key)] = fb;
      stmtUpsertResponse.run(id('pr'), attempt.id, test.id, q.id, q.question_key, JSON.stringify(response), score, Number(q.points), fb);
    }

    // Recompute the whole component from the stored response rows (server truth).
    const stored = stmtResponsesByAttemptTest.all(attempt.id, test.id) as any[];
    const storedByKey = new Map(stored.map((r) => [String(r.question_key), r]));
    let earned = 0;
    let max = 0;
    let answered = 0;
    for (const q of test.questions) {
      const pts = Number(q.points || 0);
      max += pts;
      const row = storedByKey.get(String(q.question_key));
      if (row) {
        answered += 1;
        earned += Number(row.auto_score || 0);
      }
    }
    const allAnswered = answered === test.questions.length;
    // Auto-scored components can be marked complete only when every question
    // has an answer AND every question is auto-gradeable; essay/speaking stay
    // pending for manual scoring by staff.
    const hasManual = test.questions.some((q: any) => q.qtype === 'essay' || q.qtype === 'speaking');
    const autoComplete = allAnswered && !hasManual;
    const rawMax = max || component.maxScore;
    const autoResult = Math.round((earned / rawMax) * component.maxScore * 100) / 100;

    if (autoComplete) {
      stmtUpsertResult.run(id('par'), attempt.id, component.key, component.type, component.label, 'completed', autoResult, component.maxScore, component.weight, null, null, null, JSON.stringify({ mode: 'auto', earned, max }), user.userId, 'completed');
    } else {
      // Partial or manual: keep the component pending but store the auto-earned
      // progress in the result payload so staff can see what was auto-graded.
      stmtUpsertResult.run(id('par'), attempt.id, component.key, component.type, component.label, allAnswered ? 'in_progress' : 'pending', null, component.maxScore, component.weight, null, null, null, JSON.stringify({ mode: 'auto', earned, max, answered, total: test.questions.length }), user.userId, 'pending');
    }

    const responses = stmtResponsesByAttemptTest.all(attempt.id, test.id) as any[];
    writeAudit(req, `Recorded content responses for ${visitor.full_name} on test "${test.title}" (${answered}/${test.questions.length} answered, ${earned}/${max} auto points)`);
    res.json({
      componentKey: component.key,
      answered,
      total: test.questions.length,
      autoScore: earned,
      maxScore: max,
      complete: autoComplete,
      feedback: feedbacks,
      responses: responses.map((r) => ({ questionKey: r.question_key, response: JSON.parse(r.response_json || 'null'), autoScore: r.auto_score, feedback: r.feedback })),
    });
  })
);

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
  const snapshot = (() => {
    try { return JSON.parse(attempt.snapshot_json || '{}') as Record<string, unknown>; }
    catch { return {}; }
  })();
  // Answer keys never leave the server through the read views: strip them from
  // the attempt snapshot before it reaches the client (auto-scoring reads the
  // raw snapshot_json internally, so stripping here is safe).
  if (Array.isArray((snapshot as any).tests)) {
    (snapshot as any).tests = ((snapshot as any).tests as any[]).map((t: any) => ({
      ...t,
      questions: (t.questions || []).map((q: any) => {
        const { answer_key: _ak, ...rest } = q;
        return rest;
      }),
    }));
  }
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
  // Immutable content snapshot: for content_test components, capture the
  // full test + questions + answer keys at attempt creation so historical
  // scoring never changes when the test bank is edited later.
  const contentTests: any[] = [];
  for (const c of parseComponents(profile)) {
    if (c.type === 'content_test' && c.testId) {
      const test = stmtTestById.get(c.testId) as any;
      if (test) contentTests.push({ ...test, questions: stmtQuestionsByTest.all(test.id) });
    }
  }
  const snapshot = JSON.stringify({ profile: mapProfile(profile, version, levels, rules), tests: contentTests, capturedAt: new Date().toISOString() });
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
  if (status === 'waived') {
    const role = String(req.user?.role || '');
    if (component.required && !['owner', 'manager'].includes(role)) throw new HttpError(403, 'Only management can waive a required assessment section.');
    if (!String(req.body?.notes || '').trim()) throw new HttpError(400, 'A reason is required when waiving an assessment section.');
    stmtUpsertResult.run(id('par'), attempt.id, component.key, component.type, component.label, 'waived', null, component.maxScore, component.weight, selectedLevelId, req.body?.notes || null, req.body?.resultText || null, JSON.stringify({ waived: true }), user.userId, 'waived');
    res.json(stmtResults.all(attempt.id));
    return;
  }
  if (component.type === 'content_test') {
    // Content components are scored from the immutable attempt snapshot and the
    // stored candidate responses. The auto-graded portion (mcq / short_answer)
    // is computed server-side at submission time; staff may only supply the
    // MANUAL portion (essay / speaking) bounded by the manual question points,
    // so a staff PUT cannot rewrite the auto-scored part.
    const test = (snapshot.tests || []).find((t: any) => t.id === component.testId);
    if (!test) throw new HttpError(409, 'Test content missing from the attempt snapshot.');
    const manualQuestions = test.questions.filter((q: any) => q.qtype === 'essay' || q.qtype === 'speaking');
    const autoEarned = (db.prepare('SELECT COALESCE(SUM(auto_score), 0) AS s FROM placement_assessment_responses WHERE attempt_id = ? AND test_id = ?').get(attempt.id, test.id) as any).s;
    if (manualQuestions.length === 0) {
      throw new HttpError(409, 'This content component is fully auto-graded; override its score through the responses endpoint only.');
    }
    const answeredCount = (db.prepare('SELECT COUNT(*) AS c FROM placement_assessment_responses WHERE attempt_id = ? AND test_id = ?').get(attempt.id, test.id) as any).c;
    if (answeredCount < test.questions.length) throw new HttpError(400, `Record answers for all ${test.questions.length} questions before manual scoring (${answeredCount} answered).`);
    const manualMax = manualQuestions.reduce((sum: number, q: any) => sum + Number(q.points || 0), 0);
    const manualScore = normalizeScore(req.body?.manualScore, manualMax);
    const rawCombined = autoEarned + manualScore;
    const rawMax = test.questions.reduce((sum: number, q: any) => sum + Number(q.points || 0), 0) || component.maxScore;
    const score = Math.round((rawCombined / rawMax) * component.maxScore * 100) / 100;
    stmtUpsertResult.run(id('par'), attempt.id, component.key, component.type, component.label, 'completed', score, component.maxScore, component.weight, selectedLevelId, req.body?.notes || null, req.body?.resultText || null, JSON.stringify({ mode: 'manual', autoEarned, manualScore, manualMax, combinedRaw: rawCombined, rawMax, feedback: req.body?.resultText || null }), user.userId, 'completed');
    res.json(stmtResults.all(attempt.id));
    return;
  }
  const result = componentScore(component, req.body ?? {});
  stmtUpsertResult.run(id('par'), attempt.id, component.key, component.type, component.label, status, result.score, component.maxScore, component.weight, selectedLevelId, req.body?.notes || null, req.body?.resultText || null, JSON.stringify(result.payload), user.userId, status);
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
