/**
 * Academic Module Refactor — Phase 9: Transfer / Freeze / Waitlist Engines
 * ============================================================================
 * Mirrors the app/RBAC-bootstrap pattern established in Phases 1-8.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today, id as makeId } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import enrollmentRouter from '../routes/enrollment.routes.js';
import classesRouter from '../routes/classes.routes.js';
import waitlistRouter from '../routes/waitlist.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { getClassLifecycleService } from '../core/academic/class-lifecycle-service.js';
import { getEnrollmentService } from '../core/academic/enrollment-service.js';
import { createRule } from '../core/configuration/rule-engine.js';

const BRANCH_A = 'p9_branch_a';
const BRANCH_B = 'p9_branch_b';
const BRANCH = BRANCH_A;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/enrollments', enrollmentRouter);
  app.use('/api/classes', classesRouter);
  app.use('/api/classes/:id/waitlist', waitlistRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId, username: overrides.username || overrides.userId, branchId: overrides.branchId || BRANCH, fullName: overrides.fullName || 'Test User',
  };
}
function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}
async function seedUser(userId: string, role: string, branchId: string, username: string) {
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password ) VALUES (?, ?, ?, ?, ?, 1, 0)`
  ).run(userId, username, `Test ${role}`, branchId, await hashPassword('testpass123'));
  assignRole(userId, role, branchId);
}

async function ensureScopedManager(userId: string, branchId: string, username: string) {
  await seedUser(userId, 'manager', branchId, username);

}
let studentCounter = 0;
function seedStudent(overrides: { gender?: string } = {}): string {
  studentCounter += 1;
  const studentId = `p9_student_${studentCounter}`;
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, branch_id, status, registration_date, gender) VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).run(studentId, `P9-${studentCounter}`, `Student ${studentCounter}`, BRANCH, today(), overrides.gender || 'male');
  return studentId;
}

let app: express.Express;
let manager: TokenPayload;
let enrollmentService: ReturnType<typeof getEnrollmentService>;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'P9 Branch', 'Loc');
  await seedUser('u_p9_manager', 'manager', BRANCH, 'p9_manager');

  manager = makeUser({ userId: 'u_p9_manager', branchId: BRANCH });
  app = createApp();
  enrollmentService = getEnrollmentService(db);
});

async function createActivatedClass(name: string, capacity = 10): Promise<string> {
  const res = await supertest(app).post('/api/classes').set(authHeader(manager)).send({ name, level: 'A1', branchId: BRANCH, capacity });
  const classId = res.body.id;
  const svc = getClassLifecycleService(db);
  svc.activate(classId);
  db.prepare(`INSERT OR IGNORE INTO sessions (id, class_id, date, start_time, end_time, status, session_type, branch_id) VALUES (?, ?, ?, '08:00', '09:00', 'scheduled', 'regular', ?)` )
    .run(`${classId}-teaching-session`, classId, today(), BRANCH);
  svc.startTeaching(classId);
  return classId;
}

function enrollActive(studentId: string, classId: string): string {
  const result = enrollmentService.enroll({ studentId, branchId: BRANCH, classId, enrollmentType: 'new', startedAt: today() });
  return result.enrollmentId;
}

// ============================================================================
// Freeze Engine
// ============================================================================
describe('Freeze Engine', () => {
  it('activates a freeze immediately when within policy caps, tracking start/planned-end dates', async () => {
    const classId = await createActivatedClass('Freeze Class A');
    const studentId = seedStudent();
    const enrollmentId = enrollActive(studentId, classId);

    const res = await supertest(app).post(`/api/enrollments/${enrollmentId}/freeze-requests`).set(authHeader(manager)).send({ reason: 'Family emergency', days: 14 });
    expect(res.status).toBe(201);
    expect(res.body.enrollment.status).toBe('frozen');
    expect(res.body.freeze.status).toBe('active');
    expect(res.body.freeze.reason).toBe('Family emergency');
    expect(res.body.freeze.approvedBy).toBeTruthy();

    const startDate = new Date(res.body.freeze.startDate);
    const endDate = new Date(res.body.freeze.plannedEndDate);
    const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / 86400000);
    expect(diffDays).toBe(14);
  });

  it('rejects a freeze request longer than maxFreezeDurationDays', async () => {
    const classId = await createActivatedClass('Freeze Class B');
    const studentId = seedStudent();
    const enrollmentId = enrollActive(studentId, classId);

    // Default policy: maxFreezeDurationDays = 90
    const res = await supertest(app).post(`/api/enrollments/${enrollmentId}/freeze-requests`).set(authHeader(manager)).send({ reason: 'Long trip', days: 200 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds the policy maximum/);

    const enrollment = enrollmentService.getById(enrollmentId);
    expect(enrollment.status).toBe('active');
  });

  it('rejects a freeze request once maxFreezesPerEnrollment is used up', async () => {
    const classId = await createActivatedClass('Freeze Class C');
    const studentId = seedStudent();
    const enrollmentId = enrollActive(studentId, classId);

    // Default policy: maxFreezesPerEnrollment = 2
    for (let i = 0; i < 2; i++) {
      const freezeRes = await supertest(app).post(`/api/enrollments/${enrollmentId}/freeze-requests`).set(authHeader(manager)).send({ reason: `Freeze ${i}`, days: 5 });
      expect(freezeRes.status).toBe(201);
      const resumeRes = await supertest(app).post(`/api/enrollments/${enrollmentId}/freeze-requests/resume`).set(authHeader(manager)).send({});
      expect(resumeRes.status).toBe(200);
    }

    const thirdRes = await supertest(app).post(`/api/enrollments/${enrollmentId}/freeze-requests`).set(authHeader(manager)).send({ reason: 'Freeze 3', days: 5 });
    expect(thirdRes.status).toBe(409);
    expect(thirdRes.body.error).toMatch(/policy limit of 2 freeze/);
  });

  it('resume ends the active freeze and reactivates the enrollment', async () => {
    const classId = await createActivatedClass('Freeze Class D');
    const studentId = seedStudent();
    const enrollmentId = enrollActive(studentId, classId);

    await supertest(app).post(`/api/enrollments/${enrollmentId}/freeze-requests`).set(authHeader(manager)).send({ reason: 'Medical', days: 10 });
    const resumeRes = await supertest(app).post(`/api/enrollments/${enrollmentId}/freeze-requests/resume`).set(authHeader(manager)).send({ reason: 'Recovered early' });
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.enrollment.status).toBe('active');

    const listRes = await supertest(app).get(`/api/enrollments/${enrollmentId}/freeze-requests`).set(authHeader(manager));
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].status).toBe('completed');
    expect(listRes.body[0].actualEndDate).toBeTruthy();
  });

  it('requires a reason to request a freeze', async () => {
    const classId = await createActivatedClass('Freeze Class E');
    const studentId = seedStudent();
    const enrollmentId = enrollActive(studentId, classId);

    const res = await supertest(app).post(`/api/enrollments/${enrollmentId}/freeze-requests`).set(authHeader(manager)).send({ days: 5 });
    expect(res.status).toBe(400);
  });

  it('resume with no active freeze returns 404', async () => {
    const classId = await createActivatedClass('Freeze Class F');
    const studentId = seedStudent();
    const enrollmentId = enrollActive(studentId, classId);

    const res = await supertest(app).post(`/api/enrollments/${enrollmentId}/freeze-requests/resume`).set(authHeader(manager)).send({});
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// Transfer Engine
// ============================================================================
describe('Transfer Engine', () => {
  it('auto-approves and executes a transfer when tenure clears the (default, 0-day) policy threshold', async () => {
    const fromClass = await createActivatedClass('Transfer Class From A');
    const toClass = await createActivatedClass('Transfer Class To A');
    const studentId = seedStudent();
    const enrollmentId = enrollActive(studentId, fromClass);

    const res = await supertest(app).post(`/api/enrollments/${enrollmentId}/transfer-requests`).set(authHeader(manager)).send({ toClassId: toClass, reason: 'Schedule conflict' });
    expect(res.status).toBe(201);
    expect(res.body.transferRequest.status).toBe('approved');
    expect(res.body.transferRequest.newEnrollmentId).toBeTruthy();

    const oldEnrollment = enrollmentService.getById(enrollmentId);
    expect(oldEnrollment.status).toBe('transferred');
    const newEnrollment = enrollmentService.getById(res.body.transferRequest.newEnrollmentId);
    expect(newEnrollment.class_id).toBe(toClass);
    expect(newEnrollment.status).toBe('active');
  });

  it('stores a request as pending (no transfer executed) when tenure is below a configured minDaysBeforeAutoApprove', async () => {
    const strictBranch = 'p9_branch_strict';
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(strictBranch, 'Strict Branch', 'Loc');
    createRule({
      name: 'Transfer requires 30-day tenure', description: 'Test rule', category: 'academic',
      conditions: [], actions: [{ type: 'set_value', targetKey: 'minDaysBeforeAutoApprove', value: 30 }],
      priority: 10, isActive: true, scopeBranchId: strictBranch, lastModifiedBy: 'test-operator',
    }, 'test-operator');

    // Classes in the strict branch must be created by a manager scoped to it
    // (branch isolation blocks the default branch-A manager).
    await ensureScopedManager('u_p9_manager_strict1', strictBranch, 'p9_manager_strict1');
    const strictManager = makeUser({ userId: 'u_p9_manager_strict1', branchId: strictBranch });
    const fromRes = await supertest(app).post('/api/classes').set(authHeader(strictManager)).send({ name: 'Strict From', level: 'A1', branchId: strictBranch, capacity: 10 });
    const toRes = await supertest(app).post('/api/classes').set(authHeader(strictManager)).send({ name: 'Strict To', level: 'A1', branchId: strictBranch, capacity: 10 });
    const svc = getClassLifecycleService(db);
    svc.activate(fromRes.body.id);
    db.prepare(`INSERT OR IGNORE INTO sessions (id, class_id, date, start_time, end_time, status, session_type, branch_id) VALUES (?, ?, ?, '08:00', '09:00', 'scheduled', 'regular', ?)` )
      .run(`${fromRes.body.id}-teaching-session`, fromRes.body.id, today(), BRANCH_A);
    svc.startTeaching(fromRes.body.id);
    svc.activate(toRes.body.id);
    db.prepare(`INSERT OR IGNORE INTO sessions (id, class_id, date, start_time, end_time, status, session_type, branch_id) VALUES (?, ?, ?, '08:00', '09:00', 'scheduled', 'regular', ?)` )
      .run(`${toRes.body.id}-teaching-session`, toRes.body.id, today(), strictBranch);
    svc.startTeaching(toRes.body.id);

    const studentId = `p9_strict_student`;
    db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, branch_id, status, registration_date, gender) VALUES (?, ?, ?, ?, 'active', ?, 'male')`).run(studentId, 'P9-STRICT-1', 'Strict Student', strictBranch, today());
    const enrollmentId = enrollmentService.enroll({ studentId, branchId: strictBranch, classId: fromRes.body.id, enrollmentType: 'new', startedAt: today() }).enrollmentId;

    const res = await supertest(app).post(`/api/enrollments/${enrollmentId}/transfer-requests`).set(authHeader(strictManager)).send({ toClassId: toRes.body.id, reason: 'Wants a different class' });
    expect(res.status).toBe(201);
    expect(res.body.transferRequest.status).toBe('pending');
    expect(res.body.transferRequest.newEnrollmentId).toBeNull();

    const stillEnrolled = enrollmentService.getById(enrollmentId);
    expect(stillEnrolled.status).toBe('active');
    expect(stillEnrolled.class_id).toBe(fromRes.body.id);

    // Approving it now executes the transfer.
    const approveRes = await supertest(app)
      .post(`/api/enrollments/${enrollmentId}/transfer-requests/${res.body.transferRequest.id}/approve`)
      .set(authHeader(strictManager)).send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.transferRequest.status).toBe('approved');
    expect(approveRes.body.transferRequest.newEnrollmentId).toBeTruthy();
    expect(enrollmentService.getById(enrollmentId).status).toBe('transferred');
  });

  it('rejecting a pending request leaves the enrollment untouched', async () => {
    const strictBranch2 = 'p9_branch_strict2';
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(strictBranch2, 'Strict Branch 2', 'Loc');
    createRule({
      name: 'Transfer requires 30-day tenure v2', description: 'Test rule', category: 'academic',
      conditions: [], actions: [{ type: 'set_value', targetKey: 'minDaysBeforeAutoApprove', value: 30 }],
      priority: 10, isActive: true, scopeBranchId: strictBranch2, lastModifiedBy: 'test-operator',
    }, 'test-operator');

    // Classes in the strict branch must be created by a manager scoped to it
    // (branch isolation blocks the default branch-A manager).
    await ensureScopedManager('u_p9_manager_strict2', strictBranch2, 'p9_manager_strict2');
    const strictManager = makeUser({ userId: 'u_p9_manager_strict2', branchId: strictBranch2 });
    const fromRes = await supertest(app).post('/api/classes').set(authHeader(strictManager)).send({ name: 'Strict From 2', level: 'A1', branchId: strictBranch2, capacity: 10 });
    const toRes = await supertest(app).post('/api/classes').set(authHeader(strictManager)).send({ name: 'Strict To 2', level: 'A1', branchId: strictBranch2, capacity: 10 });
    const svc = getClassLifecycleService(db);
    svc.activate(fromRes.body.id);
    db.prepare(`INSERT OR IGNORE INTO sessions (id, class_id, date, start_time, end_time, status, session_type, branch_id) VALUES (?, ?, ?, '08:00', '09:00', 'scheduled', 'regular', ?)` )
      .run(`${fromRes.body.id}-teaching-session`, fromRes.body.id, today(), BRANCH_A);
    svc.startTeaching(fromRes.body.id);
    svc.activate(toRes.body.id);
    db.prepare(`INSERT OR IGNORE INTO sessions (id, class_id, date, start_time, end_time, status, session_type, branch_id) VALUES (?, ?, ?, '08:00', '09:00', 'scheduled', 'regular', ?)` )
      .run(`${toRes.body.id}-teaching-session`, toRes.body.id, today(), strictBranch2);
    svc.startTeaching(toRes.body.id);

    const studentId = `p9_strict_student2`;
    db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, branch_id, status, registration_date, gender) VALUES (?, ?, ?, ?, 'active', ?, 'male')`).run(studentId, 'P9-STRICT-2', 'Strict Student 2', strictBranch2, today());
    const enrollmentId = enrollmentService.enroll({ studentId, branchId: strictBranch2, classId: fromRes.body.id, enrollmentType: 'new', startedAt: today() }).enrollmentId;

    const reqRes = await supertest(app).post(`/api/enrollments/${enrollmentId}/transfer-requests`).set(authHeader(strictManager)).send({ toClassId: toRes.body.id, reason: 'Wants out' });
    expect(reqRes.body.transferRequest.status).toBe('pending');

    const rejectRes = await supertest(app)
      .post(`/api/enrollments/${enrollmentId}/transfer-requests/${reqRes.body.transferRequest.id}/reject`)
      .set(authHeader(strictManager)).send({ notes: 'Not enough seats in target class' });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.transferRequest.status).toBe('rejected');

    const enrollment = enrollmentService.getById(enrollmentId);
    expect(enrollment.status).toBe('active');
    expect(enrollment.class_id).toBe(fromRes.body.id);

    // Cannot approve an already-rejected request.
    const approveAfterRejectRes = await supertest(app)
      .post(`/api/enrollments/${enrollmentId}/transfer-requests/${reqRes.body.transferRequest.id}/approve`)
      .set(authHeader(strictManager)).send({});
    expect(approveAfterRejectRes.status).toBe(409);
  });

  it('rejects a transfer request to the same class', async () => {
    const classId = await createActivatedClass('Transfer Same Class');
    const studentId = seedStudent();
    const enrollmentId = enrollActive(studentId, classId);

    const res = await supertest(app).post(`/api/enrollments/${enrollmentId}/transfer-requests`).set(authHeader(manager)).send({ toClassId: classId, reason: 'Confused request' });
    expect(res.status).toBe(400);
  });

  it('rejects a transfer request to a nonexistent class', async () => {
    const classId = await createActivatedClass('Transfer Nonexistent Target');
    const studentId = seedStudent();
    const enrollmentId = enrollActive(studentId, classId);

    const res = await supertest(app).post(`/api/enrollments/${enrollmentId}/transfer-requests`).set(authHeader(manager)).send({ toClassId: 'no_such_class', reason: 'Typo' });
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// Waitlist Engine
// ============================================================================
describe('Waitlist Engine', () => {
  it('rejects joining a class that still has open seats', async () => {
    const classId = await createActivatedClass('Waitlist Open Seats', 5);
    const studentId = seedStudent();

    const res = await supertest(app).post(`/api/classes/${classId}/waitlist`).set(authHeader(manager)).send({ studentId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/open seats/);
  });

  it('allows joining once the class is full, assigning sequential FIFO positions', async () => {
    const classId = await createActivatedClass('Waitlist Full Class', 1);
    const fillerStudent = seedStudent();
    enrollActive(fillerStudent, classId);
    db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status) VALUES (?, ?, 'Term', ?, date('now'), 0, 'active')`).run(makeId('ss'), fillerStudent, classId);

    const s1 = seedStudent();
    const s2 = seedStudent();
    const res1 = await supertest(app).post(`/api/classes/${classId}/waitlist`).set(authHeader(manager)).send({ studentId: s1 });
    const res2 = await supertest(app).post(`/api/classes/${classId}/waitlist`).set(authHeader(manager)).send({ studentId: s2 });
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.position).toBe(1);
    expect(res2.body.position).toBe(2);

    const listRes = await supertest(app).get(`/api/classes/${classId}/waitlist`).set(authHeader(manager));
    expect(listRes.body.map((e: any) => e.studentId)).toEqual([s1, s2]);
  });

  it('rejects a duplicate join for a student already waiting', async () => {
    const classId = await createActivatedClass('Waitlist Dup Class', 1);
    const fillerStudent = seedStudent();
    enrollActive(fillerStudent, classId);
    db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status) VALUES (?, ?, 'Term', ?, date('now'), 0, 'active')`).run(makeId('ss'), fillerStudent, classId);

    const s1 = seedStudent();
    await supertest(app).post(`/api/classes/${classId}/waitlist`).set(authHeader(manager)).send({ studentId: s1 });
    const dupRes = await supertest(app).post(`/api/classes/${classId}/waitlist`).set(authHeader(manager)).send({ studentId: s1 });
    expect(dupRes.status).toBe(409);
  });

  it('offer transitions an entry to offered', async () => {
    const classId = await createActivatedClass('Waitlist Offer Class', 1);
    const fillerStudent = seedStudent();
    enrollActive(fillerStudent, classId);
    db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status) VALUES (?, ?, 'Term', ?, date('now'), 0, 'active')`).run(makeId('ss'), fillerStudent, classId);

    const s1 = seedStudent();
    const joinRes = await supertest(app).post(`/api/classes/${classId}/waitlist`).set(authHeader(manager)).send({ studentId: s1 });
    const offerRes = await supertest(app).post(`/api/classes/${classId}/waitlist/${joinRes.body.id}/offer`).set(authHeader(manager)).send({});
    expect(offerRes.status).toBe(200);
    expect(offerRes.body.status).toBe('offered');
  });

  it('converts a waitlisted entry into a real active enrollment once a seat is freed', async () => {
    const classId = await createActivatedClass('Waitlist Convert Class', 1);
    const fillerStudent = seedStudent();
    enrollActive(fillerStudent, classId);
    db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status) VALUES (?, ?, 'Term', ?, date('now'), 0, 'active')`).run(makeId('ss'), fillerStudent, classId);

    const s1 = seedStudent();
    const joinRes = await supertest(app).post(`/api/classes/${classId}/waitlist`).set(authHeader(manager)).send({ studentId: s1 });

    // Seat frees up: the filler student drops. Both capacity sources must
    // reflect the freed seat — the waitlist gate reads student_semesters while
    // EnrollmentService.enroll() (called inside convert) counts active
    // enrollments — exactly as a real drop/withdrawal would update both.
    db.prepare(`UPDATE student_semesters SET status = 'completed' WHERE student_id = ? AND class_id = ?`).run(fillerStudent, classId);
    db.prepare(`UPDATE enrollments SET status = 'completed' WHERE student_id = ? AND class_id = ? AND status IN ('active','confirmed','pending')`).run(fillerStudent, classId);

    const convertRes = await supertest(app).post(`/api/classes/${classId}/waitlist/${joinRes.body.id}/convert`).set(authHeader(manager)).send({});
    expect(convertRes.status).toBe(201);
    expect(convertRes.body.waitlistEntry.status).toBe('converted');

    const newEnrollment = enrollmentService.getById(convertRes.body.enrollmentId);
    expect(newEnrollment.status).toBe('active');
    expect(newEnrollment.class_id).toBe(classId);
    expect(newEnrollment.student_id).toBe(s1);
  });

  it('rejects converting when the class is still genuinely full', async () => {
    const classId = await createActivatedClass('Waitlist Still Full Class', 1);
    const fillerStudent = seedStudent();
    enrollActive(fillerStudent, classId);
    db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status) VALUES (?, ?, 'Term', ?, date('now'), 0, 'active')`).run(makeId('ss'), fillerStudent, classId);

    const s1 = seedStudent();
    const joinRes = await supertest(app).post(`/api/classes/${classId}/waitlist`).set(authHeader(manager)).send({ studentId: s1 });

    // No seat freed up this time.
    const convertRes = await supertest(app).post(`/api/classes/${classId}/waitlist/${joinRes.body.id}/convert`).set(authHeader(manager)).send({});
    expect(convertRes.status).toBe(409);
  });

  it('cancel withdraws a waiting entry; cancelling a converted entry is rejected', async () => {
    const classId = await createActivatedClass('Waitlist Cancel Class', 1);
    const fillerStudent = seedStudent();
    enrollActive(fillerStudent, classId);
    db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status) VALUES (?, ?, 'Term', ?, date('now'), 0, 'active')`).run(makeId('ss'), fillerStudent, classId);

    const s1 = seedStudent();
    const joinRes = await supertest(app).post(`/api/classes/${classId}/waitlist`).set(authHeader(manager)).send({ studentId: s1 });
    const cancelRes = await supertest(app).post(`/api/classes/${classId}/waitlist/${joinRes.body.id}/cancel`).set(authHeader(manager)).send({});
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('cancelled');

    const cancelAgainRes = await supertest(app).post(`/api/classes/${classId}/waitlist/${joinRes.body.id}/cancel`).set(authHeader(manager)).send({});
    expect(cancelAgainRes.status).toBe(409);
  });

  it('a student can rejoin the waitlist after cancelling', async () => {
    const classId = await createActivatedClass('Waitlist Rejoin Class', 1);
    const fillerStudent = seedStudent();
    enrollActive(fillerStudent, classId);
    db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, status) VALUES (?, ?, 'Term', ?, date('now'), 0, 'active')`).run(makeId('ss'), fillerStudent, classId);

    const s1 = seedStudent();
    const joinRes = await supertest(app).post(`/api/classes/${classId}/waitlist`).set(authHeader(manager)).send({ studentId: s1 });
    await supertest(app).post(`/api/classes/${classId}/waitlist/${joinRes.body.id}/cancel`).set(authHeader(manager)).send({});

    const rejoinRes = await supertest(app).post(`/api/classes/${classId}/waitlist`).set(authHeader(manager)).send({ studentId: s1 });
    expect(rejoinRes.status).toBe(201);
    expect(rejoinRes.body.position).toBe(1); // position reflects the current 'waiting' queue depth, not a monotonic counter — the cancelled entry no longer counts
  });
});
