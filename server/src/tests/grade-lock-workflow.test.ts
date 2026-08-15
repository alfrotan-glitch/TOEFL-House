/**
 * Academic Module Refactor — Phase 7: Grade Lock Workflow
 * ============================================================================
 * Mirrors the app/RBAC-bootstrap pattern established in Phases 1-6.
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
import { getGradeLockService } from '../core/academic/grade-lock-service.js';
import { assertGradeLockTransition, GRADE_LOCK_STAGES, GRADE_LOCK_TRANSITIONS } from '../core/academic/lifecycle-engine.js';

const BRANCH = 'gl_branch_a';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/classes', classesRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId, username: overrides.username || overrides.userId,
    role: overrides.role || 'owner', branchId: overrides.branchId || BRANCH, fullName: overrides.fullName || 'Test User',
  };
}
function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}
async function seedUser(userId: string, role: string, branchId: string, username: string) {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`
  ).run(userId, username, `Test ${role}`, role, branchId, await hashPassword('testpass123'));
}
function seedStudent(studentId: string, branchId: string, name: string) {
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender) VALUES (?, ?, ?, 'active', ?, ?, 'male')`
  ).run(studentId, `TH-GL-${studentId.slice(-4)}`, name, today(), branchId);
}

let app: express.Express;
let owner: TokenPayload;
let teacher: TokenPayload;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'GL Branch', 'Loc');
  await seedUser('u_gl_owner', 'owner', BRANCH, 'gl_owner');
  await seedUser('u_gl_teacher', 'teacher', BRANCH, 'gl_teacher');
  syncLegacyUserRoles(db);
  owner = makeUser({ userId: 'u_gl_owner', role: 'owner', branchId: BRANCH });
  teacher = makeUser({ userId: 'u_gl_teacher', role: 'teacher', branchId: BRANCH });
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
async function createAssessment(classId: string, overrides: Record<string, unknown> = {}) {
  const res = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({
    title: 'Quiz 1', type: 'quiz', weight: 10, maxScore: 100, ...overrides,
  });
  return res.body.id as string;
}

describe('Grade Lock Workflow — the full happy path', () => {
  it('walks draft → submitted → reviewed → approved → published → locked', async () => {
    const classId = await createActivatedClass('Full Lock Workflow Class');
    const assessmentId = await createAssessment(classId);

    const step = async (path: string, expectStage: string) => {
      const res = await supertest(app).post(`/api/classes/${classId}/assessments/${assessmentId}${path}`).set(authHeader(owner)).send({});
      expect(res.status, `POST ${path} should succeed`).toBe(200);
      expect(res.body.assessment.lockStatus).toBe(expectStage);
      return res;
    };

    await step('/submit', 'submitted');
    await step('/review', 'reviewed');
    await step('/approve', 'approved');
    const published = await step('/publish', 'published');
    expect(published.body.assessment.visibility).toBe('visible'); // publishing also makes it visible
    await step('/lock', 'locked');
  });

  it('rejects an invalid transition (draft cannot jump straight to locked)', async () => {
    const classId = await createActivatedClass('Invalid Jump Class');
    const assessmentId = await createAssessment(classId);
    const res = await supertest(app).post(`/api/classes/${classId}/assessments/${assessmentId}/lock`).set(authHeader(owner)).send({});
    expect(res.status).toBe(409);
  });

  it('send-back returns submitted/reviewed/approved to draft for correction', async () => {
    const classId = await createActivatedClass('Send Back Class');
    const assessmentId = await createAssessment(classId);
    await supertest(app).post(`/api/classes/${classId}/assessments/${assessmentId}/submit`).set(authHeader(owner)).send({});
    const res = await supertest(app).post(`/api/classes/${classId}/assessments/${assessmentId}/send-back`).set(authHeader(owner)).send({});
    expect(res.status).toBe(200);
    expect(res.body.assessment.lockStatus).toBe('draft');
  });
});

describe('Grade Lock Workflow — teacher vs manager edit permissions', () => {
  it('a teacher CAN edit grades while the assessment is in Draft', async () => {
    const classId = await createActivatedClass('Teacher Draft Edit Class');
    const student = 'gl_stu_teacher_draft';
    seedStudent(student, BRANCH, 'Teacher Draft Student');
    const assessmentId = await createAssessment(classId);

    const res = await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(teacher)).send({
      grades: [{ assessmentId, studentId: student, score: 80, status: 'graded' }],
    });
    expect(res.status).toBe(200);
  });

  it('a teacher CANNOT edit grades once submitted', async () => {
    const classId = await createActivatedClass('Teacher Submitted Block Class');
    const student = 'gl_stu_teacher_submitted';
    seedStudent(student, BRANCH, 'Teacher Submitted Student');
    const assessmentId = await createAssessment(classId);
    await supertest(app).post(`/api/classes/${classId}/assessments/${assessmentId}/submit`).set(authHeader(owner)).send({});

    const res = await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(teacher)).send({
      grades: [{ assessmentId, studentId: student, score: 80, status: 'graded' }],
    });
    expect(res.status).toBe(409);
  });

  it('a manager CAN still edit grades at submitted/reviewed/approved/published (no unlock needed for these)', async () => {
    const classId = await createActivatedClass('Manager Edit Class');
    const student = 'gl_stu_manager_edit';
    seedStudent(student, BRANCH, 'Manager Edit Student');
    const assessmentId = await createAssessment(classId);
    await supertest(app).post(`/api/classes/${classId}/assessments/${assessmentId}/submit`).set(authHeader(owner)).send({});
    await supertest(app).post(`/api/classes/${classId}/assessments/${assessmentId}/review`).set(authHeader(owner)).send({});

    const res = await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({
      grades: [{ assessmentId, studentId: student, score: 85, status: 'graded' }],
    });
    expect(res.status).toBe(200);
  });

  it('nobody can edit grades once Locked — not even a manager — without an explicit unlock', async () => {
    const classId = await createActivatedClass('Locked Block Class');
    const student = 'gl_stu_locked';
    seedStudent(student, BRANCH, 'Locked Student');
    const assessmentId = await createAssessment(classId);
    for (const step of ['submit', 'review', 'approve', 'publish', 'lock']) {
      await supertest(app).post(`/api/classes/${classId}/assessments/${assessmentId}/${step}`).set(authHeader(owner)).send({});
    }

    const blocked = await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({
      grades: [{ assessmentId, studentId: student, score: 85, status: 'graded' }],
    });
    expect(blocked.status).toBe(409);

    const unlock = await supertest(app).post(`/api/classes/${classId}/assessments/${assessmentId}/unlock`).set(authHeader(owner)).send({});
    expect(unlock.status).toBe(200);
    expect(unlock.body.assessment.lockStatus).toBe('approved');

    const nowAllowed = await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({
      grades: [{ assessmentId, studentId: student, score: 85, status: 'graded' }],
    });
    expect(nowAllowed.status).toBe(200);
  });

  it('a teacher cannot call the unlock endpoint at all (role-gated, not just stage-gated)', async () => {
    const classId = await createActivatedClass('Teacher Cannot Unlock Class');
    const assessmentId = await createAssessment(classId);
    for (const step of ['submit', 'review', 'approve', 'publish', 'lock']) {
      await supertest(app).post(`/api/classes/${classId}/assessments/${assessmentId}/${step}`).set(authHeader(owner)).send({});
    }
    const res = await supertest(app).post(`/api/classes/${classId}/assessments/${assessmentId}/unlock`).set(authHeader(teacher)).send({});
    expect(res.status).toBe(403);
  });
});

describe('Grade Lock Workflow — pure unit tests', () => {
  it('assertGradeLockTransition allows every listed transition and rejects everything else', () => {
    for (const from of GRADE_LOCK_STAGES) {
      for (const to of GRADE_LOCK_STAGES) {
        const allowed = GRADE_LOCK_TRANSITIONS[from].includes(to);
        if (allowed) expect(() => assertGradeLockTransition(from, to)).not.toThrow();
        else expect(() => assertGradeLockTransition(from, to)).toThrow();
      }
    }
  });

  it('locked has zero forward transitions — unlock is a deliberately separate path', () => {
    expect(GRADE_LOCK_TRANSITIONS.locked).toEqual([]);
  });
});
