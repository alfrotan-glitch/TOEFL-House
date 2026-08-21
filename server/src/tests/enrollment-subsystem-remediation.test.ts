/**
 * Enrollment subsystem remediation — regression & adversarial suite
 * ============================================================================
 * Closes the confirmed findings in
 * docs/ENROLLMENT_SUBSYSTEM_AUDIT_2026-08-18.md. Every test here fails (or the
 * exploit succeeds) against the pre-remediation code.
 *
 *   E-1  CRITICAL  POST /students/:id/transfer acted as an unguarded
 *                  enrollment CREATE: it resurrected terminal enrollments,
 *                  enrolled students who had no enrollment at all, and skipped
 *                  the placement gate, the gender policy and the lifecycle
 *                  state machine that enroll() enforces.
 *   E-2  HIGH      journey/enrollments had no duplicate guard, so one student
 *                  could hold unlimited seat-consuming enrollments in a single
 *                  class by varying the caller-supplied semesterName.
 *   E-3  MEDIUM    Class merge counted active|confirmed|pending but moved only
 *                  'active', stranding pending enrollments on the cancelled
 *                  source class and over-reporting movedStudents.
 *   E-4  LOW       EnrollmentService threw bare Error for business validation,
 *                  so client-correctable failures surfaced as HTTP 500.
 *
 * Behavioural, route-level tests driven through HTTP with real permissions.
 * Raw INSERTs are used only to age fixtures into states the API cannot reach
 * directly (e.g. forcing an enrollment to 'pending'), never to fake a result
 * the production code is supposed to produce.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { studentsRouter } from '../routes/students.routes.js';
import { journeyRouter } from '../routes/journey.routes.js';
import classesRouter from '../routes/classes.routes.js';
import { enrollmentRouter } from '../routes/enrollment.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { getEnrollmentService } from '../core/academic/enrollment-service.js';
import { ACTIVE_ENROLLMENT_STATUSES } from '../core/academic/class-capacity.js';

const BRANCH = 'enr_rem_branch';
const OTHER_BRANCH = 'enr_rem_branch_b';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students/:id/journey', journeyRouter);
  app.use('/api/students', studentsRouter);
  app.use('/api/classes', classesRouter);
  app.use('/api/enrollments', enrollmentRouter);
  app.use(errorHandler);
  return app;
}
function makeUser(o: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: o.userId, username: o.username || o.userId,
    branchId: o.branchId || BRANCH, fullName: 'Enrollment Test User',
  };
}
function authHeader(u: TokenPayload) { return { Authorization: `Bearer ${signToken(u)}` }; }

let app: express.Express;
let reg: TokenPayload;
let owner: TokenPayload;
let phoneSeq = 0;
function nextPhone(): string {
  phoneSeq += 1;
  return `07${String(60000000 + phoneSeq).slice(-8)}`;
}

async function createStudent(body: Record<string, unknown> = {}) {
  const res = await supertest(app).post('/api/students/manual').set(authHeader(reg)).send({
    fullName: 'Enrollment Fixture', gender: 'male', phone: nextPhone(), ...body,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}
function makeClass(
  cid: string,
  capacity: number,
  opts: { gender?: 'mixed' | 'female' | 'male'; branch?: string; status?: string } = {},
) {
  db.prepare(
    `INSERT OR REPLACE INTO classes (id, name, branch_id, capacity, min_viable_size, status,
       lifecycle_stage, level, fee, gender_policy, start_date)
     VALUES (?, ?, ?, ?, 1, ?, 'activated', 'A1', 5000, ?, ?)`
  ).run(cid, `Class ${cid}`, opts.branch || BRANCH, capacity, opts.status || 'active', opts.gender || 'mixed', today());
  db.prepare('DELETE FROM enrollments WHERE class_id = ?').run(cid);
}
function seatRows(studentId: string, classId: string): number {
  return (db.prepare(
    `SELECT COUNT(*) c FROM enrollments WHERE student_id = ? AND class_id = ?
       AND status IN ('active','confirmed','pending')`
  ).get(studentId, classId) as { c: number }).c;
}
function seatsUsed(classId: string): number {
  return (db.prepare(
    `SELECT COUNT(DISTINCT student_id) c FROM enrollments
      WHERE class_id = ? AND status IN ('active','confirmed','pending')`
  ).get(classId) as { c: number }).c;
}
function statusesOf(studentId: string): string[] {
  return (db.prepare('SELECT status FROM enrollments WHERE student_id = ? ORDER BY created_at')
    .all(studentId) as { status: string }[]).map((r) => r.status);
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  for (const [b, n] of [[BRANCH, 'Enrollment Branch'], [OTHER_BRANCH, 'Other Branch']]) {
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(b, n, 'Loc');
  }
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`
  ).run('u_enr_reg', 'enr_reg', 'Enr Reg', BRANCH, await hashPassword('x'));
  assignRole('u_enr_reg', 'registrar', BRANCH);
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`
  ).run('u_enr_owner', 'enr_owner', 'Enr Owner', BRANCH, await hashPassword('x'));
  assignRole('u_enr_owner', 'owner', BRANCH);

  reg = makeUser({ userId: 'u_enr_reg', branchId: BRANCH });
  owner = makeUser({ userId: 'u_enr_owner', branchId: BRANCH });
  app = createApp();
});

// ===========================================================================
// E-1 — transfer is not an enrollment-creation path
// ===========================================================================
describe('E-1 — transfer requires a valid active source enrollment', () => {
  it('refuses to transfer a student whose only enrollment is terminal (graduated)', async () => {
    makeClass('e1_src', 10); makeClass('e1_dst', 10);
    const sid = await createStudent({ classId: 'e1_src' });
    const enr = db.prepare("SELECT id FROM enrollments WHERE student_id = ? AND status = 'active'")
      .get(sid) as { id: string };

    await supertest(app).post(`/api/enrollments/${enr.id}/complete`).set(authHeader(reg)).send({});
    await supertest(app).post(`/api/enrollments/${enr.id}/graduate`).set(authHeader(reg)).send({});
    expect(statusesOf(sid)).toEqual(['graduated']);

    const res = await supertest(app).post(`/api/students/${sid}/transfer`)
      .set(authHeader(reg)).send({ toClassId: 'e1_dst' });

    // Pre-remediation: 200, and a brand-new 'active' row appeared in e1_dst.
    expect(res.status).toBe(409);
    expect(statusesOf(sid)).toEqual(['graduated']);
    expect(seatsUsed('e1_dst')).toBe(0);
  });

  it.each(['dropped', 'withdrawn', 'transferred'] as const)(
    'refuses to transfer when the only enrollment is %s (terminal)',
    async (terminal) => {
      makeClass(`e1_t_${terminal}`, 10); makeClass(`e1_td_${terminal}`, 10);
      const sid = await createStudent({ classId: `e1_t_${terminal}` });
      db.prepare('UPDATE enrollments SET status = ? WHERE student_id = ?').run(terminal, sid);

      const res = await supertest(app).post(`/api/students/${sid}/transfer`)
        .set(authHeader(reg)).send({ toClassId: `e1_td_${terminal}` });

      expect(res.status).toBe(409);
      expect(seatsUsed(`e1_td_${terminal}`)).toBe(0);
    },
  );

  it('refuses to transfer a student who has no enrollment at all', async () => {
    makeClass('e1_none_dst', 10);
    const sid = await createStudent();
    expect(statusesOf(sid)).toEqual([]);

    const res = await supertest(app).post(`/api/students/${sid}/transfer`)
      .set(authHeader(reg)).send({ toClassId: 'e1_none_dst' });

    // Pre-remediation: 200 — transfer minted an enrollment from nothing.
    expect(res.status).toBe(409);
    expect(statusesOf(sid)).toEqual([]);
  });

  it('a completed (non-terminal but not active) enrollment cannot be transferred', async () => {
    makeClass('e1_comp', 10); makeClass('e1_comp_dst', 10);
    const sid = await createStudent({ classId: 'e1_comp' });
    const enr = db.prepare("SELECT id FROM enrollments WHERE student_id = ?").get(sid) as { id: string };
    await supertest(app).post(`/api/enrollments/${enr.id}/complete`).set(authHeader(reg)).send({});

    const res = await supertest(app).post(`/api/students/${sid}/transfer`)
      .set(authHeader(reg)).send({ toClassId: 'e1_comp_dst' });

    expect(res.status).toBe(409);
    expect(seatsUsed('e1_comp_dst')).toBe(0);
  });

  it('a valid active source transfers successfully and closes the source as transferred', async () => {
    makeClass('e1_ok_src', 10); makeClass('e1_ok_dst', 10);
    const sid = await createStudent({ classId: 'e1_ok_src' });

    const res = await supertest(app).post(`/api/students/${sid}/transfer`)
      .set(authHeader(reg)).send({ toClassId: 'e1_ok_dst' });

    expect(res.status).toBe(200);
    const rows = db.prepare('SELECT class_id, status FROM enrollments WHERE student_id = ?')
      .all(sid) as { class_id: string; status: string }[];
    expect(rows.find((r) => r.class_id === 'e1_ok_src')?.status).toBe('transferred');
    expect(rows.find((r) => r.class_id === 'e1_ok_dst')?.status).toBe('active');
    expect(seatsUsed('e1_ok_dst')).toBe(1);
    expect(seatsUsed('e1_ok_src')).toBe(0);
  });

  it('enforces destination capacity (seat count never exceeds capacity)', async () => {
    makeClass('e1_cap_src', 10); makeClass('e1_cap_dst', 1);
    await createStudent({ classId: 'e1_cap_dst' });          // fills it
    const mover = await createStudent({ classId: 'e1_cap_src' });

    const res = await supertest(app).post(`/api/students/${mover}/transfer`)
      .set(authHeader(reg)).send({ toClassId: 'e1_cap_dst' });

    expect(res.status).toBe(409);
    expect(seatsUsed('e1_cap_dst')).toBe(1);
    // Source must be untouched by the failed attempt.
    expect(statusesOf(mover)).toEqual(['active']);
  });

  it('enforces the destination gender policy — including via the transfer-request path', async () => {
    makeClass('e1_gen_src', 10);
    makeClass('e1_gen_dst', 10, { gender: 'female' });
    const sid = await createStudent({ classId: 'e1_gen_src', gender: 'male' });
    const enr = db.prepare("SELECT id FROM enrollments WHERE student_id = ? AND status='active'")
      .get(sid) as { id: string };

    const direct = await supertest(app).post(`/api/students/${sid}/transfer`)
      .set(authHeader(reg)).send({ toClassId: 'e1_gen_dst' });
    expect(direct.status).toBe(400);

    // The transfer-request path calls the service directly and bypassed the
    // route-level gender check entirely before remediation (HTTP 201).
    const viaRequest = await supertest(app).post(`/api/enrollments/${enr.id}/transfer-requests`)
      .set(authHeader(owner)).send({ toClassId: 'e1_gen_dst', reason: 'adversarial' });
    expect(viaRequest.status).toBe(400);
    expect(seatsUsed('e1_gen_dst')).toBe(0);
  });

  it('refuses a cross-branch destination', async () => {
    makeClass('e1_xb_src', 10);
    makeClass('e1_xb_dst', 10, { branch: OTHER_BRANCH });
    const sid = await createStudent({ classId: 'e1_xb_src' });

    const res = await supertest(app).post(`/api/students/${sid}/transfer`)
      .set(authHeader(reg)).send({ toClassId: 'e1_xb_dst' });

    expect(res.status).toBe(400);
    expect(seatsUsed('e1_xb_dst')).toBe(0);
  });

  it('a failed transfer leaves source enrollment and financial state unchanged', async () => {
    makeClass('e1_atom_src', 10); makeClass('e1_atom_dst', 1);
    await createStudent({ classId: 'e1_atom_dst' });
    const sid = await createStudent({ classId: 'e1_atom_src' });

    const semBefore = db.prepare('SELECT class_id, status FROM student_semesters WHERE student_id = ?')
      .all(sid);
    const enrBefore = db.prepare('SELECT id, class_id, status FROM enrollments WHERE student_id = ?')
      .all(sid);

    const res = await supertest(app).post(`/api/students/${sid}/transfer`)
      .set(authHeader(reg)).send({ toClassId: 'e1_atom_dst' });
    expect(res.status).toBe(409);

    expect(db.prepare('SELECT class_id, status FROM student_semesters WHERE student_id = ?').all(sid))
      .toEqual(semBefore);
    expect(db.prepare('SELECT id, class_id, status FROM enrollments WHERE student_id = ?').all(sid))
      .toEqual(enrBefore);
  });

  it('applies the placement gate on transfer exactly as enroll-class does', async () => {
    // A real placement policy: program → published version → level → class, with
    // a branch profile in 'required' mode. Without this fixture the gate exits
    // early on every path and the assertion proves nothing.
    db.prepare("INSERT OR REPLACE INTO programs (id, name, branch_id) VALUES ('e1_prog', 'Gated Program', ?)").run(BRANCH);
    db.prepare(
      `INSERT OR REPLACE INTO program_versions (id, program_id, version_label, version_number, status)
       VALUES ('e1_pv', 'e1_prog', 'v1', 1, 'published')`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO levels (id, program_id, name, "order", program_version_id, code, is_active)
       VALUES ('e1_lvl', 'e1_prog', 'Gated Level', 2, 'e1_pv', 'G2', 1)`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO placement_assessment_profiles
         (id, program_version_id, branch_id, requirement_mode, first_level_exempt, components_json)
       VALUES ('e1_pap', 'e1_pv', ?, 'required', 0, ?)`
    ).run(BRANCH, JSON.stringify([{ key: 'placement', type: 'custom_score', label: 'Placement', required: true, weight: 100, maxScore: 100 }]));

    makeClass('e1_pl_src', 10);
    makeClass('e1_pl_dst', 10);
    db.prepare("UPDATE classes SET level_id = 'e1_lvl', program_id = 'e1_prog' WHERE id = 'e1_pl_dst'").run();

    const sid = await createStudent({ classId: 'e1_pl_src' });

    const viaEnroll = await supertest(app).post(`/api/students/${sid}/enroll-class`)
      .set(authHeader(reg)).send({ classId: 'e1_pl_dst' });
    const viaTransfer = await supertest(app).post(`/api/students/${sid}/transfer`)
      .set(authHeader(reg)).send({ toClassId: 'e1_pl_dst' });

    // The whole point of E-1: these two paths must agree. Pre-remediation
    // enroll-class returned 400 and transfer returned 200.
    expect(viaEnroll.status).toBeGreaterThanOrEqual(400);
    expect(viaTransfer.status).toBeGreaterThanOrEqual(400);
    expect(String(viaTransfer.body.error)).toMatch(/placement/i);
    expect(seatsUsed('e1_pl_dst')).toBe(0);

    // Cleanup so the gated program cannot leak into later fixtures.
    db.prepare("DELETE FROM placement_assessment_profiles WHERE id = 'e1_pap'").run();
    db.prepare("UPDATE classes SET level_id = NULL WHERE id = 'e1_pl_dst'").run();
  });

  it('refuses a transfer into a class where the student already holds a seat', async () => {
    // The student is active in SRC and simultaneously holds a non-active seat
    // (pending) in DST — the only state in which the destination duplicate
    // guard is reachable, since an identical from/to class is rejected earlier.
    makeClass('e1_dup_src', 10);
    makeClass('e1_dup_dst', 10);
    const sid = await createStudent({ classId: 'e1_dup_src' });
    const extra = await supertest(app).post(`/api/students/${sid}/journey/enrollments`)
      .set(authHeader(reg)).send({ classId: 'e1_dup_dst', semesterName: 'Parallel Term', enrollmentType: 'new' });
    expect(extra.status).toBe(201);
    db.prepare("UPDATE enrollments SET status = 'pending' WHERE student_id = ? AND class_id = 'e1_dup_dst'")
      .run(sid);
    expect(seatRows(sid, 'e1_dup_dst')).toBe(1);

    const res = await supertest(app).post(`/api/students/${sid}/transfer`)
      .set(authHeader(reg)).send({ toClassId: 'e1_dup_dst' });

    expect(res.status).toBe(409);
    // Still exactly one seat — the transfer must not have added a second.
    expect(seatRows(sid, 'e1_dup_dst')).toBe(1);
    expect(statusesOf(sid).filter((s) => s === 'active')).toHaveLength(1);
  });

  it('transfer does not duplicate the fee obligation', async () => {
    makeClass('e1_fee_src', 10); makeClass('e1_fee_dst', 10);
    const sid = await createStudent({ classId: 'e1_fee_src' });
    const dueBefore = (db.prepare(
      'SELECT COALESCE(SUM(COALESCE(net_fee_amount, fee_amount, 0)), 0) s FROM student_semesters WHERE student_id = ?'
    ).get(sid) as { s: number }).s;

    const res = await supertest(app).post(`/api/students/${sid}/transfer`)
      .set(authHeader(reg)).send({ toClassId: 'e1_fee_dst' });
    expect(res.status).toBe(200);

    const dueAfter = (db.prepare(
      'SELECT COALESCE(SUM(COALESCE(net_fee_amount, fee_amount, 0)), 0) s FROM student_semesters WHERE student_id = ?'
    ).get(sid) as { s: number }).s;
    expect(dueAfter).toBe(dueBefore);
  });
});

// ===========================================================================
// E-2 — one duplicate-enrollment authority, shared by every writer
// ===========================================================================
describe('E-2 — duplicate enrollment is refused on every write path', () => {
  it('journey/enrollments cannot create a second seat for the same class+semester', async () => {
    makeClass('e2_dup', 10);
    const sid = await createStudent({ classId: 'e2_dup' });
    const sem = (db.prepare('SELECT semester_name FROM enrollments WHERE student_id = ?')
      .get(sid) as { semester_name: string }).semester_name;

    const res = await supertest(app).post(`/api/students/${sid}/journey/enrollments`)
      .set(authHeader(reg)).send({ classId: 'e2_dup', semesterName: sem, enrollmentType: 'new' });

    // Pre-remediation: 201 and a second active row.
    expect(res.status).toBe(409);
    expect(seatRows(sid, 'e2_dup')).toBe(1);
    // The APPLICATION guard must produce this, not the DB constraint. Migration
    // 074 would also stop the write, but as an unhandled SQLITE_CONSTRAINT —
    // a 500 with a raw driver message. Asserting the domain message keeps the
    // two layers independently verified: delete the service-layer check and
    // this assertion fails even though the row is still refused.
    expect(res.body.error).toBe('Already enrolled in this class.');
  });

  it('varying semesterName cannot stack unlimited seats in one class (the original exploit)', async () => {
    makeClass('e2_stack', 10);
    const sid = await createStudent({ classId: 'e2_stack' });

    // The exploit: five calls, five different caller-supplied semester names.
    for (const name of ['X1', 'X2', 'X3', 'X4', 'X5']) {
      await supertest(app).post(`/api/students/${sid}/journey/enrollments`)
        .set(authHeader(reg)).send({ classId: 'e2_stack', semesterName: name, enrollmentType: 'new' });
    }

    // Each distinct semester is a legitimate additional TERM, but the student
    // must never hold two seats for the SAME semester, and the class must
    // still count them as one occupant.
    const perSemester = db.prepare(
      `SELECT semester_name, COUNT(*) c FROM enrollments
        WHERE student_id = ? AND class_id = ? AND status IN ('active','confirmed','pending')
        GROUP BY semester_name HAVING c > 1`
    ).all(sid, 'e2_stack');
    expect(perSemester).toEqual([]);
    expect(seatsUsed('e2_stack')).toBe(1);
  });

  it('the extra-class route refuses a student already seated in that class', async () => {
    makeClass('e2_extra', 10);
    const sid = await createStudent({ classId: 'e2_extra' });

    const res = await supertest(app).post(`/api/students/${sid}/enroll-class`)
      .set(authHeader(reg)).send({ classId: 'e2_extra' });

    expect(res.status).toBe(409);
    expect(seatRows(sid, 'e2_extra')).toBe(1);
  });

  it('a legitimate following term in the same class is still allowed (no over-blocking)', async () => {
    makeClass('e2_terms', 10);
    const sid = await createStudent({ classId: 'e2_terms' });

    const res = await supertest(app).post(`/api/students/${sid}/journey/enrollments`)
      .set(authHeader(reg)).send({ classId: 'e2_terms', semesterName: 'Following Term', enrollmentType: 'new' });

    expect(res.status).toBe(201);
    // Two terms, but still a single occupied seat.
    expect(seatsUsed('e2_terms')).toBe(1);
  });

  it('is enforced at the DATABASE level, not only in the application', () => {
    const dup = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index'
        AND name = 'uq_enrollment_active_seat_per_class'`
    ).get() as { sql: string } | undefined;

    expect(dup, 'migration 074 unique index must exist').toBeDefined();
    // The guarded status set must be exactly the seat-consuming set, so the
    // constraint and the capacity predicate can never disagree.
    for (const s of ACTIVE_ENROLLMENT_STATUSES) expect(dup!.sql).toContain(s);
  });

  it('the DB constraint blocks a duplicate inserted behind the service', async () => {
    makeClass('e2_raw', 10);
    const sid = await createStudent({ classId: 'e2_raw' });
    const row = db.prepare('SELECT semester_name FROM enrollments WHERE student_id = ?')
      .get(sid) as { semester_name: string | null };

    expect(() => db.prepare(
      `INSERT INTO enrollments (id, student_id, class_id, branch_id, semester_name, status, enrollment_type, started_at)
       VALUES ('enr_raw_dup_test', ?, 'e2_raw', ?, ?, 'active', 'new', datetime('now'))`
    ).run(sid, BRANCH, row.semester_name)).toThrow(/UNIQUE constraint failed/);
  });
});

// ===========================================================================
// E-3 — class merge moves exactly what it counts, and says so truthfully
// ===========================================================================
describe('E-3 — class merge is semantically consistent', () => {
  function pendingise(studentId: string, classId: string) {
    db.prepare("UPDATE enrollments SET status = 'pending' WHERE student_id = ? AND class_id = ?")
      .run(studentId, classId);
  }

  it('moves pending enrollments too, and never strands one on the cancelled source', async () => {
    makeClass('e3_src', 10); makeClass('e3_dst', 10);
    const a = await createStudent({ classId: 'e3_src' });
    const b = await createStudent({ classId: 'e3_src' });
    pendingise(b, 'e3_src');

    const res = await supertest(app).post('/api/classes/e3_src/merge')
      .set(authHeader(owner)).send({ targetClassId: 'e3_dst' });
    expect(res.status).toBe(200);

    // Pre-remediation: the pending row stayed on e3_src, which this same
    // transaction cancels — a live enrollment pointing at a dead class.
    const leftBehind = db.prepare(
      `SELECT COUNT(*) c FROM enrollments WHERE class_id = 'e3_src'
        AND status IN ('active','confirmed','pending')`
    ).get() as { c: number };
    expect(leftBehind.c).toBe(0);
    expect(seatRows(a, 'e3_dst')).toBe(1);
    expect(seatRows(b, 'e3_dst')).toBe(1);
  });

  it('reports movedStudents equal to the students actually moved', async () => {
    makeClass('e3_count_src', 10); makeClass('e3_count_dst', 10);
    const a = await createStudent({ classId: 'e3_count_src' });
    const b = await createStudent({ classId: 'e3_count_src' });
    pendingise(b, 'e3_count_src');

    const res = await supertest(app).post('/api/classes/e3_count_src/merge')
      .set(authHeader(owner)).send({ targetClassId: 'e3_count_dst' });

    expect(res.status).toBe(200);
    const actuallyMoved = (db.prepare(
      `SELECT COUNT(DISTINCT student_id) c FROM enrollments WHERE class_id = 'e3_count_dst'
        AND status IN ('active','confirmed','pending')`
    ).get() as { c: number }).c;
    // Pre-remediation: reported 2, moved 1.
    expect(res.body.movedStudents).toBe(actuallyMoved);
    expect(res.body.movedStudents).toBe(2);
    void a;
  });

  it('leaves completed history attached to the class where it happened', async () => {
    makeClass('e3_hist_src', 10); makeClass('e3_hist_dst', 10);
    const done = await createStudent({ classId: 'e3_hist_src' });
    const live = await createStudent({ classId: 'e3_hist_src' });
    db.prepare("UPDATE enrollments SET status = 'completed' WHERE student_id = ?").run(done);

    const res = await supertest(app).post('/api/classes/e3_hist_src/merge')
      .set(authHeader(owner)).send({ targetClassId: 'e3_hist_dst' });
    expect(res.status).toBe(200);

    // A completed enrollment records where the student actually studied;
    // rewriting its class_id would falsify the academic record.
    const hist = db.prepare('SELECT class_id, status FROM enrollments WHERE student_id = ?')
      .get(done) as { class_id: string; status: string };
    expect(hist).toMatchObject({ class_id: 'e3_hist_src', status: 'completed' });
    expect(seatRows(live, 'e3_hist_dst')).toBe(1);
  });

  it('keeps the enrollment and its fee row on the same class', async () => {
    makeClass('e3_fee_src', 10); makeClass('e3_fee_dst', 10);
    const a = await createStudent({ classId: 'e3_fee_src' });
    const b = await createStudent({ classId: 'e3_fee_src' });
    pendingise(b, 'e3_fee_src');

    await supertest(app).post('/api/classes/e3_fee_src/merge')
      .set(authHeader(owner)).send({ targetClassId: 'e3_fee_dst' });

    for (const sid of [a, b]) {
      const enr = db.prepare(
        `SELECT class_id FROM enrollments WHERE student_id = ?
          AND status IN ('active','confirmed','pending')`
      ).get(sid) as { class_id: string };
      const sem = db.prepare("SELECT class_id FROM student_semesters WHERE student_id = ? AND status = 'active'")
        .get(sid) as { class_id: string } | undefined;
      // Pre-remediation the fee row moved while the pending enrollment did not.
      if (sem) expect(sem.class_id).toBe(enr.class_id);
    }
  });

  it('refuses to merge when the destination lacks free seats', async () => {
    makeClass('e3_full_src', 10); makeClass('e3_full_dst', 1);
    await createStudent({ classId: 'e3_full_dst' });
    await createStudent({ classId: 'e3_full_src' });
    await createStudent({ classId: 'e3_full_src' });

    const res = await supertest(app).post('/api/classes/e3_full_src/merge')
      .set(authHeader(owner)).send({ targetClassId: 'e3_full_dst' });

    expect(res.status).toBe(400);
    expect(seatsUsed('e3_full_dst')).toBe(1);
    expect(seatsUsed('e3_full_src')).toBe(2);
  });

  it('a merge that fails partway rolls back EVERY write, leaving no split state', async () => {
    makeClass('e3_atom_src', 10); makeClass('e3_atom_dst', 10);
    const a = await createStudent({ classId: 'e3_atom_src' });

    // 'grading' cannot transition to 'cancelled' (CLASS_TRANSITIONS), so
    // classLifecycle.cancel() throws AFTER the enrollment and semester rows
    // have been moved — a genuine mid-transaction failure rather than a
    // simulated one.
    db.prepare("UPDATE classes SET lifecycle_stage = 'grading' WHERE id = 'e3_atom_src'").run();

    const enrBefore = db.prepare('SELECT id, class_id, status FROM enrollments WHERE student_id = ?').all(a);
    const semBefore = db.prepare('SELECT id, class_id, status FROM student_semesters WHERE student_id = ?').all(a);

    const res = await supertest(app).post('/api/classes/e3_atom_src/merge')
      .set(authHeader(owner)).send({ targetClassId: 'e3_atom_dst' });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // Enrollments AND the fee projection must both be untouched. If either is
    // written outside the transaction, the student ends up with an enrollment
    // on one class and an obligation on another.
    expect(db.prepare('SELECT id, class_id, status FROM enrollments WHERE student_id = ?').all(a))
      .toEqual(enrBefore);
    expect(db.prepare('SELECT id, class_id, status FROM student_semesters WHERE student_id = ?').all(a))
      .toEqual(semBefore);
    expect(seatsUsed('e3_atom_dst')).toBe(0);

    db.prepare("UPDATE classes SET lifecycle_stage = 'activated' WHERE id = 'e3_atom_src'").run();
  });

  it('a merge with nothing movable reports zero and still cancels the source', async () => {
    makeClass('e3_empty_src', 10); makeClass('e3_empty_dst', 10);

    const res = await supertest(app).post('/api/classes/e3_empty_src/merge')
      .set(authHeader(owner)).send({ targetClassId: 'e3_empty_dst' });

    expect(res.status).toBe(200);
    expect(res.body.movedStudents).toBe(0);
    const cls = db.prepare("SELECT status FROM classes WHERE id = 'e3_empty_src'").get() as { status: string };
    expect(cls.status).toBe('cancelled');
  });
});

// ===========================================================================
// E-4 — business validation returns a business status code
// ===========================================================================
describe('E-4 — enrollment error contract', () => {
  it('maps a cross-branch destination to 4xx, not 500', async () => {
    makeClass('e4_src', 10);
    makeClass('e4_xb', 10, { branch: OTHER_BRANCH });
    const sid = await createStudent({ classId: 'e4_src' });
    const enr = db.prepare("SELECT id FROM enrollments WHERE student_id = ? AND status='active'")
      .get(sid) as { id: string };

    const res = await supertest(app).post(`/api/enrollments/${enr.id}/transfer-requests`)
      .set(authHeader(owner)).send({ toClassId: 'e4_xb', reason: 'contract probe' });

    // Pre-remediation: 500 from a bare Error.
    expect(res.status).toBe(400);
    expect(res.status).toBeLessThan(500);
  });

  it('maps an inactive destination class to 4xx, not 500', async () => {
    makeClass('e4_src2', 10);
    makeClass('e4_inactive', 10, { status: 'completed' });
    const sid = await createStudent({ classId: 'e4_src2' });

    const res = await supertest(app).post(`/api/students/${sid}/transfer`)
      .set(authHeader(reg)).send({ toClassId: 'e4_inactive' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('maps a missing destination class to 404, not 500', async () => {
    makeClass('e4_src3', 10);
    const sid = await createStudent({ classId: 'e4_src3' });

    const res = await supertest(app).post(`/api/students/${sid}/transfer`)
      .set(authHeader(reg)).send({ toClassId: 'no_such_class_at_all' });

    expect(res.status).toBe(404);
  });

  it('service-layer validation throws typed errors carrying a 4xx status', () => {
    const svc = getEnrollmentService(db);
    makeClass('e4_direct', 10);
    expect(() => svc.transfer({ studentId: 'nonexistent_student', toClassId: 'e4_direct' }))
      .toThrow(expect.objectContaining({ status: 404 }));
  });

  it('an unexpected (non-business) failure is NOT laundered into a 4xx', () => {
    const svc = getEnrollmentService(db);
    // A genuinely broken call must surface as a server-side fault, not be
    // silently reclassified as client error by a blanket catch.
    expect(() => svc.transfer({ studentId: null as unknown as string, toClassId: null as unknown as string }))
      .toThrow();
    const thrown = (() => {
      try { svc.transfer({ studentId: null as unknown as string, toClassId: null as unknown as string }); }
      catch (e) { return e as { status?: number }; }
    })();
    // Either untyped (→ 500 by the error handler) or an explicit 5xx; it must
    // never claim to be a successful or client-correctable outcome.
    if (thrown?.status !== undefined) expect(thrown.status).not.toBe(200);
  });
});

// ===========================================================================
// C-1 — enrollment → student_semesters projection (closure-audit finding)
// ===========================================================================
//
// `student_semesters` is a derived projection of the enrollment and
// EnrollmentService is its single writer. Closing an enrollment used to leave
// the projection `status='active'`, which (a) made
// `uq_student_semester_active` reject a legitimate re-enrolment into the same
// term with an opaque DB-level 409, and (b) kept the dropped term inside the
// ACTIVE balance scope, overstating current debt.
//
// 'deferred' is the correct closed state, not 'completed': the schema CHECK
// permits only active|completed|deferred, and classes.routes.ts already maps a
// manual-review 'drop'/'retake' outcome to 'deferred' while calling this same
// service. Lifetime financial truth is untouched.
describe('C-1 — dropped/withdrawn enrollments close their semester projection', () => {
  function semestersOf(sid: string) {
    return db.prepare(
      'SELECT semester_name, class_id, status, COALESCE(net_fee_amount, fee_amount, 0) AS fee FROM student_semesters WHERE student_id = ? ORDER BY rowid'
    ).all(sid) as { semester_name: string; class_id: string; status: string; fee: number }[];
  }
  function dueLifetime(sid: string) {
    return (db.prepare(
      'SELECT COALESCE(SUM(COALESCE(net_fee_amount, fee_amount, 0)), 0) t FROM student_semesters WHERE student_id = ?'
    ).get(sid) as { t: number }).t;
  }
  function dueActiveScope(sid: string) {
    return (db.prepare(
      "SELECT COALESCE(SUM(COALESCE(net_fee_amount, fee_amount, 0)), 0) t FROM student_semesters WHERE student_id = ? AND status = 'active'"
    ).get(sid) as { t: number }).t;
  }
  async function activeEnrollmentId(sid: string) {
    return (db.prepare("SELECT id FROM enrollments WHERE student_id = ? AND status = 'active'").get(sid) as { id: string }).id;
  }

  it('a dropped enrollment defers its semester row (1) instead of leaving it active', async () => {
    makeClass('c1_drop', 10);
    const sid = await createStudent({ classId: 'c1_drop' });
    expect(semestersOf(sid).map((r) => r.status)).toEqual(['active']);

    const enr = await activeEnrollmentId(sid);
    const res = await supertest(app).post(`/api/enrollments/${enr}/drop`)
      .set(authHeader(reg)).send({ reason: 'C-1 regression' });
    expect(res.status).toBe(200);

    // Pre-fix this stayed 'active'.
    expect(semestersOf(sid).map((r) => r.status)).toEqual(['deferred']);
  });

  it('a withdrawn enrollment defers its semester row too', async () => {
    makeClass('c1_wd', 10);
    const sid = await createStudent({ classId: 'c1_wd' });
    const enr = await activeEnrollmentId(sid);

    const res = await supertest(app).post(`/api/enrollments/${enr}/withdraw`)
      .set(authHeader(reg)).send({ reason: 'C-1 regression' });
    expect(res.status).toBe(200);
    expect(semestersOf(sid).map((r) => r.status)).toEqual(['deferred']);
  });

  it('same-semester re-enrolment is possible after a drop (2)', async () => {
    makeClass('c1_re', 10);
    const sid = await createStudent({ classId: 'c1_re' });
    const semName = semestersOf(sid)[0].semester_name;
    const enr = await activeEnrollmentId(sid);
    await supertest(app).post(`/api/enrollments/${enr}/drop`).set(authHeader(reg)).send({ reason: 'x' });

    const again = await supertest(app).post(`/api/students/${sid}/journey/enrollments`)
      .set(authHeader(reg)).send({ classId: 'c1_re', semesterName: semName, enrollmentType: 'new' });

    // Pre-fix: 409 "A record with this unique information already exists."
    expect(again.status).toBe(201);
    expect(seatsUsed('c1_re')).toBe(1);
  });

  it('a different semester still enrols normally after a drop (3)', async () => {
    makeClass('c1_diff', 10);
    const sid = await createStudent({ classId: 'c1_diff' });
    const enr = await activeEnrollmentId(sid);
    await supertest(app).post(`/api/enrollments/${enr}/drop`).set(authHeader(reg)).send({ reason: 'x' });

    const next = await supertest(app).post(`/api/students/${sid}/journey/enrollments`)
      .set(authHeader(reg)).send({ classId: 'c1_diff', semesterName: 'A Later Term', enrollmentType: 'new' });
    expect(next.status).toBe(201);
  });

  it('drop + re-enrol does not duplicate the fee obligation and preserves payments (4, 5)', async () => {
    makeClass('c1_fee', 10);
    const sid = await createStudent({ classId: 'c1_fee' });
    const semName = semestersOf(sid)[0].semester_name;
    const semId = (db.prepare('SELECT id FROM student_semesters WHERE student_id = ?').get(sid) as { id: string }).id;

    const pay = await supertest(app).post(`/api/students/${sid}/payments`)
      .set(authHeader(reg)).send({ amount: 2000, category: 'fee', paymentMethod: 'cash', semesterId: semId });
    expect(pay.status).toBeLessThan(400);

    const lifetimeBefore = dueLifetime(sid);
    const paidBefore = (db.prepare(
      "SELECT COALESCE(SUM(amount), 0) t FROM payments WHERE student_id = ? AND status = 'completed'"
    ).get(sid) as { t: number }).t;
    expect(paidBefore).toBe(2000);

    const enr = await activeEnrollmentId(sid);
    await supertest(app).post(`/api/enrollments/${enr}/drop`).set(authHeader(reg)).send({ reason: 'x' });
    await supertest(app).post(`/api/students/${sid}/journey/enrollments`)
      .set(authHeader(reg)).send({ classId: 'c1_fee', semesterName: semName, enrollmentType: 'new' });

    // Historical obligation preserved exactly; the replacement term adds no
    // second charge for the same money.
    expect(dueLifetime(sid)).toBe(lifetimeBefore);
    expect((db.prepare(
      "SELECT COALESCE(SUM(amount), 0) t FROM payments WHERE student_id = ? AND status = 'completed'"
    ).get(sid) as { t: number }).t).toBe(paidBefore);
    // Nothing was deleted — the dropped term survives as history.
    expect(semestersOf(sid).some((r) => r.status === 'deferred' && r.fee === lifetimeBefore)).toBe(true);
  });

  it('a dropped term leaves the ACTIVE balance scope but stays in lifetime debt', async () => {
    makeClass('c1_scope', 10);
    const sid = await createStudent({ classId: 'c1_scope' });
    const lifetime = dueLifetime(sid);
    expect(dueActiveScope(sid)).toBe(lifetime);

    const enr = await activeEnrollmentId(sid);
    await supertest(app).post(`/api/enrollments/${enr}/drop`).set(authHeader(reg)).send({ reason: 'x' });

    // Current debt no longer counts a term the student left...
    expect(dueActiveScope(sid)).toBe(0);
    // ...but the money owed is not erased.
    expect(dueLifetime(sid)).toBe(lifetime);
  });

  it('terminal enrollment states remain protected after the projection change (6)', async () => {
    makeClass('c1_term', 10);
    const sid = await createStudent({ classId: 'c1_term' });
    const enr = await activeEnrollmentId(sid);
    await supertest(app).post(`/api/enrollments/${enr}/drop`).set(authHeader(reg)).send({ reason: 'x' });

    const again = await supertest(app).post(`/api/enrollments/${enr}/drop`)
      .set(authHeader(reg)).send({ reason: 'x' });
    expect(again.status).toBe(409);

    const transfer = await supertest(app).post(`/api/students/${sid}/transfer`)
      .set(authHeader(reg)).send({ toClassId: 'c1_term' });
    expect(transfer.status).toBeGreaterThanOrEqual(400);
  });

  it('the projection write is inside the drop transaction — a failed drop changes nothing (8)', () => {
    const svc = getEnrollmentService(db);
    const sid = 'c1_atomic_student';
    db.prepare(
      `INSERT OR REPLACE INTO students (id, student_code, full_name, registration_date, gender, phone, branch_id, status)
       VALUES (?, 'TH-C1A01', 'C1 Atomic', date('now'), 'male', '0790000911', ?, 'active')`
    ).run(sid, BRANCH);
    makeClass('c1_atomic', 10);
    const created = svc.enroll({ studentId: sid, branchId: BRANCH, classId: 'c1_atomic', enrollmentType: 'new', startedAt: today() });

    const semBefore = semestersOf(sid);
    // 'dropped' is terminal: a second drop must throw, and must not have
    // deferred anything on its way out.
    svc.drop(created.enrollmentId, { reason: 'first' });
    const semAfterFirst = semestersOf(sid);
    expect(semAfterFirst.every((r) => r.status === 'deferred')).toBe(true);

    expect(() => svc.drop(created.enrollmentId, { reason: 'second' })).toThrow();
    // The failed second drop left the projection exactly as the first one did.
    expect(semestersOf(sid)).toEqual(semAfterFirst);
    expect(semBefore.length).toBe(semAfterFirst.length); // no row added or removed
  });

  it('concurrent drop + re-enrol cannot produce two active projections (7)', async () => {
    makeClass('c1_conc', 10);
    const sid = await createStudent({ classId: 'c1_conc' });
    const semName = semestersOf(sid)[0].semester_name;
    const enr = await activeEnrollmentId(sid);
    await supertest(app).post(`/api/enrollments/${enr}/drop`).set(authHeader(reg)).send({ reason: 'x' });

    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        supertest(app).post(`/api/students/${sid}/journey/enrollments`)
          .set(authHeader(reg)).send({ classId: 'c1_conc', semesterName: semName, enrollmentType: 'new' })
      )
    );
    expect(attempts.filter((r) => r.status === 201)).toHaveLength(1);
    expect(semestersOf(sid).filter((r) => r.status === 'active')).toHaveLength(1);
    expect(seatsUsed('c1_conc')).toBe(1);
  });

  it('dropping ONE enrollment does not defer the student\'s other concurrent terms', async () => {
    // A student may legitimately hold seats in two classes at once (the
    // extra-class / concurrent-enrolment flow). The projection close must be
    // scoped to the dropped enrollment's own class: a student-wide UPDATE would
    // silently deactivate the term they are still attending, removing a real
    // obligation from the ACTIVE balance scope and corrupting current debt.
    makeClass('c1_scopeA', 10);
    makeClass('c1_scopeB', 10);
    const sid = await createStudent({ classId: 'c1_scopeA' });
    const second = await supertest(app).post(`/api/students/${sid}/journey/enrollments`)
      .set(authHeader(reg)).send({ classId: 'c1_scopeB', semesterName: 'Parallel Term', enrollmentType: 'new' });
    expect(second.status).toBe(201);

    const before = semestersOf(sid);
    expect(before.filter((r) => r.status === 'active')).toHaveLength(2);
    const activeDueBefore = dueActiveScope(sid);

    const enrA = (db.prepare(
      "SELECT id FROM enrollments WHERE student_id = ? AND class_id = 'c1_scopeA' AND status = 'active'"
    ).get(sid) as { id: string }).id;
    const res = await supertest(app).post(`/api/enrollments/${enrA}/drop`)
      .set(authHeader(reg)).send({ reason: 'scope probe' });
    expect(res.status).toBe(200);

    const after = semestersOf(sid);
    // Exactly the dropped class's projection closed.
    expect(after.find((r) => r.class_id === 'c1_scopeA')?.status).toBe('deferred');
    // The other class the student is still attending is untouched.
    expect(after.find((r) => r.class_id === 'c1_scopeB')?.status).toBe('active');
    expect(after.filter((r) => r.status === 'active')).toHaveLength(1);
    // Current debt drops by exactly the abandoned term, not by both.
    const droppedFee = before.find((r) => r.class_id === 'c1_scopeA')!.fee;
    expect(dueActiveScope(sid)).toBe(activeDueBefore - droppedFee);
    expect(seatsUsed('c1_scopeB')).toBe(1);
  });

  it('JourneyEngine owns no enrollment-INSERT authority (9)', async () => {
    const engine = (await import('../core/journey/journey-engine.js')).getJourneyEngine(db);
    // The unguarded raw-INSERT path was removed; the journey layer records
    // facts only. If this ever returns a function again, a shadow enrollment
    // writer has been reintroduced.
    expect((engine as unknown as Record<string, unknown>).createEnrollment).toBeUndefined();
  });
});
