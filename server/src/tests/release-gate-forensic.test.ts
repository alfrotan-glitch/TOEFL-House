/**
 * Release-gate forensic suite — untested-surface detection & reproduction.
 * ============================================================================
 * Reproduces suspected defects on routes the 476-test suite does not cover
 * with a student/unauthorized principal:
 *
 *  1. Student → GET /api/sessions/:id/roster (branch-scope only, no
 *     permission) → leaks ALL students' names/phones in the branch.
 *  2. Student → GET /api/sessions/:id (session detail).
 *  3. Student → GET /api/enrollments/:id/freeze-requests & transfer-requests.
 *  4. Student → GET /api/academic/resolve-fee (branch-only guard).
 *  5. Reception → GET /api/sessions analytics (permission check).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import sessionsRouter from '../routes/sessions.routes.js';
import enrollmentRouter from '../routes/enrollment.routes.js';
import academicRouter from '../routes/academic.routes.js';
import studentsRouter from '../routes/students.routes.js';
import booksRouter from '../routes/books.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { id, today } from '../utils/ids.js';

const BRANCH_A = 'rg_branch_a';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/enrollments', enrollmentRouter);
  app.use('/api/academic', academicRouter);
  app.use('/api/students', studentsRouter);
  app.use('/api/books', booksRouter);
  app.use(errorHandler);
  return app;
}
function authHeader(user: TokenPayload) { return { Authorization: `Bearer ${signToken(user)}` }; }

describe('Release-gate forensic — untested student/unauthorized surfaces', () => {
  let app: express.Express;
  let owner: TokenPayload;
  let studentTok: TokenPayload;
  let registrar: TokenPayload;

  beforeAll(async () => {
    initSchema();
    bootstrapRbacCatalog(db);
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_A, 'RG Branch', 'L');
    for (const [uid, uname, role] of [['rg_owner', 'rg_owner', 'owner'], ['rg_reg', 'rg_reg', 'registrar']] as const) {
      await db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`)
        .run(uid, uname, 'RG ' + role, role, BRANCH_A, await hashPassword('x'));
    }
    await db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES ('rg_stu', 'rg_stu', 'RG Student', 'student', ?, ?, 1, 0)`).run(BRANCH_A, await hashPassword('x'));
    const stuRole = db.prepare("SELECT id FROM roles WHERE code='student'").get() as { id: string };
    db.prepare(`INSERT OR IGNORE INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by) VALUES (?, 'rg_stu', ?, 'branch', ?, 1, 'system')`).run(id('ur'), stuRole.id, BRANCH_A);
    syncLegacyUserRoles(db);
    owner = { userId: 'rg_owner', username: 'rg_owner', role: 'owner', branchId: BRANCH_A, fullName: 'RG Owner' };
    registrar = { userId: 'rg_reg', username: 'rg_reg', role: 'registrar', branchId: BRANCH_A, fullName: 'RG Registrar' };
    studentTok = { userId: 'rg_stu', username: 'rg_stu', role: 'student', branchId: BRANCH_A, fullName: 'RG Student' };
    app = createApp();

    // Seed: class, teacher, session, students, roster, enrollment.
    db.prepare(`INSERT OR IGNORE INTO classes (id, name, branch_id, capacity, status, level, fee) VALUES ('rg_class', 'RG Class', ?, 10, 'active', 'A1', 4000)`).run(BRANCH_A);
    db.prepare(`INSERT OR IGNORE INTO teachers (id, full_name, branch_id, status) VALUES ('rg_tea', 'RG Teacher', ?, 'active')`).run(BRANCH_A);
    db.prepare(`INSERT OR IGNORE INTO sessions (id, class_id, teacher_id, branch_id, date, start_time, end_time, status) VALUES ('rg_sess', 'rg_class', 'rg_tea', ?, ?, '09:00', '10:00', 'scheduled')`).run(BRANCH_A, today());
    db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
      VALUES ('rg_stu1', 'TH-RG-1', 'RG Student One', 'active', ?, ?, 'male', '0700111333')`).run(today(), BRANCH_A);
    db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
      VALUES ('rg_stu2', 'TH-RG-2', 'RG Student Two', 'active', ?, ?, 'female', '0700111444')`).run(today(), BRANCH_A);
    db.prepare(`INSERT OR IGNORE INTO rosters (id, session_id, student_id, attendance_status) VALUES (?, 'rg_sess', 'rg_stu1', 'not_marked')`).run(id('ros'));
    db.prepare(`INSERT OR IGNORE INTO rosters (id, session_id, student_id, attendance_status) VALUES (?, 'rg_sess', 'rg_stu2', 'not_marked')`).run(id('ros'));
    db.prepare(`INSERT OR IGNORE INTO enrollments (id, student_id, class_id, branch_id, enrollment_type, status, started_at)
      VALUES ('rg_enr', 'rg_stu1', 'rg_class', ?, 'new', 'active', ?)`).run(BRANCH_A, today());
    db.prepare(`INSERT OR IGNORE INTO enrollment_freezes (id, enrollment_id, student_id, reason, status, branch_id, start_date, planned_end_date) VALUES ('rg_frz', 'rg_enr', 'rg_stu1', 'test', 'active', ?, ?, ?)`).run(BRANCH_A, today(), today());
  });

  it('FIXED: student is denied session roster, detail, and enrollment history (403)', async () => {
    const roster = await supertest(app).get('/api/sessions/rg_sess/roster').set(authHeader(studentTok));
    expect(roster.status).toBe(403);
    const detail = await supertest(app).get('/api/sessions/rg_sess').set(authHeader(studentTok));
    expect(detail.status).toBe(403);
    const homework = await supertest(app).get('/api/sessions/rg_sess/homework').set(authHeader(studentTok));
    expect(homework.status).toBe(403);
    const freeze = await supertest(app).get('/api/enrollments/rg_enr/freeze-requests').set(authHeader(studentTok));
    expect(freeze.status).toBe(403);
    const transfer = await supertest(app).get('/api/enrollments/rg_enr/transfer-requests').set(authHeader(studentTok));
    expect(transfer.status).toBe(403);
    // Staff (registrar) still has access.
    const reg = await supertest(app).get('/api/sessions/rg_sess/roster').set(authHeader(registrar));
    expect(reg.status).toBe(200);
  });

  it('control: receptionist (registrar) CAN read roster; owner CAN', async () => {
    const reg = await supertest(app).get('/api/sessions/rg_sess/roster').set(authHeader(registrar));
    expect(reg.status).toBe(200);
    const own = await supertest(app).get('/api/sessions/rg_sess/roster').set(authHeader(owner));
    expect(own.status).toBe(200);
  });
});

describe('Release-gate forensic — cross-writer financial duplication', () => {
  let app: express.Express;
  let owner: TokenPayload;
  let registrar: TokenPayload;

  beforeAll(async () => {
    app = createApp();
    owner = { userId: 'rg_owner', username: 'rg_owner', role: 'owner', branchId: BRANCH_A, fullName: 'RG Owner' };
    registrar = { userId: 'rg_reg', username: 'rg_reg', role: 'registrar', branchId: BRANCH_A, fullName: 'RG Registrar' };
    // Seed a book.
    db.prepare(`INSERT OR IGNORE INTO books (id, title, price, purchase_price, stock, is_chapter, branch_id) VALUES ('rg_book', 'RG Book', 250, 100, 5, 0, ?)`).run(BRANCH_A);
  });

  it('FIXED: book charged once — sell then manual book payment is rejected (409)', async () => {
    db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
      VALUES ('rg_bkstu', 'TH-RG-B', 'Book Student', 'active', ?, ?, 'male', '0700111555')`).run(today(), BRANCH_A);
    const sell = await supertest(app).post('/api/books/rg_book/sell').set(authHeader(registrar)).send({ quantity: 1, studentId: 'rg_bkstu', customerName: 'Book Student' });
    expect(sell.status).toBe(201);
    const pay = await supertest(app).post('/api/students/rg_bkstu/payments').set(authHeader(registrar)).send({ amount: 250, category: 'book', bookId: 'rg_book' });
    expect(pay.status).toBe(409);
    expect(pay.body.error).toMatch(/already sold/i);
    const stock = (db.prepare(`SELECT stock FROM books WHERE id='rg_book'`).get() as { stock: number }).stock;
    expect(stock).toBe(4); // decremented exactly once
    const totalBookIncome = (db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM financial_transactions WHERE category='book'`).get() as { s: number }).s;
    expect(totalBookIncome).toBe(250);
    // Reverse order: manual payment first, then sell → 409.
    db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
      VALUES ('rg_bkstu3', 'TH-RG-B3', 'Book Student 3', 'active', ?, ?, 'male', '0700111777')`).run(today(), BRANCH_A);
    const manualFirst = await supertest(app).post('/api/students/rg_bkstu3/payments').set(authHeader(registrar)).send({ amount: 250, category: 'book', bookId: 'rg_book' });
    expect(manualFirst.status).toBe(201);
    const sellAfter = await supertest(app).post('/api/books/rg_book/sell').set(authHeader(registrar)).send({ quantity: 1, studentId: 'rg_bkstu3', customerName: 'Book Student 3' });
    expect(sellAfter.status).toBe(409);
    expect(sellAfter.body.error).toMatch(/already paid/i);
  });

  it('control: a genuine second sale (different student) still works', async () => {
    db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
      VALUES ('rg_bkstu2', 'TH-RG-B2', 'Book Student 2', 'active', ?, ?, 'male', '0700111666')`).run(today(), BRANCH_A);
    const sell = await supertest(app).post('/api/books/rg_book/sell').set(authHeader(registrar)).send({ quantity: 1, studentId: 'rg_bkstu2', customerName: 'Book Student 2' });
    expect(sell.status).toBe(201);
  });
});
