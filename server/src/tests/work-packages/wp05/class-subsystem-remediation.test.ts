/**
 * Class subsystem remediation — regression & adversarial suite
 * ============================================================================
 * Closes the confirmed findings in docs/CLASS_SUBSYSTEM_AUDIT_2026-08-18.md.
 * Every test here FAILS (or the exploit succeeds) against the pre-remediation
 * code at checkpoint 1567004.
 *
 *   C-1  HIGH      POST /:id/cancel stranded live enrollments on the cancelled
 *                  class: seats stayed counted, the student stayed "enrolled"
 *                  in a class that no longer runs, and the class could then
 *                  never be deleted because its own stranded seats tripped the
 *                  delete guard. Merge — the other path to 'cancelled' —
 *                  already upheld the opposite contract.
 *   C-2  HIGH      POST /:id/merge admitted students into a class whose gender
 *                  policy forbids them. Every other admission path applies the
 *                  rule; merge did not. Live: a female student was seated in a
 *                  male-only class with HTTP 200.
 *   C-3  HIGH      PUT /:id wrote `fee` and `capacity` with NO validation while
 *                  POST / validated both. Live: fee stored as -1000, "abc",
 *                  "0x10", 1e15; capacity stored as 7.5 and 1e15. The string
 *                  fee reached the money path and defeated the overpayment
 *                  guard (NaN comparisons are false); 1e15 produced a real
 *                  1e15 AFN invoice; capacity 2.5 admitted 3 students.
 *   C-5  MEDIUM    Merge OVERWROTE classes.notes, destroying operator notes
 *                  with no copy retained.
 *   C-6  HIGH      POST /students/:id/enroll-class with amountPaidNow > 0
 *                  always returned HTTP 500 ("payment idempotency_key is
 *                  required", migration 063) and rolled back — the paid
 *                  extra-class flow was entirely unusable.
 *   C-7  MEDIUM    GET /classes accepted `limit`/`offset` and ignored them.
 *
 * Behavioural, route-level tests driven through HTTP with real permissions.
 * Raw INSERT/UPDATE is used ONLY to age fixtures into states the API cannot
 * reach directly, never to fake a result production code should produce.
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { today, id as mkId } from '../../../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import classesRouter from '../../../routes/classes.routes.js';
import { studentsRouter } from '../../../routes/students.routes.js';
import { enrollmentRouter } from '../../../routes/enrollment.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { ACTIVE_ENROLLMENT_STATUSES } from '../../../core/academic/class-capacity.js';

const BRANCH = 'cls_rem_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/classes', classesRouter);
  app.use('/api/students', studentsRouter);
  app.use('/api/enrollments', enrollmentRouter);
  app.use(errorHandler);
  return app;
}
function makeUser(o: { userId: string; role?: string }): TokenPayload {
  return {
    userId: o.userId, username: o.userId,
    branchId: BRANCH, fullName: 'Class Remediation User',
  };
}
const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let app: express.Express;
let owner: TokenPayload;
let reg: TokenPayload;
let hod: TokenPayload;
let phoneSeq = 0;
const nextPhone = () => `07${String(40000000 + ++phoneSeq).slice(-8)}`;

function makeClass(
  cid: string,
  capacity: number,
  opts: { fee?: number; gender?: 'mixed' | 'female' | 'male'; stage?: string; status?: string; notes?: string } = {},
) {
  db.prepare(
    `INSERT OR REPLACE INTO classes (id, name, branch_id, capacity, min_viable_size, status, lifecycle_stage,
       level, fee, gender_policy, start_date, notes)
     VALUES (?, ?, ?, ?, 1, ?, ?, 'A1', ?, ?, ?, ?)`
  ).run(cid, `Class ${cid}`, BRANCH, capacity, opts.status || 'active', opts.stage || 'activated',
    opts.fee ?? 0, opts.gender || 'mixed', today(), opts.notes ?? null);
  db.prepare('DELETE FROM enrollments WHERE class_id = ?').run(cid);
  return cid;
}
async function createStudent(body: Record<string, unknown> = {}) {
  const res = await supertest(app).post('/api/students/manual').set(authHeader(reg))
    .send({ fullName: 'Class Fixture', gender: 'male', phone: nextPhone(), ...body });
  expect(res.status).toBe(201);
  return res.body.id as string;
}
const liveSeats = (classId: string) => (db.prepare(
  `SELECT COUNT(DISTINCT student_id) c FROM enrollments
    WHERE class_id = ? AND status IN (${ACTIVE_ENROLLMENT_STATUSES.map((s) => `'${s}'`).join(',')})`
).get(classId) as { c: number }).c;
const clsRow = (classId: string) => db.prepare('SELECT * FROM classes WHERE id = ?').get(classId) as any;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?,?,?)').run(BRANCH, 'Class Branch', 'Loc');
  for (const [uid, role] of [['u_cls_owner', 'owner'], ['u_cls_reg', 'registrar'], ['u_cls_hod', 'head_of_department']]) {
    db.prepare(
      `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
       VALUES (?, ?, ?, ?, ?, 1, 0)`
    ).run(uid, uid, uid, BRANCH, await hashPassword('x'));
    assignRole(uid, role, BRANCH);
  }

  owner = makeUser({ userId: 'u_cls_owner' });
  reg = makeUser({ userId: 'u_cls_reg' });
  hod = makeUser({ userId: 'u_cls_hod' });
  app = createApp();
});

// ===========================================================================
// C-1 — cancellation may not strand live enrollments
// ===========================================================================
describe('C-1 — cancel does not strand live enrollments', () => {
  it('THE EXPLOIT: cancelling a class holding an active enrollment is refused', async () => {
    const cid = makeClass('c1_live', 10);
    await createStudent({ classId: cid });
    expect(liveSeats(cid)).toBe(1);

    const res = await supertest(app).post(`/api/classes/${cid}/cancel`)
      .set(authHeader(owner)).send({ reason: 'not viable' });

    // Pre-remediation: 200, and the active enrollment stayed pointing at a
    // cancelled class forever.
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/still has 1 enrolled student/i);
    expect(clsRow(cid).status).toBe('active');
    expect(clsRow(cid).lifecycle_stage).toBe('activated');
    expect(liveSeats(cid)).toBe(1);
  });

  it('pending and confirmed seats block cancellation too (same predicate as capacity)', async () => {
    for (const status of ['pending', 'confirmed'] as const) {
      const cid = makeClass(`c1_${status}`, 10);
      const sid = await createStudent({ classId: cid });
      db.prepare('UPDATE enrollments SET status = ? WHERE student_id = ? AND class_id = ?').run(status, sid, cid);
      const res = await supertest(app).post(`/api/classes/${cid}/cancel`)
        .set(authHeader(owner)).send({ reason: 'r' });
      expect(res.status).toBe(409);
      expect(clsRow(cid).status).toBe('active');
    }
  });

  it('an EMPTY class still cancels cleanly (no over-blocking)', async () => {
    const cid = makeClass('c1_empty', 10);
    const res = await supertest(app).post(`/api/classes/${cid}/cancel`)
      .set(authHeader(owner)).send({ reason: 'no demand' });
    expect(res.status).toBe(200);
    expect(clsRow(cid).status).toBe('cancelled');
    expect(clsRow(cid).cancellation_reason).toBe('no demand');
  });

  it.each(['dropped', 'withdrawn', 'transferred', 'completed', 'graduated'] as const)(
    'a class whose only history is %s still cancels (closed rows are not seats)',
    async (status) => {
      const cid = makeClass(`c1_hist_${status}`, 10);
      const sid = await createStudent({ classId: cid });
      db.prepare('UPDATE enrollments SET status = ? WHERE student_id = ?').run(status, sid);
      const res = await supertest(app).post(`/api/classes/${cid}/cancel`)
        .set(authHeader(owner)).send({ reason: 'r' });
      expect(res.status).toBe(200);
      expect(clsRow(cid).status).toBe('cancelled');
    },
  );

  it('the documented recovery path works: drop the enrollment, then cancel', async () => {
    const cid = makeClass('c1_recover', 10);
    const sid = await createStudent({ classId: cid });
    const enr = db.prepare("SELECT id FROM enrollments WHERE student_id=? AND status='active'").get(sid) as { id: string };

    const blocked = await supertest(app).post(`/api/classes/${cid}/cancel`)
      .set(authHeader(owner)).send({ reason: 'r' });
    expect(blocked.status).toBe(409);

    const dropped = await supertest(app).post(`/api/enrollments/${enr.id}/drop`)
      .set(authHeader(reg)).send({ reason: 'class closing' });
    expect(dropped.status).toBeLessThan(400);

    const res = await supertest(app).post(`/api/classes/${cid}/cancel`)
      .set(authHeader(owner)).send({ reason: 'r' });
    expect(res.status).toBe(200);
    expect(clsRow(cid).status).toBe('cancelled');
  });

  it('MERGE still cancels its source — the guard must not break the drain-then-cancel path', async () => {
    const src = makeClass('c1_msrc', 10);
    const dst = makeClass('c1_mdst', 10);
    await createStudent({ classId: src });

    const res = await supertest(app).post(`/api/classes/${src}/merge`)
      .set(authHeader(owner)).send({ targetClassId: dst });

    expect(res.status).toBe(200);
    expect(clsRow(src).status).toBe('cancelled');
    expect(liveSeats(src)).toBe(0);
    expect(liveSeats(dst)).toBe(1);
  });

  it('a cancelled class holding no live seat can still be deleted (the deadlock is gone)', async () => {
    const cid = makeClass('c1_del', 10);
    const sid = await createStudent({ classId: cid });
    const enr = db.prepare("SELECT id FROM enrollments WHERE student_id=? AND status='active'").get(sid) as { id: string };
    await supertest(app).post(`/api/enrollments/${enr.id}/drop`).set(authHeader(reg)).send({ reason: 'x' });
    await supertest(app).post(`/api/classes/${cid}/cancel`).set(authHeader(owner)).send({ reason: 'r' });

    const del = await supertest(app).delete(`/api/classes/${cid}`).set(authHeader(owner)).send();
    expect(del.status).toBe(200);
  });

  it('completed/archived are deliberately NOT blocked — manual review depends on it', async () => {
    const cid = makeClass('c1_review', 10, { stage: 'grading' });
    await createStudent({ classId: cid });

    const complete = await supertest(app).post(`/api/classes/${cid}/complete`).set(authHeader(owner)).send({});
    expect(complete.status).toBe(200);
    const archive = await supertest(app).post(`/api/classes/${cid}/archive`).set(authHeader(owner)).send({});
    expect(archive.status).toBe(200);

    // The still-active row is exactly what pending-review is for.
    const pending = await supertest(app).get(`/api/classes/${cid}/promotion/pending-review`).set(authHeader(owner));
    expect(pending.status).toBe(200);
    expect(pending.body.pending.length).toBe(1);
  });
});

// ===========================================================================
// C-2 — merge is an admission path and obeys the gender policy
// ===========================================================================
describe('C-2 — merge enforces the class gender policy', () => {
  it('THE EXPLOIT: a female student may not be merged into a male-only class', async () => {
    const src = makeClass('c2_src', 10, { gender: 'female' });
    const dst = makeClass('c2_dst', 10, { gender: 'male' });
    const sid = await createStudent({ classId: src, gender: 'female' });

    // The direct admission path refuses this move…
    const direct = await supertest(app).post(`/api/students/${sid}/enroll-class`)
      .set(authHeader(reg)).send({ classId: dst });
    expect(direct.status).toBe(400);

    // …so merge must refuse it too. Pre-remediation: 200, student seated.
    const res = await supertest(app).post(`/api/classes/${src}/merge`)
      .set(authHeader(owner)).send({ targetClassId: dst });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/gender policy/i);

    const row = db.prepare('SELECT class_id FROM enrollments WHERE student_id = ?').get(sid) as { class_id: string };
    expect(row.class_id).toBe(src);
    expect(liveSeats(dst)).toBe(0);
  });

  it('checks the ACTUAL students, not just the two policies: a male in a MIXED source cannot enter a female-only target', async () => {
    const src = makeClass('c2_mixed_src', 10, { gender: 'mixed' });
    const dst = makeClass('c2_female_dst', 10, { gender: 'female' });
    const sid = await createStudent({ classId: src, gender: 'male' });

    const res = await supertest(app).post(`/api/classes/${src}/merge`)
      .set(authHeader(owner)).send({ targetClassId: dst });

    // A policy-vs-policy comparison would allow this (mixed vs female);
    // only checking the real population catches it.
    expect(res.status).toBe(400);
    expect(liveSeats(dst)).toBe(0);
    const row = db.prepare('SELECT class_id FROM enrollments WHERE student_id = ?').get(sid) as { class_id: string };
    expect(row.class_id).toBe(src);
  });

  it('the merge is refused ATOMICALLY — no student is moved and the source is not cancelled', async () => {
    const src = makeClass('c2_atomic_src', 10, { gender: 'mixed' });
    const dst = makeClass('c2_atomic_dst', 10, { gender: 'female' });
    const okStudent = await createStudent({ classId: src, gender: 'female' });
    const badStudent = await createStudent({ classId: src, gender: 'male' });

    const res = await supertest(app).post(`/api/classes/${src}/merge`)
      .set(authHeader(owner)).send({ targetClassId: dst });
    expect(res.status).toBe(400);

    for (const sid of [okStudent, badStudent]) {
      const row = db.prepare('SELECT class_id FROM enrollments WHERE student_id = ?').get(sid) as { class_id: string };
      expect(row.class_id).toBe(src);
    }
    expect(clsRow(src).status).toBe('active');
    expect(liveSeats(dst)).toBe(0);
  });

  it.each([
    ['female', 'female'],
    ['male', 'male'],
    ['female', 'mixed'],
    ['male', 'mixed'],
    ['mixed', 'mixed'],
  ] as const)('LEGITIMATE %s → %s merge still works', async (srcGender, dstGender) => {
    const src = makeClass(`c2_ok_${srcGender}_${dstGender}_s`, 10, { gender: srcGender });
    const dst = makeClass(`c2_ok_${srcGender}_${dstGender}_d`, 10, { gender: dstGender });
    const studentGender = srcGender === 'mixed' ? 'female' : srcGender;
    await createStudent({ classId: src, gender: studentGender });

    const res = await supertest(app).post(`/api/classes/${src}/merge`)
      .set(authHeader(owner)).send({ targetClassId: dst });
    expect(res.status).toBe(200);
    expect(liveSeats(dst)).toBe(1);
  });

  it('an EMPTY source merges into any target (nothing to admit)', async () => {
    const src = makeClass('c2_empty_src', 10, { gender: 'female' });
    const dst = makeClass('c2_empty_dst', 10, { gender: 'male' });
    const res = await supertest(app).post(`/api/classes/${src}/merge`)
      .set(authHeader(owner)).send({ targetClassId: dst });
    expect(res.status).toBe(200);
  });

  it('closed history in the source does not block a merge (it is not moved)', async () => {
    const src = makeClass('c2_hist_src', 10, { gender: 'mixed' });
    const dst = makeClass('c2_hist_dst', 10, { gender: 'female' });
    const male = await createStudent({ classId: src, gender: 'male' });
    db.prepare("UPDATE enrollments SET status='dropped' WHERE student_id=?").run(male);
    await createStudent({ classId: src, gender: 'female' });

    const res = await supertest(app).post(`/api/classes/${src}/merge`)
      .set(authHeader(owner)).send({ targetClassId: dst });
    expect(res.status).toBe(200);
    expect(liveSeats(dst)).toBe(1);
  });
});

// ===========================================================================
// C-3 — PUT validates money and seat counts exactly like POST
// ===========================================================================
describe('C-3 — PUT /:id validates fee and capacity', () => {
  it.each([-1000, 'abc', '0x10', 1e15, true, []] as unknown[])(
    'THE EXPLOIT: fee %j is refused and nothing is stored',
    async (badFee) => {
      const cid = makeClass(`c3_fee_${String(badFee).replace(/\W/g, '') || 'empty'}`, 10, { fee: 5000 });
      const res = await supertest(app).put(`/api/classes/${cid}`).set(authHeader(owner)).send({ fee: badFee });
      expect(res.status).toBe(400);
      expect(clsRow(cid).fee).toBe(5000);
    },
  );

  it.each([-5, 7.5, 1e15, 'abc'] as unknown[])(
    'THE EXPLOIT: capacity %j is refused and nothing is stored',
    async (badCapacity) => {
      const cid = makeClass(`c3_cap_${String(badCapacity).replace(/\W/g, '')}`, 10);
      const res = await supertest(app).put(`/api/classes/${cid}`).set(authHeader(owner)).send({ capacity: badCapacity });
      expect(res.status).toBe(400);
      expect(clsRow(cid).capacity).toBe(10);
    },
  );

  it('a fractional capacity can no longer over-admit (2.5 used to seat 3)', async () => {
    const cid = makeClass('c3_frac', 10);
    const res = await supertest(app).put(`/api/classes/${cid}`).set(authHeader(owner)).send({ capacity: 2.5 });
    expect(res.status).toBe(400);
    expect(Number.isInteger(clsRow(cid).capacity)).toBe(true);
  });

  it('a corrupted fee can no longer defeat the overpayment guard', async () => {
    const cid = makeClass('c3_overpay', 10, { fee: 1000 });
    const rejected = await supertest(app).put(`/api/classes/${cid}`).set(authHeader(owner)).send({ fee: 'abc' });
    expect(rejected.status).toBe(400);

    const sid = await createStudent();
    const res = await supertest(app).post(`/api/students/${sid}/enroll-class`)
      .set(authHeader(reg)).send({ classId: cid, amountPaidNow: 99999 });
    // The fee is still a real 1000, so the guard fires as designed.
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/cannot exceed/i);
  });

  it('the head_of_department (not only the owner) is equally constrained', async () => {
    const cid = makeClass('c3_hod', 10, { fee: 5000 });
    const res = await supertest(app).put(`/api/classes/${cid}`).set(authHeader(hod)).send({ fee: 'abc' });
    expect(res.status).toBe(400);
    expect(clsRow(cid).fee).toBe(5000);
  });

  it('POST and PUT now agree — the same value is refused by both writers', async () => {
    const post = await supertest(app).post('/api/classes').set(authHeader(owner))
      .send({ name: 'c3-sym', level: 'A1', capacity: 5, branchId: BRANCH, fee: -1000 });
    expect(post.status).toBe(400);
    const cid = makeClass('c3_sym', 10, { fee: 5000 });
    const put = await supertest(app).put(`/api/classes/${cid}`).set(authHeader(owner)).send({ fee: -1000 });
    expect(put.status).toBe(400);
  });

  it.each([-5, 7.5, 1e15, 'abc'] as unknown[])(
    'C-4 — THE EXPLOIT: minViableSize %j is refused and nothing is stored',
    async (badMinViable) => {
      // C-4 was remediated alongside C-3 (same `assertSeatCount` boundary) but
      // was left without its own negative test, so mutation testing proved the
      // suite would not notice if the guard were deleted. min_viable_size is a
      // SEAT COUNT: it drives the merge-candidates "underMin" signal that tells
      // staff which classes are unviable, so a fractional or absurd value
      // corrupts a real operational decision.
      const cid = makeClass(`c4_mv_${String(badMinViable).replace(/\W/g, '')}`, 20);
      db.prepare('UPDATE classes SET min_viable_size = 5 WHERE id = ?').run(cid);

      const res = await supertest(app).put(`/api/classes/${cid}`)
        .set(authHeader(owner)).send({ minViableSize: badMinViable });

      expect(res.status).toBe(400);
      expect(clsRow(cid).min_viable_size).toBe(5);
    },
  );

  it('C-4 — a legitimate minViableSize update still works', async () => {
    const cid = makeClass('c4_mv_ok', 20);
    const res = await supertest(app).put(`/api/classes/${cid}`)
      .set(authHeader(owner)).send({ minViableSize: 8 });
    expect(res.status).toBe(200);
    expect(clsRow(cid).min_viable_size).toBe(8);
  });

  it('C-4 — omitting minViableSize leaves it untouched', async () => {
    const cid = makeClass('c4_mv_partial', 20);
    db.prepare('UPDATE classes SET min_viable_size = 7 WHERE id = ?').run(cid);
    const res = await supertest(app).put(`/api/classes/${cid}`)
      .set(authHeader(owner)).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(clsRow(cid).min_viable_size).toBe(7);
  });

  it('LEGITIMATE fee and capacity updates still work', async () => {
    const cid = makeClass('c3_ok', 10, { fee: 5000 });
    const res = await supertest(app).put(`/api/classes/${cid}`).set(authHeader(owner))
      .send({ fee: 7501, capacity: 25, minViableSize: 4 });
    expect(res.status).toBe(200);
    const row = clsRow(cid);
    expect(row.fee).toBe(7501);
    expect(row.capacity).toBe(25);
    expect(row.min_viable_size).toBe(4);
  });

  it('omitting fee/capacity leaves them untouched', async () => {
    const cid = makeClass('c3_partial', 12, { fee: 3300 });
    const res = await supertest(app).put(`/api/classes/${cid}`).set(authHeader(owner)).send({ name: 'Renamed Only' });
    expect(res.status).toBe(200);
    const row = clsRow(cid);
    expect(row.fee).toBe(3300);
    expect(row.capacity).toBe(12);
    expect(row.name).toBe('Renamed Only');
  });

  it('capacity 0 remains legal — it means "no configured limit" everywhere in this codebase', async () => {
    const cid = makeClass('c3_zero', 10);
    const res = await supertest(app).put(`/api/classes/${cid}`).set(authHeader(owner)).send({ capacity: 0 });
    expect(res.status).toBe(200);
    expect(clsRow(cid).capacity).toBe(0);
  });
});

// ===========================================================================
// C-5 — merge preserves operator notes
// ===========================================================================
describe('C-5 — merge appends to notes instead of destroying them', () => {
  it('THE EXPLOIT: an existing operator note survives the merge', async () => {
    const src = makeClass('c5_src', 10, { notes: 'Room booked until March. Do not reuse.' });
    const dst = makeClass('c5_dst', 10);
    await createStudent({ classId: src });

    const res = await supertest(app).post(`/api/classes/${src}/merge`)
      .set(authHeader(owner)).send({ targetClassId: dst });
    expect(res.status).toBe(200);

    const notes = String(clsRow(src).notes);
    // Pre-remediation the original text was gone entirely.
    expect(notes).toContain('Room booked until March. Do not reuse.');
    expect(notes).toContain('Merged into');
  });

  it('a class with no prior note gets just the merge line (no stray separator)', async () => {
    const src = makeClass('c5_empty_src', 10);
    const dst = makeClass('c5_empty_dst', 10);
    await createStudent({ classId: src });
    await supertest(app).post(`/api/classes/${src}/merge`).set(authHeader(owner)).send({ targetClassId: dst });
    const notes = String(clsRow(src).notes);
    expect(notes.startsWith('Merged into')).toBe(true);
  });
});

// ===========================================================================
// C-6 — the paid extra-class enrollment works at all
// ===========================================================================
describe('C-6 — extra-class enrollment accepts a payment', () => {
  it('THE EXPLOIT: enroll-class with amountPaidNow no longer returns 500', async () => {
    const cid = makeClass('c6_pay', 10, { fee: 5000 });
    const sid = await createStudent();

    const res = await supertest(app).post(`/api/students/${sid}/enroll-class`)
      .set(authHeader(reg)).send({ classId: cid, amountPaidNow: 3000 });

    // Pre-remediation: 500 "payment idempotency_key is required", full rollback.
    expect(res.status).toBe(201);

    const payments = db.prepare('SELECT amount, category, idempotency_key FROM payments WHERE student_id = ?')
      .all(sid) as { amount: number; category: string; idempotency_key: string | null }[];
    expect(payments.length).toBe(1);
    expect(payments[0].amount).toBe(3000);
    expect(payments[0].idempotency_key).toBeTruthy();

    const income = db.prepare(
      `SELECT COALESCE(SUM(amount),0) amt FROM financial_transactions
        WHERE reference_id = ? AND type = 'income'`
    ).get(sid) as { amt: number };
    expect(income.amt).toBe(3000);
  });

  it('API result == database truth == financial truth', async () => {
    const cid = makeClass('c6_recon', 10, { fee: 4000 });
    const sid = await createStudent();
    const res = await supertest(app).post(`/api/students/${sid}/enroll-class`)
      .set(authHeader(reg)).send({ classId: cid, amountPaidNow: 4000 });
    expect(res.status).toBe(201);

    const paid = (db.prepare('SELECT COALESCE(SUM(amount),0) a FROM payments WHERE student_id=?')
      .get(sid) as { a: number }).a;
    const income = (db.prepare(
      `SELECT COALESCE(SUM(amount),0) a FROM financial_transactions WHERE reference_id=? AND type='income'`
    ).get(sid) as { a: number }).a;
    expect(paid).toBe(4000);
    expect(income).toBe(4000);
    expect(liveSeats(cid)).toBe(1);
  });

  it('the unpaid path is unchanged (no regression)', async () => {
    const cid = makeClass('c6_unpaid', 10, { fee: 5000 });
    const sid = await createStudent();
    const res = await supertest(app).post(`/api/students/${sid}/enroll-class`)
      .set(authHeader(reg)).send({ classId: cid });
    expect(res.status).toBe(201);
    const inv = db.prepare('SELECT net_amount, status FROM invoices WHERE student_id=?').all(sid) as any[];
    expect(inv.length).toBe(1);
    expect(inv[0].net_amount).toBe(5000);
  });

  it('a failed paid enrollment leaves ZERO residue', async () => {
    const cid = makeClass('c6_residue', 10, { fee: 1000 });
    const sid = await createStudent();
    const snap = () => JSON.stringify({
      enr: (db.prepare('SELECT COUNT(*) c FROM enrollments WHERE student_id=?').get(sid) as any).c,
      pay: (db.prepare('SELECT COUNT(*) c FROM payments WHERE student_id=?').get(sid) as any).c,
      inv: (db.prepare('SELECT COUNT(*) c FROM invoices WHERE student_id=?').get(sid) as any).c,
      led: (db.prepare('SELECT COUNT(*) c FROM financial_transactions WHERE reference_id=?').get(sid) as any).c,
    });
    const before = snap();
    // Overpayment is refused: the whole transaction must roll back.
    const res = await supertest(app).post(`/api/students/${sid}/enroll-class`)
      .set(authHeader(reg)).send({ classId: cid, amountPaidNow: 999999 });
    expect(res.status).toBe(400);
    expect(snap()).toBe(before);
  });

  it('a LEGITIMATE re-enrollment after a drop can be paid again (the key must not over-collide)', async () => {
    // Mutation testing (M8) caught a real regression here: an earlier fix keyed
    // the payment on (student, class), which refused this entirely valid second
    // payment with 409 and destroyed billable revenue. The key is per-enrollment.
    const cid = makeClass('c6_requel', 10, { fee: 2000 });
    const sid = await createStudent();

    const first = await supertest(app).post(`/api/students/${sid}/enroll-class`)
      .set(authHeader(reg)).send({ classId: cid, amountPaidNow: 2000 });
    expect(first.status).toBe(201);

    const enr = db.prepare("SELECT id FROM enrollments WHERE student_id=? AND status='active'").get(sid) as { id: string };
    const dropped = await supertest(app).post(`/api/enrollments/${enr.id}/drop`)
      .set(authHeader(reg)).send({ reason: 'left the course' });
    expect(dropped.status).toBeLessThan(400);

    const second = await supertest(app).post(`/api/students/${sid}/enroll-class`)
      .set(authHeader(reg)).send({ classId: cid, amountPaidNow: 2000 });
    expect(second.status).toBe(201);

    const payments = db.prepare('SELECT amount, idempotency_key FROM payments WHERE student_id = ?')
      .all(sid) as { amount: number; idempotency_key: string }[];
    expect(payments.length).toBe(2);
    expect(new Set(payments.map((p) => p.idempotency_key)).size).toBe(2);
    const income = (db.prepare(
      `SELECT COALESCE(SUM(amount),0) a FROM financial_transactions WHERE reference_id=? AND type='income'`
    ).get(sid) as { a: number }).a;
    expect(income).toBe(4000);
  });

  it('every extra-class payment carries a non-null, enrollment-scoped idempotency key', async () => {
    // Kills the mutant that makes the key random: a random key is still
    // non-null, so this asserts the key is DERIVED from the enrollment it pays
    // for, which is what makes it traceable and replay-safe.
    const cid = makeClass('c6_keyshape', 10, { fee: 1500 });
    const sid = await createStudent();
    const res = await supertest(app).post(`/api/students/${sid}/enroll-class`)
      .set(authHeader(reg)).send({ classId: cid, amountPaidNow: 1500 });
    expect(res.status).toBe(201);

    const enrolment = db.prepare(
      "SELECT id FROM enrollments WHERE student_id=? AND class_id=? AND status='active'"
    ).get(sid, cid) as { id: string };
    const payment = db.prepare('SELECT idempotency_key FROM payments WHERE student_id = ?')
      .get(sid) as { idempotency_key: string };

    expect(payment.idempotency_key).toBe(`extra-class:${enrolment.id}`);
  });

  it('concurrent identical paid enrollments produce exactly one payment', async () => {
    const cid = makeClass('c6_conc', 10, { fee: 2000 });
    const sid = await createStudent();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => supertest(app).post(`/api/students/${sid}/enroll-class`)
        .set(authHeader(reg)).send({ classId: cid, amountPaidNow: 2000 })),
    );
    const created = results.filter((r) => r.status === 201).length;
    expect(created).toBe(1);

    const payCount = (db.prepare('SELECT COUNT(*) c FROM payments WHERE student_id=?').get(sid) as any).c;
    const income = (db.prepare(
      `SELECT COALESCE(SUM(amount),0) a FROM financial_transactions WHERE reference_id=? AND type='income'`
    ).get(sid) as { a: number }).a;
    expect(payCount).toBe(1);
    expect(income).toBe(2000);
    expect(liveSeats(cid)).toBe(1);
  });
});

// ===========================================================================
// HARDENING — pre-existing guards that had NO direct test
// ===========================================================================
// These invariants were already correct at 1567004, but mutation testing
// proved the suite would not have noticed if they were deleted (M12, M17).
// An untested guard is one careless edit away from being an incident, so the
// coverage is added here rather than left as a known gap.

describe('H-1 — object-level branch isolation on every class endpoint', () => {
  const OTHER = 'cls_rem_other_branch';
  let foreignUser: TokenPayload;

  beforeAll(async () => {
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?,?,?)').run(OTHER, 'Other Branch', 'L');
    db.prepare(
      `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
       VALUES (?, ?, ?, ?, ?, 1, 0)`
    ).run('u_cls_foreign', 'u_cls_foreign', 'Foreign Manager', OTHER, await hashPassword('x'));
    assignRole('u_cls_foreign', 'manager', OTHER);

    foreignUser = { userId: 'u_cls_foreign', username: 'u_cls_foreign', branchId: OTHER, fullName: 'Foreign Manager' };
  });

  it('a manager from another branch is refused on every class WRITER (403, no mutation)', async () => {
    const cid = makeClass('h1_target', 10, { fee: 5000, notes: 'untouched' });
    const before = JSON.stringify(clsRow(cid));

    const attempts: Array<[string, Promise<{ status: number }>]> = [
      ['edit', supertest(app).put(`/api/classes/${cid}`).set(authHeader(foreignUser)).send({ name: 'hijacked' })],
      ['capacity', supertest(app).put(`/api/classes/${cid}`).set(authHeader(foreignUser)).send({ capacity: 999 })],
      ['fee', supertest(app).put(`/api/classes/${cid}`).set(authHeader(foreignUser)).send({ fee: 1 })],
      ['cancel', supertest(app).post(`/api/classes/${cid}/cancel`).set(authHeader(foreignUser)).send({ reason: 'x' })],
      ['suspend', supertest(app).post(`/api/classes/${cid}/suspend`).set(authHeader(foreignUser)).send({})],
      ['delete', supertest(app).delete(`/api/classes/${cid}`).set(authHeader(foreignUser)).send()],
    ];
    for (const [label, p] of attempts) {
      const res = await p;
      expect(res.status, `${label} must be refused cross-branch`).toBe(403);
    }
    expect(JSON.stringify(clsRow(cid))).toBe(before);
  });

  it('a cross-branch READ of a specific class is refused', async () => {
    const cid = makeClass('h1_read', 10);
    for (const path of ['/lifecycle', '/gradebook', '/merge-candidates']) {
      const res = await supertest(app).get(`/api/classes/${cid}${path}`).set(authHeader(foreignUser));
      expect(res.status, `GET ${path} must be refused cross-branch`).toBe(403);
    }
  });

  it('a cross-branch merge cannot pull a foreign class in as the target', async () => {
    const foreign = makeClass('h1_foreign_src', 10);
    db.prepare('UPDATE classes SET branch_id = ? WHERE id = ?').run(OTHER, foreign);
    const mine = makeClass('h1_mine_dst', 10);

    const res = await supertest(app).post(`/api/classes/${foreign}/merge`)
      .set(authHeader(foreignUser)).send({ targetClassId: mine });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(liveSeats(mine)).toBe(0);
  });
});

describe('H-2 — DELETE refuses a class that still holds live enrollments', () => {
  it.each(['active', 'confirmed', 'pending'] as const)(
    'a %s enrollment blocks deletion and the class survives',
    async (status) => {
      const cid = makeClass(`h2_${status}`, 10);
      const sid = await createStudent({ classId: cid });
      db.prepare('UPDATE enrollments SET status = ? WHERE student_id = ? AND class_id = ?').run(status, sid, cid);

      const res = await supertest(app).delete(`/api/classes/${cid}`).set(authHeader(owner)).send();
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/active enrollment/i);
      expect(clsRow(cid)).toBeTruthy();
      // The enrollment must still point at a real class, not a dangling id.
      const row = db.prepare('SELECT class_id FROM enrollments WHERE student_id = ?').get(sid) as { class_id: string };
      expect(row.class_id).toBe(cid);
    },
  );

  it('a class with only closed history CAN be deleted (no over-blocking)', async () => {
    const cid = makeClass('h2_closed', 10);
    const sid = await createStudent({ classId: cid });
    db.prepare("UPDATE enrollments SET status='dropped' WHERE student_id = ?").run(sid);
    const res = await supertest(app).delete(`/api/classes/${cid}`).set(authHeader(owner)).send();
    expect(res.status).toBe(200);
    expect(clsRow(cid)).toBeFalsy();
  });
});

// ===========================================================================
// C-7 — GET /classes honours the pagination it advertises
// ===========================================================================
describe('C-7 — GET /api/classes pagination', () => {
  it('THE EXPLOIT: ?limit=N now returns at most N rows', async () => {
    for (let i = 0; i < 25; i++) makeClass(`c7_bulk_${i}`, 5);
    const all = await supertest(app).get('/api/classes').set(authHeader(owner));
    expect(Array.isArray(all.body)).toBe(true);
    expect(all.body.length).toBeGreaterThan(10);

    const page = await supertest(app).get('/api/classes?limit=10').set(authHeader(owner));
    // Pre-remediation: returned every class regardless of limit.
    expect(page.body.length).toBe(10);
  });

  it('offset walks the list without overlap or gaps', async () => {
    const p1 = await supertest(app).get('/api/classes?limit=5&offset=0').set(authHeader(owner));
    const p2 = await supertest(app).get('/api/classes?limit=5&offset=5').set(authHeader(owner));
    expect(p1.body.length).toBe(5);
    expect(p2.body.length).toBe(5);
    const ids1 = p1.body.map((c: any) => c.id);
    const ids2 = p2.body.map((c: any) => c.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toEqual([]);
  });

  it('includeTotal reports the authoritative total, independent of the page', async () => {
    const res = await supertest(app).get('/api/classes?limit=3&includeTotal=1').set(authHeader(owner));
    expect(res.body.rows.length).toBe(3);
    const full = await supertest(app).get('/api/classes').set(authHeader(owner));
    expect(res.body.total).toBe(full.body.length);
  });

  it('the default (no limit/offset) stays a bare unbounded array — the workspace store depends on it', async () => {
    const res = await supertest(app).get('/api/classes').set(authHeader(owner));
    expect(Array.isArray(res.body)).toBe(true);
    const dbCount = (db.prepare('SELECT COUNT(*) c FROM classes WHERE branch_id = ?').get(BRANCH) as any).c;
    expect(res.body.length).toBe(dbCount);
  });

  it('a hostile limit cannot escape the cap or unbound the query', async () => {
    for (const bad of ['-1', '0', 'abc', '99999999']) {
      const res = await supertest(app).get(`/api/classes?limit=${bad}`).set(authHeader(owner));
      const rows = Array.isArray(res.body) ? res.body : res.body.rows;
      expect(rows.length).toBeLessThanOrEqual(1000);
    }
  });

  it('pagination stays branch-scoped (no cross-branch leak through a page)', async () => {
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?,?,?)').run('c7_other', 'Other', 'L');
    db.prepare(
      `INSERT OR REPLACE INTO classes (id,name,branch_id,capacity,min_viable_size,status,lifecycle_stage,level,fee,gender_policy,start_date)
       VALUES ('c7_foreign','Foreign','c7_other',5,1,'active','activated','A1',0,'mixed',?)`
    ).run(today());
    const res = await supertest(app).get('/api/classes?limit=1000').set(authHeader(reg));
    const rows = Array.isArray(res.body) ? res.body : res.body.rows;
    expect(rows.every((c: any) => c.branchId === BRANCH)).toBe(true);
  });
});
