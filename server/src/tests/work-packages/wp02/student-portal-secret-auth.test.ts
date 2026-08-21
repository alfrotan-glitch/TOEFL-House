/**
 * SPA-1 — the student portal must authenticate with a real secret.
 * ============================================================================
 * BEFORE: `POST /api/auth/student-login` accepted `studentCode + fullName`.
 * Neither is a secret — `student_code` comes from a sequential counter
 * (`utils/receipt.ts` -> `student_code_counter`, base 1000) and a student's
 * full name is public to classmates and staff. Anyone who knew a classmate's
 * name could walk the low-entropy code space and log in as them.
 *
 * AFTER: the portal reuses the SAME canonical authority staff logins use —
 * `verifyPassword` against `users.password_hash`, a constant-time dummy-hash
 * comparison on the miss path, `is_active`, `session_version` and the shared
 * session cookie. `student_code` remains an identifier only.
 *
 * No second authentication authority is introduced: onboarding and rotation go
 * through the existing owner-only `POST /api/users` / `:id/reset-password`
 * endpoints and the existing `POST /api/auth/change-password`.
 *
 * The portal keeps exactly zero privileges — that property is covered in
 * student-portal-privilege-boundary.test.ts and re-asserted here for the
 * password-authenticated session.
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { today } from '../../../utils/ids.js';
import { hashPassword } from '../../../utils/auth.js';
import authRouter from '../../../routes/auth.routes.js';
import studentsRouter from '../../../routes/students.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';

const BRANCH_A = 'spa_branch_a';
const BRANCH_B = 'spa_branch_b';
const GOOD_SECRET = 'PortalSecret!2026';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
  return app;
}

let app: express.Express;

function seedStudent(id: string, code: string, name: string, branch: string, phone: string) {
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES (?, ?, ?, 'active', ?, ?, 'male', ?)`
  ).run(id, code, name, today(), branch, phone);
}

async function seedPortalAccount(userId: string, studentId: string, code: string, name: string, branch: string, secret: string | null) {
  const hash = secret ? await hashPassword(secret) : 'unusable-placeholder-hash';
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password, linked_student_id, session_version )
     VALUES (?, ?, ?, ?, ?, 1, 0, ?, 1)`
  ).run(userId, `stu_${code}`, name, branch, hash, studentId);
  assignRole(userId, 'student', branch);
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  for (const b of [BRANCH_A, BRANCH_B]) {
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(b, b, 'Loc');
  }
  seedStudent('spa_stu_self', 'TH-SPA-001', 'Sara Portal', BRANCH_A, '0700333001');
  seedStudent('spa_stu_other', 'TH-SPA-002', 'Omid Other', BRANCH_A, '0700333002');
  seedStudent('spa_stu_farb', 'TH-SPA-003', 'Farah Branch B', BRANCH_B, '0700333003');
  await seedPortalAccount('spa_u_self', 'spa_stu_self', 'TH-SPA-001', 'Sara Portal', BRANCH_A, GOOD_SECRET);
  await seedPortalAccount('spa_u_farb', 'spa_stu_farb', 'TH-SPA-003', 'Farah Branch B', BRANCH_B, GOOD_SECRET);

  app = createApp();
});

const login = (body: Record<string, unknown>) => supertest(app).post('/api/auth/student-login').send(body);

describe('SPA-1 — identifier alone is no longer authentication', () => {
  it('REJECTS the old code + name credential (this succeeded with 200 before)', async () => {
    const res = await login({ studentCode: 'TH-SPA-001', fullName: 'Sara Portal' });
    // 400 (no secret supplied) or 401 (secret rejected) — both fail closed and
    // issue no session. What must never happen again is a 200 + token.
    expect([400, 401]).toContain(res.status);
    expect(res.body.token).toBeFalsy();
    expect(res.body.user).toBeFalsy();
  });

  it('REJECTS code + name even when fullName is sent in the password field', async () => {
    const res = await login({ studentCode: 'TH-SPA-001', password: 'Sara Portal' });
    expect(res.status).toBe(401);
    expect(res.body.token).toBeFalsy();
  });

  it('rejects a correct code with a missing secret', async () => {
    const res = await login({ studentCode: 'TH-SPA-001' });
    expect([400, 401]).toContain(res.status);
    expect(res.body.token).toBeFalsy();
  });

  it('rejects a correct code with the WRONG secret', async () => {
    const res = await login({ studentCode: 'TH-SPA-001', password: 'WrongSecret!2026' });
    expect(res.status).toBe(401);
    expect(res.body.token).toBeFalsy();
  });

  // Found by adversarial testing of the SPA-1 implementation itself: an
  // earlier revision used String(password), and String(['s3cret']) === 's3cret'
  // — so a JSON array authenticated. A credential must be a string, never a
  // coerced value.
  it('rejects a non-string secret (array/object/number coercion bypass)', async () => {
    for (const password of [[GOOD_SECRET], { toString: () => GOOD_SECRET }, 12345, true] as unknown[]) {
      const res = await login({ studentCode: 'TH-SPA-001', password });
      expect([400, 401]).toContain(res.status);
      expect(res.body.token).toBeFalsy();
    }
  });

  it('rejects a non-string student code', async () => {
    const res = await login({ studentCode: ['TH-SPA-001'], password: GOOD_SECRET });
    expect([400, 401]).toContain(res.status);
    expect(res.body.token).toBeFalsy();
  });

  it('does not leak whether the student code exists (same status for unknown code)', async () => {
    const unknown = await login({ studentCode: 'TH-NOPE-9999', password: GOOD_SECRET });
    const known = await login({ studentCode: 'TH-SPA-001', password: 'WrongSecret!2026' });
    expect(unknown.status).toBe(known.status);
  });

  it('never echoes a secret or a hash in the response body', async () => {
    const res = await login({ studentCode: 'TH-SPA-001', password: GOOD_SECRET });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(GOOD_SECRET);
    expect(body).not.toContain('password_hash');
    expect(body).not.toContain('$2');
  });
});

describe('SPA-1 — valid credentials still work and stay unprivileged', () => {
  let token: string;

  it('accepts code + correct secret', async () => {
    const res = await login({ studentCode: 'TH-SPA-001', password: GOOD_SECRET });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('student');
    expect(res.body.user.permissions).toEqual([]);
    token = res.body.token;
    expect(token).toBeTruthy();
  });

  it('reads its OWN profile', async () => {
    const res = await supertest(app).get('/api/students/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.studentCode).toBe('TH-SPA-001');
  });

  it('cannot read another student (IDOR)', async () => {
    const res = await supertest(app).get('/api/students/spa_stu_other').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('cannot list students or write money', async () => {
    expect((await supertest(app).get('/api/students').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    const pay = await supertest(app)
      .post('/api/students/spa_stu_self/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: 100, category: 'other', notes: 'x' });
    expect(pay.status).toBe(403);
  });
});

describe('SPA-1 — branch isolation and account state', () => {
  it('a branch-B portal session cannot read a branch-A student', async () => {
    const res = await login({ studentCode: 'TH-SPA-003', password: GOOD_SECRET });
    expect(res.status).toBe(200);
    const other = await supertest(app)
      .get('/api/students/spa_stu_self')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(other.status).toBe(403);
  });

  it('refuses a student with no portal account (no silent auto-provisioning)', async () => {
    const res = await login({ studentCode: 'TH-SPA-002', password: GOOD_SECRET });
    expect(res.status).toBe(401);
    // and nothing was created
    const row = db.prepare('SELECT id FROM users WHERE linked_student_id = ?').get('spa_stu_other');
    expect(row).toBeFalsy();
  });

  it('refuses a deactivated portal account', async () => {
    db.prepare(`UPDATE users SET is_active = 0 WHERE id = 'spa_u_self'`).run();
    const res = await login({ studentCode: 'TH-SPA-001', password: GOOD_SECRET });
    expect([401, 403]).toContain(res.status);
    db.prepare(`UPDATE users SET is_active = 1 WHERE id = 'spa_u_self'`).run();
  });

  it('refuses a suspended/inactive STUDENT record', async () => {
    db.prepare(`UPDATE students SET status = 'suspended' WHERE id = 'spa_stu_self'`).run();
    const res = await login({ studentCode: 'TH-SPA-001', password: GOOD_SECRET });
    expect([401, 403]).toContain(res.status);
    db.prepare(`UPDATE students SET status = 'active' WHERE id = 'spa_stu_self'`).run();
  });
});

describe('SPA-1 — session revocation still works', () => {
  it('bumping session_version invalidates an issued portal token', async () => {
    const res = await login({ studentCode: 'TH-SPA-001', password: GOOD_SECRET });
    expect(res.status).toBe(200);
    const token = res.body.token;
    expect((await supertest(app).get('/api/students/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);

    db.prepare(`UPDATE users SET session_version = session_version + 1 WHERE id = 'spa_u_self'`).run();
    const after = await supertest(app).get('/api/students/me').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  it('an owner password reset revokes existing portal sessions and rotates the secret', async () => {
    const res = await login({ studentCode: 'TH-SPA-001', password: GOOD_SECRET });
    expect(res.status).toBe(200);
    const oldToken = res.body.token;

    // Canonical rotation authority (users.routes stmtResetPassword) bumps
    // session_version in the same statement.
    const newHash = await hashPassword('RotatedSecret!2026');
    db.prepare(
      `UPDATE users SET password_hash = ?, must_change_password = 1, session_version = session_version + 1 WHERE id = 'spa_u_self'`
    ).run(newHash);

    expect((await supertest(app).get('/api/students/me').set('Authorization', `Bearer ${oldToken}`)).status).toBe(401);
    expect((await login({ studentCode: 'TH-SPA-001', password: GOOD_SECRET })).status).toBe(401);
    expect((await login({ studentCode: 'TH-SPA-001', password: 'RotatedSecret!2026' })).status).toBe(200);
  });
});
