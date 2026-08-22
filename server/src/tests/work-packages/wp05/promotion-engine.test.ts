/**
 * Academic Module Refactor — Phase 5: Promotion Engine
 * ============================================================================
 * Mirrors the app/RBAC-bootstrap pattern established in Phases 1-4.
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { today, id as makeId } from '../../../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import classesRouter from '../../../routes/classes.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { getClassLifecycleService } from '../../../core/academic/class-lifecycle-service.js';
import { getEnrollmentService } from '../../../core/academic/enrollment-service.js';
import {
  resolvePromotionCriteria, computeAttendancePercentage, hasFinancialHold, decidePromotion,
} from '../../../core/academic/promotion-engine.js';

const BRANCH = 'pe_branch_a';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/classes', classesRouter);
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
function seedStudentWithRosterAndEnrollment(studentId: string, branchId: string, name: string, classId: string) {
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender) VALUES (?, ?, ?, 'active', ?, ?, 'male')`
  ).run(studentId, `TH-PE-${studentId.slice(-4)}`, name, today(), branchId);
  const semId = makeId('sem');
  db.prepare(
    `INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount) VALUES (?, ?, 'Test Semester', ?, ?, 0)`
  ).run(semId, studentId, classId, today());
  // writeSemester:false — the helper owns its semester row above; enroll()
  // would otherwise create a duplicate projection row.
  const enrolled = getEnrollmentService(db).enroll({ studentId, branchId, classId, enrollmentType: 'new', startedAt: today(), writeSemester: false });
  return { semesterId: semId, enrollmentId: enrolled.enrollmentId };
}

let app: express.Express;
let owner: TokenPayload;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'PE Branch', 'Loc');
  await seedUser('u_pe_owner', 'owner', BRANCH, 'pe_owner');

  owner = makeUser({ userId: 'u_pe_owner', branchId: BRANCH });
  app = createApp();
});

async function createActivatedClass(name: string, levelId?: string): Promise<string> {
  const res = await supertest(app).post('/api/classes').set(authHeader(owner)).send({ name, level: 'A1', levelId, branchId: BRANCH, capacity: 10 });
  const classId = res.body.id;
  const svc = getClassLifecycleService(db);
  svc.activate(classId);
  db.prepare(`INSERT OR IGNORE INTO sessions (id, class_id, date, start_time, end_time, status, session_type, branch_id) VALUES (?, ?, ?, '09:00', '10:00', 'scheduled', 'regular', ?)` )
    .run(`${classId}-teaching-session`, classId, today(), BRANCH);
  svc.startTeaching(classId);
  return classId;
}

describe('Promotion Engine — criteria resolution precedence', () => {
  it('falls back to the canonical academic default (70/75) when nothing is configured', () => {
    const criteria = resolvePromotionCriteria(db, { level_id: null, branch_id: BRANCH });
    expect(criteria.source).toBe('default');
    expect(criteria.minScore).toBe(70);
    expect(criteria.minAttendancePercentage).toBe(75);
  });

  it('uses branch_academic_profiles when configured', () => {
    const isolatedBranch = 'pe_branch_isolated_profile';
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(isolatedBranch, 'Isolated Profile Branch', 'Loc');
    db.prepare(`INSERT OR REPLACE INTO branch_academic_profiles (branch_id, default_pass_mark, default_min_attendance) VALUES (?, 65, 80)`).run(isolatedBranch);
    const criteria = resolvePromotionCriteria(db, { level_id: null, branch_id: isolatedBranch });
    expect(criteria.source).toBe('branch_profile');
    expect(criteria.minScore).toBe(65);
  });

  it('prefers levels.pass_mark over the branch profile when a level is resolvable', () => {
    const programId = makeId('prog');
    db.prepare(`INSERT INTO programs (id, name, branch_id) VALUES (?, 'Test Program', ?)`).run(programId, BRANCH);
    const levelId = makeId('lvl');
    db.prepare(`INSERT INTO levels (id, program_id, name, pass_mark) VALUES (?, ?, 'Level 1', 72)`).run(levelId, programId);

    const criteria = resolvePromotionCriteria(db, { level_id: levelId, branch_id: BRANCH });
    expect(criteria.source).toBe('level_pass_mark');
    expect(criteria.minScore).toBe(72);
    expect(criteria.requireAllSubjects).toBe(false); // no explicit promotion_rules -> stays off
  });

  it('prefers a promotion_rules entry over everything when resolvable via level -> program_version', () => {
    const isolatedBranch = 'pe_branch_isolated_rules';
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(isolatedBranch, 'Isolated Rules Branch', 'Loc');
    const programId = makeId('prog');
    db.prepare(`INSERT INTO programs (id, name, branch_id) VALUES (?, 'Versioned Program', ?)`).run(programId, isolatedBranch);
    const versionId = makeId('pv');
    db.prepare(`INSERT INTO program_versions (id, program_id, version_label, version_number, status) VALUES (?, ?, 'v1', 1, 'published')`).run(versionId, programId);
    const levelId = makeId('lvl');
    db.prepare(`INSERT INTO levels (id, program_id, name, pass_mark, program_version_id) VALUES (?, ?, 'Level 2', 72, ?)`).run(levelId, programId, versionId);
    db.prepare(
      `INSERT INTO promotion_rules (id, program_version_id, from_level_id, name, min_score, min_attendance_pct, require_all_subjects, to_level_id) VALUES (?, ?, ?, 'Rule', 80, 85, 1, NULL)`
    ).run(makeId('pr'), versionId, levelId);

    const criteria = resolvePromotionCriteria(db, { level_id: levelId, branch_id: isolatedBranch });
    expect(criteria.source).toBe('promotion_rules');
    expect(criteria.minScore).toBe(80);
    expect(criteria.minAttendancePercentage).toBe(85);
    expect(criteria.requireAllSubjects).toBe(true);
  });
});

describe('Promotion Engine — factor computation', () => {
  it('hasFinancialHold detects an overdue invoice', async () => {
    const student = 'pe_stu_hold';
    db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender) VALUES (?, ?, ?, 'active', ?, ?, 'male')`)
      .run(student, 'TH-PE-HOLD', 'Hold Student', today(), BRANCH);
    expect(hasFinancialHold(db, student)).toBe(false);

    db.prepare(
      `INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, purpose) VALUES (?, ?, 100, 100, 'overdue', ?, '2020-01-01', ?, 'other')`
    ).run(makeId('inv'), student, today(), BRANCH);
    expect(hasFinancialHold(db, student)).toBe(true);
  });

  it('computeAttendancePercentage returns null when no sessions are marked (does not penalize unknown data)', () => {
    expect(computeAttendancePercentage(db, 'nonexistent-student', 'nonexistent-class')).toBeNull();
  });
});

describe('Promotion Engine — decidePromotion (pure)', () => {
  const criteria = { minScore: 60, minAttendancePercentage: 75, requireAllSubjects: false, toLevelId: null, source: 'default' as const };

  it('promotes a student who clears every threshold', () => {
    const d = decidePromotion({ finalPercentage: 85, hasMissingGrades: false, attendancePercentage: 90, hasFinancialHold: false, failedMandatorySkills: [], criteria });
    expect(d.outcome).toBe('promote');
  });

  it('sends financial hold straight to manual_review regardless of academic performance', () => {
    const d = decidePromotion({ finalPercentage: 95, hasMissingGrades: false, attendancePercentage: 95, hasFinancialHold: true, failedMandatorySkills: [], criteria });
    expect(d.outcome).toBe('manual_review');
  });

  it('gives conditional_pass when score is fine but attendance falls short', () => {
    const d = decidePromotion({ finalPercentage: 85, hasMissingGrades: false, attendancePercentage: 50, hasFinancialHold: false, failedMandatorySkills: [], criteria });
    expect(d.outcome).toBe('conditional_pass');
  });

  it('gives conditional_pass when score is fine but a mandatory skill failed', () => {
    const d = decidePromotion({
      finalPercentage: 85, hasMissingGrades: false, attendancePercentage: 90, hasFinancialHold: false,
      failedMandatorySkills: ['Speaking'], criteria: { ...criteria, requireAllSubjects: true },
    });
    expect(d.outcome).toBe('conditional_pass');
  });

  it('gives retake for a moderate score failure', () => {
    const d = decidePromotion({ finalPercentage: 45, hasMissingGrades: false, attendancePercentage: 90, hasFinancialHold: false, failedMandatorySkills: [], criteria });
    expect(d.outcome).toBe('retake');
  });

  it('suggests drop (via manual_review, never automatic) for a catastrophic score failure', () => {
    const d = decidePromotion({ finalPercentage: 10, hasMissingGrades: false, attendancePercentage: 20, hasFinancialHold: false, failedMandatorySkills: [], criteria });
    expect(d.outcome).toBe('manual_review');
    expect(d.suggestedManualOutcome).toBe('drop');
  });

  it('never returns drop directly — it is not an automated outcome', () => {
    for (const finalPercentage of [0, 5, 10, 20, 30, 100]) {
      const d = decidePromotion({ finalPercentage, hasMissingGrades: false, attendancePercentage: 0, hasFinancialHold: false, failedMandatorySkills: [], criteria });
      expect(d.outcome).not.toBe('drop' as any);
    }
  });
});

describe('Promotion Engine — complete-semester integration', () => {
  it('applies promote through the Enrollment Lifecycle Engine end-to-end', async () => {
    const classId = await createActivatedClass('E2E Promote Class');
    const student = 'pe_stu_e2e_promote';
    const { semesterId, enrollmentId } = seedStudentWithRosterAndEnrollment(student, BRANCH, 'E2E Promote Student', classId);
    const a = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Final', type: 'final', weight: 100 });
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({ grades: [{ assessmentId: a.body.id, studentId: student, score: 90, status: 'graded' }] });

    const res = await supertest(app).post(`/api/classes/${classId}/complete-semester`).set(authHeader(owner)).send({});
    expect(res.status).toBe(200);
    expect(res.body.outcomes.find((o: any) => o.studentId === student).outcome).toBe('promote');

    const semester = db.prepare('SELECT status FROM student_semesters WHERE id = ?').get(semesterId) as any;
    expect(semester.status).toBe('completed');
    const enrollment = getEnrollmentService(db).getById(enrollmentId);
    expect(enrollment.status).toBe('completed');
  });

  it('applies retake through the Enrollment Lifecycle Engine end-to-end', async () => {
    const classId = await createActivatedClass('E2E Retake Class');
    const student = 'pe_stu_e2e_retake';
    const { enrollmentId } = seedStudentWithRosterAndEnrollment(student, BRANCH, 'E2E Retake Student', classId);
    const a = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Final', type: 'final', weight: 100 });
    // Score 45: below the 70 pass mark but above half of it (35), so the
    // promotion engine returns an automatic 'retake' rather than the
    // catastrophic-failure manual_review (see decidePromotion's
    // finalPercentage < minScore / 2 rule).
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({ grades: [{ assessmentId: a.body.id, studentId: student, score: 45, status: 'graded' }] });

    const res = await supertest(app).post(`/api/classes/${classId}/complete-semester`).set(authHeader(owner)).send({});
    expect(res.body.outcomes.find((o: any) => o.studentId === student).outcome).toBe('retake');

    const enrollment = getEnrollmentService(db).getById(enrollmentId);
    expect(enrollment.status).toBe('retake');
  });

  it('a financial hold routes to manual_review and leaves both records untouched, pending a manager', async () => {
    const classId = await createActivatedClass('E2E Hold Class');
    const student = 'pe_stu_e2e_hold';
    const { semesterId, enrollmentId } = seedStudentWithRosterAndEnrollment(student, BRANCH, 'E2E Hold Student', classId);
    db.prepare(`INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, purpose) VALUES (?, ?, 100, 100, 'overdue', ?, '2020-01-01', ?, 'other')`)
      .run(makeId('inv'), student, today(), BRANCH);
    const a = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Final', type: 'final', weight: 100 });
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({ grades: [{ assessmentId: a.body.id, studentId: student, score: 95, status: 'graded' }] });

    const res = await supertest(app).post(`/api/classes/${classId}/complete-semester`).set(authHeader(owner)).send({});
    expect(res.body.pendingReview).toBe(1);

    const semester = db.prepare('SELECT status FROM student_semesters WHERE id = ?').get(semesterId) as any;
    expect(semester.status).toBe('active'); // untouched — awaiting manual review
    const enrollment = getEnrollmentService(db).getById(enrollmentId);
    expect(enrollment.status).toBe('active');

    const pending = await supertest(app).get(`/api/classes/${classId}/promotion/pending-review`).set(authHeader(owner));
    expect(pending.body.pending).toHaveLength(1);
    expect(pending.body.pending[0].studentId).toBe(student);
  });

  it('a manager can resolve a manual_review case with Drop — the one outcome no automated path can produce', async () => {
    const classId = await createActivatedClass('E2E Manual Drop Class');
    const student = 'pe_stu_e2e_drop';
    const { semesterId, enrollmentId } = seedStudentWithRosterAndEnrollment(student, BRANCH, 'E2E Drop Student', classId);
    db.prepare(`INSERT INTO invoices (id, student_id, total_amount, net_amount, status, issue_date, due_date, branch_id, purpose) VALUES (?, ?, 100, 100, 'overdue', ?, '2020-01-01', ?, 'other')`)
      .run(makeId('inv'), student, today(), BRANCH);
    const a = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Final', type: 'final', weight: 100 });
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({ grades: [{ assessmentId: a.body.id, studentId: student, score: 95, status: 'graded' }] });
    await supertest(app).post(`/api/classes/${classId}/complete-semester`).set(authHeader(owner)).send({});

    const resolve = await supertest(app).post(`/api/classes/${classId}/promotion/resolve/${student}`).set(authHeader(owner)).send({ outcome: 'drop', reason: 'Left the country' });
    expect(resolve.status).toBe(200);

    const semester = db.prepare('SELECT status FROM student_semesters WHERE id = ?').get(semesterId) as any;
    expect(semester.status).toBe('deferred');
    const enrollment = getEnrollmentService(db).getById(enrollmentId);
    expect(enrollment.status).toBe('dropped');
  });

  it('rejects resolving a case that is not actually pending review', async () => {
    const classId = await createActivatedClass('E2E Already Resolved Class');
    const student = 'pe_stu_e2e_resolved';
    seedStudentWithRosterAndEnrollment(student, BRANCH, 'Already Resolved Student', classId);
    const a = await supertest(app).post(`/api/classes/${classId}/assessments`).set(authHeader(owner)).send({ title: 'Final', type: 'final', weight: 100 });
    await supertest(app).put(`/api/classes/${classId}/grades`).set(authHeader(owner)).send({ grades: [{ assessmentId: a.body.id, studentId: student, score: 90, status: 'graded' }] });
    await supertest(app).post(`/api/classes/${classId}/complete-semester`).set(authHeader(owner)).send({}); // -> promote, already resolved

    const resolve = await supertest(app).post(`/api/classes/${classId}/promotion/resolve/${student}`).set(authHeader(owner)).send({ outcome: 'drop' });
    expect(resolve.status).toBe(409);
  });
});
