/**
 * EXM-2 — exam score correction is not a financial authority.
 * ============================================================================
 * Two exam-related fee semantics exist and the system already distinguishes
 * them by payment/income category:
 *
 *   'exam'    the examination SERVICE, charged at enrolment. Delivered as soon
 *             as the candidate sits the exam — a later score change cannot
 *             un-deliver it.
 *   'diploma' certificate ISSUANCE, charged ONCE PER STUDENT and only when no
 *             prior certificate and no prior diploma payment exist.
 *
 * Correcting a score downward revokes the certificate. It deliberately does
 * NOT reverse money: because the diploma charge is once-per-student and the
 * re-issue path does not re-bill, an automatic reversal would let a
 * down-then-up correction cycle refund the fee and then re-issue the same
 * certificate for free.
 *
 * Refunding a revoked certificate is an OWNER POLICY DECISION. If taken, it
 * must run through the single refund authority (POST /students/:id/refund,
 * `Refund.Approve`, idempotent, balance-checked) — never from the exam engine.
 *
 * These tests lock the invariant that matters for financial integrity:
 * a correction cycle must not MINT, DESTROY, DUPLICATE or REVERSE money, and
 * the ledger must stay reconciled.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import examsRouter from '../routes/exams.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { getFinanceAccount } from '../utils/financeAccounts.js';
import { computeReconciliation } from '../utils/reconciliation.js';
import { seedDefaultRules } from '../core/configuration/rule-engine.js';

const BRANCH = 'exm_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/exams', examsRouter);
  app.use(errorHandler);
  return app;
}
const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let app: express.Express;
let owner: TokenPayload;

const diplomaIncome = () =>
  (db
    .prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE type='income' AND category='diploma'`)
    .get() as { v: number }).v;
const ledgerRowCount = () =>
  (db.prepare(`SELECT COUNT(*) AS c FROM financial_transactions`).get() as { c: number }).c;
const certCount = () =>
  (db.prepare(`SELECT COUNT(*) AS c FROM certificates WHERE student_id = 'exm_stu'`).get() as { c: number }).c;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  // The pass/fail decision comes from the Rule Engine's
  // `rule_default_promotion_pass` rule, exactly as in production.
  seedDefaultRules();
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Exam Branch', 'Loc');
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES ('exm_owner', 'exm_owner', 'Exam Owner', ?, ?, 1, 0)`
  ).run(BRANCH, await hashPassword('testpass123'));
  assignRole('exm_owner', 'owner', BRANCH);

  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES ('exm_stu', 'TH-EXM-1', 'Exam Student', 'active', ?, ?, 'male', '0700555001')`
  ).run(today(), BRANCH);
  db.prepare(
    `INSERT OR IGNORE INTO exams (id, title, date, fee, type, branch_id)
     VALUES ('exm_exam', 'Final Exam', ?, 500, 'certification', ?)`
  ).run(today(), BRANCH);
  // A diploma fee must be configured for the entitlement charge to exist.
  db.prepare(
    `INSERT INTO branch_academic_profiles (branch_id, diploma_fee)
     VALUES (?, 500)
     ON CONFLICT(branch_id) DO UPDATE SET diploma_fee = 500`
  ).run(BRANCH);
  db.prepare(
    `INSERT OR IGNORE INTO exam_results (id, exam_id, student_id, candidate_name, score, status, exam_fee_paid, certificate_issued, branch_id)
     VALUES ('exm_res', 'exm_exam', 'exm_stu', 'Exam Student', 0, 'pending', 1, 0, ?)`
  ).run(BRANCH);
  owner = { userId: 'exm_owner', username: 'exm_owner', branchId: BRANCH, fullName: 'Exam Owner' } as TokenPayload;
  app = createApp();
});

const correct = (score: number) =>
  supertest(app)
    .put('/api/exams/exm_exam/results/exm_res/correct')
    .set(authHeader(owner))
    .send({ score, reason: 'correction' });

describe('EXM-2 — a correction cycle never mints, destroys or duplicates money', () => {
  // The default Rule Engine promotion rule passes at examScore >= 90
  // (policy-catalog.ts `rule_default_promotion_pass`), so the scores below
  // straddle that real threshold rather than an assumed one.
  it('an upward correction across the pass mark charges the diploma fee exactly once', async () => {
    const before = diplomaIncome();
    const res = await correct(95);
    expect(res.status).toBe(200);
    expect(res.body.certificateIssued).toBe(true);

    const after = diplomaIncome();
    expect(after).toBeGreaterThan(before);   // the entitlement was billed
    expect(certCount()).toBe(1);
  });

  it('a DOWNWARD correction revokes the certificate and reverses nothing', async () => {
    const incomeBefore = diplomaIncome();
    const rowsBefore = ledgerRowCount();

    const res = await correct(20);
    expect(res.status).toBe(200);
    expect(res.body.certificateIssued).toBe(false);
    expect(certCount()).toBe(0); // entitlement withdrawn

    // No reversal, no new ledger row, no negative income: money is neither
    // destroyed nor minted by an academic decision.
    expect(diplomaIncome()).toBe(incomeBefore);
    expect(ledgerRowCount()).toBe(rowsBefore);
    const negatives = db
      .prepare(`SELECT COUNT(*) AS c FROM financial_transactions WHERE category='diploma' AND amount < 0`)
      .get() as { c: number };
    expect(negatives.c).toBe(0);
  });

  it('re-issuing after a revocation does NOT bill the student a second time', async () => {
    const incomeBefore = diplomaIncome();
    const res = await correct(93);
    expect(res.status).toBe(200);
    expect(res.body.certificateIssued).toBe(true);
    // once-per-student rule holds across the revoke/re-issue cycle
    expect(diplomaIncome()).toBe(incomeBefore);
    expect(res.body.diplomaFee).toBe(0);
  });

  it('the exam SERVICE fee is never touched by a score change', async () => {
    const examIncome = (db
      .prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE type='income' AND category='exam'`)
      .get() as { v: number }).v;
    await correct(10);
    await correct(92);
    const after = (db
      .prepare(`SELECT COALESCE(SUM(amount),0) AS v FROM financial_transactions WHERE type='income' AND category='exam'`)
      .get() as { v: number }).v;
    expect(after).toBe(examIncome);
  });

  it('the exam engine writes no payment row and no refund row', () => {
    const rows = db
      .prepare(`SELECT COUNT(*) AS c FROM payments WHERE student_id = 'exm_stu' AND category IN ('refund','diploma')`)
      .get() as { c: number };
    // The correction path posts income via recordIncome() only; it must never
    // create payment/refund rows of its own.
    expect(rows.c).toBe(0);
  });

  // POLICY 2 (approved, explicit): a downward correction must NOT trigger a
  // refund. These assertions state that invariant directly rather than leaving
  // it implied by the absence of a reversal.
  it('POLICY: a downward correction issues no refund of any kind', async () => {
    // Put the candidate back above the pass mark, then correct downward.
    await correct(95);
    const paymentsBefore = (db
      .prepare(`SELECT COUNT(*) AS c FROM payments WHERE student_id = 'exm_stu'`)
      .get() as { c: number }).c;
    const negativeLedgerBefore = (db
      .prepare(`SELECT COUNT(*) AS c FROM financial_transactions WHERE amount < 0`)
      .get() as { c: number }).c;
    const incomeBefore = diplomaIncome();

    const res = await correct(15);
    expect(res.status).toBe(200);
    expect(res.body.certificateIssued).toBe(false);

    // No refund payment row, no negative ledger movement, no income reversal.
    const paymentsAfter = (db
      .prepare(`SELECT COUNT(*) AS c FROM payments WHERE student_id = 'exm_stu'`)
      .get() as { c: number }).c;
    const negativeLedgerAfter = (db
      .prepare(`SELECT COUNT(*) AS c FROM financial_transactions WHERE amount < 0`)
      .get() as { c: number }).c;
    expect(paymentsAfter).toBe(paymentsBefore);
    expect(negativeLedgerAfter).toBe(negativeLedgerBefore);
    expect(diplomaIncome()).toBe(incomeBefore);
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM payments WHERE category = 'refund'`).get() as { c: number }).c,
    ).toBe(0);
  });

  it('POLICY: the entitlement IS revoked even though the money is retained', () => {
    // Lifecycle authority acted (certificate withdrawn) while financial truth
    // was preserved — the two are decoupled on purpose.
    expect(certCount()).toBe(0);
    const row = db.prepare(`SELECT certificate_issued, certificate_no FROM exam_results WHERE id = 'exm_res'`).get() as
      { certificate_issued: number; certificate_no: string | null };
    expect(row.certificate_issued).toBe(0);
    expect(row.certificate_no).toBeNull();
  });

  it('cash stays backed and the ledger reconciles after the whole cycle', () => {
    const acct = getFinanceAccount('branch', BRANCH);
    expect(acct.mainBalance + acct.savingBalance).toBeGreaterThanOrEqual(0);

    const rec = computeReconciliation({ branchId: BRANCH, isAll: false });
    expect(Math.abs(rec.cashVariance)).toBeLessThan(0.01);
    expect(Math.abs(rec.savingVariance)).toBeLessThan(0.01);
    expect(rec.orphanLedgerRows).toBe(0);
    expect(rec.mismatchedPayments.length).toBe(0);
  });
});
