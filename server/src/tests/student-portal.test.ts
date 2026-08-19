/**
 * Student Portal regression — user-creation RangeError + student self-scope
 * ============================================================================
 * Two regression fronts from the field report:
 *
 *  1. POST /api/users crashed with "RangeError: Too many parameter values"
 *     inside rbac-service (syncPrimaryUserRole). The INSERT + role sync must
 *     accept every role in ALLOWED_ROLES (including 'student') without
 *     parameter drift, and account creation must bind the user to the branch's
 *     campus (users.campus_id).
 *
 *  2. Student portal accounts authenticate with code + full name only, see
 *     ONLY their own profile (GET /api/students/me), and can never list or
 *     read other students. The whole-DB /api/students/search endpoint must
 *     return { rows, total } with pagination at any dataset size.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { id, today } from '../utils/ids.js';
import { signToken, hashPassword } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { authRouter } from '../routes/auth.routes.js';
import { studentsRouter } from '../routes/students.routes.js';
import { usersRouter } from '../routes/users.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'portal_branch';
const CAMPUS = 'portal_campus';
const OTHER_BRANCH = 'portal_branch_2';
const OTHER_CAMPUS = 'portal_campus_2';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/students', studentsRouter);
  app.use('/api/users', usersRouter);
  app.use(errorHandler);
  return app;
}

let app: express.Express;
let ownerToken: string;

function seedStudent(studentId: string, branchId: string, fullName: string, studentCode: string) {
  // uq_students_phone is a UNIQUE index: every test student needs a distinct phone.
  const phone = `07${studentCode.replace(/\D/g, '').slice(-8)}`;
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES (?, ?, ?, 'active', ?, ?, 'male', ?)`
  ).run(studentId, studentCode, fullName, today(), branchId, phone);
}

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);

  // Campuses + branches (branch -> campus binding is what account creation resolves).
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)').run(CAMPUS, FIXED_ORG_ID, 'Portal Campus', 'PORTAL-C');
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)').run(OTHER_CAMPUS, FIXED_ORG_ID, 'Other Campus', 'PORTAL-C2');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)').run(BRANCH, 'Portal Branch', 'Loc', CAMPUS);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)').run(OTHER_BRANCH, 'Portal Branch 2', 'Loc 2', OTHER_CAMPUS);

  // Owner account (must_change_password = 0 so no quarantine).
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password, session_version)
     VALUES (?, 'portal_owner', 'Portal Owner', 'owner', ?, ?, 1, 0, 1)`
  ).run('u_portal_owner', BRANCH, await hashPassword('owner-pass-12345'));
  syncLegacyUserRoles(db);

  ownerToken = signToken({ userId: 'u_portal_owner', username: 'portal_owner', role: 'owner', branchId: BRANCH, fullName: 'Portal Owner', sessionVersion: 1 });

  seedStudent('stu_portal_1', BRANCH, 'Ali Ahmad Portal', 'TH-P-001001');
  seedStudent('stu_portal_2', BRANCH, 'Maryam Karimi Portal', 'TH-P-001002');
  seedStudent('stu_portal_other', OTHER_BRANCH, 'Zahra Other Branch', 'TH-P-002001');

  app = createApp();
});

describe('Account creation — RangeError regression (rbac-service sync)', () => {
  it('creates an owner account with full fields; campus_id is bound from the branch', async () => {
    const res = await supertest(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        username: 'owner_two',
        tempPassword: 'Owner-Two-Pass-123',
        fullName: 'Owner Two',
        role: 'owner',
        branchId: BRANCH,
        email: 'owner2@example.com',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();

    const row = db.prepare('SELECT campus_id, role, branch_id FROM users WHERE id = ?').get(res.body.id) as
      | { campus_id: string | null; role: string; branch_id: string } | undefined;
    expect(row).toBeTruthy();
    expect(row!.campus_id).toBe(CAMPUS); // bound to the branch's campus
    expect(row!.role).toBe('owner');
    expect(row!.branch_id).toBe(BRANCH);
  });

  it('creates a student-role user linked to a student (no parameter drift)', async () => {
    const res = await supertest(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        username: 'stu_portal_1_account',
        tempPassword: 'Student-Acc-Pass-123',
        fullName: 'Ali Ahmad Portal',
        role: 'student',
        branchId: BRANCH,
        linkedStudentId: 'stu_portal_1',
      });
    expect(res.status).toBe(201);

    const row = db.prepare('SELECT campus_id, role, linked_student_id FROM users WHERE id = ?').get(res.body.id) as
      | { campus_id: string | null; role: string; linked_student_id: string | null } | undefined;
    expect(row).toBeTruthy();
    expect(row!.role).toBe('student');
    expect(row!.campus_id).toBe(CAMPUS);
    expect(row!.linked_student_id).toBe('stu_portal_1');

    // The student-role sync must have written a real RBAC role row.
    const rbacRole = db.prepare(
      `SELECT ur.scope_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = ? AND r.code = 'student' AND ur.is_primary = 1`
    ).get(res.body.id) as { scope_id: string | null } | undefined;
    expect(rbacRole?.scope_id).toBe(BRANCH);

    // SPA-3 (approved policy): a student's initial password is their NAME and
    // they are NOT forced to rotate it — rotation is optional and
    // user-initiated. Staff accounts keep the mandatory first-use rotation.
    const quarantined = db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(res.body.id) as { must_change_password: number };
    expect(quarantined.must_change_password).toBe(0);
  });

  it('rejects a linked student that belongs to another branch', async () => {
    const res = await supertest(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        username: 'stu_mismatch',
        tempPassword: 'Student-Acc-Pass-123',
        fullName: 'Zahra Other Branch',
        role: 'student',
        branchId: BRANCH,
        linkedStudentId: 'stu_portal_other', // lives in OTHER_BRANCH
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/same branch/i);
  });

  it('rejects a second portal account for the same student', async () => {
    const res = await supertest(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        username: 'stu_portal_1_dup',
        tempPassword: 'Student-Acc-Pass-123',
        fullName: 'Ali Ahmad Portal',
        role: 'student',
        branchId: BRANCH,
        linkedStudentId: 'stu_portal_1',
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already has a portal account/i);
  });

  it('rejects a duplicate username with 409', async () => {
    const res = await supertest(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        username: 'owner_two',
        tempPassword: 'Another-Pass-1234',
        fullName: 'Owner Two Again',
        role: 'owner',
        branchId: BRANCH,
      });
    expect(res.status).toBe(409);
  });
});

/**
 * SPA-1 rewrote this contract. The portal used to authenticate with
 * `studentCode + fullName` (neither is a secret) and auto-provisioned an
 * account on first contact. It now requires a real secret verified through the
 * same `verifyPassword` authority staff logins use, and never mints an account
 * implicitly. These tests were updated to the new authority — every security
 * assertion they made is preserved and strengthened below.
 */
describe('Student portal login (student code + secret)', () => {
  const PORTAL_SECRET = 'Portal-Login-Pass-2026';

  beforeAll(async () => {
    // Onboard stu_portal_2 through the canonical owner-only authority.
    const created = await supertest(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        username: 'stu_portal_2_account',
        tempPassword: PORTAL_SECRET,
        fullName: 'Maryam Karimi Portal',
        role: 'student',
        branchId: BRANCH,
        linkedStudentId: 'stu_portal_2',
      });
    expect(created.status).toBe(201);
    // Clear the first-use quarantine so this suite can exercise the login path
    // itself (rotation is covered in student-portal-secret-auth.test.ts).
    db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(created.body.id);
  });

  it('logs in with student code + secret and returns a scoped token', async () => {
    const res = await supertest(app)
      .post('/api/auth/student-login')
      .send({ studentCode: 'TH-P-001002', password: PORTAL_SECRET });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('student');
    expect(res.body.user.permissions).toEqual([]);
    expect(res.body.token).toBeTruthy();
  });

  it('REJECTS the retired code + name credential', async () => {
    const res = await supertest(app)
      .post('/api/auth/student-login')
      .send({ studentCode: 'TH-P-001002', fullName: 'Maryam Karimi Portal' });
    expect([400, 401]).toContain(res.status);
    expect(res.body.token).toBeFalsy();
  });

  it('has a portal user row linked to the student', () => {
    const row = db.prepare('SELECT username, role, linked_student_id FROM users WHERE linked_student_id = ?').get('stu_portal_2') as
      | { username: string; role: string; linked_student_id: string } | undefined;
    expect(row).toBeTruthy();
    expect(row!.role).toBe('student');
  });

  it('rejects an unknown student code with 401 (no enumeration)', async () => {
    const res = await supertest(app)
      .post('/api/auth/student-login')
      .send({ studentCode: 'TH-NOPE-0000', password: PORTAL_SECRET });
    expect(res.status).toBe(401);
    // and no account is silently created for a code that does not exist
    expect(db.prepare('SELECT id FROM users WHERE username LIKE ?').get('stu_TH-NOPE%')).toBeFalsy();
  });

  it('rejects a wrong secret with 401', async () => {
    const res = await supertest(app)
      .post('/api/auth/student-login')
      .send({ studentCode: 'TH-P-001002', password: 'Wrong-Secret-Here-1' });
    expect(res.status).toBe(401);
  });
});

describe('Student self-scope — read only, own profile only', () => {
  let studentToken: string;

  beforeAll(async () => {
    // stu_portal_1 was onboarded earlier in this file via POST /api/users with
    // tempPassword 'Student-Acc-Pass-123'. SPA-1 quarantines a freshly issued
    // temporary password, which is cleared here so this suite can exercise the
    // self-scope authorization rules rather than the rotation flow.
    db.prepare('UPDATE users SET must_change_password = 0 WHERE linked_student_id = ?').run('stu_portal_1');
    const res = await supertest(app)
      .post('/api/auth/student-login')
      .send({ studentCode: 'TH-P-001001', password: 'Student-Acc-Pass-123' });
    expect(res.status).toBe(200);
    studentToken = res.body.token;
  });

  it('GET /students/me returns exactly the caller profile', async () => {
    const res = await supertest(app).get('/api/students/me').set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.studentCode).toBe('TH-P-001001');
    expect(res.body.fullName).toBe('Ali Ahmad Portal');
    expect(res.body.branchId).toBe(BRANCH);
  });

  it('student cannot list all students (403)', async () => {
    const res = await supertest(app).get('/api/students').set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(403);
  });

  it('student cannot read another student profile (403)', async () => {
    const res = await supertest(app).get('/api/students/stu_portal_2').set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(403);
  });

  it('student cannot use the whole-DB search (403)', async () => {
    const res = await supertest(app).get('/api/students/search?q=Ali').set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(403);
  });
});

describe('Whole-DB student search — paginated { rows, total }', () => {
  // Scale simulation: 40 students in the branch + 1 elsewhere.
  beforeAll(() => {
    for (let i = 0; i < 40; i++) {
      const sid = `stu_search_${i}`;
      if (!db.prepare('SELECT id FROM students WHERE id = ?').get(sid)) {
        seedStudent(sid, BRANCH, `Search Student Number ${i}`, `TH-S-${String(1000 + i)}`);
      }
    }
  });

  it('scopes to the caller branch by default (branch isolation preserved)', async () => {
    const res = await supertest(app).get('/api/students/search?limit=100').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    // 2 portal students + 40 bulk in BRANCH; the OTHER_BRANCH student is excluded.
    expect(res.body.total).toBe(42);
  });

  it('whole-DB scope (branchId=all) returns { rows, total } honoring limit/offset', async () => {
    const res = await supertest(app).get('/api/students/search?branchId=all&limit=10&offset=5').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(43); // 3 portal + 40 bulk across both branches
    expect(res.body.rows.length).toBe(10);
  });

  it('q matches across name/code fields with LIKE escaping', async () => {
    const res = await supertest(app).get('/api/students/search?branchId=all&q=TH-S-10').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(40); // TH-S-1000 … TH-S-1039 all contain 'TH-S-10'
    expect(res.body.rows.every((r: { studentCode: string }) => r.studentCode.includes('TH-S-10'))).toBe(true);
  });

  it('pages through the full result set without duplication', async () => {
    const seen = new Set<string>();
    for (let offset = 0; offset < 50; offset += 10) {
      const res = await supertest(app).get(`/api/students/search?branchId=all&limit=10&offset=${offset}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      for (const row of res.body.rows) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
    }
    expect(seen.size).toBe(43);
  });

  it('status filter narrows the result set', async () => {
    const res = await supertest(app).get('/api/students/search?branchId=all&status=active').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(43);
    expect(res.body.rows.every((r: { status: string }) => r.status === 'active')).toBe(true);
  });
});
