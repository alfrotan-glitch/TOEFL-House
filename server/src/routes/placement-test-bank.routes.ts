/**
 * Placement Test-Bank Router — reusable content authoring: tests, sections
 * (listening tracks / reading passages / speaking blocks), questions, answer
 * keys, rubrics, media (audio) upload/serve, publish/archive/preview.
 * Content is versioned (version counter bumped on edit); answered content is
 * protected from deletion by FK RESTRICT — archive instead.
 */
import { Router } from 'express';
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { db } from '../db/connection.js';
import { authorize, canAccessBranchResource, requirePermission, resolveBranchScope } from '../middleware/auth.js';
import { isGlobalOwner } from '../core/rbac/rbac-service.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';
import {
  stmtTestById, stmtInsertTest, stmtUpdateTest, stmtQuestionsByTest,
  stmtDeleteQuestion, stmtUpdateQuestion, stmtInsertQuestion, stmtSectionsByTest, stmtInsertSection, stmtDeleteSections,
  stmtRubricById, stmtInsertRubric, stmtUpdateRubric, stmtRubricsByBranch,
  stmtMediaById, stmtInsertMedia, stmtMediaByBranch,
  getUserContext, serializeTest,
} from '../core/placement/store.js';

export const placementTestBankRouter = Router();

const VALID_TEST_TYPES = ['grammar', 'listening', 'reading', 'writing', 'speaking'];
const VALID_QTYPES = ['mcq', 'short_answer', 'fill_blank', 'sentence_completion', 'error_identification', 'essay', 'speaking'];
const VALID_SECTION_KINDS = ['audio_track', 'passage', 'prompt_block', 'instructions'];
const VALID_QUESTION_LIFECYCLE = ['draft', 'reviewed', 'approved', 'active', 'retired'];

/**
 * PTB-1: by-id access must obey the same branch authority the list already
 * applies (`WHERE branch_id IS NULL OR branch_id = ?`). Without this the
 * scoping on the list was decorative — the row stayed reachable by id, and a
 * manager of another branch could rewrite, archive/activate or preview it.
 * Preview matters on its own: serializeTest() returns `answerKey` for every
 * question, so a foreign archive breaks the owning branch's placement assessment.
 *
 * `branch_id IS NULL` means "global template": it remains readable wherever
 * the global template is applicable, but mutation requires the canonical
 * organization-scoped Owner fact. Reuses canAccessBranchResource, the same
 * helper placement-attempt.routes.ts uses, so object scope is not inferred
 * from the caller's home branch.
 */
function assertPlacementAssetBranch(req: import('express').Request, branchId: string | null | undefined, mutation = false): void {
  if (branchId === null || branchId === undefined) {
    if (mutation && (!req.rbac || !isGlobalOwner(req.rbac))) {
      throw new HttpError(403, 'Only an organization-scoped owner may modify a global placement asset.');
    }
    return;
  }
  if (!canAccessBranchResource(req, branchId)) {
    throw new HttpError(403, 'This placement asset belongs to another branch.');
  }
}

function assertRubricScope(rubricId: unknown, assetBranchId: string | null, testType: unknown) {
  if (rubricId == null || rubricId === '') return null;
  const rubric = stmtRubricById.get(String(rubricId)) as any;
  if (!rubric) throw new HttpError(400, 'Rubric not found.');
  if (rubric.branch_id != null && rubric.branch_id !== assetBranchId) {
    throw new HttpError(400, 'Rubric belongs to another branch.');
  }
  const allowedKinds = testType === 'writing'
    ? new Set(['writing'])
    : testType === 'speaking'
      ? new Set(['speaking'])
      : new Set<string>();
  if (!allowedKinds.has(String(rubric.kind))) {
    throw new HttpError(400, 'Rubric kind does not match the placement test type.');
  }
  return rubric.id as string;
}

function positiveOptionalInteger(value: unknown, field: string): number | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new HttpError(400, `${field} must be a positive integer.`);
  return value;
}

function validateCriteria(criteria: unknown) {
  if (!Array.isArray(criteria) || criteria.length === 0) throw new HttpError(400, 'Rubric needs at least one criterion.');
  const keys = new Set<string>();
  const normalized: Array<{ key: string; label: string; weight: number; maxScore: number }> = [];
  let totalWeight = 0;
  for (const criterion of criteria) {
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion) || typeof criterion.key !== 'string' || typeof criterion.label !== 'string') {
      throw new HttpError(400, 'Rubric criteria require text keys and labels.');
    }
    const key = criterion.key.trim();
    const label = criterion.label.trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(key) || keys.has(key) || !label || label.length > 160) {
      throw new HttpError(400, 'Rubric criteria require valid unique keys and labels.');
    }
    if (typeof criterion.weight !== 'number' || !Number.isFinite(criterion.weight) || criterion.weight <= 0 || criterion.weight > 100) throw new HttpError(400, `Criterion ${key} needs a weight between 0 and 100.`);
    if (typeof criterion.maxScore !== 'number' || !Number.isFinite(criterion.maxScore) || criterion.maxScore <= 0) throw new HttpError(400, `Criterion ${key} needs a positive maxScore.`);
    keys.add(key);
    normalized.push({ key, label, weight: criterion.weight, maxScore: criterion.maxScore });
    totalWeight += criterion.weight;
  }
  if (Math.abs(totalWeight - 100) > 0.01) throw new HttpError(400, `Criterion weights must total 100%. Current: ${totalWeight}%.`);
  return normalized;
}

function normalizedOptions(options: unknown): Array<{ key: string; text: string }> {
  if (!Array.isArray(options)) return [];
  return options.map((option) => {
    if (typeof option === 'string') return { key: option.trim(), text: option.trim() };
    if (!option || typeof option !== 'object' || Array.isArray(option) || typeof option.key !== 'string' || typeof option.text !== 'string') {
      throw new HttpError(400, 'MCQ options require text keys and labels.');
    }
    return { key: option.key.trim(), text: option.text.trim() };
  });
}

function validateQuestions(questions: any[], sections: any[] | null = null) {
  if (!Array.isArray(questions)) throw new HttpError(400, 'questions must be an array.');
  const keys = new Set<string>();
  const sectionKeys = sections ? new Set(sections.map((section) => String(section.key))) : null;
  for (const q of questions) {
    if (!q || typeof q !== 'object' || Array.isArray(q) || typeof q.key !== 'string' || typeof q.prompt !== 'string') {
      throw new HttpError(400, 'Each question needs text key and prompt fields.');
    }
    const key = q.key.trim();
    const prompt = q.prompt.trim();
    if (!key || !/^[A-Za-z0-9_-]{1,80}$/.test(key) || keys.has(key) || !prompt || prompt.length > 8000 || !VALID_QTYPES.includes(q.qtype)) {
      throw new HttpError(400, 'Each question needs a unique key, prompt and valid type.');
    }
    q.key = key;
    q.prompt = prompt;
    keys.add(key);
    if (q.answerKey != null && typeof q.answerKey !== 'string') throw new HttpError(400, `Question ${key} answerKey must be text.`);
    if (q.sectionKey != null && typeof q.sectionKey !== 'string') throw new HttpError(400, `Question ${key} sectionKey must be text.`);
    if (q.difficulty != null && typeof q.difficulty !== 'string') throw new HttpError(400, `Question ${key} difficulty must be text.`);
    if (q.cefrLevel != null && !['A1', 'A2', 'B1', 'B2', 'C1'].includes(String(q.cefrLevel))) throw new HttpError(400, `Question ${key} CEFR level must be A1/A2/B1/B2/C1.`);
    if (q.topic != null && typeof q.topic !== 'string') throw new HttpError(400, `Question ${key} topic must be text.`);
    if (q.subskill != null && typeof q.subskill !== 'string') throw new HttpError(400, `Question ${key} subskill must be text.`);
    if (q.lifecycleStatus != null && !VALID_QUESTION_LIFECYCLE.includes(String(q.lifecycleStatus))) throw new HttpError(400, `Question ${key} lifecycleStatus is invalid.`);
    if (q.qtype === 'mcq') {
      const options = normalizedOptions(q.options);
      if (options.length < 2) throw new HttpError(400, `MCQ ${key} needs at least two options.`);
      q.options = options;
      const optionKeys = options.map((option) => option.key);
      if (optionKeys.some((optionKey) => !optionKey) || new Set(optionKeys).size !== optionKeys.length || options.some((option) => !option.text)) {
        throw new HttpError(400, `MCQ ${key} options need unique keys and text.`);
      }
      if (!optionKeys.includes(String(q.answerKey))) throw new HttpError(400, `MCQ ${key} answerKey must match an option key.`);
    } else if (q.options != null) {
      throw new HttpError(400, `Only MCQ ${key} may define options.`);
    }
    if (!['essay', 'speaking'].includes(String(q.qtype)) && !String(q.answerKey || '').trim()) throw new HttpError(400, `Question ${key} needs an answer key.`);
    if (typeof q.points !== 'number' || !Number.isFinite(q.points) || q.points <= 0) throw new HttpError(400, `Question ${key} needs positive numeric points.`);
    if (typeof q.sectionKey === 'string') q.sectionKey = q.sectionKey.trim() || null;
    if (q.sectionKey && sectionKeys && !sectionKeys.has(q.sectionKey)) throw new HttpError(400, `Question ${key} references an unknown section.`);
  }
}

function validateSections(sections: unknown): asserts sections is any[] {
  if (!Array.isArray(sections)) throw new HttpError(400, 'sections must be an array.');
  const seen = new Set<string>();
  for (const s of sections) {
    if (!s || typeof s !== 'object' || Array.isArray(s) || typeof s.key !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(s.key.trim()) || !VALID_SECTION_KINDS.includes(s.kind)) {
      throw new HttpError(400, 'Each section needs a text key and a valid kind (audio_track/passage/prompt_block/instructions).');
    }
    s.key = s.key.trim();
    if (seen.has(s.key)) throw new HttpError(400, `Duplicate section key "${s.key}".`);
    seen.add(s.key);
    for (const field of ['title', 'audioUrl', 'transcript', 'body'] as const) {
      if (s[field] != null && typeof s[field] !== 'string') throw new HttpError(400, `Section "${s.key}" ${field} must be text.`);
    }
    if (s.kind === 'audio_track' && !s.audioUrl?.trim()) throw new HttpError(400, `Audio track "${s.key}" requires an audioUrl (media id or URL).`);
    if (s.durationSeconds != null && (typeof s.durationSeconds !== 'number' || !Number.isInteger(s.durationSeconds) || s.durationSeconds <= 0)) {
      throw new HttpError(400, `Section "${s.key}" durationSeconds must be a positive integer.`);
    }
  }
}

function replaceQuestions(testId: string, questions: any[], userId: string) {
  const existingQs = stmtQuestionsByTest.all(testId) as any[];
  const existingByKey = new Map(existingQs.map((q) => [String(q.question_key), q]));
  const newKeys = new Set(questions.map((q) => String(q.key)));
  let idx = 0;
  for (const q of questions) {
    const prior = existingByKey.get(String(q.key));
    const qid = prior ? prior.id : id('ptq');
    const optionsJson = q.qtype === 'mcq' ? JSON.stringify(normalizedOptions(q.options)) : null;
    const contentJson = q.contentJson == null ? null : JSON.stringify(q.contentJson);
    const orderIndex = idx++;
    const updatePayload = [
      String(q.qtype),
      String(q.prompt),
      optionsJson,
      q.answerKey || null,
      Number(q.points || 1),
      orderIndex,
      q.difficulty || null,
      q.sectionKey || null,
      q.cefrLevel || null,
      q.topic || null,
      q.subskill || null,
      q.lifecycleStatus || 'draft',
      q.reviewedBy || null,
      q.approvedAt || null,
      contentJson,
    ];
    if (prior) stmtUpdateQuestion.run(...updatePayload, qid);
    else stmtInsertQuestion.run(
      qid,
      testId,
      String(q.key),
      String(q.qtype),
      String(q.prompt),
      optionsJson,
      q.answerKey || null,
      Number(q.points || 1),
      orderIndex,
      q.difficulty || null,
      q.sectionKey || null,
      q.cefrLevel || null,
      q.topic || null,
      q.subskill || null,
      q.lifecycleStatus || 'draft',
      1,
      userId,
      q.reviewedBy || null,
      q.approvedAt || null,
      contentJson,
    );
  }
  for (const prior of existingQs) {
    if (!newKeys.has(String(prior.question_key))) {
      const deleted = stmtDeleteQuestion.run(prior.id) as any;
      if (deleted.changes !== 1) throw new HttpError(409, `Question ${prior.question_key} could not be removed.`);
    }
  }
}

function replaceSections(testId: string, sections: any[]) {
  stmtDeleteSections.run(testId);
  let idx = 0;
  for (const s of sections) {
    stmtInsertSection.run(id('psec'), testId, String(s.key), s.title || null, String(s.kind), s.audioUrl || null, s.transcript || null, s.body || null, s.durationSeconds == null ? null : Number(s.durationSeconds), idx++);
  }
}

// ============================================================================
// §TESTS
// ============================================================================
placementTestBankRouter.get('/test-bank', requirePermission('Curriculum.TestBank'), ah(async (req, res) => {
  const scope = resolveBranchScope(req);
  const rows = (scope.isAll
    ? db.prepare(`SELECT * FROM placement_tests ORDER BY updated_at DESC`).all()
    : db.prepare(`SELECT * FROM placement_tests WHERE branch_id IS NULL OR branch_id = ? ORDER BY updated_at DESC`).all(scope.branchId)) as any[];
  res.json(rows.map((test) => serializeTest(test)));
}));

placementTestBankRouter.post('/test-bank', requirePermission('Curriculum.TestBank'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { title, testType, instructions, audioUrl, transcript, passage, branchId, questions, sections, difficulty, durationSeconds, rubricId, wordTarget, contentJson } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 240) throw new HttpError(400, 'Test title is required and must be text no longer than 240 characters.');
  for (const [field, value] of Object.entries({ instructions, audioUrl, transcript, passage, difficulty })) {
    if (value != null && typeof value !== 'string') throw new HttpError(400, `${field} must be text.`);
  }
  if (!VALID_TEST_TYPES.includes(testType)) throw new HttpError(400, 'Invalid test type.');
  const normalizedSections = sections == null ? [] : sections;
  validateSections(normalizedSections);
  if (questions != null && !Array.isArray(questions)) throw new HttpError(400, 'questions must be an array.');
  validateQuestions(questions ?? [], normalizedSections);
  const testId = id('ptst');
  // A client-supplied branch is a requested object scope, never authority.
  // New global assets are not created through this branch-scoped surface.
  const resolvedBranch = branchId === null || branchId === undefined ? user.branchId : String(branchId);
  if (!canAccessBranchResource(req, resolvedBranch)) throw new HttpError(403, 'Target branch is outside your authorized scope.');
  const resolvedRubricId = assertRubricScope(rubricId, resolvedBranch, testType);
  const normalizedDuration = positiveOptionalInteger(durationSeconds, 'durationSeconds');
  const normalizedWordTarget = positiveOptionalInteger(wordTarget, 'wordTarget');
  const tx = db.transaction(() => {
    stmtInsertTest.run(testId, String(title).trim(), testType, instructions || null, audioUrl || null, transcript || null, passage || null, 'draft', resolvedBranch, user.userId, difficulty || null, normalizedDuration, resolvedRubricId, normalizedWordTarget, contentJson == null ? null : JSON.stringify(contentJson));
    replaceQuestions(testId, Array.isArray(questions) ? questions : [], user.userId);
    if (Array.isArray(sections)) replaceSections(testId, sections);
  });
  tx();
  writeAudit(req, `Created placement test-bank entry "${String(title).trim()}" (${testType}) with ${(questions || []).length} questions`);
  res.status(201).json(serializeTest(stmtTestById.get(testId)));
}));

placementTestBankRouter.put('/test-bank/:id', requirePermission('Curriculum.TestBank'), ah(async (req, res) => {
  const user = getUserContext(req);
  const existing = stmtTestById.get(req.params.id) as any;
  if (!existing) throw new HttpError(404, 'Test not found.');
  assertPlacementAssetBranch(req, existing.branch_id, true);
  const { title, testType, instructions, audioUrl, transcript, passage, status, questions, sections, difficulty, durationSeconds, rubricId, wordTarget, contentJson, version } = req.body ?? {};
  if (version !== existing.version) throw new HttpError(409, 'Test content changed since it was loaded. Refresh and retry with the current version.');
  if (status !== undefined) throw new HttpError(400, 'Use the activate/archive endpoints to change test status.');
  if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.trim().length > 240)) throw new HttpError(400, 'Test title must be non-empty text no longer than 240 characters.');
  for (const [field, value] of Object.entries({ instructions, audioUrl, transcript, passage, difficulty })) {
    if (value != null && typeof value !== 'string') throw new HttpError(400, `${field} must be text.`);
  }
  if (testType !== undefined && !VALID_TEST_TYPES.includes(testType)) throw new HttpError(400, 'Invalid test type.');
  if (sections !== undefined && !Array.isArray(sections)) throw new HttpError(400, 'sections must be an array.');
  const effectiveSections = Array.isArray(sections)
    ? sections
    : (stmtSectionsByTest.all(existing.id) as any[]).map((section) => ({
        key: section.section_key,
        kind: section.kind,
        audioUrl: section.audio_url,
        durationSeconds: section.duration_seconds,
      }));
  validateSections(effectiveSections);
  const effectiveQuestions = Array.isArray(questions)
    ? questions
    : (stmtQuestionsByTest.all(existing.id) as any[]).map((question) => ({
        key: question.question_key,
        qtype: question.qtype,
        prompt: question.prompt,
        options: question.options_json == null ? null : JSON.parse(question.options_json),
        answerKey: question.answer_key,
        points: question.points,
        difficulty: question.difficulty,
        sectionKey: question.section_key,
      }));
  validateQuestions(effectiveQuestions, effectiveSections);
  const effectiveTestType = testType !== undefined ? testType : existing.test_type;
  const resolvedRubricId = rubricId !== undefined
    ? assertRubricScope(rubricId, existing.branch_id, effectiveTestType)
    : assertRubricScope(existing.rubric_id, existing.branch_id, effectiveTestType);
  const normalizedDuration = durationSeconds !== undefined ? positiveOptionalInteger(durationSeconds, 'durationSeconds') : existing.duration_seconds;
  const normalizedWordTarget = wordTarget !== undefined ? positiveOptionalInteger(wordTarget, 'wordTarget') : existing.word_target;
  const tx = db.transaction(() => {
    const updated = stmtUpdateTest.run(
      title !== undefined ? String(title).trim() : existing.title,
      testType !== undefined ? testType : existing.test_type,
      instructions !== undefined ? instructions : existing.instructions,
      audioUrl !== undefined ? audioUrl : existing.audio_url,
      transcript !== undefined ? transcript : existing.transcript,
      passage !== undefined ? passage : existing.passage,
      existing.status,
      difficulty !== undefined ? difficulty : existing.difficulty,
      normalizedDuration,
      resolvedRubricId,
      normalizedWordTarget,
      contentJson !== undefined ? JSON.stringify(contentJson) : existing.content_json,
      existing.id,
      version,
    ) as any;
    if (updated.changes !== 1) throw new HttpError(409, 'Test content changed since it was loaded. Refresh and retry.');
    if (Array.isArray(questions)) replaceQuestions(existing.id, questions, user.userId);
    if (Array.isArray(sections)) replaceSections(existing.id, sections);
  });
  tx();
  writeAudit(req, `Updated placement test-bank entry "${existing.title}" (v${Number(existing.version) + 1})`);
  res.json(serializeTest(stmtTestById.get(existing.id)));
}));

placementTestBankRouter.post('/test-bank/:id/activate', requirePermission('Curriculum.TestBank'), ah(async (req, res) => {
  const existing = stmtTestById.get(req.params.id) as any;
  if (!existing) throw new HttpError(404, 'Test not found.');
  assertPlacementAssetBranch(req, existing.branch_id, true);
  if (req.body?.version !== existing.version) throw new HttpError(409, 'Test content changed since it was loaded. Refresh and retry.');
  const serialized = serializeTest(existing);
  if (serialized.questions.length === 0) throw new HttpError(400, 'Cannot activate a test with no questions.');
  validateSections(serialized.sections);
  validateQuestions(serialized.questions, serialized.sections);
  const updated = stmtUpdateTest.run(existing.title, existing.test_type, existing.instructions, existing.audio_url, existing.transcript, existing.passage, 'active', existing.difficulty, existing.duration_seconds, existing.rubric_id, existing.word_target, existing.content_json, existing.id, existing.version) as any;
  if (updated.changes !== 1) throw new HttpError(409, 'Test content changed since it was loaded. Refresh and retry.');
  writeAudit(req, `Activated placement test-bank entry "${existing.title}"`);
  res.json({ ok: true, version: Number(existing.version) + 1 });
}));

placementTestBankRouter.post('/test-bank/:id/archive', requirePermission('Curriculum.TestBank'), ah(async (req, res) => {
  const existing = stmtTestById.get(req.params.id) as any;
  if (!existing) throw new HttpError(404, 'Test not found.');
  assertPlacementAssetBranch(req, existing.branch_id, true);
  if (req.body?.version !== existing.version) throw new HttpError(409, 'Test content changed since it was loaded. Refresh and retry.');
  const updated = stmtUpdateTest.run(existing.title, existing.test_type, existing.instructions, existing.audio_url, existing.transcript, existing.passage, 'archived', existing.difficulty, existing.duration_seconds, existing.rubric_id, existing.word_target, existing.content_json, existing.id, existing.version) as any;
  if (updated.changes !== 1) throw new HttpError(409, 'Test content changed since it was loaded. Refresh and retry.');
  writeAudit(req, `Archived placement test-bank entry "${existing.title}"`);
  res.json({ ok: true, version: Number(existing.version) + 1 });
}));

/** Staff preview: full content INCLUDING answer keys (authoring surface only). */
placementTestBankRouter.get('/test-bank/:id/preview', requirePermission('Curriculum.TestBank'), ah(async (req, res) => {
  const test = stmtTestById.get(req.params.id) as any;
  if (!test) throw new HttpError(404, 'Test not found.');
  assertPlacementAssetBranch(req, test.branch_id);
  res.json(serializeTest(test));
}));

// ============================================================================
// §RUBRICS (writing / speaking)
// ============================================================================
placementTestBankRouter.get('/rubrics', requirePermission('Curriculum.TestBank'), ah(async (req, res) => {
  const scope = resolveBranchScope(req);
  const rows = (scope.isAll
    ? db.prepare('SELECT * FROM placement_rubrics ORDER BY updated_at DESC').all()
    : stmtRubricsByBranch.all(scope.branchId)) as any[];
  res.json(rows.map((rubric) => ({ id: rubric.id, title: rubric.title, kind: rubric.kind, version: Number(rubric.version ?? 1), criteria: JSON.parse(rubric.criteria_json || '[]'), branchId: rubric.branch_id, createdAt: rubric.created_at, updatedAt: rubric.updated_at })));
}));

placementTestBankRouter.post('/rubrics', requirePermission('Curriculum.TestBank'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { title, kind, criteria } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 240 || !['writing', 'speaking'].includes(kind)) throw new HttpError(400, 'Rubric needs a text title no longer than 240 characters and kind (writing/speaking).');
  const normalizedCriteria = validateCriteria(criteria);
  const rubricId = id('prub');
  stmtInsertRubric.run(rubricId, title.trim(), kind, JSON.stringify(normalizedCriteria), user.branchId, user.userId);
  writeAudit(req, `Created placement rubric "${title.trim()}" (${kind})`);
  res.status(201).json({ id: rubricId, title: title.trim(), kind, version: 1, criteria: normalizedCriteria, branchId: user.branchId });
}));

placementTestBankRouter.put('/rubrics/:id', requirePermission('Curriculum.TestBank'), ah(async (req, res) => {
  const existing = stmtRubricById.get(req.params.id) as any;
  if (!existing) throw new HttpError(404, 'Rubric not found.');
  assertPlacementAssetBranch(req, existing.branch_id, true);
  const { title, kind, criteria, version } = req.body ?? {};
  if (version !== existing.version) throw new HttpError(409, 'Rubric changed since it was loaded. Refresh and retry.');
  if (title !== undefined && typeof title !== 'string') throw new HttpError(400, 'Rubric title must be text.');
  if (kind !== undefined && typeof kind !== 'string') throw new HttpError(400, 'Rubric kind must be text.');
  const nextTitle = title !== undefined ? title.trim() : existing.title;
  const nextKind = kind !== undefined ? kind : existing.kind;
  if (!nextTitle || nextTitle.length > 240 || !['writing', 'speaking'].includes(nextKind)) throw new HttpError(400, 'Rubric needs a text title no longer than 240 characters and valid kind.');
  const nextCriteria = validateCriteria(criteria !== undefined ? criteria : JSON.parse(existing.criteria_json || '[]'));
  const referencingTests = db.prepare('SELECT test_type FROM placement_tests WHERE rubric_id = ?').all(existing.id) as Array<{ test_type: string }>;
  if (referencingTests.some(({ test_type }) => test_type !== 'writing' && test_type !== 'speaking'
      || nextKind !== test_type)) {
    throw new HttpError(409, 'Rubric kind cannot be changed while linked tests require its current kind.');
  }
  const updated = stmtUpdateRubric.run(nextTitle, nextKind, JSON.stringify(nextCriteria), existing.id, version) as any;
  if (updated.changes !== 1) throw new HttpError(409, 'Rubric changed since it was loaded. Refresh and retry.');
  writeAudit(req, `Updated placement rubric "${existing.title}"`);
  res.json({ id: existing.id, title: nextTitle, kind: nextKind, version: Number(existing.version) + 1, criteria: nextCriteria });
}));

// ============================================================================
// §MEDIA — safe audio/file storage (validation: mime whitelist, size cap, sha256)
// ============================================================================
const MEDIA_DIR = path.resolve(process.cwd(), 'data', 'placement-media');
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm',
  'image/png': 'png', 'image/jpeg': 'jpg', 'application/pdf': 'pdf',
};

function hasExpectedSignature(body: Buffer, mime: string): boolean {
  const ascii = (start: number, end: number) => body.subarray(start, end).toString('ascii');
  if (mime === 'image/png') return body.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (mime === 'image/jpeg') return body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  if (mime === 'application/pdf') return ascii(0, 5) === '%PDF-';
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
  if (mime === 'audio/ogg') return ascii(0, 4) === 'OggS';
  if (mime === 'audio/mp4') return ascii(4, 8) === 'ftyp';
  if (mime === 'audio/webm') return body.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  if (mime === 'audio/aac') return body[0] === 0xff && (body[1] & 0xf6) === 0xf0;
  if (mime === 'audio/mpeg') return ascii(0, 3) === 'ID3' || (body[0] === 0xff && (body[1] & 0xe0) === 0xe0);
  return false;
}

placementTestBankRouter.post('/media/upload', express.raw({ type: () => true, limit: '30mb' }), authorize('owner', 'general_manager', 'head_of_department', 'receptionist', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const body = req.body as Buffer | undefined;
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!body || body.length === 0) throw new HttpError(400, 'Empty upload body.');
  if (body.length > MAX_MEDIA_BYTES) throw new HttpError(413, `File too large (max ${MAX_MEDIA_BYTES / 1024 / 1024} MB).`);
  const ext = ALLOWED_MIME[mime];
  if (!ext) throw new HttpError(415, `Unsupported media type "${mime}". Allowed: ${Object.keys(ALLOWED_MIME).join(', ')}.`);
  if (!hasExpectedSignature(body, mime)) throw new HttpError(415, 'Uploaded bytes do not match the declared media type.');
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const mediaId = id('pmd');
  const filename = `${mediaId}.${ext}`;
  const storagePath = path.join(MEDIA_DIR, filename);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const kind = mime.startsWith('audio/') ? 'audio' : mime.startsWith('image/') ? 'image' : 'document';
  try {
    fs.writeFileSync(storagePath, body, { flag: 'wx' });
    stmtInsertMedia.run(mediaId, filename, mime, body.length, sha256, filename, kind, user.branchId, user.userId);
  } catch (error) {
    try { fs.unlinkSync(storagePath); } catch { /* no file to clean up */ }
    throw error;
  }
  writeAudit(req, `Uploaded placement media ${filename} (${mime}, ${body.length} bytes)`);
  res.status(201).json({ id: mediaId, filename, mime, sizeBytes: body.length, sha256, kind, url: `/api/placement/media/${mediaId}/file` });
}));

placementTestBankRouter.get('/media', authorize('owner', 'general_manager', 'head_of_department', 'receptionist', 'counselor'), ah(async (req, res) => {
  const scope = resolveBranchScope(req);
  const rows = (scope.isAll
    ? db.prepare('SELECT * FROM placement_media ORDER BY created_at DESC').all()
    : stmtMediaByBranch.all(scope.branchId)) as any[];
  res.json(rows.map((media) => ({ id: media.id, filename: media.filename, mime: media.mime, sizeBytes: media.size_bytes, sha256: media.sha256, kind: media.kind, createdAt: media.created_at, url: `/api/placement/media/${media.id}/file` })));
}));

placementTestBankRouter.get('/media/:id/file', authorize('owner', 'general_manager', 'head_of_department', 'receptionist', 'counselor'), ah(async (req, res) => {
  const media = stmtMediaById.get(req.params.id) as any;
  if (!media) throw new HttpError(404, 'Media not found.');
  assertPlacementAssetBranch(req, media.branch_id);
  const fullPath = path.resolve(MEDIA_DIR, media.storage_path);
  if (!fullPath.startsWith(`${MEDIA_DIR}${path.sep}`)) throw new HttpError(409, 'Media storage path is invalid.');
  if (!fs.existsSync(fullPath)) throw new HttpError(404, 'Media file missing on disk.');
  const realPath = fs.realpathSync(fullPath);
  const realMediaDir = fs.realpathSync(MEDIA_DIR);
  if (!realPath.startsWith(`${realMediaDir}${path.sep}`)) throw new HttpError(409, 'Media storage path is invalid.');
  res.setHeader('Content-Type', media.mime);
  res.setHeader('Content-Disposition', `inline; filename="${media.filename}"`);
  res.sendFile(realPath);
}));
