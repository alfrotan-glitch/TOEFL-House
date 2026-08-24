/**
 * Class Capacity — single source of truth regression suite
 * ============================================================================
 * Locks in the invariant established in the capacity unification:
 *
 *   A student occupies a class seat iff they have an `enrollments` row in
 *   status active/confirmed/pending for the class (core/academic/class-capacity.ts).
 *   `student_semesters` is a DERIVED projection — it never grants a seat and
 *   is never used for capacity decisions.
 *
 * Also verifies the single-writer rule: EnrollmentService.enroll() creates
 * both rows atomically, and the route-level enroll paths (visitor conversion,
 * manual student registration) never duplicate the projection row.
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { id, today } from '../../../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { countActiveStudentsInClass } from '../../../core/academic/class-capacity.js';
import { getEnrollmentService } from '../../../core/academic/enrollment-service.js';
import { studentsRouter } from '../../../routes/students.routes.js';
import { visitorsRouter } from '../../../routes/visitors.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';

const BRANCH = 'cap_branch';
let classCounter = 0;

function freshClass(capacity = 10): string {
  classCounter += 1;
  const classId = `cap_class_${classCounter}`;
  db.prepare(`INSERT OR IGNORE INTO classes (id, name, branch_id, capacity, status, lifecycle_stage, level, fee) VALUES (?, ?, ?, ?, 'active', 'activated', 'A1', 5000)`)
    .run(classId, `Capacity Class ${classCounter}`, BRANCH, capacity);
  return classId;
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use('/api/visitors', visitorsRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId, username: overrides.username || overrides.userId, branchId: overrides.branchId || BRANCH, fullName: 'Cap Test User',
  };
}
function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}

let app: express.Express;
let registrar: TokenPayload;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Cap Branch', 'Loc');
  db.prepare(`
    INSERT OR REPLACE INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active)
    VALUES ('cap_registration_fee', ?, 'registration', 'Registration fee', 1500, 1, 1)
  `).run(BRANCH);
  await db.prepare(`INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password ) VALUES (?, ?, ?, ?, ?, 1, 0)`)
    .run('u_cap_reg', 'cap_reg', 'Cap Registrar', BRANCH, await hashPassword('x'));
  assignRole('u_cap_reg', 'registrar', BRANCH);

  registrar = makeUser({ userId: 'u_cap_reg', branchId: BRANCH });
  app = createApp();
});

function seedStudent(studentId: string, branchId = BRANCH): void {
  db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender) VALUES (?, ?, ?, 'active', ?, ?, 'male')`)
    .run(studentId, `TH-CAP-${studentId.slice(-4)}`, 'Cap Student', today(), branchId);
}

describe('countActiveStudentsInClass — authoritative seat rule', () => {
  it('a semester row WITHOUT an enrollment occupies no seat', () => {
    const classId = freshClass();
    const s = id('stu');
    seedStudent(s);
    db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date) VALUES (?, ?, 'Term', ?, ?)`)
      .run(id('sem'), s, classId, today());
    expect(countActiveStudentsInClass(db, classId)).toBe(0);
  });

  it('an active/pending enrollment occupies a seat; completed does not', () => {
    const classId = freshClass(10);
    const s1 = id('stu'); seedStudent(s1);
    getEnrollmentService(db).enroll({ studentId: s1, branchId: BRANCH, classId, enrollmentType: 'new', startedAt: today() });
    expect(countActiveStudentsInClass(db, classId)).toBe(1);

    const s2 = id('stu'); seedStudent(s2);
    db.prepare(`INSERT INTO enrollments (id, student_id, class_id, branch_id, enrollment_type, status, started_at) VALUES (?, ?, ?, ?, 'new', 'completed', ?)`)
      .run(id('enr'), s2, classId, BRANCH, today());
    expect(countActiveStudentsInClass(db, classId)).toBe(1); // completed does not hold a seat

    const s3 = id('stu'); seedStudent(s3);
    db.prepare(`INSERT INTO enrollments (id, student_id, class_id, branch_id, enrollment_type, status, started_at) VALUES (?, ?, ?, ?, 'new', 'pending', ?)`)
      .run(id('enr'), s3, classId, BRANCH, today());
    expect(countActiveStudentsInClass(db, classId)).toBe(2); // pending holds a seat
  });
});

describe('EnrollmentService.enroll — single writer of the projection', () => {
  it('creates the enrollments row AND exactly one student_semesters row atomically', () => {
    const classId = freshClass(10);
    const s = id('stu');
    seedStudent(s);
    const result = getEnrollmentService(db).enroll({ studentId: s, branchId: BRANCH, classId, semesterName: 'Atomic Term', enrollmentType: 'new', startedAt: today(), autoInvoice: false });
    const enrollment = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(result.enrollmentId) as any;
    expect(enrollment.status).toBe('active');
    const semesters = db.prepare('SELECT * FROM student_semesters WHERE student_id = ? AND class_id = ?').all(s, classId) as any[];
    expect(semesters).toHaveLength(1);
    expect(semesters[0].semester_name).toBe('Atomic Term');
  });

  it('writeSemester:false skips the projection (caller owns it)', () => {
    const classId = freshClass(10);
    const s = id('stu');
    seedStudent(s);
    db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date) VALUES (?, ?, 'Owned', ?, ?)`)
      .run(id('sem'), s, classId, today());
    const result = getEnrollmentService(db).enroll({ studentId: s, branchId: BRANCH, classId, enrollmentType: 'new', startedAt: today(), writeSemester: false });
    expect(result.enrollmentId).toBeTruthy();
    const semesters = db.prepare('SELECT * FROM student_semesters WHERE student_id = ? AND class_id = ?').all(s, classId) as any[];
    expect(semesters).toHaveLength(1);
  });
});

describe('Route-level capacity enforcement — HTTP', () => {
  it('manual student admission does NOT consume a seat in a full class; enrollment remains a later step', async () => {
    const classId = freshClass(1);
    const filler = id('stu'); seedStudent(filler);
    getEnrollmentService(db).enroll({ studentId: filler, branchId: BRANCH, classId, enrollmentType: 'new', startedAt: today() });
    expect(countActiveStudentsInClass(db, classId)).toBe(1);

    const res = await supertest(app).post('/api/students/manual').set(authHeader(registrar)).send({
      fullName: 'Admission Only', phone: '0799888777', gender: 'male', branchId: BRANCH, classId,
    });
    expect(res.status).toBe(201);
    expect((db.prepare('SELECT id FROM students WHERE id = ?').get(res.body.id) as { id: string } | undefined)?.id).toBe(res.body.id);
    expect(countActiveStudentsInClass(db, classId)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS c FROM enrollments WHERE student_id = ?').get(res.body.id) as { c: number }).toMatchObject({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM student_semesters WHERE student_id = ?').get(res.body.id) as { c: number }).toMatchObject({ c: 0 });
  });

  it('visitor conversion is admission-only and leaves class capacity untouched until later enrollment', async () => {
    const classId = freshClass(10);
    db.prepare(`
      INSERT OR REPLACE INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active)
      VALUES ('cap_route_registration_fee', ?, 'registration', 'Registration fee', 0, 1, 1)
    `).run(BRANCH);
    const v = id('v');
    db.prepare(`INSERT INTO visitors (id, serial_no, full_name, phone, gender, source, visit_date, status, branch_id, interested_course) VALUES (?, ?, 'Cap Visitor', '0700111222', 'male', 'social', ?, 'visited', ?, 'TOEFL')`)
      .run(v, `V-${Date.now()}`, today(), BRANCH);

    const res = await supertest(app).post(`/api/visitors/${v}/convert`).set(authHeader(registrar)).send({ classId });
    expect(res.status).toBe(201);
    const studentId = res.body.studentId as string;
    const enrollments = db.prepare('SELECT * FROM enrollments WHERE student_id = ? AND class_id = ?').all(studentId, classId) as any[];
    const semesters = db.prepare('SELECT * FROM student_semesters WHERE student_id = ? AND class_id = ?').all(studentId, classId) as any[];
    expect(enrollments).toHaveLength(0);
    expect(semesters).toHaveLength(0);
    expect(countActiveStudentsInClass(db, classId)).toBe(0);
  });
});
