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
import { authorize, canAccessBranchResource } from '../middleware/auth.js';
import { writeAudit } from '../middleware/audit.js';
import { ah, HttpError } from '../middleware/errorHandler.js';
import { id } from '../utils/ids.js';
import {
  stmtTestById, stmtInsertTest, stmtUpdateTest, stmtBumpTestVersion, stmtQuestionsByTest,
  stmtDeleteQuestion, stmtUpdateQuestion, stmtInsertQuestion, stmtSectionsByTest, stmtInsertSection, stmtDeleteSections,
  stmtRubricById, stmtInsertRubric, stmtUpdateRubric, stmtRubricsByBranch,
  stmtMediaById, stmtInsertMedia, stmtMediaByBranch,
  getUserContext, serializeTest,
} from '../core/placement/store.js';

export const placementTestBankRouter = Router();

const VALID_TEST_TYPES = ['listening', 'reading', 'writing', 'speaking'];
const VALID_QTYPES = ['mcq', 'short_answer', 'essay', 'speaking'];
const VALID_SECTION_KINDS = ['audio_track', 'passage', 'prompt_block', 'instructions'];

/**
 * PTB-1: by-id access must obey the same branch authority the list already
 * applies (`WHERE branch_id IS NULL OR branch_id = ?`). Without this the
 * scoping on the list was decorative — the row stayed reachable by id, and a
 * manager of another branch could rewrite, archive/activate or preview it.
 * Preview matters on its own: serializeTest() returns `answerKey` for every
 * question, and policy-engine.ts refuses any content_test whose test is not
 * `status='active'`, so a foreign archive breaks the owning branch's
 * placement assessment.
 *
 * `branch_id IS NULL` means "global template" and stays readable/editable by
 * every branch — that is existing product behaviour, deliberately preserved.
 * Reuses canAccessBranchResource, the same helper placement-attempt.routes.ts
 * uses, so a global owner keeps cross-branch reach and no second authority is
 * introduced.
 */
function assertPlacementAssetBranch(req: import('express').Request, branchId: string | null | undefined): void {
  if (branchId === null || branchId === undefined) return; // global template
  if (!canAccessBranchResource(req, branchId)) {
    throw new HttpError(403, 'This placement asset belongs to another branch.');
  }
}

function validateQuestions(questions: any[]) {
  for (const q of questions) {
    if (!q.key || !q.prompt || !VALID_QTYPES.includes(q.qtype)) throw new HttpError(400, 'Each question needs a key, prompt and valid type.');
    if (q.qtype === 'mcq' && (!Array.isArray(q.options) || q.options.length < 2)) throw new HttpError(400, `MCQ ${q.key} needs at least two options.`);
    if (q.qtype !== 'essay' && q.qtype !== 'speaking' && !q.answerKey) throw new HttpError(400, `Question ${q.key} needs an answer key.`);
    if (!Number.isFinite(Number(q.points)) || Number(q.points) <= 0) throw new HttpError(400, `Question ${q.key} needs positive points.`);
  }
}

function validateSections(sections: any[]) {
  const seen = new Set<string>();
  for (const s of sections) {
    if (!s.key || !VALID_SECTION_KINDS.includes(s.kind)) throw new HttpError(400, 'Each section needs a key and a valid kind (audio_track/passage/prompt_block/instructions).');
    if (seen.has(s.key)) throw new HttpError(400, `Duplicate section key "${s.key}".`);
    seen.add(s.key);
    if (s.kind === 'audio_track' && !s.audioUrl) throw new HttpError(400, `Audio track "${s.key}" requires an audioUrl (media id or URL).`);
  }
}

function replaceQuestions(testId: string, questions: any[]) {
  const existingQs = stmtQuestionsByTest.all(testId) as any[];
  const existingByKey = new Map(existingQs.map((q) => [String(q.question_key), q]));
  const newKeys = new Set(questions.map((q) => String(q.key)));
  let idx = 0;
  for (const q of questions) {
    const prior = existingByKey.get(String(q.key));
    const qid = prior ? prior.id : id('ptq');
    const payload = [String(q.qtype), String(q.prompt), q.qtype === 'mcq' ? JSON.stringify(q.options || []) : null, q.answerKey || null, Number(q.points || 1), idx++, q.difficulty || null, q.sectionKey || null];
    if (prior) stmtUpdateQuestion.run(...payload, qid);
    else stmtInsertQuestion.run(qid, testId, String(q.key), ...payload);
  }
  for (const prior of existingQs) {
    if (!newKeys.has(String(prior.question_key))) {
      try { stmtDeleteQuestion.run(prior.id); } catch { /* referenced by responses → kept (immutability) */ }
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
placementTestBankRouter.get('/test-bank', authorize('owner', 'general_manager', 'head_of_department', 'receptionist', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const rows = db.prepare(`SELECT * FROM placement_tests WHERE branch_id IS NULL OR branch_id = ? ORDER BY updated_at DESC`).all(user.branchId) as any[];
  res.json(rows.map((t) => serializeTest(t)));
}));

placementTestBankRouter.post('/test-bank', authorize('owner', 'general_manager', 'head_of_department'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { title, testType, instructions, audioUrl, transcript, passage, branchId, questions, sections, difficulty, durationSeconds, rubricId, wordTarget, contentJson } = req.body ?? {};
  if (!title || !String(title).trim()) throw new HttpError(400, 'Test title is required.');
  if (!VALID_TEST_TYPES.includes(testType)) throw new HttpError(400, 'Invalid test type.');
  validateQuestions(Array.isArray(questions) ? questions : []);
  if (sections !== undefined && sections !== null) validateSections(sections);
  if (rubricId) {
    const rubric = stmtRubricById.get(String(rubricId)) as any;
    if (!rubric) throw new HttpError(400, 'Rubric not found.');
  }
  const testId = id('ptst');
  // PTB-1: a client-supplied branchId is a request, not authorization. It was
  // stored verbatim, letting a manager plant a test into another branch
  // (proven: B2 manager -> stored branch_id = B1). An explicit null still
  // means "global template"; anything else must be a branch the caller may
  // actually write to.
  const resolvedBranch = branchId === null || branchId === undefined ? user.branchId : String(branchId);
  if (resolvedBranch !== null && resolvedBranch !== undefined && !canAccessBranchResource(req, resolvedBranch)) {
    throw new HttpError(403, 'Target branch is outside your authorized scope.');
  }
  const tx = db.transaction(() => {
    stmtInsertTest.run(testId, String(title).trim(), testType, instructions || null, audioUrl || null, transcript || null, passage || null, 'draft', resolvedBranch, user.userId, difficulty || null, durationSeconds == null ? null : Number(durationSeconds), rubricId || null, wordTarget == null ? null : Number(wordTarget), contentJson ? JSON.stringify(contentJson) : null);
    replaceQuestions(testId, Array.isArray(questions) ? questions : []);
    if (Array.isArray(sections)) replaceSections(testId, sections);
  });
  tx();
  writeAudit(req, `Created placement test-bank entry "${String(title).trim()}" (${testType}) with ${(questions || []).length} questions`);
  res.status(201).json(serializeTest(stmtTestById.get(testId)));
}));

placementTestBankRouter.put('/test-bank/:id', authorize('owner', 'general_manager', 'head_of_department'), ah(async (req, res) => {
  const existing = stmtTestById.get(req.params.id) as any;
  if (!existing) throw new HttpError(404, 'Test not found.');
  assertPlacementAssetBranch(req, existing.branch_id);
  const { title, testType, instructions, audioUrl, transcript, passage, status, questions, sections, difficulty, durationSeconds, rubricId, wordTarget, contentJson } = req.body ?? {};
  if (title !== undefined && !String(title).trim()) throw new HttpError(400, 'Test title is required.');
  if (testType !== undefined && !VALID_TEST_TYPES.includes(testType)) throw new HttpError(400, 'Invalid test type.');
  if (status !== undefined && !['draft', 'active', 'archived'].includes(status)) throw new HttpError(400, 'Invalid status.');
  if (questions !== undefined) validateQuestions(questions);
  if (sections !== undefined && sections !== null) validateSections(sections);
  if (rubricId) {
    const rubric = stmtRubricById.get(String(rubricId)) as any;
    if (!rubric) throw new HttpError(400, 'Rubric not found.');
  }
  const tx = db.transaction(() => {
    stmtUpdateTest.run(
      title !== undefined ? String(title).trim() : existing.title,
      testType !== undefined ? testType : existing.test_type,
      instructions !== undefined ? instructions : existing.instructions,
      audioUrl !== undefined ? audioUrl : existing.audio_url,
      transcript !== undefined ? transcript : existing.transcript,
      passage !== undefined ? passage : existing.passage,
      status !== undefined ? status : existing.status,
      difficulty !== undefined ? difficulty : existing.difficulty,
      durationSeconds !== undefined ? durationSeconds : existing.duration_seconds,
      rubricId !== undefined ? rubricId : existing.rubric_id,
      wordTarget !== undefined ? wordTarget : existing.word_target,
      contentJson !== undefined ? JSON.stringify(contentJson) : existing.content_json,
      existing.id
    );
    if (Array.isArray(questions)) replaceQuestions(existing.id, questions);
    if (Array.isArray(sections)) replaceSections(existing.id, sections);
  });
  tx();
  writeAudit(req, `Updated placement test-bank entry "${existing.title}" (v${Number(existing.version) + 1})`);
  res.json(serializeTest(stmtTestById.get(existing.id)));
}));

placementTestBankRouter.post('/test-bank/:id/activate', authorize('owner', 'general_manager', 'head_of_department'), ah(async (req, res) => {
  const existing = stmtTestById.get(req.params.id) as any;
  if (!existing) throw new HttpError(404, 'Test not found.');
  assertPlacementAssetBranch(req, existing.branch_id);
  const qCount = (stmtQuestionsByTest.all(existing.id) as any[]).length;
  if (qCount === 0) throw new HttpError(400, 'Cannot activate a test with no questions.');
  stmtUpdateTest.run(existing.title, existing.test_type, existing.instructions, existing.audio_url, existing.transcript, existing.passage, 'active', existing.difficulty, existing.duration_seconds, existing.rubric_id, existing.word_target, existing.content_json, existing.id);
  writeAudit(req, `Activated placement test-bank entry "${existing.title}"`);
  res.json({ ok: true, version: Number(existing.version) + 1 });
}));

placementTestBankRouter.post('/test-bank/:id/archive', authorize('owner', 'general_manager', 'head_of_department'), ah(async (req, res) => {
  const existing = stmtTestById.get(req.params.id) as any;
  if (!existing) throw new HttpError(404, 'Test not found.');
  assertPlacementAssetBranch(req, existing.branch_id);
  stmtUpdateTest.run(existing.title, existing.test_type, existing.instructions, existing.audio_url, existing.transcript, existing.passage, 'archived', existing.difficulty, existing.duration_seconds, existing.rubric_id, existing.word_target, existing.content_json, existing.id);
  writeAudit(req, `Archived placement test-bank entry "${existing.title}"`);
  res.json({ ok: true });
}));

/** Staff preview: full content INCLUDING answer keys (authoring surface only). */
placementTestBankRouter.get('/test-bank/:id/preview', authorize('owner', 'general_manager', 'head_of_department'), ah(async (req, res) => {
  const test = stmtTestById.get(req.params.id) as any;
  if (!test) throw new HttpError(404, 'Test not found.');
  assertPlacementAssetBranch(req, test.branch_id);
  res.json(serializeTest(test));
}));

// ============================================================================
// §RUBRICS (writing / speaking / interview)
// ============================================================================
placementTestBankRouter.get('/rubrics', authorize('owner', 'general_manager', 'head_of_department', 'receptionist', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  const rows = stmtRubricsByBranch.all(user.branchId) as any[];
  res.json(rows.map((r) => ({ id: r.id, title: r.title, kind: r.kind, criteria: JSON.parse(r.criteria_json || '[]'), branchId: r.branch_id, createdAt: r.created_at, updatedAt: r.updated_at })));
}));

placementTestBankRouter.post('/rubrics', authorize('owner', 'general_manager', 'head_of_department'), ah(async (req, res) => {
  const user = getUserContext(req);
  const { title, kind, criteria } = req.body ?? {};
  if (!title || !['writing', 'speaking', 'interview'].includes(kind)) throw new HttpError(400, 'Rubric needs a title and kind (writing/speaking/interview).');
  if (!Array.isArray(criteria) || criteria.length === 0) throw new HttpError(400, 'Rubric needs at least one criterion.');
  let totalWeight = 0;
  for (const c of criteria) {
    if (!c.key || !c.label || !Number.isFinite(Number(c.weight)) || !Number.isFinite(Number(c.maxScore))) throw new HttpError(400, 'Each criterion needs key, label, weight and maxScore.');
    totalWeight += Number(c.weight);
  }
  if (Math.abs(totalWeight - 100) > 0.01) throw new HttpError(400, `Criterion weights must total 100%. Current: ${totalWeight}%.`);
  const rubricId = id('prub');
  stmtInsertRubric.run(rubricId, String(title).trim(), kind, JSON.stringify(criteria), user.branchId, user.userId);
  writeAudit(req, `Created placement rubric "${String(title).trim()}" (${kind})`);
  res.status(201).json({ id: rubricId, title, kind, criteria, branchId: user.branchId });
}));

placementTestBankRouter.put('/rubrics/:id', authorize('owner', 'general_manager', 'head_of_department'), ah(async (req, res) => {
  const existing = stmtRubricById.get(req.params.id) as any;
  if (!existing) throw new HttpError(404, 'Rubric not found.');
  assertPlacementAssetBranch(req, existing.branch_id);
  const { title, kind, criteria } = req.body ?? {};
  let totalWeight = 0;
  const nextCriteria = Array.isArray(criteria) ? criteria : JSON.parse(existing.criteria_json || '[]');
  for (const c of nextCriteria) {
    if (!Number.isFinite(Number(c.weight))) throw new HttpError(400, 'Each criterion needs a numeric weight.');
    totalWeight += Number(c.weight);
  }
  if (Array.isArray(criteria) && Math.abs(totalWeight - 100) > 0.01) throw new HttpError(400, `Criterion weights must total 100%. Current: ${totalWeight}%.`);
  stmtUpdateRubric.run(title !== undefined ? String(title).trim() : existing.title, kind !== undefined ? kind : existing.kind, JSON.stringify(nextCriteria), existing.id);
  writeAudit(req, `Updated placement rubric "${existing.title}"`);
  res.json({ id: existing.id, title: title ?? existing.title, kind: kind ?? existing.kind, criteria: nextCriteria });
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

placementTestBankRouter.post('/media/upload', express.raw({ type: () => true, limit: '30mb' }), authorize('owner', 'general_manager', 'head_of_department'), ah(async (req, res) => {
  const user = getUserContext(req);
  const body = req.body as Buffer | undefined;
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!body || body.length === 0) throw new HttpError(400, 'Empty upload body.');
  if (body.length > MAX_MEDIA_BYTES) throw new HttpError(413, `File too large (max ${MAX_MEDIA_BYTES / 1024 / 1024} MB).`);
  const ext = ALLOWED_MIME[mime];
  if (!ext) throw new HttpError(415, `Unsupported media type "${mime}". Allowed: ${Object.keys(ALLOWED_MIME).join(', ')}.`);
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const mediaId = id('pmd');
  const filename = `${mediaId}.${ext}`;
  const storagePath = path.join(MEDIA_DIR, filename);
  fs.writeFileSync(storagePath, body);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  stmtInsertMedia.run(mediaId, filename, mime, body.length, sha256, filename, 'audio', user.branchId, user.userId);
  writeAudit(req, `Uploaded placement media ${filename} (${mime}, ${body.length} bytes)`);
  res.status(201).json({ id: mediaId, filename, mime, sizeBytes: body.length, sha256, kind: 'audio', url: `/api/placement/media/${mediaId}/file` });
}));

placementTestBankRouter.get('/media', authorize('owner', 'general_manager', 'head_of_department', 'receptionist', 'counselor'), ah(async (req, res) => {
  const user = getUserContext(req);
  res.json((stmtMediaByBranch.all(user.branchId) as any[]).map((m) => ({ id: m.id, filename: m.filename, mime: m.mime, sizeBytes: m.size_bytes, sha256: m.sha256, kind: m.kind, createdAt: m.created_at, url: `/api/placement/media/${m.id}/file` })));
}));

placementTestBankRouter.get('/media/:id/file', authorize('owner', 'general_manager', 'head_of_department', 'receptionist', 'counselor'), ah(async (req, res) => {
  const media = stmtMediaById.get(req.params.id) as any;
  if (!media) throw new HttpError(404, 'Media not found.');
  const user = getUserContext(req);
  if (media.branch_id && media.branch_id !== user.branchId) throw new HttpError(403, 'Media belongs to another branch.');
  const fullPath = path.join(MEDIA_DIR, media.storage_path);
  if (!fs.existsSync(fullPath)) throw new HttpError(404, 'Media file missing on disk.');
  res.setHeader('Content-Type', media.mime);
  res.setHeader('Content-Disposition', `inline; filename="${media.filename}"`);
  res.sendFile(fullPath);
}));
