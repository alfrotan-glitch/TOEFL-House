/**
 * FINAL CLOSURE — authority invariants that must not silently regress.
 * ============================================================================
 * Each block below corresponds to a closure item that was investigated
 * empirically. Several were previously carried as "open questions"; the
 * evidence is recorded here as an executable assertion so the conclusion
 * cannot rot. Where the finding was "already safe", the test locks the
 * property in place rather than asserting a fix.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import studentsRouter from '../routes/students.routes.js';
import workflowsRouter from '../routes/workflows.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { resolveAuthorizedDiscount } from '../core/configuration/discount-authority.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';
import { computeReconciliation } from '../utils/reconciliation.js';
import { ROLE_DEFINITIONS } from '../core/rbac/permission-catalog.js';

const BRANCH = 'clo_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use('/api/workflows', workflowsRouter);
  app.use(errorHandler);
  return app;
}
const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let app: express.Express;
let owner: TokenPayload;
let hod: TokenPayload;

async function seedUser(uid: string, role: string, branchId = BRANCH) {
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`
  ).run(uid, uid, `User ${uid}`, branchId, await hashPassword('testpass123'));
  assignRole(uid, role, branchId);
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Closure', 'Loc');
  await seedUser('u_clo_owner', 'owner');
  await seedUser('u_clo_hod', 'head_of_department');

  owner = { userId: 'u_clo_owner', username: 'u_clo_owner', branchId: BRANCH, fullName: 'Owner' } as TokenPayload;
  hod = { userId: 'u_clo_hod', username: 'u_clo_hod', branchId: BRANCH, fullName: 'HOD' } as TokenPayload;
  app = createApp();
});

// ---------------------------------------------------------------------------
// ITEM 2 — head_of_department vs the academic hold.
// The RBAC catalog describes this role as "Academic scope only": it holds
// Promotion.Approve but NO Payment/Refund/Invoice/Discount permission. The
// hold's override list is owner / general_manager / finance_manager. Those two
// facts agree, so the role may decide promotions but may never waive debt.
// ---------------------------------------------------------------------------

/**
 * The payment a refund reverses. Owner decision D-113 makes attribution
 * mandatory, so a fixture that refunds names the charge it reverses — here, the
 * student's most recent refundable payment.
 */
function latestRefundablePaymentId(studentId: string): string {
  const row = db
    .prepare(
      `SELECT id FROM payments
        WHERE student_id = ? AND status = 'completed' AND category <> 'refund' AND amount > 0
        ORDER BY date DESC, rowid DESC LIMIT 1`,
    )
    .get(studentId) as { id: string } | undefined;
  if (!row) throw new Error(`fixture: student ${studentId} has no refundable payment`);
  return row.id;
}

describe('CLOSURE-2 — head_of_department is academic-only and cannot waive debt', () => {
  it('holds Promotion.Approve but no financial permission in the catalog', () => {
    const role = ROLE_DEFINITIONS.find((r) => r.code === 'head_of_department');
    expect(role).toBeTruthy();
    const perms = Object.keys(role!.permissions ?? {});
    expect(perms).toContain('Promotion.Approve');
    for (const financial of ['Payment.Create', 'Payment.Edit', 'Refund.Approve', 'Invoice.Create', 'Discount.Approve']) {
      expect(perms).not.toContain(financial);
    }
  });

  it('is blocked by the academic hold on new enrolment, while owner may override', async () => {
    db.prepare(
      `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
       VALUES ('clo_s_hold', 'TH-CLO-1', 'Hold Student', 'active', ?, ?, 'male', '0700111001')`
    ).run(today(), BRANCH);
    db.prepare(
      `INSERT OR IGNORE INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, net_fee_amount, status)
       VALUES ('clo_sem_hold', 'clo_s_hold', 'Term 1', ?, 20000, 20000, 'active')`
    ).run(today());
    db.prepare(
      `INSERT OR IGNORE INTO classes (id, name, level, branch_id, status, lifecycle_stage, capacity, fee)
       VALUES ('clo_c_next', 'Next', 'A2', ?, 'active', 'in_progress', 10, 20000)`
    ).run(BRANCH);

    const blocked = await supertest(app)
      .post('/api/students/clo_s_hold/enroll-semester')
      .set(authHeader(hod))
      .send({ semesterName: 'Term 2 HOD', classId: 'clo_c_next', tuitionAmount: 20000 });
    expect(blocked.status).toBe(403);
    expect(String(blocked.body.error)).toContain('Academic Hold');

    const allowed = await supertest(app)
      .post('/api/students/clo_s_hold/enroll-semester')
      .set(authHeader(owner))
      .send({ semesterName: 'Term 2 Owner', classId: 'clo_c_next', tuitionAmount: 20000 });
    expect(allowed.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// ITEM 4 — a revived sponsorship agreement grants no discount authority.
// The discount authority reads student_discount_authorizations, NOT
// sponsorship_agreements, so flipping an agreement terminated -> active cannot
// restore a financial entitlement. Only the separately-revocable
// authorization row can.
// ---------------------------------------------------------------------------
describe('CLOSURE-4 — sponsorship revival cannot restore discount authority', () => {
  beforeAll(() => {
    db.prepare(
      `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
       VALUES ('clo_s_spon', 'TH-CLO-2', 'Sponsored', 'active', ?, ?, 'male', '0700111002')`
    ).run(today(), BRANCH);
    db.prepare(`INSERT OR IGNORE INTO donors (id, full_name) VALUES ('clo_d1', 'Donor')`).run();
    db.prepare(
      `INSERT OR IGNORE INTO sponsorship_agreements (id, donor_id, student_id, monthly_amount, start_date, end_date, status, branch_id)
       VALUES ('clo_sa1', 'clo_d1', 'clo_s_spon', 1000, ?, ?, 'terminated', ?)`
    ).run(today(), today(), BRANCH);
  });

  it('terminated agreement => ordinary ceiling', () => {
    expect(resolveAuthorizedDiscount(db, 'clo_s_spon', 100, { branchId: BRANCH }).percent).toBe(20);
  });

  it('agreement revived to active STILL grants only the ordinary ceiling', () => {
    db.prepare(`UPDATE sponsorship_agreements SET status = 'active' WHERE id = 'clo_sa1'`).run();
    expect(resolveAuthorizedDiscount(db, 'clo_s_spon', 100, { branchId: BRANCH }).percent).toBe(20);
  });

  it('a revoked authorization grants nothing; only an active one authorizes', () => {
    db.prepare(
      `INSERT OR IGNORE INTO student_discount_authorizations (id, student_id, category, approved_percent, status, branch_id)
       VALUES ('clo_a1', 'clo_s_spon', 'SPONSORSHIP', 100, 'revoked', ?)`
    ).run(BRANCH);
    expect(resolveAuthorizedDiscount(db, 'clo_s_spon', 100, { branchId: BRANCH }).percent).toBe(20);

    db.prepare(`UPDATE student_discount_authorizations SET status = 'active' WHERE id = 'clo_a1'`).run();
    expect(resolveAuthorizedDiscount(db, 'clo_s_spon', 100, { branchId: BRANCH }).percent).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// ITEM 6 — sub-cent amounts cannot create phantom money.
// assertMoney rounds 0.001 -> 0, so the risk was a zero-amount payment row
// with a real receipt. Every money boundary rejects it before any write.
// ---------------------------------------------------------------------------
describe('CLOSURE-6 — sub-cent and zero amounts never reach a money writer', () => {
  it('rejects sub-cent and zero payments and writes nothing', async () => {
    db.prepare(
      `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
       VALUES ('clo_s_cent', 'TH-CLO-3', 'Cent', 'active', ?, ?, 'male', '0700111003')`
    ).run(today(), BRANCH);

    const before = db.prepare(`SELECT COUNT(*) AS c FROM payments WHERE student_id = 'clo_s_cent'`).get() as { c: number };
    for (const amount of [0.001, 0, 0.004]) {
      const res = await supertest(app)
        .post('/api/students/clo_s_cent/payments')
        .set(authHeader(owner))
        .set('Idempotency-Key', `clo-cent-${amount}`)
        .send({ amount, category: 'other', notes: 'sub-cent probe' });
      expect(res.status).toBe(400);
    }
    const after = db.prepare(`SELECT COUNT(*) AS c FROM payments WHERE student_id = 'clo_s_cent'`).get() as { c: number };
    expect(after.c).toBe(before.c); // no phantom rows
  });

  it('rejects a sub-cent refund', async () => {
    // A refund now names the payment it reverses, so the student needs real
    // money on file before the amount itself can be the thing under test.
    const seeded = await supertest(app)
      .post('/api/students/clo_s_cent/payments')
      .set(authHeader(owner))
      .set('Idempotency-Key', 'clo-cent-seed')
      .send({ amount: 1000, category: 'other', notes: 'refund probe seed' });
    expect(seeded.status).toBe(201);

    const res = await supertest(app)
      .post('/api/students/clo_s_cent/refund')
      .set(authHeader(owner))
      .set('Idempotency-Key', 'clo-cent-refund')
      .send({ amount: 0.001, reason: 'sub-cent', paymentId: latestRefundablePaymentId('clo_s_cent') });
    expect(res.status).toBe(400);
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM payments WHERE student_id = 'clo_s_cent' AND category = 'refund'`).get() as { c: number }).c,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ITEM 7 — workflows are advisory. Nothing outside the workflow router reads
// workflow_instances, so approving a workflow authorizes nothing on its own.
// This test fails the moment someone makes money/entitlement depend on it
// without building a real consuming authority.
// ---------------------------------------------------------------------------
describe('CLOSURE-7 — workflow approval is advisory and authorizes nothing', () => {
  it('approving a workflow moves no money and changes no student state', async () => {
    const cashBefore = getFinanceAccount('branch', BRANCH);
    db.prepare(
      `INSERT OR IGNORE INTO workflow_definitions (id, name, trigger, steps, is_active)
       VALUES ('clo_wd', 'Closure WF', 'manual', ?, 1)`
    ).run(JSON.stringify([{ order: 1, role: 'owner', action: 'approve' }]));
    db.prepare(
      `INSERT OR IGNORE INTO workflow_instances (id, definition_id, entity_type, entity_id, current_step, status, branch_id, initiated_by, payload)
       VALUES ('clo_wi', 'clo_wd', 'student', 'clo_s_hold', 1, 'in_progress', ?, 'u_clo_owner', '{}')`
    ).run(BRANCH);

    const res = await supertest(app)
      .post('/api/workflows/instances/clo_wi/approve')
      .set(authHeader(owner))
      .send({ notes: 'closure probe' });
    expect([200, 403, 404]).toContain(res.status);

    const cashAfter = getFinanceAccount('branch', BRANCH);
    expect(cashAfter.mainBalance).toBe(cashBefore.mainBalance);
    expect(cashAfter.savingBalance).toBe(cashBefore.savingBalance);
  });

  it('is not read by any financial or entitlement authority (advisory by construction)', () => {
    // A workflow row in any status must not alter the resolved discount.
    const before = resolveAuthorizedDiscount(db, 'clo_s_hold', 100, { branchId: BRANCH }).percent;
    db.prepare(`UPDATE workflow_instances SET status = 'approved' WHERE id = 'clo_wi'`).run();
    const after = resolveAuthorizedDiscount(db, 'clo_s_hold', 100, { branchId: BRANCH }).percent;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// ITEM 8 — student_semesters may only ever hold a legal status, and the
// database CHECK is the backstop for every writer (5 of them).
// ---------------------------------------------------------------------------
describe('CLOSURE-8 — student_semesters status domain is enforced by the database', () => {
  it('rejects any status outside active/completed/deferred', () => {
    db.prepare(
      `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
       VALUES ('clo_s_dom', 'TH-CLO-4', 'Domain', 'active', ?, ?, 'male', '0700111004')`
    ).run(today(), BRANCH);
    expect(() =>
      db.prepare(
        `INSERT INTO student_semesters (id, student_id, semester_name, enroll_date, fee_amount, status)
         VALUES ('clo_sem_bad', 'clo_s_dom', 'Bad', ?, 0, 'graduated')`
      ).run(today())
    ).toThrow(/CHECK constraint failed/i);
  });

  it('every live semester row holds a legal status', () => {
    const bad = db
      .prepare(`SELECT COUNT(*) AS c FROM student_semesters WHERE status NOT IN ('active','completed','deferred')`)
      .get() as { c: number };
    expect(bad.c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ITEM 12 — the ledger reconciles after real activity, and cash is only ever
// the difference between operating income and the savings sweep.
// ---------------------------------------------------------------------------
describe('CLOSURE-12 — financial reconciliation holds after real HTTP activity', () => {
  it('payment + refund leave the ledger reconciled with no orphans', async () => {
    db.prepare(
      `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
       VALUES ('clo_s_rec', 'TH-CLO-5', 'Recon', 'active', ?, ?, 'male', '0700111005')`
    ).run(today(), BRANCH);

    const pay = await supertest(app)
      .post('/api/students/clo_s_rec/payments')
      .set(authHeader(owner))
      .set('Idempotency-Key', 'clo-rec-pay')
      .send({ amount: 1000, category: 'other', notes: 'recon seed' });
    expect(pay.status).toBe(201);

    const refund = await supertest(app)
      .post('/api/students/clo_s_rec/refund')
      .set(authHeader(owner))
      .set('Idempotency-Key', 'clo-rec-ref')
      .send({ amount: 400, reason: 'partial', paymentId: latestRefundablePaymentId('clo_s_rec') });
    expect(refund.status).toBe(201);

    const refunded = db
      .prepare(`SELECT COALESCE(SUM(ABS(amount)),0) AS v FROM payments WHERE student_id = 'clo_s_rec' AND category = 'refund'`)
      .get() as { v: number };
    expect(refunded.v).toBe(400);

    const rec = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(rec.unmatchedPayments).toBe(0);
    expect(rec.orphanLedgerRows).toBe(0);
    expect(rec.mismatchedPayments.length).toBe(0);
    expect(Math.abs(rec.cashVariance)).toBeLessThan(0.01);
    expect(Math.abs(rec.savingVariance)).toBeLessThan(0.01);
  });

  it('refunds beyond the refundable balance are refused (no negative-cash minting)', async () => {
    const res = await supertest(app)
      .post('/api/students/clo_s_rec/refund')
      .set(authHeader(owner))
      .set('Idempotency-Key', 'clo-rec-over')
      .send({ amount: 100000, reason: 'over-refund', paymentId: latestRefundablePaymentId('clo_s_rec') });
    expect(res.status).toBe(400);

    const rec = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(Math.abs(rec.cashVariance)).toBeLessThan(0.01);
  });
});
