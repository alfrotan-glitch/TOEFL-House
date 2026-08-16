/**
 * A teacher may only act on the classes they actually teach.
 * ============================================================================
 * F-6 HIGH (proven live over HTTP, 2026-08-16 second audit pass):
 *
 *   Two teachers in the SAME branch. A user account linked to teacher A sent
 *
 *     PUT /api/classes/<class taught by teacher B>/grades
 *     { grades: [{ assessmentId, studentId, score: 99, notes: "forged" }] }
 *
 *   and received 200 {ok:true,count:1}. The row persisted in student_grades
 *   with graded_by set to teacher A's user id. Teacher A could also read the
 *   whole colleague gradebook, its per-student edit history, and lifecycle.
 *
 * Root cause: `requireClass()` authorized on BRANCH only. Colleagues share a
 * branch, so the check passed. `canAccessClass`/`assertClassAccess` had been
 * written in core/rbac/abac.ts for exactly this rule and were never called by
 * any route — the module was reachable only from a unit test, which passed and
 * created the impression the rule was enforced. Meanwhile sessions.routes.ts
 * DID enforce ownership (assertCanMarkSession), so the two halves of the same
 * teaching workflow disagreed: a teacher could not mark a colleague's
 * attendance but could rewrite their grades.
 *
 * Fix: requireClass() now applies assertClassAccess() whenever the caller is
 * class-scoped, so every current and future class endpoint inherits the rule
 * instead of each one having to remember it.
 *
 * These tests drive real HTTP through the real router, because the pre-existing
 * unit test on canAccessClass passed throughout the vulnerable period.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import classesRouter from '../routes/classes.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { today } from '../utils/ids.js';

const BRANCH = 'cto_branch';
const T_OWN = 'cto_teacher_own';    // teacher who owns CLASS_OWN
const T_OTHER = 'cto_teacher_other'; // colleague who owns CLASS_OTHER
const CLASS_OWN = 'cto_class_own';
const CLASS_OTHER = 'cto_class_other';
const ASSESSMENT = 'cto_assessment_other'; // belongs to CLASS_OTHER
const STUDENT = 'cto_student';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/classes', classesRouter);
  app.use(errorHandler);
  return app;
}

const token = (userId: string, role: string) =>
  `Bearer ${signToken({ userId, username: userId, role, branchId: BRANCH, fullName: userId } as TokenPayload)}`;

let app: express.Express;

beforeEach(async () => {
  initSchema();
  bootstrapRbacCatalog(db);

  db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'Loc')`).run(BRANCH, BRANCH);

  const pw = await hashPassword('x');
  const mkTeacher = (id: string, phone: string) =>
    db.prepare(
      `INSERT OR REPLACE INTO teachers (id, full_name, phone, branch_id, status, joined_date)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    ).run(id, id, phone, BRANCH, today());
  mkTeacher(T_OWN, '0700110001');
  mkTeacher(T_OTHER, '0700110002');

  // Two teacher users, each linked to their own teacher profile, same branch.
  const mkUser = (id: string, role: string, linkedTeacher: string | null) =>
    db.prepare(
      `INSERT OR REPLACE INTO users
         (id, username, full_name, role, branch_id, password_hash, linked_teacher_id, is_active, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`,
    ).run(id, id, id, role, BRANCH, pw, linkedTeacher);
  mkUser('cto_u_own', 'teacher', T_OWN);
  mkUser('cto_u_other', 'teacher', T_OTHER);
  mkUser('cto_u_manager', 'manager', null);
  syncLegacyUserRoles(db);

  const mkClass = (id: string, teacher: string) =>
    db.prepare(
      `INSERT OR REPLACE INTO classes (id, name, teacher_id, branch_id, level, capacity, schedule_time, start_date, end_date, fee, status)
       VALUES (?, ?, ?, ?, 'A1', 10, '08:00', ?, '2026-12-01', 5000, 'active')`,
    ).run(id, id, teacher, BRANCH, today());
  mkClass(CLASS_OWN, T_OWN);
  mkClass(CLASS_OTHER, T_OTHER);

  db.prepare(
    `INSERT OR REPLACE INTO students (id, student_code, full_name, gender, phone, status, registration_date, branch_id)
     VALUES (?, 'CTO-1', 'Victim Student', 'male', '0700110009', 'active', ?, ?)`,
  ).run(STUDENT, today(), BRANCH);

  db.prepare(
    `INSERT OR REPLACE INTO class_assessments (id, class_id, title, type, weight, max_score, date, lock_status)
     VALUES (?, ?, 'Victim Exam', 'quiz', 50, 100, '2026-03-01', 'draft')`,
  ).run(ASSESSMENT, CLASS_OTHER);

  db.prepare(`DELETE FROM student_grades WHERE assessment_id = ?`).run(ASSESSMENT);

  app = createApp();
});

const forgery = {
  grades: [{ assessmentId: ASSESSMENT, studentId: STUDENT, score: 99, status: 'graded', notes: 'forged' }],
};

describe('F-6: a teacher cannot reach a colleague\'s class', () => {
  it('THE EXPLOIT: writing grades into another teacher\'s class is refused', async () => {
    const res = await supertest(app)
      .put(`/api/classes/${CLASS_OTHER}/grades`)
      .set('Authorization', token('cto_u_own', 'teacher'))
      .send(forgery);

    expect(res.status).toBe(403);

    // The database is the real assertion: a 403 that still wrote is not a fix.
    const row = db.prepare(
      'SELECT score FROM student_grades WHERE assessment_id = ? AND student_id = ?',
    ).get(ASSESSMENT, STUDENT);
    expect(row, 'no grade row may exist after a refused write').toBeUndefined();
  });

  it('reading another teacher\'s gradebook, history and lifecycle is refused', async () => {
    for (const path of [
      `/api/classes/${CLASS_OTHER}/gradebook`,
      `/api/classes/${CLASS_OTHER}/gradebook/history`,
      `/api/classes/${CLASS_OTHER}/lifecycle`,
    ]) {
      const res = await supertest(app).get(path).set('Authorization', token('cto_u_own', 'teacher'));
      expect(res.status, `${path} must be refused`).toBe(403);
    }
  });

  it('the teacher keeps full access to their OWN class (no over-blocking)', async () => {
    const read = await supertest(app)
      .get(`/api/classes/${CLASS_OWN}/gradebook`)
      .set('Authorization', token('cto_u_own', 'teacher'));
    expect(read.status).toBe(200);

    const own = db.prepare(
      `INSERT OR REPLACE INTO class_assessments (id, class_id, title, type, weight, max_score, date, lock_status)
       VALUES ('cto_assessment_own', ?, 'Own Exam', 'quiz', 50, 100, '2026-03-01', 'draft')`,
    );
    own.run(CLASS_OWN);
    db.prepare(
      `INSERT OR REPLACE INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, status)
       VALUES ('cto_ss1', ?, 'S1', ?, ?, 'active')`,
    ).run(STUDENT, CLASS_OWN, today());

    const write = await supertest(app)
      .put(`/api/classes/${CLASS_OWN}/grades`)
      .set('Authorization', token('cto_u_own', 'teacher'))
      .send({ grades: [{ assessmentId: 'cto_assessment_own', studentId: STUDENT, score: 88, status: 'graded' }] });
    expect(write.status).toBe(200);

    const row = db.prepare(
      `SELECT score FROM student_grades WHERE assessment_id = 'cto_assessment_own' AND student_id = ?`,
    ).get(STUDENT) as { score: number } | undefined;
    expect(row?.score).toBe(88);
  });

  it('the owning teacher of the target class can still grade it', async () => {
    const res = await supertest(app)
      .put(`/api/classes/${CLASS_OTHER}/grades`)
      .set('Authorization', token('cto_u_other', 'teacher'))
      .send({ grades: [{ assessmentId: ASSESSMENT, studentId: STUDENT, score: 70, status: 'graded' }] });
    expect(res.status).toBe(200);
  });

  it('a manager is branch-scoped, not class-scoped, and keeps access to both classes', async () => {
    for (const c of [CLASS_OWN, CLASS_OTHER]) {
      const res = await supertest(app)
        .get(`/api/classes/${c}/gradebook`)
        .set('Authorization', token('cto_u_manager', 'manager'));
      expect(res.status, `manager must still read ${c}`).toBe(200);
    }
    const write = await supertest(app)
      .put(`/api/classes/${CLASS_OTHER}/grades`)
      .set('Authorization', token('cto_u_manager', 'manager'))
      .send({ grades: [{ assessmentId: ASSESSMENT, studentId: STUDENT, score: 55, status: 'graded' }] });
    expect(write.status).toBe(200);
  });

  it('a teacher account with no linked teacher profile cannot grade anything', async () => {
    db.prepare(`UPDATE users SET linked_teacher_id = NULL WHERE id = 'cto_u_own'`).run();
    const res = await supertest(app)
      .put(`/api/classes/${CLASS_OWN}/grades`)
      .set('Authorization', token('cto_u_own', 'teacher'))
      .send({ grades: [] });
    expect(res.status).toBe(403);
  });
});
