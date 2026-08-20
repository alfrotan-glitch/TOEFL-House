/**
 * Academic Module Refactor — Phase 4: Gradebook Engine
 * ============================================================================
 * Mirrors the app/RBAC-bootstrap pattern established in Phases 1-3.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today, id as makeId } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import classesRouter from '../routes/classes.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { getClassLifecycleService } from '../core/academic/class-lifecycle-service.js';
import { computeClassGrades, letterGradeFor, hasGradeChanged, type LetterGradeBand } from '../core/academic/gradebook-service.js';

const BRANCH = 'ge_branch_a';

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
    branchId: overrides.branchId || BRANCH,
    fullName: overrides.fullName || 'Test User',
  };
}
function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}
async function seedUser(userId: string, role: string, branchId: string, username: string) {
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`
  ).run(userId, username, `Test ${role}`, branchId, await hashPassword('testpass123'));
  assignRole(userId, role, branchId);
}
function seedStudentWithRoster(studentId: string, branchId: string, name: string, classId: string) {
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
     VALUES (?, ?, ?, 'active', ?, ?, 'male')`
  ).run(studentId, `TH-GE-${studentId.slice(-4)}`, name, today(), branchId);
  const semId = makeId('sem');
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount) VALUES (?, ?, 'Test Semester', ?, ?, 0)`
  ).run(semId, studentId, classId, today());
  return semId;
}

let app: express.Express;
let owner: TokenPayload;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'GE Branch', 'Loc');
  await seedUser('u_ge_owner', 'owner', BRANCH, 'ge_owner');

  owner = makeUser({ userId: 'u_ge_owner', branchId: BRANCH });
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

describe('Gradebook Engine — live computed preview', () => {
  it('GET /:id/gradebook returns a projected final grade per student before locking', async () => {
    const classId = await createActivatedClass('Preview Class');
    const student = 'ge_stu_preview';
    seedStudentWithRoster(student, BRANCH, 'Preview Student', classId);
    const a = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Quiz', type: 'quiz', weight: 100, maxScore: 100 });
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({
      grades: [{ assessmentId: a.body.id, studentId: student, score: 85, status: 'graded' }],
    });

    const gb = await supertest(app).get(`/api/classes/${classId}/gradebook`).set(authHeader(owner));
    const row = gb.body.students.find((s: any) => s.id === student);
    expect(row.projected.finalPercentage).toBe(85);
    expect(row.projected.letterGrade).toBe('B');
    expect(row.projected.isPassing).toBe(true);
  });

  it('the live preview and the final locked result agree exactly (same computation, no drift)', async () => {
    const classId = await createActivatedClass('Preview Matches Lock Class');
    const student = 'ge_stu_matches';
    seedStudentWithRoster(student, BRANCH, 'Matches Student', classId);
    const a = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Final', type: 'final', weight: 100, maxScore: 100 });
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({
      grades: [{ assessmentId: a.body.id, studentId: student, score: 73, status: 'graded' }],
    });

    const before = await supertest(app).get(`/api/classes/${classId}/gradebook`).set(authHeader(owner));
    const preview = before.body.students.find((s: any) => s.id === student).projected;

    await supertest(app).post(`/api/classes/${classId}/complete-semester`).set(authHeader(owner)).send({});

    const semester = db.prepare('SELECT final_percentage, letter_grade, status FROM student_semesters WHERE student_id = ? AND class_id = ?').get(student, classId) as any;
    expect(semester.final_percentage).toBe(preview.finalPercentage);
    expect(semester.letter_grade).toBe(preview.letterGrade);
    expect(semester.status).toBe(preview.isPassing ? 'completed' : 'deferred');
  });
});

describe('Gradebook Engine — grade history', () => {
  it('logs a history entry for an actual score change', async () => {
    const classId = await createActivatedClass('History Class');
    const student = 'ge_stu_history';
    seedStudentWithRoster(student, BRANCH, 'History Student', classId);
    const a = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Quiz', type: 'quiz', weight: 10 });

    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({
      grades: [{ assessmentId: a.body.id, studentId: student, score: 60, status: 'graded' }],
    });
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({
      grades: [{ assessmentId: a.body.id, studentId: student, score: 75, status: 'graded' }],
    });

    const history = await supertest(app).get(`/api/classes/${classId}/gradebook/history`).set(authHeader(owner));
    expect(history.status).toBe(200);
    expect(history.body).toHaveLength(2); // first grade (null->60) + the correction (60->75)
    expect(history.body[0].newScore).toBe(75); // most recent first
    expect(history.body[0].previousScore).toBe(60);
  });

  it('does NOT log a history entry when the exact same values are resaved (auto-save no-op)', async () => {
    const classId = await createActivatedClass('No Duplicate History Class');
    const student = 'ge_stu_noop';
    seedStudentWithRoster(student, BRANCH, 'No-op Student', classId);
    const a = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Quiz', type: 'quiz', weight: 10 });

    const payload = { grades: [{ assessmentId: a.body.id, studentId: student, score: 60, status: 'graded' }] };
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send(payload);
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send(payload); // identical resave
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send(payload); // identical resave again

    const history = await supertest(app).get(`/api/classes/${classId}/gradebook/history`).set(authHeader(owner));
    expect(history.body).toHaveLength(1); // only the first, genuine grading
  });

  it('filters history by studentId', async () => {
    const classId = await createActivatedClass('Filtered History Class');
    const s1 = 'ge_stu_filter1', s2 = 'ge_stu_filter2';
    seedStudentWithRoster(s1, BRANCH, 'Filter Student 1', classId);
    seedStudentWithRoster(s2, BRANCH, 'Filter Student 2', classId);
    const a = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Quiz', type: 'quiz', weight: 10 });

    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({
      grades: [{ assessmentId: a.body.id, studentId: s1, score: 60, status: 'graded' }, { assessmentId: a.body.id, studentId: s2, score: 70, status: 'graded' }],
    });

    const history = await supertest(app).get(`/api/classes/${classId}/gradebook/history?studentId=${s1}`).set(authHeader(owner));
    expect(history.body).toHaveLength(1);
    expect(history.body[0].studentId).toBe(s1);
  });
});

describe('Gradebook Engine — pure computation unit tests', () => {
  it('letterGradeFor maps percentages to the standard 5-band default correctly', () => {
    const bands: LetterGradeBand[] = [
      { min: 90, grade: 'A' }, { min: 80, grade: 'B' }, { min: 70, grade: 'C' }, { min: 60, grade: 'D' }, { min: 0, grade: 'F' },
    ];
    expect(letterGradeFor(95, bands)).toBe('A');
    expect(letterGradeFor(80, bands)).toBe('B'); // boundary is inclusive
    expect(letterGradeFor(79.9, bands)).toBe('C');
    expect(letterGradeFor(0, bands)).toBe('F');
  });

  it('hasGradeChanged detects real changes and ignores identical resaves', () => {
    const previous = { score: 60, status: 'graded', notes: 'ok' };
    expect(hasGradeChanged(undefined, { score: 60, status: 'graded' })).toBe(true); // first time
    expect(hasGradeChanged(previous, { score: 60, status: 'graded' })).toBe(false); // identical (notes omitted = don't compare)
    expect(hasGradeChanged(previous, { score: 61, status: 'graded' })).toBe(true); // score changed
    expect(hasGradeChanged(previous, { score: 60, status: 'excused' })).toBe(true); // status changed
    expect(hasGradeChanged(previous, { score: 60, status: 'graded', notes: 'different' })).toBe(true); // notes changed
  });

  it('computeClassGrades reproduces the exact make-up substitution behavior from Phase 3', () => {
    const students = [{ id: 's1' }];
    const assessments = [
      { id: 'a1', weight: 100, max_score: 100, makeup_for_assessment_id: null },
      { id: 'a1-makeup', weight: 0, max_score: 100, makeup_for_assessment_id: 'a1' },
    ];
    const grades = [
      { assessment_id: 'a1', student_id: 's1', score: 20 },
      { assessment_id: 'a1-makeup', student_id: 's1', score: 90 },
    ];
    const result = computeClassGrades(students, assessments, grades, BRANCH);
    expect(result[0].finalPercentage).toBe(90); // makeup replaced the 20, not averaged with it
  });
});
