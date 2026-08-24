import { describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { db } from '../../../db/connection.js';
import { runReport } from '../../../core/reporting/report-engine.js';
import { today } from '../../../utils/ids.js';
import { bearerFor, seedUser } from '../../support/identity.js';
import { seedContext, type Wp06Context } from './fixtures.js';

/**
 * WP-06 exam authority (D-95/D-96/D-98): creation honors assignment scope,
 * the exam vocabulary is one, scored state is marked by `status`, and the
 * canonical schema backstops every boundary the route enforces.
 */

async function createExam(ctx: Wp06Context, actor: { Authorization: string }, body: Record<string, unknown>, query = '') {
  return supertest(ctx.app).post(`/api/exams${query}`).set(actor).send(body as object);
}

describe('WP-06 exam scope and storage boundary', () => {
  it('exam creation honors assignment scope, never identity branch', async () => {
    const ctx = seedContext();
    // Identity branch is A, but the only live assignment reaches B: the
    // identity branch must not be a fallback creation grant.
    const misaligned = `${ctx.key}_misaligned`;
    seedUser({ id: misaligned, role: 'receptionist', branchId: ctx.branchB, username: misaligned, fullName: 'Misaligned' });
    db.prepare('UPDATE users SET branch_id = ? WHERE id = ?').run(ctx.branchA, misaligned);

    const res = await createExam(ctx, bearerFor(misaligned), { title: 'Scoped Exam', date: '2026-09-01', fee: 500, type: 'placement' });
    expect(res.status).toBe(403);
    expect(db.prepare(`SELECT id FROM exams WHERE title = 'Scoped Exam'`).get()).toBeUndefined();

    // The same principal CAN create in the branch their assignment actually
    // authorizes — the identity branch never leaks into the record.
    const cross = await createExam(ctx, bearerFor(misaligned), { title: 'Cross Exam', date: '2026-09-02', fee: 500, type: 'final' }, `?branchId=${ctx.branchB}`);
    expect(cross.status).toBe(201);
    const row = db.prepare(`SELECT branch_id FROM exams WHERE id = ?`).get(cross.body.id) as { branch_id: string };
    expect(row.branch_id).toBe(ctx.branchB);
  });

  it('rejects the all-branches scope for creation — an exam needs one branch', async () => {
    const ctx = seedContext();
    const res = await createExam(ctx, ctx.owner, { title: 'Scopeless', date: '2026-09-03', fee: 0, type: 'midterm' }, '?branchId=all');
    expect(res.status).toBe(400);
  });

  it('has one exam-type vocabulary: mock is not creatable or editable', async () => {
    const ctx = seedContext();
    const create = await createExam(ctx, ctx.receptionist, { title: 'Mock?', date: '2026-09-04', fee: 0, type: 'mock' });
    expect(create.status).toBe(400);

    const ok = await createExam(ctx, ctx.receptionist, { title: 'Real', date: '2026-09-05', fee: 0, type: 'final' });
    expect(ok.status).toBe(201);
    const edit = await supertest(ctx.app).put(`/api/exams/${ok.body.id}`).set(ctx.receptionist).send({ type: 'mock' });
    expect(edit.status).toBe(400);
  });

  it('rejects malformed exam dates on create and edit', async () => {
    const ctx = seedContext();
    const bad = await createExam(ctx, ctx.receptionist, { title: 'Bad date', date: '2026-13-40', fee: 0, type: 'final' });
    expect(bad.status).toBe(400);

    const ok = await createExam(ctx, ctx.receptionist, { title: 'Good date', date: '2026-09-06', fee: 0, type: 'final' });
    const edit = await supertest(ctx.app).put(`/api/exams/${ok.body.id}`).set(ctx.receptionist).send({ date: 'yesterday-ish' });
    expect(edit.status).toBe(400);
  });

  it('marks a scored result by status, so a recorded 0 cannot be overwritten', async () => {
    const ctx = seedContext();
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, branch_id, status, registration_date, gender)
       VALUES ('scoped_stu','SC-1','Scored Student',?,'active','2026-08-01','male')`,
    ).run(ctx.branchA);
    const exam = await createExam(ctx, ctx.receptionist, { title: 'Score Gate', date: '2026-01-01', fee: 0, type: 'final' });
    const enroll = await supertest(ctx.app).post(`/api/exams/${exam.body.id}/enroll`).set(ctx.receptionist).send({ studentId: 'scoped_stu', feePaid: false });
    expect(enroll.status).toBe(201);
    const resultId = enroll.body.id;

    const first = await supertest(ctx.app)
      .patch(`/api/exams/${exam.body.id}/results/${resultId}`)
      .set(ctx.receptionist)
      .send({ score: 0, certIssued: false });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('fail');

    const second = await supertest(ctx.app)
      .patch(`/api/exams/${exam.body.id}/results/${resultId}`)
      .set(ctx.receptionist)
      .send({ score: 50, certIssued: false });
    expect(second.status).toBe(409);
  });

  it('revoked certificates are recorded history, never issued output in reports', async () => {
    const ctx = seedContext();
    const sid = `${ctx.key}_metric_stu`;
    db.prepare(
      `INSERT INTO students (id, student_code, full_name, branch_id, status, registration_date, gender)
       VALUES (?,?,'Metric Student',?,'active','2026-08-01','male')`,
    ).run(sid, `${sid}-code`, ctx.branchA);
    const exam = await createExam(ctx, ctx.receptionist, { title: 'Revoke Metric', date: '2026-01-01', fee: 0, type: 'final' });
    db.prepare(`
      INSERT OR REPLACE INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active)
      VALUES (?, ?, 'diploma', 'Diploma fee', 0, 1, 1)
    `).run(`${ctx.key}_revoke_metric_diploma_fee`, ctx.branchA);
    const enroll = await supertest(ctx.app).post(`/api/exams/${exam.body.id}/enroll`).set(ctx.receptionist).send({ studentId: sid, feePaid: false });
    const resultId = enroll.body.id;

    const issued = await supertest(ctx.app)
      .patch(`/api/exams/${exam.body.id}/results/${resultId}`)
      .set(ctx.receptionist)
      .send({ score: 95, certIssued: true });
    expect(issued.status).toBe(200);

    const before = runReport(db, 'academic-delivery', 'today', { branchId: ctx.branchA, isAll: false }, today());
    const issuedBefore = before.metrics.find((m) => m.id === 'academic.certificates_issued')?.value ?? 0;
    expect(issuedBefore).toBeGreaterThanOrEqual(1);

    await supertest(ctx.app)
      .put(`/api/exams/${exam.body.id}/results/${resultId}/correct`)
      .set(ctx.owner)
      .send({ score: 40 });

    const after = runReport(db, 'academic-delivery', 'today', { branchId: ctx.branchA, isAll: false }, today());
    const issuedAfter = after.metrics.find((m) => m.id === 'academic.certificates_issued')?.value ?? 0;
    expect(issuedAfter).toBe(issuedBefore - 1);
  });

  it('the schema backstops every exam and certificate boundary', () => {
    const ctx = seedContext();
    const goodExam = db.prepare(
      `INSERT INTO exams (id, title, date, fee, type, branch_id) VALUES ('stg_exam','Schema','2026-09-07',0,'final',?)`,
    ).run(ctx.branchA);
    expect(goodExam.changes).toBe(1);

    expect(() =>
      db.prepare(`INSERT INTO exams (id, title, date, fee, type, branch_id) VALUES ('stg_mock','Mock','2026-09-08',0,'mock',?)`).run(ctx.branchA),
    ).toThrow();

    expect(() =>
      db.prepare(`INSERT INTO exam_results (id, exam_id, status, branch_id) VALUES ('stg_r1','stg_exam','bogus',?)`).run(ctx.branchA),
    ).toThrow();

    expect(() =>
      db.prepare(`INSERT INTO exam_results (id, exam_id, score, branch_id) VALUES ('stg_r2','stg_exam',121,?)`).run(ctx.branchA),
    ).toThrow();

    expect(() =>
      db.prepare(`INSERT INTO exam_results (id, exam_id, score, branch_id) VALUES ('stg_r3','stg_exam',-1,?)`).run(ctx.branchA),
    ).toThrow();

    expect(() =>
      db.prepare(`INSERT INTO certificates (id, student_id, issue_date, certificate_no, status, branch_id) VALUES ('stg_c1','scoped_stu','2026-09-07','TH-CERT-STG','gone',?)`).run(ctx.branchA),
    ).toThrow();

    // The attendance table has no session-anchored column anymore.
    expect(() =>
      db.prepare(`INSERT INTO attendance (id, date, target_id, target_type, status, branch_id, session_id) VALUES ('stg_a1','2026-09-07','x','student','present',?,'sess')`).run(ctx.branchA),
    ).toThrow();
  });
});
