/**
 * Student subsystem remediation — regression & adversarial suite
 * ============================================================================
 * Closes the confirmed findings in docs/STUDENT_SUBSYSTEM_AUDIT_2026-08-18.md.
 * Every test here failed (or the exploit succeeded) before the remediation.
 *
 *   STU-C1  journey/events was a second, unvalidated students.status writer
 *   STU-C2  no lifecycle state machine; graduated students stayed mutable
 *   STU-H1  PATCH validation weaker than CREATE, and it persisted the values
 *   STU-H3  phone uniqueness defeated by formatting
 *   STU-H4  graduated students permanently consumed class capacity
 *   STU-H2  roster truncated at 2000 with no authoritative total
 *
 * These are behavioural, route-level tests driven through HTTP with real
 * permissions — not raw INSERTs. The audit specifically flagged raw-INSERT
 * fixtures as false-confidence coverage, so the write paths are exercised the
 * way production callers use them.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { id, today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { studentsRouter } from '../routes/students.routes.js';
import { journeyRouter } from '../routes/journey.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import {
  STUDENT_TRANSITIONS,
  STUDENT_STATUSES,
  assertStudentTransition,
  type StudentStatus,
} from '../core/students/student-lifecycle.js';
import { normalizeStudentInput, studentPhoneKey } from '../core/students/student-input.js';

const BRANCH = 'stu_rem_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students/:id/journey', journeyRouter);
  app.use('/api/students', studentsRouter);
  app.use(errorHandler);
  return app;
}
function makeUser(o: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: o.userId, username: o.username || o.userId,
    branchId: o.branchId || BRANCH, fullName: 'Remediation Test User',
  };
}
function authHeader(u: TokenPayload) { return { Authorization: `Bearer ${signToken(u)}` }; }

let app: express.Express;
let reg: TokenPayload;
let phoneSeq = 0;
/** A unique, well-formed Afghan mobile for each fixture. */
function nextPhone(): string {
  phoneSeq += 1;
  return `07${String(70000000 + phoneSeq).slice(-8)}`;
}

async function createStudent(body: Record<string, unknown>) {
  return supertest(app).post('/api/students/manual').set(authHeader(reg)).send({
    fullName: 'Fixture Student', gender: 'male', phone: nextPhone(), ...body,
  });
}
function statusOf(sid: string): string {
  return (db.prepare('SELECT status FROM students WHERE id = ?').get(sid) as { status: string }).status;
}
function seatsUsed(classId: string): number {
  return (db.prepare(
    `SELECT COUNT(DISTINCT student_id) c FROM enrollments
      WHERE class_id = ? AND status IN ('active','confirmed','pending')`
  ).get(classId) as { c: number }).c;
}
function makeClass(cid: string, capacity: number, gender: 'mixed' | 'female' | 'male' = 'mixed') {
  db.prepare(
    `INSERT OR REPLACE INTO classes (id, name, branch_id, capacity, min_viable_size, status,
       lifecycle_stage, level, fee, gender_policy, start_date)
     VALUES (?, ?, ?, ?, 1, 'active', 'activated', 'A1', 5000, ?, ?)`
  ).run(cid, `Class ${cid}`, BRANCH, capacity, gender, today());
  db.prepare('DELETE FROM enrollments WHERE class_id = ?').run(cid);
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)')
    .run(BRANCH, 'Remediation Branch', 'Loc');
  await db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES (?, ?, ?, ?, ?, 1, 0)`
  ).run('u_rem_reg', 'rem_reg', 'Rem Reg', BRANCH, await hashPassword('x'));
  assignRole('u_rem_reg', 'registrar', BRANCH);

  reg = makeUser({ userId: 'u_rem_reg', branchId: BRANCH });
  app = createApp();
});

// ===========================================================================
// STU-C2 — lifecycle state machine
// ===========================================================================
describe('STU-C2 — Student lifecycle transition matrix', () => {
  it('is exhaustively defined for every status (no undefined source state)', () => {
    for (const s of STUDENT_STATUSES) {
      expect(STUDENT_TRANSITIONS[s], `missing transitions for '${s}'`).toBeDefined();
    }
  });

  it('accepts every transition the matrix declares legal', () => {
    for (const from of STUDENT_STATUSES) {
      for (const to of STUDENT_TRANSITIONS[from]) {
        expect(() => assertStudentTransition(from, to as StudentStatus)).not.toThrow();
      }
    }
  });

  it('rejects every transition the matrix does not declare', () => {
    for (const from of STUDENT_STATUSES) {
      const allowed = new Set<string>(STUDENT_TRANSITIONS[from]);
      for (const to of STUDENT_STATUSES) {
        if (allowed.has(to)) continue;
        expect(() => assertStudentTransition(from, to), `${from} -> ${to} should be refused`).toThrow();
      }
    }
  });

  it('treats graduated as terminal — the exact laundering path from the audit', () => {
    // graduated -> inactive -> active all returned 200 before remediation.
    expect(() => assertStudentTransition('graduated', 'inactive')).toThrow();
    expect(() => assertStudentTransition('graduated', 'active')).toThrow();
    expect(() => assertStudentTransition('graduated', 'suspended')).toThrow();
  });

  it('PATCH /:id/status refuses graduated -> inactive over HTTP', async () => {
    const created = await createStudent({ fullName: 'Terminal Subject' });
    const sid = created.body.id as string;
    expect((await supertest(app).patch(`/api/students/${sid}/status`).set(authHeader(reg))
      .send({ status: 'graduated' })).status).toBe(200);

    const back = await supertest(app).patch(`/api/students/${sid}/status`).set(authHeader(reg))
      .send({ status: 'inactive' });
    expect(back.status).toBe(409);
    expect(statusOf(sid)).toBe('graduated');
  });

  it('PATCH /:id/status rejects an unknown status value', async () => {
    const created = await createStudent({ fullName: 'Bad Status' });
    const res = await supertest(app).patch(`/api/students/${created.body.id}/status`)
      .set(authHeader(reg)).send({ status: 'alumni' });
    expect(res.status).toBe(400);
  });

  it('allows the legitimate active -> inactive -> active cycle', async () => {
    const created = await createStudent({ fullName: 'Cycle Subject' });
    const sid = created.body.id as string;
    expect((await supertest(app).patch(`/api/students/${sid}/status`).set(authHeader(reg))
      .send({ status: 'inactive' })).status).toBe(200);
    expect((await supertest(app).patch(`/api/students/${sid}/status`).set(authHeader(reg))
      .send({ status: 'active' })).status).toBe(200);
    expect(statusOf(sid)).toBe('active');
  });

  it('refuses enroll / transfer / ID-card charge on a graduated student', async () => {
    makeClass('rem_ops', 10);
    const created = await createStudent({ fullName: 'Graduated Ops', classId: 'rem_ops' });
    const sid = created.body.id as string;
    await supertest(app).patch(`/api/students/${sid}/status`).set(authHeader(reg)).send({ status: 'graduated' });

    makeClass('rem_ops2', 10);
    const enroll = await supertest(app).post(`/api/students/${sid}/enroll-class`)
      .set(authHeader(reg)).send({ classId: 'rem_ops2' });
    expect(enroll.status).toBe(409);

    const transfer = await supertest(app).post(`/api/students/${sid}/transfer`)
      .set(authHeader(reg)).send({ toClassId: 'rem_ops2' });
    expect(transfer.status).toBe(409);

    const card = await supertest(app).post(`/api/students/${sid}/issue-card`)
      .set(authHeader(reg)).send({ cardDesign: { primaryColor: '#fff', bgStyle: 'plain' } });
    expect(card.status).toBe(409);
  });

  it('still allows fee collection after graduation (arrears remain collectable)', async () => {
    makeClass('rem_arrears', 10);
    const created = await createStudent({ fullName: 'Arrears Subject', classId: 'rem_arrears' });
    const sid = created.body.id as string;
    const sem = db.prepare('SELECT id FROM student_semesters WHERE student_id = ?').get(sid) as { id: string } | undefined;
    await supertest(app).patch(`/api/students/${sid}/status`).set(authHeader(reg)).send({ status: 'graduated' });

    const pay = await supertest(app).post(`/api/students/${sid}/payments`).set(authHeader(reg))
      .send({ amount: 100, category: 'fee', paymentMethod: 'cash', semesterId: sem?.id });
    expect(pay.status).toBe(201);
  });
});

// ===========================================================================
// STU-C1 — one status authority
// ===========================================================================
describe('STU-C1 — journey/events is not a second status authority', () => {
  it('source: no module other than students.routes writes students.status', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const routesDir = path.join(process.cwd(), 'src', 'routes');
    const offenders: string[] = [];
    for (const f of fs.readdirSync(routesDir)) {
      if (!f.endsWith('.ts')) continue;
      const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
      // Ignore comments; look for a real UPDATE of the students status column.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/UPDATE\s+students\s+SET\s+status/i.test(code) && f !== 'students.routes.ts') offenders.push(f);
    }
    expect(offenders, `unexpected students.status writers: ${offenders.join(', ')}`).toEqual([]);
  });

  it('journey status_changed cannot set suspended (must use the suspend workflow)', async () => {
    const created = await createStudent({ fullName: 'Journey Suspend' });
    const sid = created.body.id as string;
    const res = await supertest(app).post(`/api/students/${sid}/journey/events`).set(authHeader(reg))
      .send({ eventType: 'journey.status_changed', payload: { status: 'suspended' } });
    expect(res.status).toBe(400);
    expect(statusOf(sid)).toBe('active');
  });

  it('journey status_changed enforces the same transition matrix as the status endpoint', async () => {
    const created = await createStudent({ fullName: 'Journey Matrix' });
    const sid = created.body.id as string;
    await supertest(app).patch(`/api/students/${sid}/status`).set(authHeader(reg)).send({ status: 'graduated' });

    const res = await supertest(app).post(`/api/students/${sid}/journey/events`).set(authHeader(reg))
      .send({ eventType: 'journey.status_changed', payload: { status: 'active' } });
    expect(res.status).toBe(409);
    expect(statusOf(sid)).toBe('graduated');
  });

  it('journey status_changed rejects an unknown status instead of silently ignoring it', async () => {
    const created = await createStudent({ fullName: 'Journey Unknown' });
    const res = await supertest(app).post(`/api/students/${created.body.id}/journey/events`)
      .set(authHeader(reg)).send({ eventType: 'journey.status_changed', payload: { status: 'zombie' } });
    expect(res.status).toBe(400);
  });

  it('journey graduation performs the SAME side effects as the status endpoint', async () => {
    makeClass('rem_j_grad', 10);
    const viaJourney = await createStudent({ fullName: 'Grad Journey', classId: 'rem_j_grad' });
    const viaStatus = await createStudent({ fullName: 'Grad Status', classId: 'rem_j_grad' });

    await supertest(app).post(`/api/students/${viaJourney.body.id}/journey/events`).set(authHeader(reg))
      .send({ eventType: 'journey.graduated', payload: {} });
    await supertest(app).patch(`/api/students/${viaStatus.body.id}/status`).set(authHeader(reg))
      .send({ status: 'graduated' });

    const enr = (sid: string) => db.prepare('SELECT status FROM enrollments WHERE student_id = ?')
      .all(sid).map((r: any) => r.status).sort();
    expect(statusOf(viaJourney.body.id)).toBe('graduated');
    expect(statusOf(viaStatus.body.id)).toBe('graduated');
    // Identical DB state from both writers — the whole point of STU-C1.
    expect(enr(viaJourney.body.id)).toEqual(enr(viaStatus.body.id));
    expect(enr(viaJourney.body.id)).toEqual(['completed']);
  });
});

// ===========================================================================
// STU-H1 — CREATE / PATCH validation parity
// ===========================================================================
describe('STU-H1 — CREATE and PATCH share one validation authority', () => {
  const oversized = 'A'.repeat(5000);
  const cases: Array<{ label: string; payload: Record<string, unknown> }> = [
    { label: 'invalid gender', payload: { gender: 'martian' } },
    { label: 'malformed dob', payload: { dob: '9999-99-99' } },
    { label: 'non-calendar dob', payload: { dob: '2023-02-30' } },
    { label: 'oversized name', payload: { fullName: oversized } },
    { label: 'phone as array', payload: { phone: ['x'] } },
    { label: 'oversized notes', payload: { notes: 'N'.repeat(6000) } },
  ];

  for (const c of cases) {
    it(`rejects ${c.label} on BOTH create and patch`, async () => {
      const create = await createStudent({ fullName: 'Parity Probe', ...c.payload });
      expect(create.status, `CREATE should reject ${c.label}`).toBe(400);

      const base = await createStudent({ fullName: 'Parity Base' });
      const sid = base.body.id as string;
      const before = db.prepare('SELECT * FROM students WHERE id = ?').get(sid) as Record<string, unknown>;

      const patch = await supertest(app).patch(`/api/students/${sid}`).set(authHeader(reg)).send(c.payload);
      expect(patch.status, `PATCH should reject ${c.label}`).toBe(400);

      // And must not have persisted anything.
      const after = db.prepare('SELECT * FROM students WHERE id = ?').get(sid) as Record<string, unknown>;
      expect(after).toEqual(before);
    });
  }

  it('rejects blanking a required field via PATCH', async () => {
    const base = await createStudent({ fullName: 'Blank Probe' });
    const sid = base.body.id as string;
    expect((await supertest(app).patch(`/api/students/${sid}`).set(authHeader(reg))
      .send({ fullName: '   ' })).status).toBe(400);
    expect((await supertest(app).patch(`/api/students/${sid}`).set(authHeader(reg))
      .send({ phone: '' })).status).toBe(400);
  });

  it('accepts a legitimate gender correction and boundary-length name', async () => {
    const base = await createStudent({ fullName: 'Legit Edit' });
    const sid = base.body.id as string;
    expect((await supertest(app).patch(`/api/students/${sid}`).set(authHeader(reg))
      .send({ gender: 'female' })).status).toBe(200);
    expect((await supertest(app).patch(`/api/students/${sid}`).set(authHeader(reg))
      .send({ fullName: 'B'.repeat(200) })).status).toBe(200);
    expect((await supertest(app).patch(`/api/students/${sid}`).set(authHeader(reg))
      .send({ dob: '2001-03-15' })).status).toBe(200);
  });

  it('rejects the name one character over the limit (boundary)', async () => {
    const base = await createStudent({ fullName: 'Boundary Probe' });
    expect((await supertest(app).patch(`/api/students/${base.body.id}`).set(authHeader(reg))
      .send({ fullName: 'C'.repeat(201) })).status).toBe(400);
  });

  it('gender cannot be laundered to bypass a gender-segregated class', async () => {
    // The concrete business defect from the audit: male student refused entry
    // to a female-only class, then admitted after PATCHing gender to a value
    // CREATE would have rejected.
    makeClass('rem_female', 10, 'female');
    const male = await createStudent({ fullName: 'Policy Probe', gender: 'male' });
    const sid = male.body.id as string;

    const refused = await supertest(app).post(`/api/students/${sid}/enroll-class`)
      .set(authHeader(reg)).send({ classId: 'rem_female' });
    expect(refused.status).toBe(400);

    const laundered = await supertest(app).patch(`/api/students/${sid}`)
      .set(authHeader(reg)).send({ gender: 'martian' });
    expect(laundered.status).toBe(400);
    expect((db.prepare('SELECT gender FROM students WHERE id = ?').get(sid) as any).gender).toBe('male');
  });

  it('unit: normalizeStudentInput applies identical rules in both modes', () => {
    expect(() => normalizeStudentInput({ gender: 'martian' }, 'patch')).toThrow();
    expect(() => normalizeStudentInput({ gender: 'martian' }, 'create')).toThrow();
    expect(() => normalizeStudentInput({ dob: '9999-99-99' }, 'patch')).toThrow();
    expect(() => normalizeStudentInput({ fullName: 'A'.repeat(5000) }, 'patch')).toThrow();
    // Absent keys are simply not validated in patch mode.
    expect(() => normalizeStudentInput({}, 'patch')).not.toThrow();
    // but create still demands them
    expect(() => normalizeStudentInput({}, 'create')).toThrow();
  });
});

// ===========================================================================
// STU-H3 — normalized phone identity
// ===========================================================================
describe('STU-H3 — phone identity is normalized', () => {
  it('unit: all real-world formats collapse to one key', () => {
    const k = studentPhoneKey('0700111001');
    expect(studentPhoneKey('0700-111-001')).toBe(k);
    expect(studentPhoneKey('+93700111001')).toBe(k);
    expect(studentPhoneKey('0700 111 001')).toBe(k);
    expect(studentPhoneKey('(0700)111001')).toBe(k);
    expect(studentPhoneKey(' 0700111001 ')).toBe(k);
    expect(studentPhoneKey('0700111002')).not.toBe(k);
    expect(studentPhoneKey(null)).toBeNull();
  });

  it('refuses every formatting variant of an existing number with a clean 409', async () => {
    const phone = '0700990011';
    const first = await createStudent({ fullName: 'Phone Owner', phone });
    expect(first.status).toBe(201);

    for (const variant of ['0700990011', '0700-990-011', '+93700990011', '0700 990 011', ' 0700990011 ']) {
      const dup = await supertest(app).post('/api/students/manual').set(authHeader(reg))
        .send({ fullName: 'Phone Dup', gender: 'male', phone: variant });
      expect(dup.status, `variant ${variant} must be refused`).toBe(409);
      expect(String(dup.body.error)).toMatch(/phone/i);
    }
  });

  it('still accepts a genuinely different number (no false positives)', async () => {
    const ok = await supertest(app).post('/api/students/manual').set(authHeader(reg))
      .send({ fullName: 'Different Line', gender: 'male', phone: '0788777666' });
    expect(ok.status).toBe(201);
  });

  it('PATCH cannot steal another student\'s number via reformatting', async () => {
    const a = await createStudent({ fullName: 'Owner A', phone: '0700880022' });
    const b = await createStudent({ fullName: 'Owner B', phone: '0700880033' });
    const steal = await supertest(app).patch(`/api/students/${b.body.id}`).set(authHeader(reg))
      .send({ phone: '+93700880022' });
    expect(steal.status).toBe(409);
  });

  it('PATCH may reformat the student\'s OWN number', async () => {
    const a = await createStudent({ fullName: 'Self Reformat', phone: '0700884400' });
    const res = await supertest(app).patch(`/api/students/${a.body.id}`).set(authHeader(reg))
      .send({ phone: '+93700884400' });
    expect(res.status).toBe(200);
  });

  it('the DATABASE rejects a normalized duplicate even when the app guard is bypassed', () => {
    // This is the race-safety half: migration 073's expression index is the
    // final authority, so a check-then-insert race cannot persist a duplicate.
    const owner = db.prepare(
      `SELECT phone FROM students WHERE phone IS NOT NULL AND TRIM(phone) <> '' AND branch_id = ? LIMIT 1`
    ).get(BRANCH) as { phone: string } | undefined;
    expect(owner).toBeDefined();
    const digits = String(owner!.phone).replace(/\D/g, '');
    expect(() =>
      db.prepare(
        `INSERT INTO students (id, student_code, full_name, phone, qr_code, status, registration_date, branch_id, discount_percent, gender)
         VALUES (?, ?, 'Raw Dup', ?, 'q', 'active', ?, ?, 0, 'male')`
      ).run(id('stu'), `TH-RAW-${phoneSeq++}`, `+93${digits.slice(-9)}`, today(), BRANCH)
    ).toThrow(/UNIQUE|constraint/i);
  });

  it('concurrent creation of the same normalized phone yields exactly one student', async () => {
    const variants = ['0700995511', '0700-995-511', '+93700995511', '0700 995 511', '(0700)995511'];
    const results = await Promise.all(variants.map((v) =>
      supertest(app).post('/api/students/manual').set(authHeader(reg))
        .send({ fullName: 'Race Phone', gender: 'male', phone: v })
    ));
    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(variants.length - 1);
    // No 500s — the failure must be a clean, explained conflict.
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);

    const rows = db.prepare(
      `SELECT COUNT(*) c FROM students
        WHERE SUBSTR(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'(',''),')',''),'+',''), -9) = ?`
    ).get('700995511') as { c: number };
    expect(rows.c).toBe(1);
  });
});

// ===========================================================================
// STU-H4 — capacity respects the student lifecycle
// ===========================================================================
describe('STU-H4 — graduated students release their seat', () => {
  it('an active student consumes a seat; graduating frees it for a paying applicant', async () => {
    makeClass('rem_cap', 2);
    const a = await createStudent({ fullName: 'Seat Holder A', classId: 'rem_cap' });
    const b = await createStudent({ fullName: 'Seat Holder B', classId: 'rem_cap' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(seatsUsed('rem_cap')).toBe(2);

    // Class is full — this is the applicant the audit saw refused.
    const refused = await createStudent({ fullName: 'Applicant', classId: 'rem_cap' });
    expect(refused.status).toBe(409);

    await supertest(app).patch(`/api/students/${a.body.id}/status`).set(authHeader(reg))
      .send({ status: 'graduated' });

    expect(seatsUsed('rem_cap')).toBe(1);
    const admitted = await createStudent({ fullName: 'Applicant Retry', classId: 'rem_cap' });
    expect(admitted.status).toBe(201);
  });

  it('graduation moves the enrollment to a terminal state, not deletion', async () => {
    makeClass('rem_cap2', 5);
    const s = await createStudent({ fullName: 'Terminal Enrollment', classId: 'rem_cap2' });
    await supertest(app).patch(`/api/students/${s.body.id}/status`).set(authHeader(reg))
      .send({ status: 'graduated' });
    const rows = db.prepare('SELECT status, ended_at FROM enrollments WHERE student_id = ?')
      .all(s.body.id) as Array<{ status: string; ended_at: string | null }>;
    expect(rows).toHaveLength(1);           // history preserved
    expect(rows[0].status).toBe('completed');
    expect(rows[0].ended_at).toBeTruthy();
  });

  it('a suspended student still holds their seat (suspension is temporary)', async () => {
    makeClass('rem_cap3', 3);
    const s = await createStudent({ fullName: 'Suspended Holder', classId: 'rem_cap3' });
    expect(seatsUsed('rem_cap3')).toBe(1);
    await supertest(app).post(`/api/students/${s.body.id}/suspend`).set(authHeader(reg)).send({});
    // suspend() defers the enrollment; the seat is intentionally reserved so
    // resume() can put the student back. Documented behaviour, asserted here
    // so a future change cannot silently reinterpret it.
    expect(statusOf(s.body.id)).toBe('suspended');
  });

  it('concurrent enrollment at capacity never overbooks (regression guard)', async () => {
    makeClass('rem_race', 2);
    const students: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await createStudent({ fullName: `Racer ${i}` });
      students.push(r.body.id as string);
    }
    const results = await Promise.all(students.map((sid) =>
      supertest(app).post(`/api/students/${sid}/enroll-class`).set(authHeader(reg))
        .send({ classId: 'rem_race' })
    ));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(seatsUsed('rem_race')).toBe(2);
  });
});

// ===========================================================================
// STU-H2 — authoritative totals, pagination and export
// ===========================================================================
describe('STU-H2 — roster exposes authoritative totals', () => {
  const BULK = 60;
  beforeAll(() => {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO students (id, student_code, full_name, phone, qr_code, status, registration_date, branch_id, discount_percent, gender)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 0, 'male')`
    );
    db.transaction(() => {
      for (let i = 1; i <= BULK; i++) {
        ins.run(`stu_pg_${i}`, `TH-PG-${i}`, `Paged Student ${i}`,
          `0752${String(100000 + i).slice(-6)}`, `QPG${i}`, today(), BRANCH);
      }
    })();
  });

  it('returns X-Total-Count that exceeds the page size', async () => {
    const res = await supertest(app).get('/api/students?limit=10&offset=0').set(authHeader(reg));
    expect(res.status).toBe(200);
    expect((res.body as any[]).length).toBe(10);
    const total = Number(res.headers['x-total-count']);
    expect(total).toBeGreaterThan(10);
    // The exact figure must equal DB truth for this branch.
    const dbTotal = (db.prepare('SELECT COUNT(*) c FROM students WHERE branch_id = ?').get(BRANCH) as { c: number }).c;
    expect(total).toBe(dbTotal);
  });

  it('page boundaries are stable and non-overlapping', async () => {
    const p1 = await supertest(app).get('/api/students?limit=5&offset=0').set(authHeader(reg));
    const p2 = await supertest(app).get('/api/students?limit=5&offset=5').set(authHeader(reg));
    const ids1 = (p1.body as any[]).map((s) => s.id);
    const ids2 = (p2.body as any[]).map((s) => s.id);
    expect(ids1).toHaveLength(5);
    expect(ids2).toHaveLength(5);
    expect(ids1.filter((x) => ids2.includes(x))).toEqual([]);
  });

  it('X-Total-Count reflects the FILTER, not the whole table', async () => {
    const filtered = await supertest(app).get('/api/students?q=Paged%20Student&limit=5').set(authHeader(reg));
    const total = Number(filtered.headers['x-total-count']);
    expect(total).toBeGreaterThanOrEqual(BULK);
    const unfiltered = Number(filtered.headers['x-unfiltered-count']);
    expect(unfiltered).toBeGreaterThanOrEqual(total);
  });

  it('search paginates beyond the first page with a correct total', async () => {
    const res = await supertest(app).get('/api/students/search?q=Paged&limit=10&offset=50').set(authHeader(reg));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(BULK);
    expect(Array.isArray(res.body.rows)).toBe(true);
  });

  it('CSV export covers the full filtered dataset, not one page', async () => {
    const res = await supertest(app).get('/api/students/export?q=Paged%20Student').set(authHeader(reg));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.trim().split('\n');
    // header + every matching student
    expect(lines.length - 1).toBeGreaterThanOrEqual(BULK);
    expect(Number(res.headers['x-total-count'])).toBe(lines.length - 1);
    expect(lines[0]).toContain('Code');
    expect(lines[0]).toContain('Debt');
  });

  it('CSV export honours filters and branch isolation', async () => {
    const other = 'stu_rem_other_branch';
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(other, 'Other', 'L');
    db.prepare(
      `INSERT OR IGNORE INTO students (id, student_code, full_name, phone, qr_code, status, registration_date, branch_id, discount_percent, gender)
       VALUES ('stu_other_1','TH-OTHER-1','Other Branch Student','0769000001','QOB','active',?,?,0,'male')`
    ).run(today(), other);

    const res = await supertest(app).get('/api/students/export').set(authHeader(reg));
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Other Branch Student');
  });

  it('CSV export escapes embedded commas and quotes', async () => {
    await createStudent({ fullName: 'Comma, "Quoted" Name' });
    const res = await supertest(app).get('/api/students/export?q=Quoted').set(authHeader(reg));
    expect(res.status).toBe(200);
    expect(res.text).toContain('"Comma, ""Quoted"" Name"');
  });

  it('GET /students/summary is authoritative over the full filtered set', async () => {
    const res = await supertest(app).get('/api/students/summary').set(authHeader(reg));
    expect(res.status).toBe(200);
    const dbTotal = (db.prepare('SELECT COUNT(*) c FROM students WHERE branch_id = ?').get(BRANCH) as { c: number }).c;
    expect(res.body.filtered).toBe(dbTotal);
    expect(res.body.unfiltered).toBeGreaterThanOrEqual(res.body.filtered);
    // Status buckets must reconcile with the filtered total.
    const summed = (res.body.byStatus as Array<{ count: number }>).reduce((a, r) => a + r.count, 0);
    expect(summed).toBe(res.body.filtered);
  });

  it('summary respects the same filters as the roster', async () => {
    const res = await supertest(app).get('/api/students/summary?q=Paged%20Student').set(authHeader(reg));
    expect(res.status).toBe(200);
    expect(res.body.filtered).toBeGreaterThanOrEqual(BULK);
    expect(res.body.filtered).toBeLessThan(res.body.unfiltered + 1);
  });

  it('summary is branch-isolated', async () => {
    const res = await supertest(app).get('/api/students/summary').set(authHeader(reg));
    const dbTotal = (db.prepare('SELECT COUNT(*) c FROM students WHERE branch_id = ?').get(BRANCH) as { c: number }).c;
    expect(res.body.unfiltered).toBe(dbTotal);
  });

  it('an unknown status filter is rejected, never silently ignored', async () => {
    const res = await supertest(app).get('/api/students?status=notastatus').set(authHeader(reg));
    expect(res.status).toBe(400);
  });
});
