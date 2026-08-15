/**
 * Student subsystem — deep audit reproduction suite.
 * ============================================================================
 * Reproduces suspected defects with executable tests BEFORE any fix:
 *
 *  1. enroll-semester double-submit → duplicate semester rows + double income
 *  2. issue-card first-issuance race → double ID-card fee under concurrency
 *  3. audit gap → payments/refunds/profile-edits/enrollments leave NO
 *     audit_logs entry (only status/suspend/resume do)
 *  4. payment idempotency TOCTOU → concurrent same-key payments: one should
 *     replay 200, the other 201; a 500 (unique violation) is the defect
 *  5. identity uniqueness + IDOR + branch isolation (control tests that must
 *     PASS — proving the surrounding protections work)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import studentsRouter, { paymentsRouter } from '../routes/students.routes.js';
import { auditRouter } from '../routes/audit.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';

const BRANCH_A = 'stu_branch_a';
const BRANCH_B = 'stu_branch_b';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/audit-logs', auditRouter);
  app.use(errorHandler);
  return app;
}
function authHeader(user: TokenPayload) { return { Authorization: `Bearer ${signToken(user)}` }; }

describe('Student subsystem deep audit', () => {
  let app: express.Express;
  let owner: TokenPayload;
  let registrar: TokenPayload;
  let finance: TokenPayload;
  let teacher: TokenPayload;
  let studentTok: TokenPayload;
  let manager: TokenPayload;

  beforeAll(async () => {
    initSchema();
    bootstrapRbacCatalog(db);
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_A, 'Stu Branch A', 'A');
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_B, 'Stu Branch B', 'B');
    for (const [uid, uname, role] of [
      ['stu_owner', 'stu_owner', 'owner'], ['stu_mgr', 'stu_mgr', 'manager'],
      ['stu_reg', 'stu_reg', 'registrar'], ['stu_fin', 'stu_fin', 'finance'],
      ['stu_tea', 'stu_tea', 'teacher'],
    ] as const) {
      await db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`)
        .run(uid, uname, 'Stu ' + role, role, BRANCH_A, await hashPassword('x'));
    }
    await db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES ('stu_stu', 'stu_stu', 'Stu Student', 'student', ?, ?, 1, 0)`).run(BRANCH_A, await hashPassword('x'));
    const stuRole = db.prepare("SELECT id FROM roles WHERE code='student'").get() as { id: string };
    db.prepare(`INSERT OR IGNORE INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by) VALUES (?, 'stu_stu', ?, 'branch', ?, 1, 'system')`).run(id('ur'), stuRole.id, BRANCH_A);
    syncLegacyUserRoles(db);
    owner = { userId: 'stu_owner', username: 'stu_owner', role: 'owner', branchId: BRANCH_A, fullName: 'Stu Owner' };
    manager = { userId: 'stu_mgr', username: 'stu_mgr', role: 'manager', branchId: BRANCH_A, fullName: 'Stu Manager' };
    registrar = { userId: 'stu_reg', username: 'stu_reg', role: 'registrar', branchId: BRANCH_A, fullName: 'Stu Registrar' };
    finance = { userId: 'stu_fin', username: 'stu_fin', role: 'finance', branchId: BRANCH_A, fullName: 'Stu Finance' };
    teacher = { userId: 'stu_tea', username: 'stu_tea', role: 'teacher', branchId: BRANCH_A, fullName: 'Stu Teacher' };
    studentTok = { userId: 'stu_stu', username: 'stu_stu', role: 'student', branchId: BRANCH_A, fullName: 'Stu Student' };
    app = createApp();
  });

  function seedStudent(sid: string, name: string, branch: string, phone: string, gender = 'male') {
    db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`).run(sid, `TH-STU-${sid.slice(-4)}`, name, today(), branch, gender, phone);
  }
  function seedSemester(sid: string, semName: string, fee: number) {
    db.prepare(`INSERT OR IGNORE INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')`).run(id('sem'), sid, semName, today(), fee, fee);
  }

  // ── CONTROL TESTS (must PASS — the protections work) ─────────────────────
  it('control: duplicate identity (phone/email/tazkira) rejected', async () => {
    seedStudent('stu_ctl1', 'Control One', BRANCH_A, '0700000001');
    const dup = await supertest(app).post('/api/students/manual').set(authHeader(registrar)).send({ fullName: 'Control Dup', phone: '0700000001', gender: 'male', branchId: BRANCH_A });
    expect(dup.status).toBe(409);
  });

  it('control: branch isolation — branch-B student detail is 403 for branch-A registrar', async () => {
    seedStudent('stu_ctl_b', 'Control B', BRANCH_B, '0700000002');
    const res = await supertest(app).get('/api/students/stu_ctl_b').set(authHeader(registrar));
    expect(res.status).toBe(403);
    const ownerRes = await supertest(app).get('/api/students/stu_ctl_b').set(authHeader(owner));
    expect(ownerRes.status).toBe(200);
  });

  it('control: teacher and student cannot create/read students beyond scope', async () => {
    const teaCreate = await supertest(app).post('/api/students/manual').set(authHeader(teacher)).send({ fullName: 'X', phone: '0700000003', gender: 'male', branchId: BRANCH_A });
    expect(teaCreate.status).toBe(403);
    const stuList = await supertest(app).get('/api/students').set(authHeader(studentTok));
    expect(stuList.status).toBe(403);
  });

  // ── DEFECT 1: enroll-semester double-submit ──────────────────────────────
  it('FIXED: enroll-semester duplicate submission creates exactly one semester + one income', async () => {
    seedStudent('stu_d1', 'D1 Student', BRANCH_A, '0700000010');
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      supertest(app).post('/api/students/stu_d1/enroll-semester').set(authHeader(registrar)).send({ semesterName: 'Level A1', tuitionAmount: 5000, amountPaidNow: 5000 })));
    const ok = results.filter((r) => r.status === 201).length;
    const semRows = (db.prepare(`SELECT COUNT(*) c FROM student_semesters WHERE student_id='stu_d1' AND semester_name='Level A1'`).get() as { c: number }).c;
    const incRows = (db.prepare(`SELECT COUNT(*) c FROM financial_transactions WHERE reference_id='stu_d1' AND category='fee' AND description LIKE '%Level A1%'`).get() as { c: number }).c;
    console.log(`[EVIDENCE] enroll-semester: 201=${ok}, semester rows=${semRows}, income rows=${incRows}`);
    expect(ok).toBe(1);       // exactly one success, the rest 409
    expect(semRows).toBe(1);
    expect(incRows).toBe(1);
    // A legitimate repeat after the semester is completed is still allowed.
    db.prepare(`UPDATE student_semesters SET status='completed' WHERE student_id='stu_d1' AND semester_name='Level A1'`).run();
    const repeat = await supertest(app).post('/api/students/stu_d1/enroll-semester').set(authHeader(registrar)).send({ semesterName: 'Level A1', tuitionAmount: 5000, amountPaidNow: 0 });
    expect(repeat.status).toBe(201);
    const activeCount = (db.prepare(`SELECT COUNT(*) c FROM student_semesters WHERE student_id='stu_d1' AND semester_name='Level A1' AND status='active'`).get() as { c: number }).c;
    expect(activeCount).toBe(1);
  });

  // ── DEFECT 2: issue-card first-issuance race ─────────────────────────────
  it('control: issue-card first-issuance charges the card fee exactly once (no race in single-process model)', async () => {
    seedStudent('stu_d2', 'D2 Student', BRANCH_A, '0700000011');
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      supertest(app).post('/api/students/stu_d2/issue-card').set(authHeader(registrar)).send({ cardDesign: { primaryColor: 'rose' } })));
    const ok = results.filter((r) => r.status === 201).length;
    const payRows = (db.prepare(`SELECT COUNT(*) c FROM payments WHERE student_id='stu_d2' AND category='card'`).get() as { c: number }).c;
    const incRows = (db.prepare(`SELECT COUNT(*) c FROM financial_transactions WHERE reference_id='stu_d2' AND category='card'`).get() as { c: number }).c;
    console.log(`[EVIDENCE] issue-card: 201=${ok}, card payment rows=${payRows}, income rows=${incRows}`);
    expect(payRows).toBe(1);
    expect(incRows).toBe(1);
  });

  // ── DEFECT 3: audit gap ──────────────────────────────────────────────────
  it('FIXED: payment and profile-edit now write audit_logs entries with operator + receipt', async () => {
    seedStudent('stu_d3', 'D3 Student', BRANCH_A, '0700000012');
    seedSemester('stu_d3', 'Level A1', 5000);
    const semId = (db.prepare(`SELECT id FROM student_semesters WHERE student_id='stu_d3' LIMIT 1`).get() as { id: string }).id;
    const pay = await supertest(app).post('/api/students/stu_d3/payments').set(authHeader(registrar)).send({ amount: 5000, category: 'fee', semesterId: semId });
    expect(pay.status).toBe(201);
    const patch = await supertest(app).patch('/api/students/stu_d3').set(authHeader(registrar)).send({ fullName: 'D3 Renamed', gender: 'female' });
    expect(patch.status).toBe(200);
    const paymentAudit = db.prepare(`SELECT operator_id, operator_role, action, new_value FROM audit_logs WHERE action LIKE 'Recorded fee payment%' ORDER BY rowid DESC LIMIT 1`).get() as any;
    expect(paymentAudit).toBeTruthy();
    expect(paymentAudit.operator_id).toBe('stu_reg');
    expect(paymentAudit.new_value).toContain(pay.body.receiptNumber);
    const profileAudit = db.prepare(`SELECT old_value, new_value FROM audit_logs WHERE action LIKE 'Updated student profile%' ORDER BY rowid DESC LIMIT 1`).get() as any;
    expect(profileAudit).toBeTruthy();
    expect(profileAudit.old_value).toContain('D3 Student');
    expect(profileAudit.new_value).toContain('D3 Renamed');
    expect(profileAudit.new_value).toContain('female');
  });

  // ── DEFECT 4: idempotency TOCTOU race ────────────────────────────────────
  it('control: concurrent same-key payments replay 200/201 without 500 or duplication', async () => {
    seedStudent('stu_d4', 'D4 Student', BRANCH_A, '0700000013');
    seedSemester('stu_d4', 'Level B1', 4000);
    const semId = (db.prepare(`SELECT id FROM student_semesters WHERE student_id='stu_d4' LIMIT 1`).get() as { id: string }).id;
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      supertest(app).post('/api/students/stu_d4/payments').set(authHeader(registrar)).set('Idempotency-Key', 'idem-d4-1').send({ amount: 4000, category: 'fee', semesterId: semId })));
    const statuses = results.map((r) => r.status).sort();
    console.log(`[EVIDENCE] same-key concurrent payments statuses: ${statuses.join(',')}`);
    expect(statuses.every((s) => s === 200 || s === 201)).toBe(true); // DEFECT: a 500 appears
    const payCount = (db.prepare(`SELECT COUNT(*) c FROM payments WHERE idempotency_key='idem-d4-1'`).get() as { c: number }).c;
    expect(payCount).toBe(1);
    const incCount = (db.prepare(`SELECT COUNT(*) c FROM financial_transactions WHERE payment_id IN (SELECT id FROM payments WHERE idempotency_key='idem-d4-1')`).get() as { c: number }).c;
    expect(incCount).toBe(1);
  });
});
