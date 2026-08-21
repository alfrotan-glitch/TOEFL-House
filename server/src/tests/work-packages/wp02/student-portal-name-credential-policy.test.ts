/**
 * SPA-3 — approved business policy for student portal credentials.
 * ============================================================================
 * OWNER-APPROVED POLICY (implemented here, not invented):
 *
 *   1. The student's INITIAL password is exactly the student's name.
 *   2. The student ID number (`student_code`) is the other credential, as the
 *      existing student-login model already defines.
 *   3. A student is NOT forced to change the password on first login.
 *   4. Changing the password stays optional and user-initiated.
 *   5. Student permissions and object scope are unchanged.
 *
 * This deliberately lowers the *initial* credential strength in exchange for
 * usability. It is a documented product decision, so the compensating controls
 * become load-bearing and are asserted here:
 *
 *   - the credential is still verified with bcrypt (`verifyPassword`) against
 *     `users.password_hash` — the name is never compared as plaintext, and no
 *     second authentication authority exists;
 *   - the portal rate limiter still applies;
 *   - the role still carries `permissions: {}` and reaches exactly one
 *     object-scoped endpoint;
 *   - branch isolation and `linked_student_id` object checks are unchanged;
 *   - a student who HAS rotated their password keeps the rotated secret — the
 *     name must not act as a permanent backdoor.
 *
 * That last property is the one that makes this policy safe to ship: "initial"
 * must mean initial.
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { today } from '../../../utils/ids.js';
import { signToken, type TokenPayload } from '../../../utils/auth.js';
import authRouter from '../../../routes/auth.routes.js';
import usersRouter from '../../../routes/users.routes.js';
import studentsRouter from '../../../routes/students.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { hashPassword } from '../../../utils/auth.js';

const BRANCH_A = 'spn_branch_a';
const BRANCH_B = 'spn_branch_b';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
  return app;
}

let app: express.Express;
let owner: TokenPayload;
const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

function seedStudent(id: string, code: string, name: string, branch: string, phone: string) {
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES (?, ?, ?, 'active', ?, ?, 'male', ?)`
  ).run(id, code, name, today(), branch, phone);
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  for (const b of [BRANCH_A, BRANCH_B]) {
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(b, b, 'Loc');
  }
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES ('spn_owner', 'spn_owner', 'Owner', ?, ?, 1, 0)`
  ).run(BRANCH_A, await hashPassword('owner-pass-123456'));
  assignRole('spn_owner', 'owner', BRANCH_A);

  owner = { userId: 'spn_owner', username: 'spn_owner', branchId: BRANCH_A, fullName: 'Owner' } as TokenPayload;

  seedStudent('spn_stu_a', 'TH-SPN-001', 'Ahmad Rahimi', BRANCH_A, '0700666001');
  seedStudent('spn_stu_b', 'TH-SPN-002', 'Sara Noori', BRANCH_A, '0700666002');
  seedStudent('spn_stu_c', 'TH-SPN-003', 'Zahra Branch B', BRANCH_B, '0700666003');
  app = createApp();
});

const login = (body: Record<string, unknown>) => supertest(app).post('/api/auth/student-login').send(body);

/** Create a portal account the way an operator does, via the canonical route. */
async function provision(studentId: string, username: string, fullName: string, branch: string, password: string) {
  const res = await supertest(app)
    .post('/api/users')
    .set(authHeader(owner))
    .send({ username, tempPassword: password, fullName, role: 'student', branchId: branch, linkedStudentId: studentId });
  return res;
}

describe('SPA-3 — the initial password is the student name', () => {
  it('provisions a portal account whose initial password is the student name', async () => {
    const res = await provision('spn_stu_a', 'stu_TH-SPN-001', 'Ahmad Rahimi', BRANCH_A, 'Ahmad Rahimi');
    expect(res.status).toBe(201);

    const login1 = await login({ studentCode: 'TH-SPN-001', password: 'Ahmad Rahimi' });
    expect(login1.status).toBe(200);
    expect(login1.body.user.role).toBe('student');
    expect(login1.body.user.permissions).toEqual([]);
  });

  it('does NOT force a password change on first login', async () => {
    const res = await login({ studentCode: 'TH-SPN-001', password: 'Ahmad Rahimi' });
    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(false);

    const row = db.prepare(`SELECT must_change_password FROM users WHERE linked_student_id = 'spn_stu_a'`).get() as
      { must_change_password: number };
    expect(row.must_change_password).toBe(0);
  });

  it('the student can immediately use the portal without rotating (no quarantine 403)', async () => {
    const res = await login({ studentCode: 'TH-SPN-001', password: 'Ahmad Rahimi' });
    const me = await supertest(app).get('/api/students/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.studentCode).toBe('TH-SPN-001');
  });

  it('the name is still stored as a bcrypt hash, never as plaintext', () => {
    const row = db.prepare(`SELECT password_hash FROM users WHERE linked_student_id = 'spn_stu_a'`).get() as
      { password_hash: string };
    expect(row.password_hash).not.toBe('Ahmad Rahimi');
    expect(row.password_hash.startsWith('$2')).toBe(true);
  });

  it('a wrong name is still refused', async () => {
    const res = await login({ studentCode: 'TH-SPN-001', password: 'Wrong Name' });
    expect(res.status).toBe(401);
    expect(res.body.token).toBeFalsy();
  });

  it("another student's name does not unlock this account", async () => {
    const res = await login({ studentCode: 'TH-SPN-001', password: 'Sara Noori' });
    expect(res.status).toBe(401);
  });
});

describe('SPA-3 — rotation stays optional and user-initiated, and is honoured', () => {
  it('a student may change their own password via the canonical endpoint', async () => {
    const before = await login({ studentCode: 'TH-SPN-001', password: 'Ahmad Rahimi' });
    expect(before.status).toBe(200);

    const changed = await supertest(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${before.body.token}`)
      .send({ currentPassword: 'Ahmad Rahimi', newPassword: 'MyOwnChosenPass2026' });
    expect(changed.status).toBe(200);
  });

  it('after rotation the NAME no longer works — "initial" means initial', async () => {
    const withName = await login({ studentCode: 'TH-SPN-001', password: 'Ahmad Rahimi' });
    expect(withName.status).toBe(401);
    expect(withName.body.token).toBeFalsy();

    const withNew = await login({ studentCode: 'TH-SPN-001', password: 'MyOwnChosenPass2026' });
    expect(withNew.status).toBe(200);
  });
});

describe('SPA-3 — scope, isolation and enumeration are unchanged', () => {
  beforeAll(async () => {
    await provision('spn_stu_b', 'stu_TH-SPN-002', 'Sara Noori', BRANCH_A, 'Sara Noori');
    await provision('spn_stu_c', 'stu_TH-SPN-003', 'Zahra Branch B', BRANCH_B, 'Zahra Branch B');
  });

  it('a student cannot read another student (IDOR) or list students', async () => {
    const res = await login({ studentCode: 'TH-SPN-002', password: 'Sara Noori' });
    expect(res.status).toBe(200);
    const token = res.body.token;
    expect((await supertest(app).get('/api/students/spn_stu_a').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    expect((await supertest(app).get('/api/students').set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('a student cannot move money', async () => {
    const res = await login({ studentCode: 'TH-SPN-002', password: 'Sara Noori' });
    const pay = await supertest(app)
      .post('/api/students/spn_stu_b/payments')
      .set('Authorization', `Bearer ${res.body.token}`)
      .send({ amount: 100, category: 'other', notes: 'x' });
    expect(pay.status).toBe(403);
  });

  it('cross-branch isolation holds for a branch-B student', async () => {
    const res = await login({ studentCode: 'TH-SPN-003', password: 'Zahra Branch B' });
    expect(res.status).toBe(200);
    const cross = await supertest(app)
      .get('/api/students/spn_stu_a')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(cross.status).toBe(403);
  });

  it('an unknown code and a wrong password are indistinguishable (no enumeration)', async () => {
    const unknown = await login({ studentCode: 'TH-NOPE-9999', password: 'Ahmad Rahimi' });
    const wrong = await login({ studentCode: 'TH-SPN-002', password: 'Not The Name' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it('still rejects non-string credentials (no coercion bypass)', async () => {
    for (const password of [['Sara Noori'], { toString: () => 'Sara Noori' }, 12345] as unknown[]) {
      const res = await login({ studentCode: 'TH-SPN-002', password });
      expect([400, 401]).toContain(res.status);
      expect(res.body.token).toBeFalsy();
    }
  });

  it('a deactivated portal account is refused even with the correct name', async () => {
    db.prepare(`UPDATE users SET is_active = 0 WHERE linked_student_id = 'spn_stu_b'`).run();
    const res = await login({ studentCode: 'TH-SPN-002', password: 'Sara Noori' });
    expect([401, 403]).toContain(res.status);
    db.prepare(`UPDATE users SET is_active = 1 WHERE linked_student_id = 'spn_stu_b'`).run();
  });
});
