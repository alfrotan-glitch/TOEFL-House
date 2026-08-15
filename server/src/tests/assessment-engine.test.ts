/**
 * Academic Module Refactor — Phase 3: Assessment Engine
 * ============================================================================
 * Mirrors the app/RBAC-bootstrap pattern established in Phases 1 and 2.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import classesRouter from '../routes/classes.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { getClassLifecycleService } from '../core/academic/class-lifecycle-service.js';
import { id as makeId } from '../utils/ids.js';

const BRANCH = 'ae_branch_a';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/classes', classesRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId,
    username: overrides.username || overrides.userId,
    role: overrides.role || 'owner',
    branchId: overrides.branchId || BRANCH,
    fullName: overrides.fullName || 'Test User',
  };
}
function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}
async function seedUser(userId: string, role: string, branchId: string, username: string) {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0)`
  ).run(userId, username, `Test ${role}`, role, branchId, await hashPassword('testpass123'));
}
function seedStudentWithRoster(studentId: string, branchId: string, name: string, classId: string) {
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
     VALUES (?, ?, ?, 'active', ?, ?, 'male')`
  ).run(studentId, `TH-AE-${studentId.slice(-4)}`, name, today(), branchId);
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount) VALUES (?, ?, 'Test Semester', ?, ?, 0)`
  ).run(makeId('sem'), studentId, classId, today());
}

let app: express.Express;
let owner: TokenPayload;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'AE Branch', 'Loc');
  await seedUser('u_ae_owner', 'owner', BRANCH, 'ae_owner');
  syncLegacyUserRoles(db);
  owner = makeUser({ userId: 'u_ae_owner', role: 'owner', branchId: BRANCH });
  app = createApp();
});

async function createActivatedClass(name: string): Promise<string> {
  const res = await supertest(app).post('/api/classes').set(authHeader(owner)).send({ name, level: 'A1', branchId: BRANCH, capacity: 10 });
  const classId = res.body.id;
  const svc = getClassLifecycleService(db);
  svc.activate(classId);
  db.prepare(`INSERT OR IGNORE INTO sessions (id, class_id, date, start_time, end_time, status, session_type, branch_id) VALUES (?, ?, ?, '09:00', '10:00', 'scheduled', 'regular', ?)` )
    .run(`${classId}-teaching-session`, classId, today(), BRANCH);
  svc.startTeaching(classId);
  return classId;
}

describe('Assessment Engine — types and fields', () => {
  it('accepts the full blueprint type set (speaking, listening, reading, writing, quiz, practice_test)', async () => {
    const classId = await createActivatedClass('Full Type Set Class');
    for (const type of ['speaking', 'listening', 'reading', 'writing', 'quiz', 'practice_test']) {
      const res = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({
        title: `${type} test`, type, weight: 5, maxScore: 100,
      });
      expect(res.status, `type "${type}" should be accepted`).toBe(201);
    }
  });

  it('rejects an invalid assessment type', async () => {
    const classId = await createActivatedClass('Invalid Type Class');
    const res = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({
      title: 'Bad', type: 'placement_test', weight: 10,
    });
    expect(res.status).toBe(400); // deliberately excluded — see ADR AM-15
  });

  it('persists passingScore, publishDate, dueDate, visibility, and rubric', async () => {
    const classId = await createActivatedClass('Full Fields Class');
    const create = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({
      title: 'Midterm', type: 'midterm', weight: 30, maxScore: 100,
      passingScore: 60, publishDate: '2026-08-01', dueDate: '2026-08-15',
      visibility: 'scheduled', rubric: 'Grammar 40%, Vocabulary 30%, Fluency 30%',
    });
    expect(create.status).toBe(201);

    const gradebook = await supertest(app).get(`/api/classes/${classId}/gradebook`).set(authHeader(owner));
    const a = gradebook.body.assessments.find((x: any) => x.id === create.body.id);
    expect(a.passingScore).toBe(60);
    expect(a.publishDate).toBe('2026-08-01');
    expect(a.dueDate).toBe('2026-08-15');
    expect(a.visibility).toBe('scheduled');
    expect(a.rubric).toMatch(/Grammar/);
  });

  it('rejects total weight exceeding 100%', async () => {
    const classId = await createActivatedClass('Weight Budget Class');
    await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'A', type: 'quiz', weight: 60 });
    const res = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'B', type: 'quiz', weight: 50 });
    expect(res.status).toBe(400);
  });
});

describe('Assessment Engine — edit/delete lifecycle', () => {
  it('allows editing metadata freely with no grades recorded', async () => {
    const classId = await createActivatedClass('Edit Class');
    const create = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Quiz 1', type: 'quiz', weight: 10 });
    const res = await supertest(app).put(`/api/classes/${classId}/assessments/${create.body.id}`).set(authHeader(owner)).send({ title: 'Quiz 1 (renamed)', weight: 15 });
    expect(res.status).toBe(200);
  });

  it('blocks a weight/maxScore change once grades exist, unless confirmRescore is set', async () => {
    const classId = await createActivatedClass('Rescore Guard Class');
    const student = 'ae_stu_rescore';
    seedStudentWithRoster(student, BRANCH, 'Rescore Student', classId);
    const create = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Quiz 1', type: 'quiz', weight: 10, maxScore: 100 });

    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({
      grades: [{ assessmentId: create.body.id, studentId: student, score: 80, status: 'graded' }],
    });

    const blocked = await supertest(app).put(`/api/classes/${classId}/assessments/${create.body.id}`).set(authHeader(owner)).send({ maxScore: 50 });
    expect(blocked.status).toBe(409);

    const allowed = await supertest(app).put(`/api/classes/${classId}/assessments/${create.body.id}`).set(authHeader(owner)).send({ maxScore: 50, confirmRescore: true });
    expect(allowed.status).toBe(200);
  });

  it('blocks deleting an assessment that already has grades', async () => {
    const classId = await createActivatedClass('Delete Guard Class');
    const student = 'ae_stu_delete';
    seedStudentWithRoster(student, BRANCH, 'Delete Student', classId);
    const create = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Quiz 1', type: 'quiz', weight: 10 });
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({
      grades: [{ assessmentId: create.body.id, studentId: student, score: 80, status: 'graded' }],
    });

    const res = await supertest(app).delete(`/api/classes/${classId}/assessments/${create.body.id}`).set(authHeader(owner));
    expect(res.status).toBe(409);
  });
});

describe('Assessment Engine — teacher comments', () => {
  it('persists notes (teacher comments) through the bulk grade endpoint and preserves them on a later partial update', async () => {
    const classId = await createActivatedClass('Comments Class');
    const student = 'ae_stu_comments';
    seedStudentWithRoster(student, BRANCH, 'Comments Student', classId);
    const create = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Speaking Test', type: 'speaking', weight: 10 });

    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({
      grades: [{ assessmentId: create.body.id, studentId: student, score: 70, status: 'graded', notes: 'Good pronunciation, needs more fluency practice.' }],
    });

    let gb = await supertest(app).get(`/api/classes/${classId}/gradebook`).set(authHeader(owner));
    expect(gb.body.grades[0].notes).toMatch(/pronunciation/);

    // Partial update omitting notes should NOT wipe the existing comment.
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({
      grades: [{ assessmentId: create.body.id, studentId: student, score: 75, status: 'graded' }],
    });
    gb = await supertest(app).get(`/api/classes/${classId}/gradebook`).set(authHeader(owner));
    expect(gb.body.grades[0].score).toBe(75);
    expect(gb.body.grades[0].notes).toMatch(/pronunciation/);
  });
});

describe('Assessment Engine — make-up support', () => {
  it('POST /:id/assessments/:assessmentId/makeup requires allowsMakeup to be set first', async () => {
    const classId = await createActivatedClass('Makeup Guard Class');
    const create = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Final Exam', type: 'final', weight: 40 });
    const res = await supertest(app).post(`/api/classes/${classId}/assessments/${create.body.id}/makeup`).set(authHeader(owner)).send({});
    expect(res.status).toBe(400);
  });

  it("a graded makeup REPLACES the original's contribution in complete-semester scoring, not adds to it", async () => {
    const classId = await createActivatedClass('Makeup Replaces Class');
    const student = 'ae_stu_makeup';
    seedStudentWithRoster(student, BRANCH, 'Makeup Student', classId);

    // Single assessment worth the entire grade, so the final percentage
    // directly reflects whichever score (original vs makeup) was used.
    const original = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({
      title: 'Final Exam', type: 'final', weight: 100, maxScore: 100, allowsMakeup: true,
    });

    // Student missed it / scored very low originally.
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({
      grades: [{ assessmentId: original.body.id, studentId: student, score: 20, status: 'graded' }],
    });

    const makeup = await supertest(app).post(`/api/classes/${classId}/assessments/${original.body.id}/makeup`).set(authHeader(owner)).send({});
    expect(makeup.status).toBe(201);
    expect(makeup.body.id).toBeTruthy();

    // Makeup attempt: much higher score.
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({
      grades: [{ assessmentId: makeup.body.id, studentId: student, score: 90, status: 'graded' }],
    });

    const complete = await supertest(app).post(`/api/classes/${classId}/complete-semester`).set(authHeader(owner)).send({});
    expect(complete.status).toBe(200);

    // 90/100 * 100% weight = 90% -> comfortably passing. If the makeup had
    // been added as a second line item instead of replacing the original,
    // the weight budget would have been invalid (100 + makeup's own
    // weight > 100) and/or the score would reflect an average dragged down
    // by the original 20 rather than the makeup's 90.
    const semester = db.prepare('SELECT status FROM student_semesters WHERE student_id = ? AND class_id = ?').get(student, classId) as any;
    expect(semester.status).toBe('completed'); // 'completed' = passed, per the existing promotion mapping
  });

  it('makeup-linked assessments do not count toward the 100% weight budget', async () => {
    const classId = await createActivatedClass('Makeup Budget Class');
    const original = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({
      title: 'Final Exam', type: 'final', weight: 100, allowsMakeup: true,
    });
    // A second full-weight assessment would normally be rejected (100+100),
    // but a makeup of the first should NOT be blocked by the budget check.
    const makeup = await supertest(app).post(`/api/classes/${classId}/assessments/${original.body.id}/makeup`).set(authHeader(owner)).send({});
    expect(makeup.status).toBe(201);
  });
});
