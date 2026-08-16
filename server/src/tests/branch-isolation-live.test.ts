/**
 * Branch isolation — end-to-end through the real HTTP + RBAC stack (group F9)
 * ============================================================================
 * Addendum 4 tested branch isolation at the QUERY layer only, because the live
 * database had a single branch. That left the honest gap: no evidence that a
 * real manager, authenticated as themselves against the real middleware, is
 * confined to their own branch.
 *
 * This suite closes it. It builds two branches, a manager scoped to each, and
 * drives the actual routers through supertest with real signed tokens — so
 * `authenticate`, `resolveBranchScope`, `canAccessBranchResource` and the RBAC
 * catalogue are all in the path.
 *
 * Amounts are deliberately unmistakable (11111 vs 77777) so a leak cannot hide
 * behind a coincidental substring. That matters: a first live attack reported
 * two "leaks" that turned out to be the digits of one branch's figure
 * appearing incidentally inside an unrelated number. Both were false
 * positives; distinctive values disproved them.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { studentsRouter, paymentsRouter } from '../routes/students.routes.js';
import { invoicesRouter } from '../routes/invoices.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { today } from '../utils/ids.js';

const BR_A = 'live_iso_a';
const BR_B = 'live_iso_b';
const A_AMOUNT = 11111;
const B_AMOUNT = 77777;

const STU_A = 'live_iso_stu_a';
const STU_B = 'live_iso_stu_b';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use(errorHandler);
  return app;
}
const mgr = (branchId: string, id: string): TokenPayload => ({
  userId: id, username: id, role: 'manager', branchId, fullName: `Mgr ${branchId}`,
});
const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let app: express.Express;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  const d = today();

  for (const [b, name] of [[BR_A, 'Live Iso A'], [BR_B, 'Live Iso B']]) {
    db.prepare(`INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'Loc')`).run(b, name);
  }

  const pw = await hashPassword('x');
  for (const [uid, br] of [['u_live_a', BR_A], ['u_live_b', BR_B]]) {
    db.prepare(
      `INSERT OR REPLACE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
       VALUES (?, ?, ?, 'manager', ?, ?, 1, 0)`,
    ).run(uid, uid, uid, br, pw);
  }
  syncLegacyUserRoles(db);

  // One student per branch, each with a distinctive payment.
  const mkStudent = (id: string, code: string, name: string, phone: string, branch: string) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO students (id, student_code, full_name, gender, phone, status, registration_date, branch_id)
         VALUES (?, ?, ?, 'male', ?, 'active', ?, ?)`,
      )
      .run(id, code, name, phone, d, branch);

  mkStudent(STU_A, 'LIVE-A', 'Alpha Branch Student', '0700111111', BR_A);
  mkStudent(STU_B, 'LIVE-B', 'Beta Branch Student', '0700777777', BR_B);

  const mkPayment = (id: string, student: string, amount: number, branch: string) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO payments (id, student_id, amount, date, payment_method, status, category, receipt_number, branch_id, idempotency_key)
         VALUES (?, ?, ?, ?, 'cash', 'completed', 'fee', ?, ?, hex(randomblob(16)))`,
      )
      .run(id, student, amount, d, `RC-${id}`, branch);

  mkPayment('live_pay_a', STU_A, A_AMOUNT, BR_A);
  mkPayment('live_pay_b', STU_B, B_AMOUNT, BR_B);

  app = createApp();
});

describe('a manager reads only their own branch', () => {
  it('GET /students returns only the caller branch roster', async () => {
    const res = await supertest(app).get('/api/students').set(auth(mgr(BR_B, 'u_live_b')));
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('Beta Branch Student');
    expect(body).not.toContain('Alpha Branch Student');
  });

  it('GET /payments never exposes the other branch amount', async () => {
    const res = await supertest(app).get('/api/payments').set(auth(mgr(BR_B, 'u_live_b')));
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain(String(B_AMOUNT));
    expect(body).not.toContain(String(A_AMOUNT));
  });

  it('the two branches do not receive identical payloads', async () => {
    const a = await supertest(app).get('/api/payments').set(auth(mgr(BR_A, 'u_live_a')));
    const b = await supertest(app).get('/api/payments').set(auth(mgr(BR_B, 'u_live_b')));
    expect(JSON.stringify(a.body)).not.toBe(JSON.stringify(b.body));
    expect(JSON.stringify(a.body)).toContain(String(A_AMOUNT));
    expect(JSON.stringify(a.body)).not.toContain(String(B_AMOUNT));
  });

  it('passing another branch id as a query parameter does not escalate', async () => {
    const res = await supertest(app)
      .get('/api/payments')
      .query({ branchId: BR_A })
      .set(auth(mgr(BR_B, 'u_live_b')));
    if (res.status === 200) {
      expect(JSON.stringify(res.body)).not.toContain(String(A_AMOUNT));
    } else {
      expect([400, 403]).toContain(res.status);
    }
  });
});

describe('a manager cannot WRITE across branches', () => {
  it('reading a foreign student is refused', async () => {
    const res = await supertest(app).get(`/api/students/${STU_A}`).set(auth(mgr(BR_B, 'u_live_b')));
    expect([403, 404]).toContain(res.status);
  });

  it('recording a payment against a foreign student is refused', async () => {
    const before = (db.prepare(`SELECT COUNT(*) AS c FROM payments WHERE student_id = ?`).get(STU_A) as { c: number }).c;
    const res = await supertest(app)
      .post(`/api/students/${STU_A}/payments`)
      .set(auth(mgr(BR_B, 'u_live_b')))
      .send({ amount: 500, category: 'other' });
    expect([403, 404]).toContain(res.status);

    const after = (db.prepare(`SELECT COUNT(*) AS c FROM payments WHERE student_id = ?`).get(STU_A) as { c: number }).c;
    expect(after).toBe(before); // nothing was written
  });

  it('refunding a foreign student is refused', async () => {
    const res = await supertest(app)
      .post(`/api/students/${STU_A}/refund`)
      .set(auth(mgr(BR_B, 'u_live_b')))
      .send({ amount: 100, reason: 'cross-branch attempt' });
    expect([403, 404]).toContain(res.status);
  });

  it('invoicing a foreign student is refused', async () => {
    const res = await supertest(app)
      .post('/api/invoices')
      .set(auth(mgr(BR_B, 'u_live_b')))
      .send({ studentId: STU_A, items: [{ description: 'x', quantity: 1, unitPrice: 100 }] });
    expect([403, 404]).toContain(res.status);
  });

  it('the caller CAN still operate inside their own branch', async () => {
    const res = await supertest(app)
      .post(`/api/students/${STU_B}/payments`)
      .set(auth(mgr(BR_B, 'u_live_b')))
      .send({ amount: 250, category: 'other' });
    expect(res.status).toBe(201);
  });
});
