import { describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { db } from '../../../db/connection.js';
import { seedContext, type Wp06Context } from './fixtures.js';

/**
 * WP-06 grade/assessment bounds (D-99): scores are non-negative and bounded
 * by the assessment's max score, assessment weights are non-negative and
 * max scores positive — at the API boundary and in the canonical schema.
 */

async function createAssessment(ctx: Wp06Context, body: Record<string, unknown>) {
  return supertest(ctx.app).post(`/api/classes/${ctx.classId}/assessments`).set(ctx.manager).send(body as object);
}

describe('WP-06 gradebook bounds', () => {
  it('rejects assessments with negative weight or non-positive max score', async () => {
    const ctx = seedContext();
    const negativeWeight = await createAssessment(ctx, { title: 'W', type: 'quiz', weight: -1, maxScore: 100 });
    expect(negativeWeight.status).toBe(400);

    const zeroMax = await createAssessment(ctx, { title: 'M', type: 'quiz', weight: 10, maxScore: 0 });
    expect(zeroMax.status).toBe(400);

    const negativeMax = await createAssessment(ctx, { title: 'N', type: 'quiz', weight: 10, maxScore: -5 });
    expect(negativeMax.status).toBe(400);

    const ok = await createAssessment(ctx, { title: 'OK', type: 'quiz', weight: 10, maxScore: 100 });
    expect(ok.status).toBe(201);
  });

  it('rejects grades below zero, above max score, or with unknown status', async () => {
    const ctx = seedContext();
    const assessment = await createAssessment(ctx, { title: 'Quiz 1', type: 'quiz', weight: 20, maxScore: 100 });
    expect(assessment.status).toBe(201);
    const assessmentId = assessment.body.id;

    const negative = await supertest(ctx.app).put(`/api/classes/${ctx.classId}/grades`).set(ctx.teacher).send({
      grades: [{ assessmentId, studentId: ctx.studentA, score: -5, status: 'graded' }],
    });
    expect(negative.status).toBe(400);

    const tooHigh = await supertest(ctx.app).put(`/api/classes/${ctx.classId}/grades`).set(ctx.teacher).send({
      grades: [{ assessmentId, studentId: ctx.studentA, score: 101, status: 'graded' }],
    });
    expect(tooHigh.status).toBe(400);

    const badStatus = await supertest(ctx.app).put(`/api/classes/${ctx.classId}/grades`).set(ctx.teacher).send({
      grades: [{ assessmentId, studentId: ctx.studentA, score: 80, status: 'scribbled' }],
    });
    expect(badStatus.status).toBe(400);

    const ok = await supertest(ctx.app).put(`/api/classes/${ctx.classId}/grades`).set(ctx.teacher).send({
      grades: [{ assessmentId, studentId: ctx.studentA, score: 80, status: 'graded' }],
    });
    expect(ok.status).toBe(200);
  });

  it('the schema backstops grade and assessment bounds', () => {
    const ctx = seedContext();
    const assessmentId = 'gb_bounds_asm';
    db.prepare(`INSERT INTO class_assessments (id, class_id, title, type, weight, max_score, lock_status) VALUES (?,?,'Bounds','quiz',10,100,'draft')`)
      .run(assessmentId, ctx.classId);

    expect(() =>
      db.prepare(`INSERT INTO student_grades (id, assessment_id, student_id, class_id, score, status) VALUES ('gb_neg',?,?,?,-1,'graded')`)
        .run(assessmentId, ctx.studentA, ctx.classId),
    ).toThrow();

    expect(() =>
      db.prepare(`INSERT INTO class_assessments (id, class_id, title, type, weight, max_score) VALUES ('gb_negw',?,'NegW','quiz',-1,100)`)
        .run(ctx.classId),
    ).toThrow();

    expect(() =>
      db.prepare(`INSERT INTO class_assessments (id, class_id, title, type, weight, max_score) VALUES ('gb_zerom',?,'ZeroM','quiz',10,0)`)
        .run(ctx.classId),
    ).toThrow();
  });
});
