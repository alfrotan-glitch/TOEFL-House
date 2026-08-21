/**
 * JRN-1 — journey enrollment discount must respect the canonical authority.
 *
 * `POST /api/students/:id/journey/enrollments` accepted an absolute
 * `discountAmount` from the request body and passed it straight into
 * EnrollmentService.enroll(). The only bound that existed lived in the frozen
 * service — `discount <= snapshot.total` — so the discount could legally be
 * 100% of the tuition.
 *
 * Every other path that discounts tuition resolves the ceiling through the
 * canonical CFG-1 authority `resolveAuthorizedDiscount`:
 *   students.routes.ts:687   manual create      -> .percent
 *   students.routes.ts:1223  new semester       -> .percent, then round(fee * pct/100)
 *   visitors.routes.ts:745   visitor conversion -> .percent, then fee * pct/100
 * Journey did not call it at all.
 *
 * Reproduced live on a fresh DB, as a real `registrar`, against a 10,000 AFN
 * class, for students with ZERO rows in `student_discount_authorizations`:
 *
 *   discountAmount 2000   -> 201, invoice 10000/2000/8000   (20.00%)
 *   discountAmount 2001   -> 201, invoice 10000/2001/7999   (20.01%)
 *   discountAmount 9999   -> 201, invoice 10000/9999/1      (99.99%)
 *   discountAmount 10000  -> 201, invoice 10000/10000/0     (100.00%, FREE)
 *
 * The canonical authority, asked for the same student/branch/fee, answers 20%
 * (category ORDINARY, authorizationId null, maxAllowed 20) = 2,000 AFN. The
 * parity control is decisive: the same registrar sending discountPercent 100
 * to POST /students/manual has it clamped to a stored 20.
 *
 * The invariant: a journey enrollment may never grant a discount greater than
 * the canonical authorized discount for that student, branch and fee.
 *
 * Fail-closed is chosen over silent clamping because the request carries an
 * explicit AFN figure. Clamping 10,000 to 2,000 would report success for an
 * enrollment that was never authorised at the price the operator entered, and
 * the surrounding money routes already reject rather than cap an over-large
 * discount (books sell, invoices). students.routes clamps a *percent* it
 * derived itself from the rule engine, which is a different act: there the
 * caller never stated an AFN figure.
 */
import { assignRole } from './support/identity.js';
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { resolveAuthorizedDiscount, ORDINARY_MAX } from '../core/configuration/discount-authority.js';
import { journeyRouter } from '../routes/journey.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'jrn_branch';
const PROGRAM = 'jrn_program';
const VERSION = 'jrn_version';
const LEVEL = 'jrn_level';
const CLASS_ID = 'jrn_class';
const FEE = 10_000;
/**
 * A REGISTRATION fee alongside the tuition, so the ceiling basis is actually
 * discriminated. A discount attaches to TUITION only (owner decision on
 * WP07-F18), and the authorised maximum is a percentage of the tuition rather
 * than of the whole fee snapshot. With a tuition-only fixture the old and new
 * bases coincide and a regression to the snapshot basis would pass unnoticed.
 */
const REGISTRATION_FEE = 2_500;

let app: express.Express;
let registrar: TokenPayload;

const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let seq = 0;
/** A clean student with no discount authorization of any kind. */
function makeStudent(): string {
  seq += 1;
  const sid = `jrn_s_${seq}`;
  db.prepare(
    `INSERT INTO students (id, student_code, full_name, registration_date, phone, gender, branch_id, status)
     VALUES (?, ?, ?, date('now'), ?, 'male', ?, 'active')`,
  ).run(sid, `JRNC${seq}`, `Journey Student ${seq}`, `0788${String(seq).padStart(6, '0')}`, BRANCH);
  return sid;
}

const enroll = (sid: string, body: Record<string, unknown>) =>
  supertest(app)
    .post(`/api/students/${sid}/journey/enrollments`)
    .set(authHeader(registrar))
    .send({
      classId: CLASS_ID,
      programId: PROGRAM,
      programVersionId: VERSION,
      levelId: LEVEL,
      semesterName: `S${seq}`,
      levelCode: 'A1',
      enrollmentType: 'new',
      ...body,
    });

const invoiceOf = (sid: string) =>
  db.prepare('SELECT total_amount AS total, discount_amount AS discount, net_amount AS net FROM invoices WHERE student_id = ?').get(sid) as
    | { total: number; discount: number; net: number }
    | undefined;

const counts = () => ({
  invoices: (db.prepare('SELECT COUNT(*) AS c FROM invoices').get() as { c: number }).c,
  enrollments: (db.prepare('SELECT COUNT(*) AS c FROM enrollments').get() as { c: number }).c,
  payments: (db.prepare('SELECT COUNT(*) AS c FROM payments').get() as { c: number }).c,
  items: (db.prepare('SELECT COUNT(*) AS c FROM invoice_items').get() as { c: number }).c,
});

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  app = express();
  app.use(express.json());
  app.use('/api/students/:id/journey', journeyRouter);
  app.use(errorHandler);

  db.prepare("INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'T')").run(BRANCH, 'Journey Branch');
  db.prepare("INSERT OR IGNORE INTO programs (id, name, code, branch_id) VALUES (?, 'Journey Program', 'JRNP', ?)").run(PROGRAM, BRANCH);
  db.prepare(
    "INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status) VALUES (?, ?, 'v1', 1, 'published')",
  ).run(VERSION, PROGRAM);
  db.prepare(
    `INSERT OR IGNORE INTO levels (id, program_id, program_version_id, name, code, "order", is_active, default_fee)
     VALUES (?, ?, ?, 'A1', 'A1', 1, 1, ?)`,
  ).run(LEVEL, PROGRAM, VERSION, FEE);
  db.prepare(
    `INSERT OR IGNORE INTO classes (id, name, branch_id, capacity, status, lifecycle_stage, level, fee, program_id, level_id)
     VALUES (?, 'Journey Class', ?, 500, 'active', 'activated', 'A1', ?, ?, ?)`,
  ).run(CLASS_ID, BRANCH, FEE, PROGRAM, LEVEL);
  db.prepare('INSERT OR REPLACE INTO level_branch_fees (id, level_id, branch_id, fee) VALUES (?, ?, ?, ?)').run('jrn_lbf', LEVEL, BRANCH, FEE);
  // Registration sits alongside tuition on the enrolment snapshot, so the
  // snapshot total (12,500) and the tuition total (10,000) differ and the
  // ceiling basis is observable.
  db.prepare(
    `INSERT OR REPLACE INTO fee_rules (id, fee_type, name, amount, branch_id, is_active, version)
     VALUES ('jrn_fr_reg', 'registration', 'Registration fee', ?, ?, 1, 1)`,
  ).run(REGISTRATION_FEE, BRANCH);

  const pwd = await hashPassword('Str0ng!Pass2026');
  db.prepare(
    'INSERT OR IGNORE INTO users ( id, username, password_hash, full_name, branch_id, must_change_password ) VALUES (?, ?, ?, ?, ?, 0)',
  ).run('jrn_reg', 'jrn_reg', pwd, 'Registrar', BRANCH);
  assignRole('jrn_reg', 'registrar', BRANCH);

  registrar = { userId: 'jrn_reg', username: 'jrn_reg', branchId: BRANCH, fullName: 'Registrar' } as TokenPayload;
});

describe('JRN-1 · the canonical authority is the ceiling, and it is 20% here', () => {
  it('the fixture really has no authorization record, so ORDINARY governs', () => {
    const sid = makeStudent();
    const rows = db.prepare('SELECT COUNT(*) AS c FROM student_discount_authorizations WHERE student_id = ?').get(sid) as { c: number };
    expect(rows.c).toBe(0);

    const resolved = resolveAuthorizedDiscount(db, sid, 100, { branchId: BRANCH });
    expect(resolved.percent).toBe(ORDINARY_MAX);
    expect(resolved.percent).toBe(20);
    expect(resolved.authorizationId).toBeNull();
    // 20% of a 10,000 AFN fee.
    expect(Math.round((FEE * resolved.percent) / 100)).toBe(2000);
  });
});

describe('JRN-1 · a journey enrollment may not exceed the authorized discount', () => {
  it('accepts no discount at all', async () => {
    const sid = makeStudent();
    const res = await enroll(sid, { discountAmount: 0 });
    expect(res.status).toBe(201);
    expect(invoiceOf(sid)).toMatchObject({ total: FEE, discount: 0, net: FEE });
  });

  it('accepts an omitted discount', async () => {
    const sid = makeStudent();
    const res = await enroll(sid, {});
    expect(res.status).toBe(201);
    expect(invoiceOf(sid)).toMatchObject({ total: FEE, discount: 0, net: FEE });
  });

  it('accepts exactly the authorized maximum (20% = 2000 AFN)', async () => {
    const sid = makeStudent();
    const res = await enroll(sid, { discountAmount: 2000 });
    expect(res.status).toBe(201);
    expect(invoiceOf(sid)).toMatchObject({ total: FEE, discount: 2000, net: 8000 });
  });

  it('accepts a discount below the authorized maximum', async () => {
    const sid = makeStudent();
    const res = await enroll(sid, { discountAmount: 1500 });
    expect(res.status).toBe(201);
    expect(invoiceOf(sid)).toMatchObject({ total: FEE, discount: 1500, net: 8500 });
  });

  it('rejects one AFN above the authorized maximum, with zero DB mutation', async () => {
    const sid = makeStudent();
    const before = counts();
    const res = await enroll(sid, { discountAmount: 2001 });

    expect(res.status).toBe(400);
    expect(invoiceOf(sid)).toBeUndefined();
    expect(counts()).toEqual(before);
  });

  it.each([
    ['an excessive discount', 9999],
    ['the entire tuition', 10_000],
  ])('rejects %s, with zero DB mutation', async (_label, discountAmount) => {
    const sid = makeStudent();
    const before = counts();
    const res = await enroll(sid, { discountAmount });

    expect(res.status).toBe(400);
    expect(invoiceOf(sid)).toBeUndefined();
    expect(counts()).toEqual(before);
  });

  it('never produces a free enrollment for a student with no authorization', async () => {
    const sid = makeStudent();
    await enroll(sid, { discountAmount: FEE });
    const free = db.prepare('SELECT COUNT(*) AS c FROM invoices WHERE net_amount = 0').get() as { c: number };
    expect(free.c).toBe(0);
  });

  it('still rejects a discount above the fee itself (the frozen service bound)', async () => {
    const sid = makeStudent();
    const before = counts();
    const res = await enroll(sid, { discountAmount: 10_001 });
    expect(res.status).toBe(400);
    expect(counts()).toEqual(before);
  });
});

describe('JRN-1 · malformed and hostile input is refused before anything is written', () => {
  it.each([
    ['a negative discount', -5000],
    ['a non-numeric discount', 'abc'],
    ['a boolean', true],
    ['an array', [[7]]],
    ['a value beyond monetary precision', 1e15],
  ])('rejects %s, with zero DB mutation', async (_label, discountAmount) => {
    const sid = makeStudent();
    const before = counts();
    const res = await enroll(sid, { discountAmount });

    expect(res.status).toBe(400);
    expect(invoiceOf(sid)).toBeUndefined();
    expect(counts()).toEqual(before);
  });

  it('refuses a sub-unit discount, matching assertMoney everywhere else', async () => {
    const sid = makeStudent();
    const res = await enroll(sid, { discountAmount: 0.001 });
    expect(res.status).toBe(400);
    // Nothing is written: no invoice, so no silent zero-discount enrolment.
    expect(invoiceOf(sid)).toBeUndefined();
  });

  it('a tiny fractional discount is measured against the ceiling, not used to set it', async () => {
    // The ceiling must be derived from what the student is AUTHORIZED for, not
    // from what they asked for. Asking the authority to bound itself by the
    // request collapses the ordinary 20% ceiling to the request's own value,
    // A 0.4 AFN discount is not a representable amount and is refused.
    const sid = makeStudent();
    const res = await enroll(sid, { discountAmount: 0.4 });
    expect(res.status).toBe(400);
  });

  it('a small but real discount well under the ceiling is accepted', async () => {
    const sid = makeStudent();
    const res = await enroll(sid, { discountAmount: 1 });
    expect(res.status).toBe(201);
    expect(invoiceOf(sid)).toMatchObject({ total: FEE, discount: 1, net: 9999 });
  });
});

describe('JRN-1 · an authorized exception raises the ceiling, and only that far', () => {
  /**
   * Grant a live authorization through the same table the authority reads.
   * COURSE_AMBASSADOR is used because its eligibility test is the
   * authorization row itself; the relative categories additionally require a
   * real `student_staff_relations` row, which is a separate authority and not
   * what this suite is testing. Its ceiling is 15%.
   */
  function authorize(studentId: string, category: string, percent: number) {
    db.prepare(
      `INSERT INTO student_discount_authorizations
         (id, student_id, category, approved_percent, status, effective_from, effective_to, branch_id, approved_by, created_at)
       VALUES (?, ?, ?, ?, 'active', date('now','-1 day'), date('now','+30 day'), ?, 'jrn_reg', datetime('now'))`,
    ).run(`jda_${studentId}`, studentId, category, percent, BRANCH);
  }

  it('an authorized sponsorship (100%) may take the whole fee', async () => {
    const sid = makeStudent();
    authorize(sid, 'SPONSORSHIP', 100);
    // Confirm the authority itself agrees before asserting on the route.
    expect(resolveAuthorizedDiscount(db, sid, 100, { branchId: BRANCH }).percent).toBe(100);

    const res = await enroll(sid, { discountAmount: FEE });
    expect(res.status).toBe(201);
    expect(invoiceOf(sid)).toMatchObject({ total: FEE, discount: FEE, net: 0 });
  });

  it('an ambassador authorization raises the ceiling only to its 15% category max', async () => {
    const sid = makeStudent();
    authorize(sid, 'COURSE_AMBASSADOR', 15);
    expect(resolveAuthorizedDiscount(db, sid, 15, { branchId: BRANCH }).percent).toBe(15);

    const before = counts();
    const tooMuch = await enroll(sid, { discountAmount: 1501 });
    expect(tooMuch.status).toBe(400);
    expect(counts()).toEqual(before);

    const ok = await enroll(sid, { discountAmount: 1500 });
    expect(ok.status).toBe(201);
    expect(invoiceOf(sid)).toMatchObject({ total: FEE, discount: 1500, net: 8500 });
  });

  it('an approved_percent above the category ceiling is still capped at the ceiling', async () => {
    const sid = makeStudent();
    // An approver typed 90 on an ambassador grant, whose category max is 15.
    authorize(sid, 'COURSE_AMBASSADOR', 90);
    expect(resolveAuthorizedDiscount(db, sid, 90, { branchId: BRANCH }).percent).toBe(15);

    const before = counts();
    const res = await enroll(sid, { discountAmount: 9000 });
    expect(res.status).toBe(400);
    expect(counts()).toEqual(before);
  });

  it('an unauthorized student is still held to 20% even when others are authorized', async () => {
    const sid = makeStudent();
    const before = counts();
    const res = await enroll(sid, { discountAmount: 5000 });
    expect(res.status).toBe(400);
    expect(counts()).toEqual(before);
  });
});
