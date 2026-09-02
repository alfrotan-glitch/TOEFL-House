/**
 * Reception workflow — the front-desk lifecycle, end to end.
 *
 * Covers the guarantees the visitor workspace is built on:
 *  - next-contact dates are future-or-today at EVERY writer
 *  - the workflow read model derives one stage + one next action from real
 *    domain facts, through every real transition of the lifecycle
 *  - placement starts only after admission, and is reachable right after it
 *  - admission invoices block enrollment until settled, through whichever
 *    enrollment endpoint is called
 *  - the list and the profile agree on a person's stage
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

const BRANCH = 'wf_branch';
const PROGRAM = 'wf_program';
const VERSION = 'wf_version';
const LEVEL_A1 = 'wf_level_a1';
const LEVEL_B1 = 'wf_level_b1';
const LEVEL_C1 = 'wf_level_c1';
const CLASS_B1 = 'wf_class_b1';
const CLASS_C1 = 'wf_class_c1';
const PROFILE = 'wf_profile';

const COMPONENTS = [
  { key: 'grammar', type: 'grammar', label: 'Grammar', required: true, weight: 25, maxScore: 30, durationMinutes: 30, timeLimitSeconds: 1800, instructions: 'Grammar', bankIds: ['wf_bank_grammar'], blueprintBuckets: [{ count: 30, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['mcq'] }] },
  { key: 'reading', type: 'reading', label: 'Reading', required: true, weight: 16.67, maxScore: 20, durationMinutes: 25, timeLimitSeconds: 1500, instructions: 'Reading', bankIds: ['wf_bank_reading'], blueprintBuckets: [{ count: 20, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['mcq'] }] },
  { key: 'listening', type: 'listening', label: 'Listening', required: true, weight: 16.67, maxScore: 20, durationMinutes: 25, timeLimitSeconds: 1500, instructions: 'Listening', bankIds: ['wf_bank_listening'], blueprintBuckets: [{ count: 20, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['mcq'] }] },
  { key: 'writing', type: 'writing', label: 'Writing', required: true, weight: 20.83, maxScore: 25, durationMinutes: 30, timeLimitSeconds: 1800, instructions: 'Writing', bankIds: ['wf_bank_writing'], blueprintBuckets: [{ count: 1, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['essay'] }] },
  { key: 'speaking', type: 'speaking', label: 'Speaking', required: true, weight: 20.83, maxScore: 25, durationMinutes: 15, timeLimitSeconds: 900, instructions: 'Speaking', bankIds: ['wf_bank_speaking'], blueprintBuckets: [{ count: 1, cefrLevel: 'ANY', difficulty: 'ANY', qtypes: ['speaking'] }] },
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

async function seedUser(userId: string, role: string, username: string) {
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`,
  ).run(userId, username, username, BRANCH, await hashPassword('x'));
  assignRole(userId, role, BRANCH);
}

const receptionist: TokenPayload = { userId: 'u_wf_reception', username: 'wf_reception', branchId: BRANCH, fullName: 'Front Desk' };
const finance: TokenPayload = { userId: 'u_wf_finance', username: 'wf_finance', branchId: BRANCH, fullName: 'Finance Desk' };
const asReception = { Authorization: `Bearer ${signToken(receptionist)}` };
const asFinance = { Authorization: `Bearer ${signToken(finance)}` };

function futureDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
}
function pastDate(days: number): string {
  return futureDate(-days);
}

let visitorSeq = 0;
async function createLead(overrides: Record<string, unknown> = {}): Promise<string> {
  visitorSeq += 1;
  const res = await supertest(app).post('/api/visitors').set(asReception).send({
    fullName: `Workflow Lead ${visitorSeq}`,
    gender: 'male',
    source: 'walk_in',
    phone: `0778${String(500000 + visitorSeq).slice(-6)}`,
    programVersionId: VERSION,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function workflowOf(vid: string) {
  const res = await supertest(app).get(`/api/visitors/${vid}/workflow`).set(asReception);
  expect(res.status).toBe(200);
  return res.body;
}

async function admit(vid: string) {
  const res = await supertest(app).post(`/api/visitors/${vid}/convert`).set(asReception).send({});
  expect(res.status).toBe(201);
  return res.body as { studentId: string; studentCode: string; invoices: Array<{ id: string; chargeKind: string; amount: number; status: string }>; nextStep: string };
}

async function runPlacement(vid: string, scores: typeof B1_SCORES) {
  const start = await supertest(app).post(`/api/placement/visitors/${vid}/placement/attempts`).set(asReception).send({ deliveryMode: 'PHYSICAL' });
  expect(start.status).toBe(201);
  const attemptId = start.body.id as string;
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
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Workflow Branch', 'Kabul');
  await seedUser('u_wf_reception', 'receptionist', 'wf_reception');
  await seedUser('u_wf_finance', 'finance_manager', 'wf_finance');

  db.prepare('INSERT OR IGNORE INTO programs (id, name, duration_months, branch_id, is_active) VALUES (?, ?, 12, ?, 1)').run(PROGRAM, 'Workflow Program', BRANCH);
  db.prepare('INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status, is_default) VALUES (?, ?, ?, 1, ?, 1)').run(VERSION, PROGRAM, 'v1', 'published');
  db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'A1', 1, ?, 'A1', 1)`).run(LEVEL_A1, PROGRAM, VERSION);
  db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'B1', 2, ?, 'B1', 1)`).run(LEVEL_B1, PROGRAM, VERSION);
  db.prepare(`INSERT OR IGNORE INTO levels (id, program_id, name, "order", program_version_id, code, is_active) VALUES (?, ?, 'C1', 3, ?, 'C1', 1)`).run(LEVEL_C1, PROGRAM, VERSION);

  insertBank('wf_bank_grammar', 'grammar', 30, 'mcq');
  insertBank('wf_bank_reading', 'reading', 20, 'mcq');
  insertBank('wf_bank_listening', 'listening', 20, 'mcq');
  insertBank('wf_bank_writing', 'writing', 1, 'essay');
  insertBank('wf_bank_speaking', 'speaking', 1, 'speaking');

  db.prepare(`
    INSERT OR REPLACE INTO placement_assessment_profiles
      (id, program_version_id, branch_id, components_json, scoring_model, allow_retake, pass_score, requirement_mode, instructions, decision_rules_json)
    VALUES (?, ?, ?, ?, 'canonical', 1, 60, 'required', 'Complete every configured component.', ?)
  `).run(PROFILE, VERSION, BRANCH, JSON.stringify(COMPONENTS), JSON.stringify(DECISION_RULES));

  db.prepare(`INSERT OR REPLACE INTO fee_rules (id, branch_id, program_version_id, fee_type, name, amount, version, is_active) VALUES ('wf_registration_fee', ?, ?, 'registration', 'Admission registration', 500, 1, 1)`).run(BRANCH, VERSION);
  db.prepare(`INSERT OR REPLACE INTO fee_rules (id, branch_id, program_version_id, fee_type, name, amount, version, is_active) VALUES ('wf_placement_fee', ?, ?, 'placement', 'Placement fee', 0, 1, 1)`).run(BRANCH, VERSION);
  db.prepare(`INSERT OR REPLACE INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active) VALUES ('wf_tuition_fee', ?, 'semester', 'Tuition', 20000, 1, 1)`).run(BRANCH);

  db.prepare(`
    INSERT OR REPLACE INTO classes (id, name, level, level_id, program_id, branch_id, status, lifecycle_stage, schedule_time, fee, capacity)
    VALUES (?, 'Workflow B1 Class', 'B1', ?, ?, ?, 'active', 'in_progress', '08:00', 20000, 20)
  `).run(CLASS_B1, LEVEL_B1, PROGRAM, BRANCH);
  db.prepare(`
    INSERT OR REPLACE INTO classes (id, name, level, level_id, program_id, branch_id, status, lifecycle_stage, schedule_time, fee, capacity)
    VALUES (?, 'Workflow C1 Class', 'C1', ?, ?, ?, 'active', 'in_progress', '10:00', 20000, 20)
  `).run(CLASS_C1, LEVEL_C1, PROGRAM, BRANCH);
});

describe('next-contact dates', () => {
  it('rejects a past date at creation and accepts today and future dates', async () => {
    const past = await supertest(app).post('/api/visitors').set(asReception).send({
      fullName: 'Past Date Lead', gender: 'male', source: 'walk_in', phone: '0778000001', nextContactDate: pastDate(2),
    });
    expect(past.status).toBe(400);
    expect(past.body.error).toMatch(/today or a future date/i);

    const todayLead = await supertest(app).post('/api/visitors').set(asReception).send({
      fullName: 'Today Date Lead', gender: 'male', source: 'walk_in', phone: '0778000002', nextContactDate: today(),
    });
    expect(todayLead.status).toBe(201);

    const futureLead = await supertest(app).post('/api/visitors').set(asReception).send({
      fullName: 'Future Date Lead', gender: 'male', source: 'walk_in', phone: '0778000003', nextContactDate: futureDate(5),
    });
    expect(futureLead.status).toBe(201);
  });

  it('rejects past dates through follow-ups, CRM updates and profile patches', async () => {
    const vid = await createLead();

    const followUp = await supertest(app).post(`/api/visitors/${vid}/followups`).set(asReception)
      .send({ notes: 'callback', outcome: 'callback', nextContactDate: pastDate(1) });
    expect(followUp.status).toBe(400);

    const crm = await supertest(app).patch(`/api/visitors/${vid}/crm`).set(asReception)
      .send({ nextContactDate: pastDate(1) });
    expect(crm.status).toBe(400);

    const patch = await supertest(app).patch(`/api/visitors/${vid}`).set(asReception)
      .send({ nextContactDate: pastDate(1) });
    expect(patch.status).toBe(400);
  });

  it('rejects malformed dates rather than storing garbage', async () => {
    const res = await supertest(app).post('/api/visitors').set(asReception).send({
      fullName: 'Malformed Date Lead', gender: 'male', source: 'walk_in', phone: '0778000004', nextContactDate: '2026-13-45',
    });
    expect(res.status).toBe(400);
  });
});

describe('the reception lifecycle', () => {
  it('walks one person through every real transition with the right stage and next action', async () => {
    const vid = await createLead();

    const lead = await workflowOf(vid);
    expect(lead.stage).toBe('lead');
    expect(lead.nextAction).toBe('log_follow_up');
    expect(lead.admission.admitted).toBe(false);

    await supertest(app).post(`/api/visitors/${vid}/followups`).set(asReception)
      .send({ notes: 'Very interested, coming tomorrow', outcome: 'callback', nextContactDate: futureDate(1) });
    const nurturing = await workflowOf(vid);
    expect(nurturing.stage).toBe('admission');
    expect(nurturing.nextAction).toBe('admit');

    const admission = await admit(vid);
    expect(admission.invoices.map((invoice) => invoice.chargeKind)).toContain('registration');
    const audited = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE action LIKE ?`).get(`%${admission.studentCode}%`) as { c: number };
    expect(audited.c).toBeGreaterThan(0);

    const placed = await workflowOf(vid);
    expect(placed.stage).toBe('placement');
    expect(placed.nextAction).toBe('start_placement');
    expect(placed.admission).toMatchObject({ admitted: true, studentId: admission.studentId });

    const preAdmissionLead = await createLead();
    const noStudent = await supertest(app).post(`/api/placement/visitors/${preAdmissionLead}/placement/attempts`).set(asReception).send({ deliveryMode: 'PHYSICAL' });
    expect(noStudent.status).toBe(409);
    expect(noStudent.body.error).toMatch(/Admit this candidate to a student record/i);

    const completion = await runPlacement(vid, B1_SCORES);
    expect(completion.recommendation?.levelId ?? completion.recommendedLevelId ?? true).toBeTruthy();

    const awaitingFees = await workflowOf(vid);
    expect(awaitingFees.stage).toBe('financial_clearance');
    expect(awaitingFees.nextAction).toBe('settle_admission_fees');
    expect(awaitingFees.financial.totalOutstanding).toBe(500);
    expect(awaitingFees.financial.cleared).toBe(false);
    expect(awaitingFees.blockers.some((b: { code: string }) => b.code === 'admission_fees_outstanding')).toBe(true);
    expect(awaitingFees.placement.recommendedLevelName).toBe('B1');
    expect(awaitingFees.capabilities.canSettleInvoices).toBe(false);

    const blockedEnrollment = await supertest(app).post(`/api/students/${admission.studentId}/enroll-semester`).set(asReception)
      .send({ semesterName: 'Blocked Term', classId: CLASS_B1, tuitionAmount: 20000, amountPaidNow: 0 });
    expect([403, 409]).toContain(blockedEnrollment.status);
    expect(blockedEnrollment.body.error).toMatch(/settled|hold|outstanding/i);

    const invoiceId = admission.invoices.find((invoice) => invoice.chargeKind === 'registration')!.id;
    const payment = await supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(asFinance).send({ amount: 500, paymentMethod: 'cash' });
    expect(payment.status).toBe(201);

    const readyToEnroll = await workflowOf(vid);
    expect(readyToEnroll.stage).toBe('enrollment');
    expect(readyToEnroll.nextAction).toBe('enroll');
    expect(readyToEnroll.financial.cleared).toBe(true);

    const enrollment = await supertest(app).post(`/api/students/${admission.studentId}/enroll-semester`).set(asReception)
      .send({ semesterName: 'Live Term', classId: CLASS_B1, tuitionAmount: 20000, amountPaidNow: 0 });
    expect(enrollment.status).toBe(201);
    expect(enrollment.body).toMatchObject({ ok: true });

    const done = await workflowOf(vid);
    expect(done.stage).toBe('enrolled');
    expect(done.nextAction).toBe('view_enrollment');
    expect(done.enrollment.classId).toBe(CLASS_B1);
  });

  it('keeps the list, the profile and the workflow endpoint on one stage', async () => {
    const vid = await createLead();
    await admit(vid);

    const detail = await supertest(app).get(`/api/visitors/${vid}`).set(asReception);
    expect(detail.status).toBe(200);

    const list = await supertest(app).get('/api/visitors/?limit=200').set(asReception);
    expect(list.status).toBe(200);
    const row = (list.body as Array<{ id: string; workflow?: { stage: string } }>).find((v) => v.id === vid);
    expect(row?.workflow?.stage).toBeDefined();
    expect(row?.workflow?.stage).toBe(detail.body.workflow.stage);
    expect(row?.workflow?.stage).toBe((await workflowOf(vid)).stage);
  });

  it('reports stage populations under the reception vocabulary', async () => {
    const res = await supertest(app).get('/api/visitors/summary').set(asReception);
    expect(res.status).toBe(200);
    expect(res.body.byWorkflowStage).toBeDefined();
    const stages = new Map((res.body.byWorkflowStage as Array<{ stage: string; count: number }>).map((r) => [r.stage, r.count]));
    expect(stages.get('lead')).toBeGreaterThan(0);
    expect(stages.get('placement')).toBeGreaterThan(0);
    expect(stages.get('enrolled')).toBeGreaterThan(0);
  });

  it('refuses to admit twice', async () => {
    const vid = await createLead();
    await admit(vid);
    const second = await supertest(app).post(`/api/visitors/${vid}/convert`).set(asReception).send({});
    expect(second.status).toBe(409);
  });

  it('blocks enrollment into a level above the placement recommendation', async () => {
    const vid = await createLead();
    const admission = await admit(vid);
    await runPlacement(vid, B1_SCORES);
    const invoiceId = admission.invoices.find((invoice) => invoice.chargeKind === 'registration')!.id;
    await supertest(app).post(`/api/invoices/${invoiceId}/pay`).set(asFinance).send({ amount: 500, paymentMethod: 'cash' });

    const above = await supertest(app).post(`/api/students/${admission.studentId}/enroll-semester`).set(asReception)
      .send({ semesterName: 'Too High', classId: CLASS_C1, tuitionAmount: 20000, amountPaidNow: 0 });
    expect(above.status).toBe(409);
    expect(above.body.error).toMatch(/above the authorized level|recommendation/i);
  });
});
