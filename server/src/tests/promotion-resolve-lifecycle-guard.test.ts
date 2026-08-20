/**
 * SSL-1 — Manual promotion review must respect the class lifecycle.
 * ============================================================================
 * `POST /api/classes/:id/promotion/resolve/:studentId` is the ONLY path that
 * may apply a manual promotion outcome, and it writes
 * `student_semesters.status` — the column `getStudentBalance(db, id, 'active')`
 * sums tuition over, which `checkAcademicHold()` uses to block a new
 * enrolment while a student still owes money.
 *
 * The endpoint validated the *semester* ("is it still pending?") but never the
 * *class*, so a promotion could be "resolved" for a class that had never been
 * completed at all — including `draft`, `enrollment_open` and `cancelled`
 * classes, where no promotion decision exists to review.
 *
 * Reproduced live on a fresh database before the fix (HTTP, not SQL):
 *
 *   stage=draft            HTTP 200  semester_now=completed
 *   stage=scheduled        HTTP 200  semester_now=completed
 *   stage=enrollment_open  HTTP 200  semester_now=completed
 *   stage=in_progress      HTTP 200  semester_now=completed
 *   stage=grading          HTTP 200  semester_now=completed
 *   stage=completed        HTTP 200  semester_now=completed   <- legitimate
 *   stage=archived         HTTP 200  semester_now=completed   <- legitimate
 *   stage=cancelled        HTTP 200  semester_now=completed
 *
 * The financial consequence, also reproduced live end-to-end:
 *
 *   POST /students/:id/enroll-semester  -> 403 "Academic Hold: ... 20000 AFN"
 *   POST /classes/:id/promotion/resolve -> 200  (class still in `draft`)
 *   POST /students/:id/enroll-semester  -> 201  (hold gone, 40,000 still owed)
 *
 * Flipping the semester out of 'active' removes it from the active-scope
 * balance, so the debt stops counting against the hold while remaining owed in
 * the lifetime scope. That is debt laundering through an academic endpoint.
 *
 * The read counterpart `GET /:id/promotion/pending-review` already refuses to
 * report anything before the class is locked (`completed`/`archived`). These
 * tests hold the write path to exactly the same authority.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import classesRouter from '../routes/classes.routes.js';
import studentsRouter from '../routes/students.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { deriveCoarseClassStatus, type ClassStage } from '../core/academic/lifecycle-engine.js';
import { getStudentBalance } from '../utils/studentBalance.js';

const BRANCH = 'prl_branch';
const OTHER_BRANCH = 'prl_branch_other';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/classes', classesRouter);
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
  return app;
}

function authHeader(user: TokenPayload) {
  return { Authorization: `Bearer ${signToken(user)}` };
}

let app: express.Express;
let hod: TokenPayload;
let otherHod: TokenPayload;

/** A class parked directly at `stage`, plus a student holding one unpaid
 *  ACTIVE semester in it. Mirrors the real shape: fee owed, nothing paid. */
function seedCase(key: string, stage: ClassStage, branchId = BRANCH) {
  const classId = `prl_c_${key}`;
  const studentId = `prl_s_${key}`;
  const semesterId = `prl_sem_${key}`;
  db.prepare(
    `INSERT OR IGNORE INTO classes (id, name, level, branch_id, status, lifecycle_stage, capacity, fee)
     VALUES (?, ?, 'A1', ?, ?, ?, 10, 20000)`
  ).run(classId, `Class ${key}`, branchId, deriveCoarseClassStatus(stage), stage);
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES (?, ?, ?, 'active', ?, ?, 'male', ?)`
  ).run(studentId, `TH-PRL-${key}`, `Student ${key}`, today(), branchId, `0700${key.padStart(6, '0').slice(0, 6)}`);
  db.prepare(
    `INSERT OR IGNORE INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, fee_amount, net_fee_amount, status)
     VALUES (?, ?, 'Term 1', ?, ?, 20000, 20000, 'active')`
  ).run(semesterId, studentId, classId, today());
  return { classId, studentId, semesterId };
}

function semesterStatus(semesterId: string): string {
  return (db.prepare('SELECT status FROM student_semesters WHERE id = ?').get(semesterId) as { status: string }).status;
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'PRL Branch', 'Loc');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(OTHER_BRANCH, 'PRL Other', 'Loc');
  const hash = await hashPassword('testpass123');
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`
  ).run('u_prl_hod', 'prl_hod', 'PRL HOD', BRANCH, hash);
  assignRole('u_prl_hod', 'head_of_department', BRANCH);
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`
  ).run('u_prl_hod_other', 'prl_hod_other', 'PRL HOD Other', OTHER_BRANCH, hash);
  assignRole('u_prl_hod_other', 'head_of_department', OTHER_BRANCH);

  hod = { userId: 'u_prl_hod', username: 'prl_hod', branchId: BRANCH, fullName: 'PRL HOD' } as TokenPayload;
  otherHod = { userId: 'u_prl_hod_other', username: 'prl_hod_other', branchId: OTHER_BRANCH, fullName: 'PRL HOD Other' } as TokenPayload;
  app = createApp();
});

describe('SSL-1 — promotion/resolve is refused before the class is locked', () => {
  // Every stage that is NOT a finished class. A manual review cannot exist
  // for these: no promotion decision has been computed yet.
  const PREMATURE: ClassStage[] = ['draft', 'scheduled', 'enrollment_open', 'in_progress', 'grading', 'cancelled'];

  for (const stage of PREMATURE) {
    it(`refuses to resolve a promotion while the class is '${stage}' (was HTTP 200 + semester flipped)`, async () => {
      const { classId, studentId, semesterId } = seedCase(`p_${stage}`, stage);
      const res = await supertest(app)
        .post(`/api/classes/${classId}/promotion/resolve/${studentId}`)
        .set(authHeader(hod))
        .send({ outcome: 'promote', reason: 'attempted early resolve' });

      expect(res.status).toBe(409);
      // DB state, not just the status code: the semester must be untouched.
      expect(semesterStatus(semesterId)).toBe('active');
    });
  }

  // The legitimate window stays open — this fix must not break real usage.
  for (const stage of ['completed', 'archived'] as ClassStage[]) {
    it(`still allows a genuine manual review when the class is '${stage}'`, async () => {
      const { classId, studentId, semesterId } = seedCase(`ok_${stage}`, stage);
      const res = await supertest(app)
        .post(`/api/classes/${classId}/promotion/resolve/${studentId}`)
        .set(authHeader(hod))
        .send({ outcome: 'promote', reason: 'genuine review' });

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe('promote');
      expect(semesterStatus(semesterId)).toBe('completed');
    });
  }
});

describe('SSL-1 — the financial consequence is closed', () => {
  it('cannot launder an academic hold by resolving a promotion on an unfinished class', async () => {
    const { classId, studentId, semesterId } = seedCase('launder', 'draft');
    // A destination class the student would enrol into next.
    db.prepare(
      `INSERT OR IGNORE INTO classes (id, name, level, branch_id, status, lifecycle_stage, capacity, fee)
       VALUES (?, ?, 'A2', ?, 'active', 'in_progress', 10, 20000)`
    ).run('prl_c_next', 'Next Class', BRANCH);

    // The debt is real and the hold is enforced.
    expect(getStudentBalance(db, studentId, 'active').outstanding).toBe(20000);
    const blocked = await supertest(app)
      .post(`/api/students/${studentId}/enroll-semester`)
      .set(authHeader(hod))
      .send({ semesterName: 'Term 2', classId: 'prl_c_next', tuitionAmount: 20000 });
    expect(blocked.status).toBe(403);
    expect(String(blocked.body.error)).toContain('Academic Hold');

    // The laundering attempt must fail...
    const launder = await supertest(app)
      .post(`/api/classes/${classId}/promotion/resolve/${studentId}`)
      .set(authHeader(hod))
      .send({ outcome: 'promote', reason: 'launder' });
    expect(launder.status).toBe(409);

    // ...so the semester, the balance and the hold are all unchanged.
    expect(semesterStatus(semesterId)).toBe('active');
    expect(getStudentBalance(db, studentId, 'active').outstanding).toBe(20000);
    const stillBlocked = await supertest(app)
      .post(`/api/students/${studentId}/enroll-semester`)
      .set(authHeader(hod))
      .send({ semesterName: 'Term 2', classId: 'prl_c_next', tuitionAmount: 20000 });
    expect(stillBlocked.status).toBe(403);
  });
});

describe('SSL-1 — surrounding authority is preserved', () => {
  it('keeps refusing an already-resolved semester (409), independent of the new guard', async () => {
    const { classId, studentId, semesterId } = seedCase('twice', 'completed');
    const first = await supertest(app)
      .post(`/api/classes/${classId}/promotion/resolve/${studentId}`)
      .set(authHeader(hod))
      .send({ outcome: 'promote', reason: 'first' });
    expect(first.status).toBe(200);
    expect(semesterStatus(semesterId)).toBe('completed');

    const second = await supertest(app)
      .post(`/api/classes/${classId}/promotion/resolve/${studentId}`)
      .set(authHeader(hod))
      .send({ outcome: 'retake', reason: 'second' });
    expect(second.status).toBe(409);
    // The winning outcome is not overwritten by the loser.
    expect(semesterStatus(semesterId)).toBe('completed');
  });

  it('keeps enforcing cross-branch isolation on the resolve path', async () => {
    const { classId, studentId, semesterId } = seedCase('xbranch', 'completed');
    const res = await supertest(app)
      .post(`/api/classes/${classId}/promotion/resolve/${studentId}`)
      .set(authHeader(otherHod))
      .send({ outcome: 'promote', reason: 'cross branch' });
    expect(res.status).toBe(403);
    expect(semesterStatus(semesterId)).toBe('active');
  });

  it('records operator attribution for a legitimate resolve', async () => {
    const { classId, studentId } = seedCase('audit', 'completed');
    const res = await supertest(app)
      .post(`/api/classes/${classId}/promotion/resolve/${studentId}`)
      .set(authHeader(hod))
      .send({ outcome: 'conditional_pass', reason: 'audit attribution' });
    expect(res.status).toBe(200);

    const entry = db
      .prepare(
        `SELECT * FROM audit_logs WHERE action LIKE ? ORDER BY rowid DESC LIMIT 1`
      )
      .get(`%${studentId}%`) as { user_name?: string; action?: string } | undefined;
    expect(entry).toBeTruthy();
    expect(String(entry?.action)).toContain('conditional_pass');
  });
});

describe('SSL-1 — concurrency: two operators resolving the same semester', () => {
  it('only one resolve wins; the semester is never double-transitioned', async () => {
    const { classId, studentId, semesterId } = seedCase('race', 'completed');
    const [a, b] = await Promise.all([
      supertest(app)
        .post(`/api/classes/${classId}/promotion/resolve/${studentId}`)
        .set(authHeader(hod))
        .send({ outcome: 'promote', reason: 'racer A' }),
      supertest(app)
        .post(`/api/classes/${classId}/promotion/resolve/${studentId}`)
        .set(authHeader(hod))
        .send({ outcome: 'retake', reason: 'racer B' }),
    ]);

    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);
    // Exactly one transition happened, and it is a legal terminal value.
    expect(['completed', 'deferred']).toContain(semesterStatus(semesterId));
  });
});
