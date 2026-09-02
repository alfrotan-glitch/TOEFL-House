/**
 * Reception workflow — attack paths and projection invariants.
 *
 * Proves, against the real HTTP surface:
 *  - after EVERY lifecycle mutation, the list row (board), the profile and
 *    the workflow endpoint report the same stage, next action and blockers
 *  - enrollment cannot bypass placement, financial clearance, capacity or
 *    the duplicate-seat rule, whichever endpoint is called
 *  - settlement stays behind the finance desk, and cannot overpay
 *  - the read model is branch-scoped and permission-scoped
 *  - a desk holding ten people in ten different states can always answer
 *    where each one is, what blocks them and what happens next
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { db, initSchema } from '../../../db/connection.js';
import { today } from '../../../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import express from 'express';
import supertest from 'supertest';
import { visitorsRouter } from '../../../routes/visitors.routes.js';
import placementRouter from '../../../routes/placement.routes.js';
import { studentsRouter } from '../../../routes/students.routes.js';
import { invoicesRouter } from '../../../routes/invoices.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';

const BRANCH = 'wf14_branch';
const BRANCH_B = 'wf14_branch_b';
const PROGRAM = 'wf14_program';
const VERSION = 'wf14_version';
const LEVEL_A1 = 'wf14_level_a1';
const LEVEL_B1 = 'wf14_level_b1';
const LEVEL_C1 = 'wf14_level_c1';
const CLASS_B1 = 'wf14_class_b1';
const CLASS_C1 = 'wf14_class_c1';
const CLASS_CAP1 = 'wf14_class_cap1';
const PROFILE = 'wf14_profile';

const COMPONENTS = [
  { key: 'grammar', type: 'grammar', label: 'Grammar', required: true, weight: 25, maxScore: 30, durationMinutes: 30, timeLimitSeconds: 1800, instructions: 'Grammar', bankIds: ['wf14_bank_grammar'], blueprintBuckets: [{ count: 30, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['mcq'] }] },
  { key: 'reading', type: 'reading', label: 'Reading', required: true, weight: 16.67, maxScore: 20, durationMinutes: 25, timeLimitSeconds: 1500, instructions: 'Reading', bankIds: ['wf14_bank_reading'], blueprintBuckets: [{ count: 20, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['mcq'] }] },
  { key: 'listening', type: 'listening', label: 'Listening', required: true, weight: 16.67, maxScore: 20, durationMinutes: 25, timeLimitSeconds: 1500, instructions: 'Listening', bankIds: ['wf14_bank_listening'], blueprintBuckets: [{ count: 20, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['mcq'] }] },
  { key: 'writing', type: 'writing', label: 'Writing', required: true, weight: 20.83, maxScore: 25, durationMinutes: 30, timeLimitSeconds: 1800, instructions: 'Writing', bankIds: ['wf14_bank_writing'], blueprintBuckets: [{ count: 1, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['essay'] }] },
  { key: 'speaking', type: 'speaking', label: 'Speaking', required: true, weight: 20.83, maxScore: 25, durationMinutes: 15, timeLimitSeconds: 900, instructions: 'Speaking', bankIds: ['wf14_bank_speaking'], blueprintBuckets: [{ count: 1, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['speaking'] }] },
] as const;

const DECISION_RULES = [
  { cefrLevel: 'A1', recommendedLevelId: LEVEL_A1, minimumScores: { grammar: 5, reading: 3, listening: 3, writing: 8, speaking: 8 } },
  { cefrLevel: 'A2', recommendedLevelId: LEVEL_A1, minimumScores: { grammar: 10, reading: 7, listening: 7, writing: 10, speaking: 10 } },
  { cefrLevel: 'B1', recommendedLevelId: LEVEL_B1, minimumScores: { grammar: 16, reading: 11, listening: 11, writing: 13, speaking: 13 } },
  { cefrLevel: 'B2', recommendedLevelId: LEVEL_B1, minimumScores: { grammar: 22, reading: 15, listening: 15, writing: 17, speaking: 17 } },
  { cefrLevel: 'C1', recommendedLevelId: LEVEL_C1, minimumScores: { grammar: 27, reading: 18, listening: 18, writing: 21, speaking: 21 } },
];

const B1_SCORES = { grammar: 20, reading: 14, listening: 14, writing: 16, speaking: 16 };

const app = express();
app.use(express.json());
app.use('/api/visitors', visitorsRouter);
app.use('/api/placement', placementRouter);
app.use('/api/students', studentsRouter);
app.use('/api/invoices', invoicesRouter);
app.use(errorHandler);

async function seedUser(userId: string, role: string, username: string, branchId: string) {
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`,
  ).run(userId, username, username, branchId, await hashPassword('x'));
  assignRole(userId, role, branchId);
}

const receptionist: TokenPayload = { userId: 'u_wf14_reception', username: 'wf14_reception', branchId: BRANCH, fullName: 'Front Desk' };
const receptionistB: TokenPayload = { userId: 'u_wf14_reception_b', username: 'wf14_reception_b', branchId: BRANCH_B, fullName: 'Other Branch Desk' };
const finance: TokenPayload = { userId: 'u_wf14_finance', username: 'wf14_finance', branchId: BRANCH, fullName: 'Finance Desk' };
const counselor: TokenPayload = { userId: 'u_wf14_counselor', username: 'wf14_counselor', branchId: BRANCH, fullName: 'Counselor' };
const manager: TokenPayload = { userId: 'u_wf14_manager', username: 'wf14_manager', branchId: BRANCH, fullName: 'General Manager' };
const teacher: TokenPayload = { userId: 'u_wf14_teacher', username: 'wf14_teacher', branchId: BRANCH, fullName: 'Teacher' };
const asReception = { Authorization: `Bearer ${signToken(receptionist)}` };
const asReceptionB = { Authorization: `Bearer ${signToken(receptionistB)}` };
const asFinance = { Authorization: `Bearer ${signToken(finance)}` };
const asCounselor = { Authorization: `Bearer ${signToken(counselor)}` };
const asManager = { Authorization: `Bearer ${signToken(manager)}` };
const asTeacher = { Authorization: `Bearer ${signToken(teacher)}` };

function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
}

let visitorSeq = 0;
async function createLead(overrides: Record<string, unknown> = {}): Promise<string> {
  visitorSeq += 1;
  const res = await supertest(app).post('/api/visitors').set(asReception).send({
    fullName: `Attack Lead ${visitorSeq}`,
    gender: 'male',
    source: 'walk_in',
    phone: `0779${String(600000 + visitorSeq).slice(-6)}`,
    programVersionId: VERSION,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function workflowOf(vid: string, auth = asReception) {
  const res = await supertest(app).get(`/api/visitors/${vid}/workflow`).set(auth);
  expect(res.status).toBe(200);
  return res.body;
}

async function admit(vid: string) {
  const res = await supertest(app).post(`/api/visitors/${vid}/convert`).set(asReception).send({});
  expect(res.status).toBe(201);
  return res.body as { studentId: string; studentCode: string; invoices: Array<{ id: string; chargeKind: string; amount: number; status: string }>; nextStep: string };
}

async function startAttempt(vid: string) {
  const res = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(asReception).send({ deliveryMode: 'PHYSICAL' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function runPlacement(vid: string, scores: typeof B1_SCORES) {
  const attemptId = await startAttempt(vid);
  for (const key of ['grammar', 'reading', 'listening', 'writing', 'speaking'] as const) {
    const timer = await supertest(app).put(`/api/placement/visitors/${vid}/placement/attempts/${attemptId}/tests/${key}/start`).set(asReception).send({});
    expect(timer.status).toBe(200);
    const scored = await supertest(app).put(`/api/placement/visitors/${vid}/placement/attempts/${attemptId}/components/${key}`).set(asReception).send({ score: scores[key] });
    expect(scored.status).toBe(200);
  }
  const complete = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts/${attemptId}/complete`).set(asReception).send({});
  expect(complete.status).toBe(200);
  return complete.body;
}

async function settleRegistration(admission: Awaited<ReturnType<typeof admit>>) {
  const invoiceId = admission.invoices.find((invoice) => invoice.chargeKind === 'registration')!.id;
  const payment = await supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(asFinance).send({ amount: 500, paymentMethod: 'cash' });
  expect(payment.status).toBe(201);
  return invoiceId;
}

async function enroll(studentId: string, classId: string, semesterName: string, auth = asReception) {
  return supertest(app).post(`/api/students/${studentId}/enroll-semester`).set(auth)
    .send({ semesterName, classId, tuitionAmount: 20000, amountPaidNow: 0 });
}

/** The board row, the profile and the workspace must tell one story. */
async function assertProjections(vid: string) {
  const workflow = await workflowOf(vid);
  const expected = {
    stage: workflow.stage,
    nextAction: workflow.nextAction,
    blockers: (workflow.blockers as Array<{ code: string; reason: string }>)
      .map((b) => `${b.code}:${b.reason}`)
      .sort(),
  };

  const detail = await supertest(app).get(`/api/visitors/${vid}`).set(asReception);
  expect(detail.status).toBe(200);
  expect(detail.body.workflow).toMatchObject({ stage: expected.stage, nextAction: expected.nextAction });
  expect((detail.body.workflow.blockers as Array<{ code: string; reason: string }>).map((b) => `${b.code}:${b.reason}`).sort())
    .toEqual(expected.blockers);

  const list = await supertest(app).get('/api/visitors/?limit=200').set(asReception);
  expect(list.status).toBe(200);
  const row = (list.body as Array<{ id: string; workflow?: { stage: string; nextAction: string; blockers: Array<{ code: string; reason: string }> } }>).find((v) => v.id === vid);
  expect(row).toBeDefined();
  expect(row!.workflow).toMatchObject({ stage: expected.stage, nextAction: expected.nextAction });
  expect(row!.workflow!.blockers.map((b) => `${b.code}:${b.reason}`).sort()).toEqual(expected.blockers);
  return workflow;
}

function insertBank(bankId: string, testType: string, questionCount: number, qtype: 'mcq' | 'essay' | 'speaking') {
  db.prepare(`
    INSERT OR REPLACE INTO placement_tests (id, title, test_type, instructions, status, branch_id, duration_seconds, version)
    VALUES (?, ?, ?, ?, 'active', ?, ?, 1)
  `).run(bankId, `${testType} bank`, testType, `${testType} instructions`, BRANCH, Math.max(60, questionCount * 60));
  for (let i = 0; i < questionCount; i += 1) {
    db.prepare(`
      INSERT OR REPLACE INTO placement_test_questions
        (id, test_id, question_key, qtype, prompt, options_json, answer_key, points, order_index, difficulty, cefr_level, topic, subskill, lifecycle_status, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'medium', 'A1', ?, ?, 'active', 1)
    `).run(
      `${bankId}_q${i + 1}`, bankId, `${testType}_${i + 1}`, qtype, `${testType} prompt ${i + 1}`,
      qtype === 'mcq' ? JSON.stringify([{ key: 'A', text: 'Correct' }, { key: 'B', text: 'Wrong' }]) : null,
      qtype === 'mcq' ? 'A' : null, i, testType, testType,
    );
  }
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Attack Branch', 'Kabul');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_B, 'Attack Branch B', 'Herat');
  await seedUser('u_wf14_reception', 'receptionist', 'wf14_reception', BRANCH);
  await seedUser('u_wf14_reception_b', 'receptionist', 'wf14_reception_b', BRANCH_B);
  await seedUser('u_wf14_finance', 'finance_manager', 'wf14_finance', BRANCH);
  await seedUser('u_wf14_counselor', 'counselor', 'wf14_counselor', BRANCH);
  await seedUser('u_wf14_manager', 'general_manager', 'wf14_manager', BRANCH);
  await seedUser('u_wf14_teacher', 'teacher', 'wf14_teacher', BRANCH);

  db.prepare('INSERT OR IGNORE INTO programs (id, name, duration_months, branch_id, is_active) VALUES (?, ?, 12, ?, 1)').run(PROGRAM, 'Attack Program', BRANCH);
  db.prepare('INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status, is_default) VALUES (?, ?, ?, 1, ?, 1)').run(VERSION, PROGRAM, 'v1', 'published');
  db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'A1', 1, ?, 'A1', 1)`).run(LEVEL_A1, PROGRAM, VERSION);
  db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'B1', 2, ?, 'B1', 1)`).run(LEVEL_B1, PROGRAM, VERSION);
  db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'C1', 3, ?, 'C1', 1)`).run(LEVEL_C1, PROGRAM, VERSION);

  insertBank('wf14_bank_grammar', 'grammar', 30, 'mcq');
  insertBank('wf14_bank_reading', 'reading', 20, 'mcq');
  insertBank('wf14_bank_listening', 'listening', 20, 'mcq');
  insertBank('wf14_bank_writing', 'writing', 1, 'essay');
  insertBank('wf14_bank_speaking', 'speaking', 1, 'speaking');

  db.prepare(`
    INSERT OR REPLACE INTO placement_assessment_profiles
      (id, program_version_id, branch_id, components_json, scoring_model, allow_retake, pass_score, requirement_mode, instructions, decision_rules_json)
    VALUES (?, ?, ?, ?, 'canonical', 1, 60, 'required', 'Complete every configured component.', ?)
  `).run(PROFILE, VERSION, BRANCH, JSON.stringify(COMPONENTS), JSON.stringify(DECISION_RULES));

  db.prepare(`INSERT OR REPLACE INTO fee_rules (id, branch_id, program_version_id, fee_type, name, amount, version, is_active) VALUES ('wf14_registration_fee', ?, ?, 'registration', 'Admission registration', 500, 1, 1)`).run(BRANCH, VERSION);
  db.prepare(`INSERT OR REPLACE INTO fee_rules (id, branch_id, program_version_id, fee_type, name, amount, version, is_active) VALUES ('wf14_placement_fee', ?, ?, 'placement', 'Placement fee', 0, 1, 1)`).run(BRANCH, VERSION);
  db.prepare(`INSERT OR REPLACE INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active) VALUES ('wf14_tuition_fee', ?, 'semester', 'Tuition', 20000, 1, 1)`).run(BRANCH);

  const insertClass = (classId: string, name: string, levelId: string, capacity: number) =>
    db.prepare(`
      INSERT OR REPLACE INTO classes (id, name, level, level_id, program_id, branch_id, status, lifecycle_stage, schedule_time, fee, capacity)
      VALUES (?, ?, ?, ?, ?, ?, 'active', 'in_progress', '08:00', 20000, ?)
    `).run(classId, name, name, levelId, PROGRAM, BRANCH, capacity);
  insertClass(CLASS_B1, 'Attack B1 Class', LEVEL_B1, 20);
  insertClass(CLASS_C1, 'Attack C1 Class', LEVEL_C1, 20);
  insertClass(CLASS_CAP1, 'Attack Capacity-1 Class', LEVEL_B1, 1);
});

describe('projection invariant across the lifecycle', () => {
  it('keeps board, profile and workspace in agreement after every mutation', async () => {
    const vid = await createLead();

    const lead = await assertProjections(vid);
    expect(lead.stage).toBe('lead');
    expect(lead.nextAction).toBe('log_follow_up');

    await supertest(app).post(`/api/visitors/${vid}/followups`).set(asReception)
      .send({ notes: 'Revisiting tomorrow', outcome: 'callback', nextContactDate: futureDate(1) });
    const nurturing = await assertProjections(vid);
    expect(nurturing.stage).toBe('admission');
    expect(nurturing.nextAction).toBe('admit');

    const admission = await admit(vid);
    const admitted = await assertProjections(vid);
    expect(admitted.stage).toBe('placement');

    const attemptId = await startAttempt(vid);
    expect(attemptId).toBeTruthy();
    const inProgress = await assertProjections(vid);
    expect(inProgress.stage).toBe('placement');
    expect(inProgress.placement.status).toBe('in_progress');
    expect(inProgress.nextActionReason).toMatch(/in progress/i);

    for (const key of ['grammar', 'reading', 'listening', 'writing', 'speaking'] as const) {
      await supertest(app).put(`/api/placement/visitors/${vid}/placement/attempts/${attemptId}/tests/${key}/start`).set(asReception).send({}).expect(200);
      await supertest(app).put(`/api/placement/visitors/${vid}/placement/attempts/${attemptId}/components/${key}`).set(asReception).send({ score: B1_SCORES[key] }).expect(200);
    }
    await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts/${attemptId}/complete`).set(asReception).send({}).expect(200);
    const cleared = await assertProjections(vid);
    expect(cleared.stage).toBe('financial_clearance');
    expect(cleared.blockers.some((b: { code: string }) => b.code === 'admission_fees_outstanding')).toBe(true);

    await settleRegistration(admission);
    const ready = await assertProjections(vid);
    expect(ready.stage).toBe('enrollment');
    expect(ready.nextAction).toBe('enroll');

    const enrollment = await enroll(admission.studentId, CLASS_B1, 'Projection Term');
    expect(enrollment.status).toBe(201);
    const done = await assertProjections(vid);
    expect(done.stage).toBe('enrolled');
    expect(done.nextAction).toBe('view_enrollment');
    expect(done.enrollment.classId).toBe(CLASS_B1);
  });
});

describe('enrollment gates under attack', () => {
  it('blocks enrollment when placement has not been completed', async () => {
    const vid = await createLead();
    const admission = await admit(vid);
    await settleRegistration(admission);

    const attempt = await enroll(admission.studentId, CLASS_B1, 'No Placement Term');
    expect([400, 409]).toContain(attempt.status);
    expect(attempt.body.error).toMatch(/placement/i);
  });

  it('blocks enrollment when the target level is above the recommendation', async () => {
    const vid = await createLead();
    const admission = await admit(vid);
    await runPlacement(vid, B1_SCORES);
    await settleRegistration(admission);

    const above = await enroll(admission.studentId, CLASS_C1, 'Too High Term');
    expect(above.status).toBe(409);
    expect(above.body.error).toMatch(/above the authorized level/i);
  });

  it('blocks enrollment into a full class', async () => {
    const first = await createLead();
    const firstAdmission = await admit(first);
    await runPlacement(first, B1_SCORES);
    await settleRegistration(firstAdmission);
    const seatOne = await enroll(firstAdmission.studentId, CLASS_CAP1, 'Capacity Term');
    expect(seatOne.status).toBe(201);

    const second = await createLead();
    const secondAdmission = await admit(second);
    await runPlacement(second, B1_SCORES);
    await settleRegistration(secondAdmission);
    const seatTwo = await enroll(secondAdmission.studentId, CLASS_CAP1, 'Capacity Term');
    expect(seatTwo.status).toBe(409);
    expect(seatTwo.body.error).toMatch(/class is full/i);
  });

  it('refuses a duplicate enrollment (double-click and repeat)', async () => {
    const vid = await createLead();
    const admission = await admit(vid);
    await runPlacement(vid, B1_SCORES);
    await settleRegistration(admission);

    const first = await enroll(admission.studentId, CLASS_B1, 'Duplicate Term');
    expect(first.status).toBe(201);
    const repeat = await enroll(admission.studentId, CLASS_B1, 'Duplicate Term');
    expect([403, 409]).toContain(repeat.status);
    expect(repeat.body.error).toMatch(/already enrolled|debt|hold/i);
    const managerRepeat = await enroll(admission.studentId, CLASS_B1, 'Duplicate Term', asManager);
    expect(managerRepeat.status).toBe(409);
    expect(managerRepeat.body.error).toMatch(/already enrolled/i);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM enrollments WHERE student_id = ? AND class_id = ?`).get(admission.studentId, CLASS_B1)).toEqual({ c: 1 });
  });

  it('refuses a second placement attempt while one is open', async () => {
    const vid = await createLead();
    await admit(vid);
    await startAttempt(vid);
    const second = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(asReception).send({ deliveryMode: 'PHYSICAL' });
    expect(second.status).toBe(409);
  });
});

describe('settlement under attack', () => {
  it('keeps invoice payment behind the finance desk', async () => {
    const vid = await createLead();
    const admission = await admit(vid);
    const invoiceId = admission.invoices.find((invoice) => invoice.chargeKind === 'registration')!.id;

    const asReceptionist = await supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(asReception).send({ amount: 500, paymentMethod: 'cash' });
    expect(asReceptionist.status).toBe(403);
    const asCounselorAttempt = await supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(asCounselor).send({ amount: 500, paymentMethod: 'cash' });
    expect(asCounselorAttempt.status).toBe(403);

    const workflow = await workflowOf(vid);
    expect(workflow.capabilities.canSettleInvoices).toBe(false);
    expect(workflow.financial.totalOutstanding).toBe(500);
  });

  it('records a double-clicked payment once and refuses further amounts', async () => {
    const vid = await createLead();
    const admission = await admit(vid);
    const invoiceId = await settleRegistration(admission);

    const retry = await supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(asFinance).send({ amount: 500, paymentMethod: 'cash' });
    expect(retry.status).toBe(200);
    expect(retry.body.idempotentReplay).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS c FROM payments WHERE invoice_id = ?').get(invoiceId)).toEqual({ c: 1 });

    const extra = await supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(asFinance).send({ amount: 100, paymentMethod: 'cash' });
    expect([400, 409]).toContain(extra.status);
    expect(extra.body.error).toMatch(/already fully paid|only issued, partial, or overdue/i);
  });
});

describe('scope and permission attacks', () => {
  it('hides another branch\'s person from the desk', async () => {
    const vid = await createLead();

    const workflow = await supertest(app).get(`/api/visitors/${vid}/workflow`).set(asReceptionB);
    expect(workflow.status).toBe(403);

    const detail = await supertest(app).get(`/api/visitors/${vid}`).set(asReceptionB);
    expect(detail.status).toBe(403);

    const convert = await supertest(app).post(`/api/visitors/${vid}/convert`).set(asReceptionB).send({});
    expect(convert.status).toBe(403);

    const list = await supertest(app).get('/api/visitors/?limit=200').set(asReceptionB);
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string }>).some((v) => v.id === vid)).toBe(false);
  });

  it('denies workflow writes the caller\'s role does not carry', async () => {
    const vid = await createLead();
    await supertest(app).post(`/api/visitors/${vid}/followups`).set(asCounselor)
      .send({ notes: 'Counselor called', outcome: 'callback', nextContactDate: futureDate(2) }).expect(201);

    const workflow = await workflowOf(vid, asCounselor);
    expect(workflow.capabilities.canFollowUp).toBe(true);
    expect(workflow.capabilities.canAdmit).toBe(false);

    const convert = await supertest(app).post(`/api/visitors/${vid}/convert`).set(asCounselor).send({});
    expect(convert.status).toBe(403);
  });

  it('keeps the read model and placement writes away from roles without lead access', async () => {
    const vid = await createLead();

    const workflow = await supertest(app).get(`/api/visitors/${vid}/workflow`).set(asTeacher);
    expect(workflow.status).toBe(403);

    const attempt = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(asTeacher).send({ deliveryMode: 'PHYSICAL' });
    expect(attempt.status).toBe(403);
  });
});

describe('a desk of ten people in ten states', () => {
  it('answers state, blocker and next action for every one of them', async () => {
    // 1 — fresh lead
    const fresh = await createLead();

    // 2 — a lead with follow-up history whose admission is blocked: closed
    //     after contact. This is the population the follow-up column holds.
    const lapsed = await createLead();
    await supertest(app).post(`/api/visitors/${lapsed}/followups`).set(asReception)
      .send({ notes: 'Promised to return, then went quiet', outcome: 'callback', nextContactDate: futureDate(3) }).expect(201);
    await supertest(app).post(`/api/visitors/${lapsed}/advance-stage`).set(asReception).send({ stage: 'lost', fromStage: 'lead' }).expect(200);

    // 3 — ready to admit
    const readyToAdmit = await createLead();
    await supertest(app).post(`/api/visitors/${readyToAdmit}/followups`).set(asReception)
      .send({ notes: 'Wants to register', outcome: 'interested', nextContactDate: futureDate(1) }).expect(201);

    // 4 — admitted, placement pending
    const admitted = await createLead();
    const admittedInfo = await admit(admitted);

    // 5 — placement attempt open
    const inPlacement = await createLead();
    const inPlacementInfo = await admit(inPlacement);
    await startAttempt(inPlacement);

    // 6 — placement done, fees outstanding
    const owesFees = await createLead();
    const owesFeesInfo = await admit(owesFees);
    await runPlacement(owesFees, B1_SCORES);

    // 7 — paid, ready to enroll
    const readyToEnroll = await createLead();
    const readyToEnrollInfo = await admit(readyToEnroll);
    await runPlacement(readyToEnroll, B1_SCORES);
    await settleRegistration(readyToEnrollInfo);

    // 8 — enrolled
    const enrolledPerson = await createLead();
    const enrolledInfo = await admit(enrolledPerson);
    await runPlacement(enrolledPerson, B1_SCORES);
    await settleRegistration(enrolledInfo);
    expect((await enroll(enrolledInfo.studentId, CLASS_B1, 'Ten States Term')).status).toBe(201);

    // 9 — closed lead
    const closed = await createLead();
    await supertest(app).post(`/api/visitors/${closed}/advance-stage`).set(asReception).send({ stage: 'lost', fromStage: 'lead' }).expect(200);

    // 10 — above-level-blocked (recommendation B1, wants C1)
    const levelBlocked = await createLead();
    const levelBlockedInfo = await admit(levelBlocked);
    await runPlacement(levelBlocked, B1_SCORES);
    await settleRegistration(levelBlockedInfo);
    expect((await enroll(levelBlockedInfo.studentId, CLASS_C1, 'Blocked Term')).status).toBe(409);

    const expectations: Array<{ vid: string; stage: string; nextAction: string; blocker?: string }> = [
      { vid: fresh, stage: 'lead', nextAction: 'log_follow_up' },
      { vid: lapsed, stage: 'follow_up', nextAction: 'log_follow_up', blocker: 'lead_lost' },
      { vid: readyToAdmit, stage: 'admission', nextAction: 'admit' },
      { vid: admitted, stage: 'placement', nextAction: 'start_placement' },
      { vid: inPlacement, stage: 'placement', nextAction: 'start_placement' },
      { vid: owesFees, stage: 'financial_clearance', nextAction: 'settle_admission_fees', blocker: 'admission_fees_outstanding' },
      { vid: readyToEnroll, stage: 'enrollment', nextAction: 'enroll' },
      { vid: enrolledPerson, stage: 'enrolled', nextAction: 'view_enrollment' },
      { vid: closed, stage: 'lead', nextAction: 'log_follow_up', blocker: 'lead_lost' },
      { vid: levelBlocked, stage: 'enrollment', nextAction: 'enroll' },
    ];

    const STAGES = ['lead', 'follow_up', 'admission', 'placement', 'financial_clearance', 'enrollment', 'enrolled'];
    const ACTIONS = ['log_follow_up', 'admit', 'start_placement', 'settle_admission_fees', 'enroll', 'view_enrollment'];

    for (const expectation of expectations) {
      const workflow = await assertProjections(expectation.vid);
      expect(STAGES).toContain(workflow.stage);
      expect(workflow.stage).toBe(expectation.stage);
      expect(ACTIONS).toContain(workflow.nextAction);
      expect(workflow.nextAction).toBe(expectation.nextAction);
      expect(String(workflow.nextActionReason || '').length).toBeGreaterThan(5);
      for (const blocker of workflow.blockers as Array<{ code: string; reason: string }>) {
        expect(String(blocker.reason || '').length).toBeGreaterThan(5);
      }
      if (expectation.blocker) {
        expect(workflow.blockers.some((b: { code: string }) => b.code.includes(expectation.blocker!))).toBe(true);
      }
    }

    // The closed person must not masquerade as active pipeline.
    const closedWorkflow = await workflowOf(closed);
    expect(closedWorkflow.closed).toBe(true);
    // The in-placement person reports the attempt honestly.
    const attemptWorkflow = await workflowOf(inPlacement);
    expect(attemptWorkflow.placement.status).toBe('in_progress');
    // The enrolled person names their class.
    const enrolledWorkflow = await workflowOf(enrolledPerson);
    expect(enrolledWorkflow.enrollment.className).toBeTruthy();
    // The level-blocked person's reason carries the recommendation.
    const blockedWorkflow = await workflowOf(levelBlocked);
    expect(blockedWorkflow.nextActionReason).toMatch(/B1/);
    expect(admittedInfo.studentId).toBeTruthy();
    expect(inPlacementInfo.studentId).toBeTruthy();
    expect(owesFeesInfo.studentId).toBeTruthy();
    expect(String(today())).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
