/**
 * Academic Module Refactor — Phase 6: Academic Policy Engine (formalize)
 * ============================================================================
 * Mirrors the app/RBAC-bootstrap pattern established in Phases 1-5.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today, id as makeId } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import classesRouter from '../routes/classes.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { getClassLifecycleService } from '../core/academic/class-lifecycle-service.js';
import { getEnrollmentService } from '../core/academic/enrollment-service.js';
import {
  getRetakePolicy, getConditionalPassPolicy, getTransferPolicy, getFreezePolicy,
  getCertificatePolicy, getMakeupPolicy, getFullPolicyProfile, countPriorRetakes,
} from '../core/academic/academic-policy-service.js';
import { decidePromotion } from '../core/academic/promotion-engine.js';

const BRANCH = 'ap_branch_a';

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
function seedStudentWithRosterAndEnrollment(studentId: string, branchId: string, name: string, classId: string) {
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender) VALUES (?, ?, ?, 'active', ?, ?, 'male')`
  ).run(studentId, `TH-AP-${studentId.slice(-4)}`, name, today(), branchId);
  const semId = makeId('sem');
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount) VALUES (?, ?, 'Test Semester', ?, ?, 0)`
  ).run(semId, studentId, classId, today());
  const enrolled = getEnrollmentService(db).enroll({ studentId, branchId, classId, enrollmentType: 'new', startedAt: today() });
  return { semesterId: semId, enrollmentId: enrolled.enrollmentId };
}

let app: express.Express;
let owner: TokenPayload;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'AP Branch', 'Loc');
  await seedUser('u_ap_owner', 'owner', BRANCH, 'ap_owner');
  syncLegacyUserRoles(db);
  owner = makeUser({ userId: 'u_ap_owner', role: 'owner', branchId: BRANCH });
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

describe('Academic Policy Engine — the six new policy getters have sane defaults', () => {
  it('returns documented defaults for every new policy category when nothing is configured', () => {
    const unconfiguredBranch = 'ap_branch_unconfigured';
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(unconfiguredBranch, 'Unconfigured', 'Loc');

    expect(getRetakePolicy(unconfiguredBranch).maxAutomaticRetakes).toBe(2);
    expect(getConditionalPassPolicy(unconfiguredBranch).maxConsecutiveConditionalPasses).toBe(1);
    expect(getTransferPolicy(unconfiguredBranch).minDaysBeforeAutoApprove).toBe(0);
    expect(getFreezePolicy(unconfiguredBranch)).toEqual({ maxFreezeDurationDays: 90, maxFreezesPerEnrollment: 2 });
    expect(getCertificatePolicy(unconfiguredBranch).minPercentageForCertificate).toBe(60);
    expect(getMakeupPolicy(unconfiguredBranch).windowDays).toBe(14);
  });

  it('getFullPolicyProfile aggregates every category (attendance, gradebook, and all six new ones) in one call', () => {
    const profile = getFullPolicyProfile(BRANCH, { programId: 'p1', levelId: 'l1' });
    expect(profile.attendance.maxConsecutiveAbsences).toBe(3);
    expect(profile.letterGradeBands.length).toBeGreaterThan(0);
    expect(profile.retake.maxAutomaticRetakes).toBe(2);
    expect(profile.makeup.windowDays).toBe(14);
    expect(profile.scope).toEqual({ programId: 'p1', levelId: 'l1' });
  });
});

describe('Academic Policy Engine — GET /:id/policy-profile diagnostic endpoint', () => {
  it('returns a coherent, complete profile for a class', async () => {
    const classId = await createActivatedClass('Policy Profile Class');
    const res = await supertest(app).get(`/api/classes/${classId}/policy-profile`).set(authHeader(owner));
    expect(res.status).toBe(200);
    expect(res.body.promotion.minScore).toBeDefined();
    expect(res.body.attendance.lateThresholdMinutes).toBeDefined();
    expect(res.body.retake.maxAutomaticRetakes).toBe(2);
    expect(res.body.freeze.maxFreezeDurationDays).toBe(90);
  });
});

describe('Academic Policy Engine — Retake Policy enforcement', () => {
  it('countPriorRetakes correctly counts retake_marked enrollment_events for a specific student+class', async () => {
    const classId = await createActivatedClass('Count Retakes Class');
    const student = 'ap_stu_count';
    const { enrollmentId } = seedStudentWithRosterAndEnrollment(student, BRANCH, 'Count Student', classId);
    expect(countPriorRetakes(db, student, classId)).toBe(0);

    getEnrollmentService(db).markRetake(enrollmentId);
    expect(countPriorRetakes(db, student, classId)).toBe(1);
  });

  it('decidePromotion escalates to manual_review once the retake cap is reached, instead of looping automatic retakes forever', () => {
    const criteria = { minScore: 60, minAttendancePercentage: 75, requireAllSubjects: false, toLevelId: null, source: 'default' as const };
    const factorsBase = { finalPercentage: 45, hasMissingGrades: false, attendancePercentage: 90, hasFinancialHold: false, failedMandatorySkills: [], criteria };

    // Below the cap: still an automatic retake.
    expect(decidePromotion({ ...factorsBase, priorRetakeCount: 1, maxAutomaticRetakes: 2 }).outcome).toBe('retake');
    // At the cap: escalates.
    const atCap = decidePromotion({ ...factorsBase, priorRetakeCount: 2, maxAutomaticRetakes: 2 });
    expect(atCap.outcome).toBe('manual_review');
  });

  it('end-to-end: a student retaken exactly maxAutomaticRetakes times before is escalated to manual_review on the next failure', async () => {
    const classId = await createActivatedClass('Retake Cap E2E Class');
    const student = 'ap_stu_e2e_retakecap';
    const { enrollmentId } = seedStudentWithRosterAndEnrollment(student, BRANCH, 'Retake Cap Student', classId);
    // Simulate 2 prior retakes of THIS class (the default cap) before this semester's attempt.
    getEnrollmentService(db).markRetake(enrollmentId);
    getEnrollmentService(db).activate(enrollmentId);
    getEnrollmentService(db).markRetake(enrollmentId);
    getEnrollmentService(db).activate(enrollmentId);

    const a = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Final', type: 'final', weight: 100 });
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({ grades: [{ assessmentId: a.body.id, studentId: student, score: 40, status: 'graded' }] });

    const res = await supertest(app).post(`/api/classes/${classId}/complete-semester`).set(authHeader(owner)).send({});
    expect(res.body.outcomes.find((o: any) => o.studentId === student).outcome).toBe('manual_review');
  });
});

describe('Academic Policy Engine — Make-up Policy enforcement', () => {
  it('rejects a make-up requested outside the configured window', async () => {
    const classId = await createActivatedClass('Makeup Window Class');
    const original = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({
      title: 'Final Exam', type: 'final', weight: 100, allowsMakeup: true, dueDate: '2026-01-01',
    });
    // Default window is 14 days — requesting a makeup for 2026-02-01 (31 days later) should be rejected.
    const res = await supertest(app).post(`/api/classes/${classId}/assessments/${original.body.id}/makeup`).set(authHeader(owner)).send({ date: '2026-02-01' });
    expect(res.status).toBe(400);
    expect(res.body.error || res.body.message).toMatch(/window has closed/i);
  });

  it('allows a make-up requested within the configured window', async () => {
    const classId = await createActivatedClass('Makeup Within Window Class');
    const original = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({
      title: 'Final Exam', type: 'final', weight: 100, allowsMakeup: true, dueDate: '2026-01-01',
    });
    const res = await supertest(app).post(`/api/classes/${classId}/assessments/${original.body.id}/makeup`).set(authHeader(owner)).send({ date: '2026-01-10' });
    expect(res.status).toBe(201);
  });

  it('does not enforce a window when the original assessment has no due date', async () => {
    const classId = await createActivatedClass('Makeup No Due Date Class');
    const original = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({
      title: 'Final Exam', type: 'final', weight: 100, allowsMakeup: true,
    });
    const res = await supertest(app).post(`/api/classes/${classId}/assessments/${original.body.id}/makeup`).set(authHeader(owner)).send({});
    expect(res.status).toBe(201);
  });
});
