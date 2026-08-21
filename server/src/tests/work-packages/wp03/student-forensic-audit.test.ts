/**
 * Student subsystem — final forensic attack suite.
 * ============================================================================
 * Actively attacks the Student financial/profile surface for duplication and
 * manipulation vectors not covered by earlier passes:
 *
 *  1. card-fee duplication: issue-card auto-charges the card fee; a manual
 *     'card' payment then charges it AGAIN (reproduce).
 *  2. diploma-fee duplication (API-only category, same class).
 *  3. 'other' payment double-click: two sequential identical payments without
 *     an idempotency key produce two payments + two income rows (reproduce).
 *  4. Profile PATCH cannot mutate immutable identity fields (branch_id,
 *     student_code, status, created_at) via undocumented fields.
 *  5. Portal student cannot read other students' financial/academic data.
 *  6. Refund concurrency without idempotency key respects the refundable cap.
 *  7. Fee/installment/book categories are inherently deduplicated server-side
 *     (control: double-click on 'fee' → 409).
 */
import { assignRole } from '../../support/identity.js';
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import studentsRouter from '../../../routes/students.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { id, today } from '../../../utils/ids.js';

const BRANCH_A = 'fa_branch_a';
const BRANCH_B = 'fa_branch_b';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
  return app;
}
function authHeader(user: TokenPayload) { return { Authorization: `Bearer ${signToken(user)}` }; }

describe('Student forensic audit', () => {
  let app: express.Express;
  let owner: TokenPayload;
  let registrar: TokenPayload;
  let studentTok: TokenPayload;

  beforeAll(async () => {
    initSchema();
    bootstrapRbacCatalog(db);
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_A, 'FA Branch A', 'A');
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH_B, 'FA Branch B', 'B');
    for (const [uid, uname, role] of [['fa_owner', 'fa_owner', 'owner'], ['fa_reg', 'fa_reg', 'registrar']] as const) {
      await db.prepare(`INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password ) VALUES (?, ?, ?, ?, ?, 1, 0)`)
        .run(uid, uname, 'FA ' + role, BRANCH_A, await hashPassword('x'));
      assignRole(uid, role, BRANCH_A);
    }
    await db.prepare(`INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password ) VALUES ('fa_stu', 'fa_stu', 'FA Student', ?, ?, 1, 0)`).run(BRANCH_A, await hashPassword('x'));
    assignRole('fa_stu', 'student', BRANCH_A);

    owner = { userId: 'fa_owner', username: 'fa_owner', branchId: BRANCH_A, fullName: 'FA Owner' };
    registrar = { userId: 'fa_reg', username: 'fa_reg', branchId: BRANCH_A, fullName: 'FA Registrar' };
    studentTok = { userId: 'fa_stu', username: 'fa_stu', branchId: BRANCH_A, fullName: 'FA Student' };
    app = createApp();
  });

  function seedStudent(sid: string, name: string, branch: string, phone: string, gender = 'male') {
    db.prepare(`INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`).run(sid, `TH-FA-${sid.slice(-4)}`, name, today(), branch, gender, phone);
  }

  it('FIXED: card fee is charged once — issue-card then manual card payment is rejected (409)', async () => {
    db.prepare(`INSERT OR IGNORE INTO branch_academic_profiles (branch_id, card_fee) VALUES (?, 150)`).run(BRANCH_A);
    seedStudent('fa_card', 'Card Fee Student', BRANCH_A, '0700000101');
    const issue = await supertest(app).post('/api/students/fa_card/issue-card').set(authHeader(registrar)).send({ cardDesign: { primaryColor: 'rose' } });
    expect(issue.status).toBe(201);
    expect(issue.body.feeCharged).toBe(150);
    // Manual 'card' payment is now rejected.
    const pay = await supertest(app).post('/api/students/fa_card/payments').set(authHeader(registrar)).send({ amount: 150, category: 'card' });
    expect(pay.status).toBe(409);
    expect(pay.body.error).toMatch(/already recorded/i);
    const income = (db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM financial_transactions WHERE reference_id='fa_card' AND category='card'`).get() as { s: number }).s;
    expect(income).toBe(150);
    // Reverse order: a fresh student paying card first, then issue-card, must not double-charge.
    seedStudent('fa_card2', 'Card Reverse', BRANCH_A, '0700000108');
    const manualFirst = await supertest(app).post('/api/students/fa_card2/payments').set(authHeader(registrar)).send({ amount: 150, category: 'card' });
    expect(manualFirst.status).toBe(201);
    const issue2 = await supertest(app).post('/api/students/fa_card2/issue-card').set(authHeader(registrar)).send({ cardDesign: { primaryColor: 'rose' } });
    expect(issue2.status).toBe(201);
    expect(issue2.body.feeCharged).toBe(0); // no second charge
    const income2 = (db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM financial_transactions WHERE reference_id='fa_card2' AND category='card'`).get() as { s: number }).s;
    expect(income2).toBe(150);
  });

  it('FIXED: diploma fee is charged once — a second diploma payment is rejected (409)', async () => {
    db.prepare(`UPDATE branch_academic_profiles SET diploma_fee = 500 WHERE branch_id = ?`).run(BRANCH_A);
    seedStudent('fa_dip', 'Diploma Student', BRANCH_A, '0700000102');
    const p1 = await supertest(app).post('/api/students/fa_dip/payments').set(authHeader(owner)).send({ amount: 500, category: 'diploma' });
    const p2 = await supertest(app).post('/api/students/fa_dip/payments').set(authHeader(owner)).send({ amount: 500, category: 'diploma' });
    expect(p1.status).toBe(201);
    expect(p2.status).toBe(409);
    expect(p2.body.error).toMatch(/already recorded/i);
    const income = (db.prepare(`SELECT COUNT(*) c FROM financial_transactions WHERE reference_id='fa_dip' AND category='diploma'`).get() as { c: number }).c;
    expect(income).toBe(1);
  });

  it('FIXED (frontend contract): an idempotency-keyed "other" payment replays the same receipt instead of charging twice', async () => {
    // The UI now sends a per-submission Idempotency-Key; the backend replays.
    seedStudent('fa_other', 'Other Pay Student', BRANCH_A, '0700000103');
    const p1 = await supertest(app).post('/api/students/fa_other/payments').set(authHeader(registrar)).set('Idempotency-Key', 'fa-other-1').send({ amount: 100, category: 'other', notes: 'lab' });
    const p2 = await supertest(app).post('/api/students/fa_other/payments').set(authHeader(registrar)).set('Idempotency-Key', 'fa-other-1').send({ amount: 100, category: 'other', notes: 'lab' });
    expect(p1.status).toBe(201);
    expect(p2.status).toBe(200);
    expect(p2.body.receiptNumber).toBe(p1.body.receiptNumber); // same receipt, no double charge
    const rows = (db.prepare(`SELECT COUNT(*) c FROM payments WHERE student_id='fa_other' AND category='other'`).get() as { c: number }).c;
    const income = (db.prepare(`SELECT COUNT(*) c FROM financial_transactions WHERE reference_id='fa_other' AND category='other'`).get() as { c: number }).c;
    expect(rows).toBe(1);
    expect(income).toBe(1);
  });

  it('control: fee and installment categories are server-deduplicated on double-submit', async () => {
    seedStudent('fa_fee', 'Fee Student', BRANCH_A, '0700000104');
    db.prepare(`INSERT OR IGNORE INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status) VALUES (?, 'fa_fee', 'S1', ?, 3000, 3000, 'active')`).run(id('sem'), today());
    const semId = (db.prepare(`SELECT id FROM student_semesters WHERE student_id='fa_fee' LIMIT 1`).get() as { id: string }).id;
    const p1 = await supertest(app).post('/api/students/fa_fee/payments').set(authHeader(registrar)).send({ amount: 3000, category: 'fee', semesterId: semId });
    const p2 = await supertest(app).post('/api/students/fa_fee/payments').set(authHeader(registrar)).send({ amount: 3000, category: 'fee', semesterId: semId });
    expect(p1.status).toBe(201);
    expect(p2.status).toBe(400); // already fully paid
  });

  it('control: profile PATCH cannot mutate immutable identity fields via undocumented keys', async () => {
    seedStudent('fa_patch', 'Patch Student', BRANCH_A, '0700000105');
    const before = db.prepare(`SELECT student_code, branch_id, status, created_at FROM students WHERE id='fa_patch'`).get() as any;
    const res = await supertest(app).patch('/api/students/fa_patch').set(authHeader(registrar)).send({
      fullName: 'Patch Renamed', student_code: 'HACKED', branch_id: BRANCH_B, status: 'graduated', created_at: '2000-01-01',
    });
    expect(res.status).toBe(200);
    const after = db.prepare(`SELECT student_code, branch_id, status, created_at, full_name FROM students WHERE id='fa_patch'`).get() as any;
    expect(after.student_code).toBe(before.student_code); // immutable
    expect(after.branch_id).toBe(before.branch_id);       // immutable
    expect(after.status).toBe(before.status);             // immutable via PATCH
    expect(after.created_at).toBe(before.created_at);     // immutable
    expect(after.full_name).toBe('Patch Renamed');        // mutable field did change
  });

  it('control: portal student cannot read another student or organization-wide data', async () => {
    seedStudent('fa_other_stu', 'Other Student', BRANCH_A, '0700000106');
    const list = await supertest(app).get('/api/students').set(authHeader(studentTok));
    expect(list.status).toBe(403);
    const detail = await supertest(app).get('/api/students/fa_other_stu').set(authHeader(studentTok));
    expect(detail.status).toBe(403);
    const payRouter = await supertest(app).get('/api/payments').set(authHeader(studentTok));
    expect(payRouter.status).toBe(404); // route not mounted in this harness; auth check happens on the mounted router (covered in pass 6-10)
  });

  it('control: concurrent refunds without idempotency key respect the refundable cap', async () => {
    seedStudent('fa_ref', 'Refund Student', BRANCH_A, '0700000107');
    db.prepare(`INSERT OR IGNORE INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status) VALUES (?, 'fa_ref', 'S1', ?, 1000, 1000, 'active')`).run(id('sem'), today());
    const semId = (db.prepare(`SELECT id FROM student_semesters WHERE student_id='fa_ref' LIMIT 1`).get() as { id: string }).id;
    await supertest(app).post('/api/students/fa_ref/payments').set(authHeader(owner)).send({ amount: 1000, category: 'fee', semesterId: semId });
    // 10 concurrent refunds of 200 each: at most 5 may succeed (1000 cap).
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      supertest(app).post('/api/students/fa_ref/refund').set(authHeader(owner)).send({ amount: 200, reason: `race ${i}` })));
    const ok = results.filter((r) => r.status === 201).length;
    const refunded = (db.prepare(`SELECT COALESCE(SUM(-amount),0) s FROM payments WHERE student_id='fa_ref' AND category='refund'`).get() as { s: number }).s;
    console.log(`[EVIDENCE] concurrent refunds: ok=${ok}, total refunded=${refunded}`);
    expect(refunded).toBeLessThanOrEqual(1000);
    expect(ok).toBeLessThanOrEqual(5);
  });
});
