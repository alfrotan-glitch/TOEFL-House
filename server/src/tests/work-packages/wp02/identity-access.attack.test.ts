import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../../../db/connection.js';
import { bootstrapRbacCatalog, buildRbacContext, resolveUserPermissions } from '../../../core/rbac/rbac-service.js';
import { hashPassword, signToken } from '../../../utils/auth.js';
import { assignRole, bearerFor } from '../../support/identity.js';
import usersRouter from '../../../routes/users.routes.js';
import securityRouter from '../../../routes/security.routes.js';
import authRouter from '../../../routes/auth.routes.js';
import sessionsRouter from '../../../routes/sessions.routes.js';
import classesRouter, { attendanceRouter } from '../../../routes/classes.routes.js';
import examsRouter from '../../../routes/exams.routes.js';
import studentsRouter from '../../../routes/students.routes.js';
import journeyRouter from '../../../routes/journey.routes.js';
import { authenticate, canAccessBranchResource, requirePermission } from '../../../middleware/auth.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { today } from '../../../utils/ids.js';

const A = 'wp02_repro_a';
const B = 'wp02_repro_b';
const password = 'Strong-Password-2026';
let app: express.Express;

function addUser(id: string, role: string, branchId: string, linkedStudentId: string | null = null) {
  db.prepare(`INSERT INTO users
    (id, username, password_hash, full_name, branch_id, linked_student_id, is_active, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0)`).run(id, id, '$2a$10$N9qo8uLOickgx2ZMRZoMy.Mrq8JjCqDwBvVj9oGm6ZvXqJqoYtXa', id, branchId, linkedStudentId);
  assignRole(id, role, branchId);
}

function addCustomRole(code: string, permissionCodes: string[]): string {
  const roleId = `role_${code}`;
  db.prepare(`INSERT INTO roles (id, code, name, is_system, is_active)
    VALUES (?, ?, ?, 0, 1)`).run(roleId, code, code);
  for (const permissionCode of permissionCodes) {
    const permission = db.prepare('SELECT id FROM permissions WHERE code = ?').get(permissionCode) as { id: string };
    db.prepare(`INSERT INTO role_permissions (id, role_id, permission_id, default_scope)
      VALUES (?, ?, ?, 'branch')`).run(randomUUID(), roleId, permission.id);
  }
  return roleId;
}

function assignRoleId(userId: string, roleId: string, branchId: string, isPrimary = false): void {
  db.prepare(`INSERT INTO user_roles
    (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by)
    VALUES (?, ?, ?, 'branch', ?, ?, 'attack-fixture')`)
    .run(randomUUID(), userId, roleId, branchId, isPrimary ? 1 : 0);
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare("INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'Kabul')").run(A, 'Repro A');
  db.prepare("INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'Kabul')").run(B, 'Repro B');
  const hash = await hashPassword(password);
  addUser('wp02_repro_global', 'owner', A);
  addUser('wp02_repro_scoped', 'owner', A);
  db.prepare("UPDATE user_roles SET scope_type = 'branch', scope_id = ? WHERE user_id = 'wp02_repro_scoped'").run(A);
  addUser('wp02_repro_foreign', 'receptionist', B);
  db.prepare('UPDATE users SET password_hash = ? WHERE id IN (?, ?, ?)').run(hash, 'wp02_repro_global', 'wp02_repro_scoped', 'wp02_repro_foreign');

  addUser('wp02_repro_manager', 'general_manager', A);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, 'wp02_repro_manager');
  const gm = db.prepare("SELECT id FROM roles WHERE code = 'general_manager'").get() as { id: string };
  for (const code of ['Role.Edit', 'User.Edit', 'Permission.Override']) {
    const p = db.prepare('SELECT id FROM permissions WHERE code = ?').get(code) as { id: string };
    db.prepare("INSERT OR IGNORE INTO role_permissions (id, role_id, permission_id, default_scope) VALUES (?, ?, ?, 'branch')")
      .run(randomUUID(), gm.id, p.id);
  }

  db.prepare(`INSERT INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
    VALUES ('wp02_repro_student', 'TH-WP02-REPRO', 'Portal Student', 'active', ?, ?, 'female', '0700111000')`).run(today(), A);

  // Scope-laundering administration fixture: the caller may administer users
  // in A and holds finance authority only in B. A code-only privilege ceiling
  // would incorrectly allow takeover of the finance target in A.
  const accountAdminRole = addCustomRole('wp02_account_admin', ['User.View', 'User.Edit', 'Role.Edit', 'Permission.Override']);
  addUser('wp02_repro_admin_launder', 'receptionist', A);
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run('wp02_repro_admin_launder');
  assignRoleId('wp02_repro_admin_launder', accountAdminRole, A, true);
  assignRole('wp02_repro_admin_launder', 'finance_manager', B, { isPrimary: false });
  addUser('wp02_repro_finance_target', 'finance_manager', A);

  const emptyRole = addCustomRole('wp02_empty_target', []);
  addUser('wp02_repro_empty_target', 'receptionist', A);
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run('wp02_repro_empty_target');
  assignRoleId('wp02_repro_empty_target', emptyRole, A, true);

  app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  app.use('/api/security', securityRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/classes', classesRouter);
  app.use('/api/attendance', attendanceRouter);
  app.use('/api/exams', examsRouter);
  app.use('/api/students/:id/journey', journeyRouter);
  app.use('/api/students', studentsRouter);
  app.get('/api/probe/:branchId', authenticate, requirePermission('Payment.Edit'), (req, res) => {
    res.status(canAccessBranchResource(req, req.params.branchId) ? 200 : 403).json({ ok: true });
  });
  app.get('/api/student-branch-probe/:branchId', authenticate, requirePermission('Student.View'), (req, res) => {
    res.status(canAccessBranchResource(req, req.params.branchId) ? 200 : 403).json({ ok: true });
  });
  app.use(errorHandler);
});

describe('WP-02 privilege and identity attack regressions', () => {
  it('keeps a foreign user out of a scoped account list and refuses password reset', async () => {
    const list = await supertest(app).get('/api/users').set(bearerFor('wp02_repro_scoped'));
    expect(list.status).toBe(200);
    expect(list.body.some((u: { id: string }) => u.id === 'wp02_repro_foreign')).toBe(false);
    const reset = await supertest(app).post('/api/users/wp02_repro_foreign/reset-password')
      .set(bearerFor('wp02_repro_scoped')).send({ tempPassword: 'Replacement-Password-2026' });
    expect(reset.status).toBe(403);
  });

  it('refuses to let a branch-scoped owner mint an organization owner', async () => {
    const res = await supertest(app).post('/api/users').set(bearerFor('wp02_repro_scoped')).send({
      username: 'wp02_repro_minted_owner', tempPassword: password, fullName: 'Minted Owner', role: 'owner', branchId: A,
    });
    expect(res.status).toBe(403);
    expect(db.prepare("SELECT id FROM users WHERE username = 'wp02_repro_minted_owner'").get()).toBeUndefined();
  });

  it('refuses a permission grant the delegated manager does not hold', async () => {
    const permission = db.prepare("SELECT id FROM permissions WHERE code = 'Payment.Delete'").get() as { id: string };
    const res = await supertest(app).post('/api/security/users/wp02_repro_manager/overrides')
      .set(bearerFor('wp02_repro_manager')).send({ permissionId: permission.id, effect: 'grant', scopeType: 'branch', scopeId: A });
    expect(res.status).toBe(403);
    expect(resolveUserPermissions(db, 'wp02_repro_manager').some((p) => p.code === 'Payment.Delete')).toBe(false);
  });

  it('does not widen an own-or-class permission into branch-wide access', async () => {
    addUser('wp02_repro_teacher_scope', 'teacher', A);
    const res = await supertest(app).get(`/api/student-branch-probe/${A}`).set(bearerFor('wp02_repro_teacher_scope'));
    expect(res.status).toBe(403);
  });

  it('limits a teacher session collection and object reads to the linked teacher', async () => {
    addUser('wp02_repro_session_teacher_user', 'teacher', A);
    db.prepare(`INSERT INTO teachers (id, full_name, branch_id, joined_date)
      VALUES ('wp02_repro_session_teacher', 'Scoped Teacher', ?, ?),
             ('wp02_repro_session_colleague', 'Colleague Teacher', ?, ?)`).run(A, today(), A, today());
    db.prepare(`UPDATE users SET linked_teacher_id = 'wp02_repro_session_teacher'
      WHERE id = 'wp02_repro_session_teacher_user'`).run();
    db.prepare(`INSERT INTO classes (id, name, teacher_id, level, branch_id)
      VALUES ('wp02_repro_session_own_class', 'Own Class', 'wp02_repro_session_teacher', 'A1', ?),
             ('wp02_repro_session_other_class', 'Other Class', 'wp02_repro_session_colleague', 'A1', ?)`).run(A, A);
    db.prepare(`INSERT INTO sessions (id, class_id, date, start_time, end_time, teacher_id, branch_id)
      VALUES ('wp02_repro_session_own', 'wp02_repro_session_own_class', ?, '08:00', '09:00', 'wp02_repro_session_teacher', ?),
             ('wp02_repro_session_other', 'wp02_repro_session_other_class', ?, '09:00', '10:00', 'wp02_repro_session_colleague', ?)`).run(today(), A, today(), A);

    const list = await supertest(app).get('/api/sessions').set(bearerFor('wp02_repro_session_teacher_user'));
    expect(list.status).toBe(200);
    expect(list.body.map((row: { id: string }) => row.id)).toContain('wp02_repro_session_own');
    expect(list.body.map((row: { id: string }) => row.id)).not.toContain('wp02_repro_session_other');
    const classes = await supertest(app).get('/api/classes').set(bearerFor('wp02_repro_session_teacher_user'));
    expect(classes.status).toBe(200);
    expect(classes.body.map((row: { id: string }) => row.id)).toContain('wp02_repro_session_own_class');
    expect(classes.body.map((row: { id: string }) => row.id)).not.toContain('wp02_repro_session_other_class');

    const own = await supertest(app).get('/api/sessions/wp02_repro_session_own')
      .set(bearerFor('wp02_repro_session_teacher_user'));
    const other = await supertest(app).get('/api/sessions/wp02_repro_session_other')
      .set(bearerFor('wp02_repro_session_teacher_user'));
    const otherRoster = await supertest(app).get('/api/sessions/wp02_repro_session_other/roster')
      .set(bearerFor('wp02_repro_session_teacher_user'));
    expect(own.status).toBe(200);
    expect(other.status).toBe(403);
    expect(otherRoster.status).toBe(403);
  });

  it('limits Student.View:class to students enrolled with the linked teacher', async () => {
    addUser('wp02_repro_student_teacher_user', 'teacher', A);
    db.prepare(`INSERT INTO teachers (id, full_name, branch_id, joined_date)
      VALUES ('wp02_repro_student_teacher', 'Student Teacher', ?, ?),
             ('wp02_repro_student_colleague', 'Student Colleague', ?, ?)`).run(A, today(), A, today());
    db.prepare(`UPDATE users SET linked_teacher_id = 'wp02_repro_student_teacher'
      WHERE id = 'wp02_repro_student_teacher_user'`).run();
    db.prepare(`INSERT INTO classes (id, name, teacher_id, level, branch_id)
      VALUES ('wp02_repro_student_own_class', 'Student Own Class', 'wp02_repro_student_teacher', 'A1', ?),
             ('wp02_repro_student_other_class', 'Student Other Class', 'wp02_repro_student_colleague', 'A1', ?)`).run(A, A);
    db.prepare(`INSERT INTO students (id, student_code, full_name, gender, status, registration_date, branch_id)
      VALUES ('wp02_repro_student_own', 'WP02-S-OWN', 'Own Student', 'male', 'active', ?, ?),
             ('wp02_repro_student_other', 'WP02-S-OTHER', 'Other Student', 'male', 'active', ?, ?)`).run(today(), A, today(), A);
    db.prepare(`INSERT INTO student_semesters (id, student_id, semester_name, class_id, enroll_date, status)
      VALUES ('wp02_repro_student_sem_own', 'wp02_repro_student_own', 'Term', 'wp02_repro_student_own_class', ?, 'active'),
             ('wp02_repro_student_sem_other', 'wp02_repro_student_other', 'Term', 'wp02_repro_student_other_class', ?, 'active')`).run(today(), today());

    const own = await supertest(app).get('/api/students/wp02_repro_student_own')
      .set(bearerFor('wp02_repro_student_teacher_user'));
    const other = await supertest(app).get('/api/students/wp02_repro_student_other')
      .set(bearerFor('wp02_repro_student_teacher_user'));
    const collection = await supertest(app).get('/api/students')
      .set(bearerFor('wp02_repro_student_teacher_user'));
    const ownJourney = await supertest(app).get('/api/students/wp02_repro_student_own/journey')
      .set(bearerFor('wp02_repro_student_teacher_user'));
    const otherJourney = await supertest(app).get('/api/students/wp02_repro_student_other/journey')
      .set(bearerFor('wp02_repro_student_teacher_user'));
    const forgedAttendance = await supertest(app).post('/api/attendance')
      .set(bearerFor('wp02_repro_student_teacher_user'))
      .send({
        date: today(),
        records: [{
          targetId: 'wp02_repro_student_other',
          targetType: 'student',
          status: 'present',
          classId: 'wp02_repro_student_other_class',
        }],
      });
    const ownAttendance = await supertest(app).post('/api/attendance')
      .set(bearerFor('wp02_repro_student_teacher_user'))
      .send({
        date: today(),
        records: [{
          targetId: 'wp02_repro_student_own',
          targetType: 'student',
          status: 'present',
          classId: 'wp02_repro_student_own_class',
        }],
      });
    const attendanceList = await supertest(app).get('/api/attendance')
      .set(bearerFor('wp02_repro_student_teacher_user'));
    expect(own.status).toBe(200);
    expect(own.body.balance).toBeUndefined();
    expect(own.body.discountPercent).toBeUndefined();
    expect(own.body.installmentPlan).toBeUndefined();
    expect(own.body.semesters[0].feeAmount).toBeUndefined();
    expect(own.body.semesters[0].netFeeAmount).toBeUndefined();
    expect(other.status).toBe(403);
    expect(collection.status).toBe(200);
    expect(collection.body.map((student: { id: string }) => student.id)).toContain('wp02_repro_student_own');
    expect(collection.body.map((student: { id: string }) => student.id)).not.toContain('wp02_repro_student_other');
    expect(ownJourney.status).toBe(200);
    expect(ownJourney.body.financialTimeline).toEqual([]);
    expect(otherJourney.status).toBe(403);
    expect(forgedAttendance.status).toBe(403);
    expect(ownAttendance.status).toBe(201);
    expect(attendanceList.status).toBe(200);
    expect(attendanceList.body.map((row: { target_id: string }) => row.target_id)).toContain('wp02_repro_student_own');
    expect(attendanceList.body.map((row: { target_id: string }) => row.target_id)).not.toContain('wp02_repro_student_other');
    expect(db.prepare(`SELECT 1 FROM attendance WHERE target_id = 'wp02_repro_student_other'`).get()).toBeUndefined();
  });

  it('fails closed when an own-scoped exam grant has no exam ownership relation', async () => {
    addUser('wp02_repro_exam_teacher', 'teacher', A);
    db.prepare(`INSERT INTO exams (id, title, date, fee, type, branch_id)
      VALUES ('wp02_repro_exam', 'Unrelated Branch Exam', ?, 0, 'midterm', ?)`).run(today(), A);
    const res = await supertest(app).get('/api/exams').set(bearerFor('wp02_repro_exam_teacher'));
    expect(res.status).toBe(403);
  });

  it('does not let one position lend branch reach to another position permission', async () => {
    addUser('wp02_repro_launder', 'finance_manager', B);
    assignRole('wp02_repro_launder', 'receptionist', A, { isPrimary: false });
    const res = await supertest(app).get(`/api/probe/${A}`).set(bearerFor('wp02_repro_launder'));
    expect(res.status).toBe(403);
  });

  it('does not let cross-position scope laundering satisfy the account-takeover ceiling', async () => {
    const before = db.prepare("SELECT session_version AS v FROM users WHERE id = 'wp02_repro_finance_target'").get() as { v: number };
    const res = await supertest(app).post('/api/users/wp02_repro_finance_target/reset-password')
      .set(bearerFor('wp02_repro_admin_launder')).send({ tempPassword: 'Replacement-Password-2026' });
    expect(res.status).toBe(403);
    const after = db.prepare("SELECT session_version AS v FROM users WHERE id = 'wp02_repro_finance_target'").get() as { v: number };
    expect(after.v).toBe(before.v);
  });

  it('does not treat temporarily denied authority as safe for account takeover', async () => {
    const permissions = db.prepare(`SELECT p.id
      FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = 'wp02_repro_finance_target'`).all() as Array<{ id: string }>;
    for (const permission of permissions) {
      db.prepare(`INSERT INTO permission_overrides
        (id, user_id, permission_id, effect, scope_type, scope_id, granted_by, expires_at)
        VALUES (?, 'wp02_repro_finance_target', ?, 'deny', 'branch', ?, 'wp02_repro_global', '2099-01-01T00:00:00.000Z')`)
        .run(randomUUID(), permission.id, A);
    }
    expect(resolveUserPermissions(db, 'wp02_repro_finance_target')).toEqual([]);
    const res = await supertest(app).post('/api/users/wp02_repro_finance_target/reset-password')
      .set(bearerFor('wp02_repro_admin_launder')).send({ tempPassword: 'Replacement-Password-2026' });
    expect(res.status).toBe(403);
  });

  it('does not let a role editor grant permissions outside every assignment scope', async () => {
    const permission = db.prepare("SELECT id FROM permissions WHERE code = 'Payment.View'").get() as { id: string };
    const res = await supertest(app).put('/api/security/roles/role_wp02_empty_target/permissions')
      .set(bearerFor('wp02_repro_admin_launder'))
      .send({ permissions: [{ permissionId: permission.id, scope: 'branch' }] });
    expect(res.status).toBe(403);
    const count = db.prepare("SELECT COUNT(*) AS c FROM role_permissions WHERE role_id = 'role_wp02_empty_target'").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('does not let permission reach in one branch remove a deny in another', async () => {
    const permission = db.prepare("SELECT id FROM permissions WHERE code = 'Payment.View'").get() as { id: string };
    const overrideId = 'wp02_repro_scoped_deny';
    db.prepare(`INSERT INTO permission_overrides
      (id, user_id, permission_id, effect, scope_type, scope_id, granted_by)
      VALUES (?, 'wp02_repro_empty_target', ?, 'deny', 'branch', ?, 'wp02_repro_global')`)
      .run(overrideId, permission.id, A);
    const res = await supertest(app).delete(`/api/security/overrides/${overrideId}`)
      .set(bearerFor('wp02_repro_admin_launder'));
    expect(res.status).toBe(403);
    expect(db.prepare('SELECT id FROM permission_overrides WHERE id = ?').get(overrideId)).toBeTruthy();
  });

  it('rejects a student portal password that is not the approved initial name', async () => {
    const res = await supertest(app).post('/api/users').set(bearerFor('wp02_repro_global')).send({
      username: 'wp02_repro_portal', tempPassword: 'Not The Student Name', fullName: 'Portal Student', role: 'student', branchId: A,
      linkedStudentId: 'wp02_repro_student',
    });
    expect(res.status).toBe(400);
    const created = await supertest(app).post('/api/users').set(bearerFor('wp02_repro_global')).send({
      username: 'wp02_repro_portal', tempPassword: 'Portal Student', fullName: 'Portal Student', role: 'student', branchId: A,
      linkedStudentId: 'wp02_repro_student',
    });
    expect(created.status).toBe(201);
  });

  it('rejects a staff identity link whose business record belongs to another branch', async () => {
    db.prepare(`INSERT INTO teachers (id, full_name, branch_id, joined_date)
      VALUES ('wp02_repro_teacher_b', 'Teacher B', ?, ?)`).run(B, today());
    const res = await supertest(app).post('/api/users').set(bearerFor('wp02_repro_global')).send({
      username: 'wp02_repro_teacher_account', tempPassword: password, fullName: 'Teacher B', role: 'teacher', branchId: A,
      linkedTeacherId: 'wp02_repro_teacher_b',
    });
    expect(res.status).toBe(400);
    expect(db.prepare("SELECT id FROM users WHERE username = 'wp02_repro_teacher_account'").get()).toBeUndefined();
  });

  it('enforces one portal identity per student at the database boundary', () => {
    expect(() => db.prepare(`INSERT INTO users (id, username, password_hash, full_name, branch_id, linked_student_id, is_active, must_change_password)
      VALUES ('wp02_repro_duplicate_portal', 'wp02_repro_duplicate_portal', 'x', 'Duplicate', ?, 'wp02_repro_student', 1, 0)`).run(A)).toThrow();
    const count = db.prepare("SELECT COUNT(*) AS c FROM users WHERE linked_student_id = 'wp02_repro_student'").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('does not let an old logout token revoke a newer session', async () => {
    const row = db.prepare("SELECT session_version FROM users WHERE id = 'wp02_repro_foreign'").get() as { session_version: number };
    const stale = signToken({ userId: 'wp02_repro_foreign', username: 'wp02_repro_foreign', fullName: 'Foreign', branchId: B, sessionVersion: row.session_version });
    db.prepare("UPDATE users SET session_version = session_version + 1 WHERE id = 'wp02_repro_foreign'").run();
    const before = (db.prepare("SELECT session_version AS v FROM users WHERE id = 'wp02_repro_foreign'").get() as { v: number }).v;
    expect((await supertest(app).post('/api/auth/logout').set('Authorization', `Bearer ${stale}`)).status).toBe(200);
    const after = (db.prepare("SELECT session_version AS v FROM users WHERE id = 'wp02_repro_foreign'").get() as { v: number }).v;
    expect(after).toBe(before);
  });

  it('makes an explicit deny dominant regardless of row order', () => {
    const permission = db.prepare("SELECT id FROM permissions WHERE code = 'Payment.View'").get() as { id: string };
    db.prepare('DELETE FROM permission_overrides WHERE user_id = ? AND permission_id = ?').run('wp02_repro_manager', permission.id);
    db.prepare(`INSERT INTO permission_overrides (id, user_id, permission_id, effect, scope_type, scope_id)
      VALUES (?, 'wp02_repro_manager', ?, 'deny', 'branch', ?), (?, 'wp02_repro_manager', ?, 'grant', 'branch', ?)`)
      .run(randomUUID(), permission.id, A, randomUUID(), permission.id, A);
    const context = buildRbacContext(db, db.prepare("SELECT id, username, full_name, branch_id FROM users WHERE id = 'wp02_repro_manager'").get() as never);
    expect(context.permissionCodes.has('Payment.View')).toBe(false);
  });
});
