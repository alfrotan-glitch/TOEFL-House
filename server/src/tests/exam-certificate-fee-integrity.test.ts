/**
 * EXAMS — certificate issuance and diploma-fee integrity.
 *
 * The exams router had no dedicated test coverage despite charging two kinds of
 * money through `recordIncome`: the exam fee on enrolment and the diploma fee
 * on certificate issuance.
 *
 * EXM-1 (the defect this suite is written against):
 *   `PATCH /exams/:id/results/:resultId` (score entry) charges the branch
 *   diploma fee when it issues a certificate.
 *   `PUT  /exams/:id/results/:resultId/correct` (score correction) ALSO issues
 *   a certificate — when a corrected score crosses the pass threshold — but
 *   never charges the fee, because that handler contains no `recordIncome`
 *   call at all.
 *
 *   Reproduced live on a fresh database with a clean student: the score-entry
 *   path charged 500 AFN and produced one certificate; the correction path
 *   produced an identical, fully valid certificate (TH-CERT-2026-000007) for
 *   0 AFN. This is reachable through an ordinary split-role workflow — a
 *   registrar records a failing score, a manager later corrects it upward —
 *   not a contrived sequence.
 *
 * The invariant: a certificate carries the diploma fee exactly once per
 * student, whichever endpoint issues it.
 *
 * Deliberately NOT changed here (documented, no financial leak): correcting a
 * PAID certificate downward revokes the document but leaves the original
 * income row standing. Refunds are the Finance subsystem's authority and
 * inventing one here would be a second, parallel refund path.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { seedDefaultRules } from '../core/configuration/rule-engine.js';
import { examsRouter } from '../routes/exams.routes.js';

const BR = 'exmt_branch';
const DIPLOMA_FEE = 500;
/** The seeded promotion rule passes at >= 90. */
const PASS = 95;
const FAIL = 40;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/exams', examsRouter);
  app.use(errorHandler);
  return app;
}

const tok = (userId: string, role: string): TokenPayload => ({
  userId,
  username: userId,
  role: role as TokenPayload['role'],
  branchId: BR,
  fullName: userId,
});
const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

const OWNER = tok('exmt_owner', 'owner');
const MANAGER = tok('exmt_mgr', 'manager');
const REGISTRAR = tok('exmt_reg', 'registrar');

let app: ReturnType<typeof createApp>;
let seq = 0;

function seedStudent(id: string) {
  db.prepare(
    `INSERT OR REPLACE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone, discount_percent)
     VALUES (?, ?, ?, 'active', ?, ?, 'male', ?, 0)`,
  ).run(id, `TH-EXMT-${id}`, `Student ${id}`, today(), BR, `0766${(++seq).toString().padStart(6, '0')}`);
}

const diplomaIncome = (studentId: string) =>
  (db.prepare(
    "SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM financial_transactions WHERE type='income' AND category='diploma' AND reference_id=?",
  ).get(studentId) as { c: number; s: number });

const certCount = (studentId: string) =>
  (db.prepare('SELECT COUNT(*) c FROM certificates WHERE student_id=?').get(studentId) as { c: number }).c;

async function makeExam(actor: TokenPayload = OWNER) {
  const res = await supertest(app)
    .post('/api/exams')
    .set(auth(actor))
    .send({ title: `Exam ${++seq}`, date: '2026-01-01', fee: 0, type: 'certification' });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function enroll(examId: string, studentId: string, actor: TokenPayload = OWNER) {
  const res = await supertest(app)
    .post(`/api/exams/${examId}/enroll`)
    .set(auth(actor))
    .send({ studentId, feePaid: false });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  // The promotion rule (pass at >= 90) lives in the rule engine; without it
  // every corrected score evaluates to 'fail' and no certificate is issued.
  seedDefaultRules();
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?,?,?,?,1)')
    .run('exmt_campus', FIXED_ORG_ID, 'Exam Campus', 'EXMT');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?,?,?,?)')
    .run(BR, BR, 'Loc', 'exmt_campus');
  const pw = await hashPassword('testpass123');
  for (const u of [OWNER, MANAGER, REGISTRAR]) {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
       VALUES (?,?,?,?,?,?,1,0)`,
    ).run(u.userId, u.username, u.fullName, u.role, u.branchId, pw);
  }
  syncLegacyUserRoles(db);
  db.prepare(
    `INSERT OR REPLACE INTO branch_academic_profiles
       (branch_id, placement_test_fee, registration_fee, card_fee, diploma_fee, default_pass_mark, default_min_attendance, updated_at)
     VALUES (?, 300, 0, 200, ?, 60, 75, datetime('now'))`,
  ).run(BR, DIPLOMA_FEE);
  app = createApp();
});

describe('EXM-1 · a certificate always carries its diploma fee', () => {
  it('the score-entry path charges the fee (control)', async () => {
    seedStudent('exmt_control');
    const examId = await makeExam();
    const resultId = await enroll(examId, 'exmt_control');

    const res = await supertest(app)
      .patch(`/api/exams/${examId}/results/${resultId}`)
      .set(auth(OWNER))
      .send({ score: PASS, certIssued: true });

    expect(res.status).toBe(200);
    expect(res.body.diplomaFee).toBe(DIPLOMA_FEE);
    expect(certCount('exmt_control')).toBe(1);
    expect(diplomaIncome('exmt_control').s).toBe(DIPLOMA_FEE);
  });

  it('a correction that issues a certificate charges the same fee', async () => {
    seedStudent('exmt_corrected');
    const examId = await makeExam();
    const resultId = await enroll(examId, 'exmt_corrected');

    // A failing score, no certificate, no charge.
    const low = await supertest(app)
      .patch(`/api/exams/${examId}/results/${resultId}`)
      .set(auth(REGISTRAR))
      .send({ score: FAIL, certIssued: false });
    expect(low.status).toBe(200);
    expect(certCount('exmt_corrected')).toBe(0);
    expect(diplomaIncome('exmt_corrected').s).toBe(0);

    // A manager corrects it upward — the ordinary split-role workflow.
    const corrected = await supertest(app)
      .put(`/api/exams/${examId}/results/${resultId}/correct`)
      .set(auth(MANAGER))
      .send({ score: PASS });

    expect(corrected.status).toBe(200);
    expect(corrected.body.certificateIssued).toBe(true);
    expect(certCount('exmt_corrected')).toBe(1);

    // The certificate is identical in standing to the control's, so it must
    // cost the same. Previously this was 0.
    expect(diplomaIncome('exmt_corrected').s).toBe(DIPLOMA_FEE);
  });

  it('a correction that issues no certificate charges nothing', async () => {
    seedStudent('exmt_stillfail');
    const examId = await makeExam();
    const resultId = await enroll(examId, 'exmt_stillfail');

    await supertest(app)
      .patch(`/api/exams/${examId}/results/${resultId}`)
      .set(auth(REGISTRAR))
      .send({ score: FAIL, certIssued: false });

    const corrected = await supertest(app)
      .put(`/api/exams/${examId}/results/${resultId}/correct`)
      .set(auth(MANAGER))
      .send({ score: FAIL + 5 });

    expect(corrected.status).toBe(200);
    expect(corrected.body.certificateIssued).toBe(false);
    expect(certCount('exmt_stillfail')).toBe(0);
    expect(diplomaIncome('exmt_stillfail').s).toBe(0);
  });

  it('the fee is charged once per student, not once per certificate', async () => {
    seedStudent('exmt_twice');

    // Pay through the score-entry path.
    const firstExam = await makeExam();
    const firstResult = await enroll(firstExam, 'exmt_twice');
    await supertest(app)
      .patch(`/api/exams/${firstExam}/results/${firstResult}`)
      .set(auth(OWNER))
      .send({ score: PASS, certIssued: true });
    expect(diplomaIncome('exmt_twice').s).toBe(DIPLOMA_FEE);

    // A later correction on a different exam must not charge a second time.
    const secondExam = await makeExam();
    const secondResult = await enroll(secondExam, 'exmt_twice');
    await supertest(app)
      .patch(`/api/exams/${secondExam}/results/${secondResult}`)
      .set(auth(REGISTRAR))
      .send({ score: FAIL, certIssued: false });
    await supertest(app)
      .put(`/api/exams/${secondExam}/results/${secondResult}/correct`)
      .set(auth(MANAGER))
      .send({ score: PASS });

    expect(diplomaIncome('exmt_twice').c).toBe(1);
    expect(diplomaIncome('exmt_twice').s).toBe(DIPLOMA_FEE);
  });

  it('re-issuing after a revocation does not charge the student twice', async () => {
    seedStudent('exmt_revoked');
    const examId = await makeExam();
    const resultId = await enroll(examId, 'exmt_revoked');

    await supertest(app)
      .patch(`/api/exams/${examId}/results/${resultId}`)
      .set(auth(OWNER))
      .send({ score: PASS, certIssued: true });
    const paid = diplomaIncome('exmt_revoked');
    expect(paid.s).toBe(DIPLOMA_FEE);

    // Corrected down: the certificate is revoked. The original income stands —
    // refunds belong to Finance, not to this endpoint.
    await supertest(app)
      .put(`/api/exams/${examId}/results/${resultId}/correct`)
      .set(auth(OWNER))
      .send({ score: FAIL });
    expect(certCount('exmt_revoked')).toBe(0);
    expect(diplomaIncome('exmt_revoked').s).toBe(DIPLOMA_FEE);

    // Corrected back up: already paid, so no second charge.
    await supertest(app)
      .put(`/api/exams/${examId}/results/${resultId}/correct`)
      .set(auth(OWNER))
      .send({ score: PASS });
    expect(diplomaIncome('exmt_revoked').c).toBe(1);
    expect(diplomaIncome('exmt_revoked').s).toBe(DIPLOMA_FEE);
  });

  it('a correction does not re-charge a student who already holds a certificate', async () => {
    // Kills the "ignore a prior certificate" dedupe mutant: the first charge
    // comes from score entry, and a correction on a SECOND exam must see the
    // existing certificate and stay free.
    seedStudent('exmt_priorcert');
    const first = await makeExam();
    const firstResult = await enroll(first, 'exmt_priorcert');
    await supertest(app)
      .patch(`/api/exams/${first}/results/${firstResult}`)
      .set(auth(OWNER))
      .send({ score: PASS, certIssued: true });
    expect(diplomaIncome('exmt_priorcert').c).toBe(1);
    expect(certCount('exmt_priorcert')).toBe(1);

    const second = await makeExam();
    const secondResult = await enroll(second, 'exmt_priorcert');
    await supertest(app)
      .patch(`/api/exams/${second}/results/${secondResult}`)
      .set(auth(REGISTRAR))
      .send({ score: FAIL, certIssued: false });
    const corrected = await supertest(app)
      .put(`/api/exams/${second}/results/${secondResult}/correct`)
      .set(auth(MANAGER))
      .send({ score: PASS });

    expect(corrected.status).toBe(200);
    expect(corrected.body.diplomaFee).toBe(0);
    expect(diplomaIncome('exmt_priorcert').c).toBe(1);
    expect(diplomaIncome('exmt_priorcert').s).toBe(DIPLOMA_FEE);
  });

  it('a correction does not re-charge a student who already paid at the desk', async () => {
    // Kills the "ignore a prior payment" dedupe mutant: the student holds no
    // certificate, but the diploma fee was already settled by Finance.
    seedStudent('exmt_deskpaid');
    db.prepare(
      `INSERT INTO payments (id, student_id, amount, date, payment_method, category, notes, receipt_number, branch_id, status, idempotency_key)
       VALUES (?, ?, ?, ?, 'cash', 'diploma', 'paid at desk', ?, ?, 'completed', ?)`,
    ).run(`pay_exmt_${++seq}`, 'exmt_deskpaid', DIPLOMA_FEE, today(), `R-EXMT-${seq}`, BR, `idem-exmt-${seq}`);

    const examId = await makeExam();
    const resultId = await enroll(examId, 'exmt_deskpaid');
    await supertest(app)
      .patch(`/api/exams/${examId}/results/${resultId}`)
      .set(auth(REGISTRAR))
      .send({ score: FAIL, certIssued: false });
    const corrected = await supertest(app)
      .put(`/api/exams/${examId}/results/${resultId}/correct`)
      .set(auth(MANAGER))
      .send({ score: PASS });

    expect(corrected.status).toBe(200);
    expect(corrected.body.certificateIssued).toBe(true);
    expect(corrected.body.diplomaFee).toBe(0);
    // No income row: the desk already collected it.
    expect(diplomaIncome('exmt_deskpaid').c).toBe(0);
  });

  it('a correction that keeps an existing certificate charges nothing', async () => {
    // Kills the "charge even when no certificate is issued" mutant: correcting
    // a passing score to another passing score must not bill again.
    seedStudent('exmt_stillpass');
    const examId = await makeExam();
    const resultId = await enroll(examId, 'exmt_stillpass');
    await supertest(app)
      .patch(`/api/exams/${examId}/results/${resultId}`)
      .set(auth(OWNER))
      .send({ score: PASS, certIssued: true });
    expect(diplomaIncome('exmt_stillpass').c).toBe(1);

    const corrected = await supertest(app)
      .put(`/api/exams/${examId}/results/${resultId}/correct`)
      .set(auth(MANAGER))
      .send({ score: 100 });

    expect(corrected.status).toBe(200);
    expect(corrected.body.diplomaFee).toBe(0);
    expect(diplomaIncome('exmt_stillpass').c).toBe(1);
    expect(diplomaIncome('exmt_stillpass').s).toBe(DIPLOMA_FEE);
  });

  it('a failing correction never charges a diploma fee', async () => {
    seedStudent('exmt_nocharge');
    const examId = await makeExam();
    const resultId = await enroll(examId, 'exmt_nocharge');
    await supertest(app)
      .patch(`/api/exams/${examId}/results/${resultId}`)
      .set(auth(REGISTRAR))
      .send({ score: FAIL, certIssued: false });

    const corrected = await supertest(app)
      .put(`/api/exams/${examId}/results/${resultId}/correct`)
      .set(auth(MANAGER))
      .send({ score: FAIL + 1 });

    expect(corrected.body.diplomaFee).toBe(0);
    expect(diplomaIncome('exmt_nocharge').c).toBe(0);
  });

  it('a visitor correction issues no student certificate row and no duplicate charge', async () => {
    // Visitors have no student_id, so no certificate row is written; the
    // endpoint must not blow up or post a stray income row against null.
    const examId = await makeExam();
    const visitorId = 'exmt_visitor';
    db.prepare(
      `INSERT OR REPLACE INTO visitors (id, full_name, phone, gender, source, visit_date, stage, status, serial_no, branch_id)
       VALUES (?, 'Visitor One', '0766999111', 'male', 'walk_in', ?, 'lead', 'visited', ?, ?)`,
    ).run(visitorId, today(), `EXMT-V-${++seq}`, BR);

    const enrolled = await supertest(app)
      .post(`/api/exams/${examId}/enroll`)
      .set(auth(OWNER))
      .send({ visitorId, feePaid: false });
    expect(enrolled.status).toBe(201);

    await supertest(app)
      .patch(`/api/exams/${examId}/results/${enrolled.body.id}`)
      .set(auth(REGISTRAR))
      .send({ score: FAIL, certIssued: false });

    const corrected = await supertest(app)
      .put(`/api/exams/${examId}/results/${enrolled.body.id}/correct`)
      .set(auth(MANAGER))
      .send({ score: PASS });

    expect(corrected.status).toBe(200);
    expect(
      (db.prepare("SELECT COUNT(*) c FROM financial_transactions WHERE category='diploma' AND reference_id IS NULL").get() as { c: number }).c,
    ).toBe(0);
  });
});

describe('EXAMS · correction authorization and score bounds', () => {
  it('only an owner or manager may correct a score', async () => {
    seedStudent('exmt_authz');
    const examId = await makeExam();
    const resultId = await enroll(examId, 'exmt_authz');
    await supertest(app)
      .patch(`/api/exams/${examId}/results/${resultId}`)
      .set(auth(REGISTRAR))
      .send({ score: FAIL, certIssued: false });

    const denied = await supertest(app)
      .put(`/api/exams/${examId}/results/${resultId}/correct`)
      .set(auth(REGISTRAR))
      .send({ score: PASS });
    expect(denied.status).toBe(403);
    expect(certCount('exmt_authz')).toBe(0);
    expect(diplomaIncome('exmt_authz').s).toBe(0);
  });

  it.each([
    ['negative', -1],
    ['above the maximum', 121],
    ['text', 'abc'],
    ['null', null],
    ['array', [90]],
  ])('rejects a %s corrected score and issues nothing', async (_label, score) => {
    seedStudent('exmt_bad');
    const examId = await makeExam();
    const resultId = await enroll(examId, 'exmt_bad');
    await supertest(app)
      .patch(`/api/exams/${examId}/results/${resultId}`)
      .set(auth(REGISTRAR))
      .send({ score: FAIL, certIssued: false });

    const res = await supertest(app)
      .put(`/api/exams/${examId}/results/${resultId}/correct`)
      .set(auth(MANAGER))
      .send({ score });
    expect(res.status).toBe(400);
    expect(diplomaIncome('exmt_bad').s).toBe(0);
  });
});
