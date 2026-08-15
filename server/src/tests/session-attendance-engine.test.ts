/**
 * Academic Module Refactor — Phase 2: Session Engine + Smart Attendance Engine
 * ============================================================================
 * Mirrors the app/RBAC-bootstrap pattern established in
 * academic-lifecycle.test.ts (Phase 1) and branch-isolation-http.test.ts.
 *
 * The first test is a regression test for the confirmed critical bug this
 * phase fixes: POST /api/sessions/generate previously threw
 * "RangeError: Too few parameter values were provided" on every call.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import classesRouter from '../routes/classes.routes.js';
import sessionsRouter from '../routes/sessions.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { getEnrollmentService } from '../core/academic/enrollment-service.js';
import { getClassLifecycleService } from '../core/academic/class-lifecycle-service.js';
import {
  computeAttendanceWeight,
  classifyArrival,
  checkConsecutiveAbsences,
  getAttendancePolicy,
} from '../core/academic/attendance-policy-service.js';

const BRANCH = 'se_branch_a';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/classes', classesRouter);
  app.use('/api/sessions', sessionsRouter);
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
function seedStudent(studentId: string, branchId: string, name: string) {
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
     VALUES (?, ?, ?, 'active', ?, ?, 'male')`
  ).run(studentId, `TH-SE-${studentId.slice(-4)}`, name, today(), branchId);
}
function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA');
}
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA');
}

let app: express.Express;
let owner: TokenPayload;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'SE Branch', 'Loc');
  await seedUser('u_se_owner', 'owner', BRANCH, 'se_owner');
  syncLegacyUserRoles(db);
  owner = makeUser({ userId: 'u_se_owner', role: 'owner', branchId: BRANCH });
  app = createApp();
});

/** Creates a class and fast-tracks it to 'in_progress' via the Phase 1
 *  Class Lifecycle Engine, since Phase 2 gates attendance marking on
 *  activation. Returns the class id. */
async function createActivatedClass(name: string): Promise<string> {
  const res = await supertest(app).post('/api/classes').set(authHeader(owner)).send({ name, level: 'A1', branchId: BRANCH, capacity: 10 });
  const classId = res.body.id;
  const svc = getClassLifecycleService(db);
  svc.activate(classId);
  db.prepare(`INSERT OR IGNORE INTO sessions (id, class_id, date, start_time, end_time, status, session_type, branch_id) VALUES (?, ?, ?, '08:00', '09:00', 'scheduled', 'regular', ?)` )
    .run(`${classId}-teaching-session`, classId, today(), BRANCH);
  svc.startTeaching(classId);
  return classId;
}

describe('Session Engine — HTTP integration', () => {
  it('CRIT-FIX: POST /api/sessions/generate no longer throws "Too few parameter values were provided"', async () => {
    const classId = await createActivatedClass('Bulk Generate Class');
    const res = await supertest(app)
      .post('/api/sessions/generate')
      .set(authHeader(owner))
      .send({ classId, startDate: today(), weeks: 1, daysOfWeek: [1, 3], startTime: '09:00', endTime: '10:00' });
    // Any non-500 response proves the parameter-shift bug is gone; the
    // generator's own business validation (schedule conflicts etc.) may
    // still legitimately reject specific inputs.
    expect(res.status).not.toBe(500);
  });

  it('creates a session with sessionType, notes, and roomId', async () => {
    const classId = await createActivatedClass('Session Fields Class');
    const res = await supertest(app).post('/api/sessions').set(authHeader(owner)).send({
      classId, date: today(), startTime: '09:00', endTime: '10:00',
      topic: 'Unit 1', notes: 'Bring textbooks', sessionType: 'online',
    });
    expect(res.status).toBe(201);
    expect(res.body.sessionType).toBe('online');
    expect(res.body.notes).toBe('Bring textbooks');
  });

  it('rejects an invalid sessionType', async () => {
    const classId = await createActivatedClass('Invalid Session Type Class');
    const res = await supertest(app).post('/api/sessions').set(authHeader(owner)).send({
      classId, date: today(), startTime: '09:00', endTime: '10:00', sessionType: 'bogus',
    });
    expect(res.status).toBe(400);
  });

  it('POST /:id/makeup creates a linked makeup session', async () => {
    const classId = await createActivatedClass('Makeup Source Class');
    const original = await supertest(app).post('/api/sessions').set(authHeader(owner)).send({
      classId, date: today(), startTime: '09:00', endTime: '10:00', topic: 'Original lesson',
    });
    const makeup = await supertest(app).post(`/api/sessions/${original.body.id}/makeup`).set(authHeader(owner)).send({
      date: today(), startTime: '14:00', endTime: '15:00',
    });
    expect(makeup.status).toBe(201);
    expect(makeup.body.sessionType).toBe('makeup');
    expect(makeup.body.linkedSessionId).toBe(original.body.id);
  });

  it('Quiz CRUD mirrors Homework', async () => {
    const classId = await createActivatedClass('Quiz Class');
    const session = await supertest(app).post('/api/sessions').set(authHeader(owner)).send({
      classId, date: today(), startTime: '09:00', endTime: '10:00',
    });
    const created = await supertest(app).post(`/api/sessions/${session.body.id}/quizzes`).set(authHeader(owner)).send({
      title: 'Vocabulary Quiz', maxScore: 10,
    });
    expect(created.status).toBe(201);

    const list = await supertest(app).get(`/api/sessions/${session.body.id}/quizzes`).set(authHeader(owner));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].title).toBe('Vocabulary Quiz');
  });
});

describe('Smart Attendance Engine — activation gating', () => {
  it('rejects attendance marking for a class that has not been activated', async () => {
    const create = await supertest(app).post('/api/classes').set(authHeader(owner)).send({ name: 'Not Activated Class', level: 'A1', branchId: BRANCH, capacity: 10 });
    const classId = create.body.id; // stays in 'scheduled' stage — never activated
    const student = 'se_stu_gate';
    seedStudent(student, BRANCH, 'Gate Test Student');
    getEnrollmentService(db).enroll({ studentId: student, branchId: BRANCH, classId, enrollmentType: 'new', startedAt: today() });

    const session = await supertest(app).post('/api/sessions').set(authHeader(owner)).send({
      classId, date: yesterday(), startTime: '09:00', endTime: '10:00',
    });
    const roster = await supertest(app).get(`/api/sessions/${session.body.id}/roster`).set(authHeader(owner));
    const rosterId = roster.body[0].id;

    const res = await supertest(app).patch(`/api/sessions/${session.body.id}/roster/${rosterId}`).set(authHeader(owner)).send({ status: 'present' });
    expect(res.status).toBe(400);
    expect(res.body.error || res.body.message).toMatch(/not been activated/i);
  });

  it('allows attendance marking once the class is activated', async () => {
    const classId = await createActivatedClass('Activated Attendance Class');
    const student = 'se_stu_allow';
    seedStudent(student, BRANCH, 'Allow Test Student');
    getEnrollmentService(db).enroll({ studentId: student, branchId: BRANCH, classId, enrollmentType: 'new', startedAt: today() });

    const session = await supertest(app).post('/api/sessions').set(authHeader(owner)).send({
      classId, date: yesterday(), startTime: '09:00', endTime: '10:00',
    });
    const roster = await supertest(app).get(`/api/sessions/${session.body.id}/roster`).set(authHeader(owner));
    const rosterId = roster.body[0].id;

    const res = await supertest(app).patch(`/api/sessions/${session.body.id}/roster/${rosterId}`).set(authHeader(owner)).send({ status: 'present' });
    expect(res.status).toBe(200);
  });
});

describe('Smart Attendance Engine — bulk marking, weights, auto-drop', () => {
  it('bulk-marks the full expanded status set and computes attendance_weight', async () => {
    const classId = await createActivatedClass('Bulk Mark Class');
    const student = 'se_stu_bulk';
    seedStudent(student, BRANCH, 'Bulk Test Student');
    getEnrollmentService(db).enroll({ studentId: student, branchId: BRANCH, classId, enrollmentType: 'new', startedAt: today() });

    const session = await supertest(app).post('/api/sessions').set(authHeader(owner)).send({
      classId, date: yesterday(), startTime: '09:00', endTime: '10:00',
    });

    const res = await supertest(app).post(`/api/sessions/${session.body.id}/roster`).set(authHeader(owner)).send({
      records: [{ studentId: student, status: 'online' }],
    });
    expect(res.status).toBe(201);

    const roster = await supertest(app).get(`/api/sessions/${session.body.id}/roster`).set(authHeader(owner));
    expect(roster.body[0].attendanceStatus).toBe('online');
    expect(roster.body[0].attendanceWeight).toBe(1);
  });

  it('half-absence rule: a late arrival past the half-absence threshold earns 0.5 weight', () => {
    const policy = { lateThresholdMinutes: 15, halfAbsenceThresholdMinutes: 30, minAttendancePercentage: 75, maxConsecutiveAbsences: 3 };
    expect(computeAttendanceWeight('late', 10, policy)).toBe(1); // late but under half-absence threshold
    expect(computeAttendanceWeight('late', 45, policy)).toBe(0.5); // past half-absence threshold
    expect(computeAttendanceWeight('absent', null, policy)).toBe(0);
    expect(computeAttendanceWeight('excused', null, policy)).toBe(0);
    expect(computeAttendanceWeight('present', null, policy)).toBe(1);
  });

  it('classifyArrival auto-classifies present vs late from raw minutes', () => {
    const policy = getAttendancePolicy(BRANCH); // unconfigured branch -> DEFAULT_POLICY fallback
    expect(classifyArrival(5, policy)).toBe('present');
    expect(classifyArrival(20, policy)).toBe('late');
  });

  it('auto-drops a student after reaching the consecutive-absence threshold (default: 3)', async () => {
    const classId = await createActivatedClass('Auto Drop Class');
    const student = 'se_stu_autodrop';
    seedStudent(student, BRANCH, 'Auto Drop Student');
    const enrolled = getEnrollmentService(db).enroll({ studentId: student, branchId: BRANCH, classId, enrollmentType: 'new', startedAt: today() });

    let lastRes: any;
    for (let i = 3; i >= 1; i--) {
      const session = await supertest(app).post('/api/sessions').set(authHeader(owner)).send({
        classId, date: daysAgo(i), startTime: '09:00', endTime: '10:00',
      });
      lastRes = await supertest(app).post(`/api/sessions/${session.body.id}/roster`).set(authHeader(owner)).send({
        records: [{ studentId: student, status: 'absent' }],
      });
    }

    expect(lastRes.body.autoDrops).toHaveLength(1);
    expect(lastRes.body.autoDrops[0].consecutiveAbsences).toBe(3);

    const enrollment = getEnrollmentService(db).getById(enrolled.enrollmentId);
    expect(enrollment.status).toBe('dropped');
  });

  it('an excused absence interrupts the consecutive-absence streak (no auto-drop)', async () => {
    const classId = await createActivatedClass('Excused Interrupt Class');
    const student = 'se_stu_excused';
    seedStudent(student, BRANCH, 'Excused Student');
    getEnrollmentService(db).enroll({ studentId: student, branchId: BRANCH, classId, enrollmentType: 'new', startedAt: today() });

    const mark = async (daysBack: number, status: string) => {
      const session = await supertest(app).post('/api/sessions').set(authHeader(owner)).send({
        classId, date: daysAgo(daysBack), startTime: '09:00', endTime: '10:00',
      });
      return supertest(app).post(`/api/sessions/${session.body.id}/roster`).set(authHeader(owner)).send({ records: [{ studentId: student, status }] });
    };

    await mark(4, 'absent');
    await mark(3, 'absent');
    await mark(2, 'excused'); // interrupts the streak
    const last = await mark(1, 'absent');

    expect(last.body.autoDrops).toHaveLength(0);

    const check = checkConsecutiveAbsences(db, student, classId, getAttendancePolicy(BRANCH));
    expect(check.consecutiveAbsences).toBe(1); // only the most recent 'absent' counts
  });
});

describe('Timetable skill coverage — regression', () => {
  it('generates the configured class skills rather than pinning the timetable to the first skill', async () => {
    const classId = await createActivatedClass('Multi Skill Timetable Class');
    db.prepare(`INSERT OR IGNORE INTO skills (id, name) VALUES (?, ?), (?, ?), (?, ?)`)
      .run('skill-reading', 'Reading', 'skill-writing', 'Writing', 'skill-speaking', 'Speaking');
    db.prepare(`INSERT OR IGNORE INTO teachers (id, full_name, branch_id, joined_date, status, salary_type, base_salary, default_skill_rate)
      VALUES (?, ?, ?, ?, 'active', 'fixed', 0, 0), (?, ?, ?, ?, 'active', 'fixed', 0, 0), (?, ?, ?, ?, 'active', 'fixed', 0, 0)`)
      .run('teacher-reading', 'Reading Teacher', BRANCH, today(), 'teacher-writing', 'Writing Teacher', BRANCH, today(), 'teacher-speaking', 'Speaking Teacher', BRANCH, today());
    db.prepare(`INSERT INTO class_teacher_skills (id, class_id, teacher_id, skill_id, branch_id, assignment_type, monthly_rate)
      VALUES (?, ?, ?, ?, ?, 'primary', 0), (?, ?, ?, ?, ?, 'primary', 0), (?, ?, ?, ?, ?, 'primary', 0)`)
      .run('cts-reading', classId, 'teacher-reading', 'skill-reading', BRANCH, 'cts-writing', classId, 'teacher-writing', 'skill-writing', BRANCH, 'cts-speaking', classId, 'teacher-speaking', 'skill-speaking', BRANCH);

    const res = await supertest(app)
      .post('/api/sessions/generate')
      .set(authHeader(owner))
      .send({ classId, weeks: 1, daysOfWeek: [6, 0, 1], startTime: '09:00', endTime: '10:00' });

    expect(res.status).toBe(201);
    const sessionIds = res.body.sessionIds as string[];
    const generated = sessionIds.length
      ? db.prepare(`SELECT DISTINCT skill_id FROM sessions WHERE id IN (${sessionIds.map(() => '?').join(',')})`).all(...sessionIds) as { skill_id: string | null }[]
      : [];
    const skills = new Set(generated.map((r) => r.skill_id));
    expect(skills.has('skill-reading')).toBe(true);
    expect(skills.has('skill-writing')).toBe(true);
    expect(skills.has('skill-speaking')).toBe(true);
    expect(res.body.details.skills).toEqual(expect.arrayContaining(['skill-reading', 'skill-writing', 'skill-speaking']));
  });
});
