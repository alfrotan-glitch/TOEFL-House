/**
 * Visitor subsystem — adversarial audit regression suite.
 * ============================================================================
 * Each test below encodes a defect that was REPRODUCED against a live server
 * during the visitor subsystem audit (docs/VISITOR_AUDIT_2026-08-17.md).
 *
 * These tests are written to FAIL against the current implementation. They are
 * the executable statement of the defects, not a description of today's
 * behaviour. Tests that merely restate current behaviour are how a subsystem
 * accumulates 110 passing tests while a placement gate can be deleted without
 * a single failure (mutant V2).
 *
 * Where a defect is intentionally left unfixed in this audit-only pass, the
 * test is marked with `.fails()` so the suite stays green while still failing
 * loudly the moment the behaviour changes — and it will start failing (as a
 * "expected to fail but passed" error) the moment a fix lands, which is the
 * signal to flip it to a normal assertion.
 */
import { assignRole } from '../../support/identity.js';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { visitorsRouter } from '../../../routes/visitors.routes.js';
import { searchRouter } from '../../../routes/search.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { today } from '../../../utils/ids.js';
import Database from 'better-sqlite3';

const BRANCH_A = 'vsa_a';
const BRANCH_B = 'vsa_b';

let owner: TokenPayload;
let registrarA: TokenPayload;
let counselorA: TokenPayload;
let teacherA: TokenPayload;
let app: express.Express;

const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

/** Program with placement REQUIRED, plus a class whose level maps to it. */
function seedPlacementRequiredProgram() {
  db.prepare(`INSERT OR IGNORE INTO programs (id,name,branch_id) VALUES ('vsa_prog','VSA Program',?)`).run(BRANCH_A);
  db.prepare(`INSERT OR IGNORE INTO program_versions (id,program_id,version_label,version_number,status,is_default)
              VALUES ('vsa_pv','vsa_prog','v1',1,'published',1)`).run();
  db.prepare(`INSERT OR IGNORE INTO levels (id,program_id,name,"order",program_version_id)
              VALUES ('vsa_lvl','vsa_prog','Level 1',1,'vsa_pv')`).run();
  db.prepare(`INSERT OR IGNORE INTO classes (id,name,level,branch_id,status,capacity,fee,program_id,level_id,gender_policy)
              VALUES ('vsa_cls','VSA Class','Level 1',?, 'active',50,6000,'vsa_prog','vsa_lvl','mixed')`).run(BRANCH_A);
  // An ungoverned program + class pair for the control tests: no placement
  // profile attaches to pv_open, so conversions through it are legitimately
  // eligible. Note the conversion gate correctly still fires when the VISITOR
  // carries a governed program even if the class is ungoverned — the visitor's
  // program is a deliberate fallback, not a loophole.
  db.prepare(`INSERT OR IGNORE INTO programs (id,name,branch_id) VALUES ('vsa_prog_open','VSA Open Program',?)`).run(BRANCH_A);
  db.prepare(`INSERT OR IGNORE INTO program_versions (id,program_id,version_label,version_number,status,is_default)
              VALUES ('vsa_pv_open','vsa_prog_open','v1',1,'published',0)`).run();
  // A class with NO level, therefore governed by no placement policy. Control
  // tests use this for legitimate conversions. They previously reached the same
  // state by detaching the visitor's program — which was the V-1 defect itself,
  // and is now correctly refused.
  db.prepare(`INSERT OR IGNORE INTO classes (id,name,level,branch_id,status,capacity,fee,gender_policy)
              VALUES ('vsa_open','VSA Open Class','Open',?, 'active',50,6000,'mixed')`).run(BRANCH_A);
  db.prepare(`INSERT OR IGNORE INTO placement_assessment_profiles
      (id, program_version_id, branch_id, enabled, required, method, sections_json, components_json,
       scoring_model, allow_retake, max_score, pass_score, requirement_mode, first_level_exempt, max_attempts)
      VALUES ('vsa_pap','vsa_pv',?,1,1,'written_test','[]',?, 'weighted_average',1,100,50,'required',0,2)`)
    .run(BRANCH_A, JSON.stringify([{ key: 'writing', type: 'written_test', label: 'Writing', weight: 100, maxScore: 100, enabled: true, required: true, order: 0 }]));
}

const createVisitor = (as: TokenPayload, body: Record<string, unknown> = {}) =>
  supertest(app).post('/api/visitors').set(authHeader(as)).send({
    fullName: 'Audit Subject', gender: 'male', source: 'walk_in', ...body,
  });

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES (?, 'VSA A', 'T')`).run(BRANCH_A);
  db.prepare(`INSERT OR IGNORE INTO branches (id,name,location) VALUES (?, 'VSA B', 'T')`).run(BRANCH_B);
  seedPlacementRequiredProgram();

  const pwd = await hashPassword('Str0ng!Pass2026');
  const insU = db.prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, full_name, branch_id, must_change_password)
                           VALUES (?, ?, ?, ?, ?, 0)`);
  insU.run('vsa_own', 'vsa_own', pwd, 'Owner', BRANCH_A);
  assignRole('vsa_own', 'owner', BRANCH_A)
  insU.run('vsa_reg', 'vsa_reg', pwd, 'Registrar A', BRANCH_A);
  assignRole('vsa_reg', 'registrar', BRANCH_A)
  insU.run('vsa_cou', 'vsa_cou', pwd, 'Counselor A', BRANCH_A);
  assignRole('vsa_cou', 'counselor', BRANCH_A)
  insU.run('vsa_tea', 'vsa_tea', pwd, 'Teacher A', BRANCH_A);
  assignRole('vsa_tea', 'teacher', BRANCH_A)

  owner = { userId: 'vsa_own', username: 'vsa_own', branchId: BRANCH_A, fullName: 'Owner' } as TokenPayload;
  registrarA = { userId: 'vsa_reg', username: 'vsa_reg', branchId: BRANCH_A, fullName: 'Registrar A' } as TokenPayload;
  counselorA = { userId: 'vsa_cou', username: 'vsa_cou', branchId: BRANCH_A, fullName: 'Counselor A' } as TokenPayload;
  teacherA = { userId: 'vsa_tea', username: 'vsa_tea', branchId: BRANCH_A, fullName: 'Teacher A' } as TokenPayload;

  app = express();
  app.use(express.json());
  app.use('/api/visitors', visitorsRouter);
  app.use('/api/search', searchRouter);
  app.use(errorHandler);
});

// ===========================================================================
// V-1 (CRITICAL) — placement gate bypass by clearing programVersionId
// ===========================================================================
describe('V-1 — placement requirement cannot be evaded by clearing the program', () => {
  let visitorId: string;

  beforeEach(async () => {
    const res = await createVisitor(registrarA, { fullName: 'Gate Subject', programVersionId: 'vsa_pv' });
    visitorId = res.body.id;
  });

  it('blocks conversion while the placement-required program is attached', async () => {
    const res = await supertest(app).post(`/api/visitors/${visitorId}/convert`)
      .set(authHeader(registrarA)).send({ classId: 'vsa_cls', amountPaid: 0 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/placement/i);
  });

  it('still blocks conversion after programVersionId is set to null', async () => {
    // EXPLOIT: Lead.Edit is enough to detach the program, and the conversion
    // gate is wrapped in `if (effectiveProgramVersionId)`, so detaching it
    // skips the gate entirely. The target class still belongs to the
    // placement-required program via its level.
    await supertest(app).patch(`/api/visitors/${visitorId}`)
      .set(authHeader(registrarA)).send({ programVersionId: null }).expect(200);

    const res = await supertest(app).post(`/api/visitors/${visitorId}/convert`)
      .set(authHeader(registrarA)).send({ classId: 'vsa_cls', amountPaid: 0 });
    expect(res.status).toBe(400);
  });

  it('never enrolls a student into a placement-gated class with zero attempts', async () => {
    await supertest(app).patch(`/api/visitors/${visitorId}`)
      .set(authHeader(registrarA)).send({ programVersionId: null });
    await supertest(app).post(`/api/visitors/${visitorId}/convert`)
      .set(authHeader(registrarA)).send({ classId: 'vsa_cls', amountPaid: 0 });

    const student = db.prepare('SELECT id FROM students WHERE lead_id=?').get(visitorId) as { id: string } | undefined;
    const attempts = (db.prepare('SELECT COUNT(*) c FROM placement_assessment_attempts WHERE visitor_id=?')
      .get(visitorId) as { c: number }).c;
    // An enrollment recorded against the gated program with no assessment is
    // exactly the state the gate exists to prevent.
    const enrolledUnderGatedProgram = student
      ? (db.prepare(`SELECT COUNT(*) c FROM enrollments WHERE student_id=? AND program_version_id='vsa_pv'`)
          .get(student.id) as { c: number }).c
      : 0;
    expect(attempts === 0 && enrolledUnderGatedProgram > 0).toBe(false);
  });

  it('a candidate who FAILED placement cannot be enrolled by detaching the program', async () => {
    db.prepare(`INSERT INTO placement_assessment_attempts
        (id, visitor_id, program_version_id, profile_id, branch_id, attempt_number, status, outcome,
         started_at, completed_at, total_score, max_score, percentage, snapshot_json)
        VALUES ('vsa_att',?, 'vsa_pv','vsa_pap',?,1,'completed','failed',datetime('now'),datetime('now'),10,100,10,'{}')`)
      .run(visitorId, BRANCH_A);
    db.prepare(`UPDATE visitors SET placement_status='completed' WHERE id=?`).run(visitorId);

    await supertest(app).patch(`/api/visitors/${visitorId}`)
      .set(authHeader(registrarA)).send({ programVersionId: null });
    const res = await supertest(app).post(`/api/visitors/${visitorId}/convert`)
      .set(authHeader(registrarA)).send({ classId: 'vsa_cls', amountPaid: 0 });
    expect(res.status).toBe(400);
  });

  it('a counselor detaching the program cannot enable a bypass for anyone', async () => {
    // Separation of duties: a counselor is deliberately denied Lead.Convert.
    // Detaching a program is still a legitimate Lead.Edit action — the defect
    // was never that the edit was allowed, but that it silently removed an
    // academic control. So the edit may succeed; the ENROLLMENT must not.
    await supertest(app).patch(`/api/visitors/${visitorId}`)
      .set(authHeader(counselorA)).send({ programVersionId: null }).expect(200);

    const res = await supertest(app).post(`/api/visitors/${visitorId}/convert`)
      .set(authHeader(registrarA)).send({ classId: 'vsa_cls', amountPaid: 0 });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/placement/i);
  });
});

// ===========================================================================
// V-2 (HIGH) — no duplicate detection on visitor creation
// ===========================================================================
describe('V-2 — duplicate lead prevention', () => {
  it('does not silently create five identical leads', async () => {
    const person = { fullName: 'Duplicate Person', phone: '0700000099', tazkiraNo: 'TZK-DUP-99' };
    for (let i = 0; i < 5; i += 1) await createVisitor(registrarA, person);
    const count = (db.prepare('SELECT COUNT(*) c FROM visitors WHERE phone=?').get(person.phone) as { c: number }).c;
    expect(count).toBeLessThan(5);
  });

  it('does not allow two leads to share a national ID (tazkira) in one branch', async () => {
    await createVisitor(registrarA, { fullName: 'Tazkira One', phone: '0700000097', tazkiraNo: 'TZK-UNIQ-1' });
    await createVisitor(registrarA, { fullName: 'Tazkira Two', phone: '0700000096', tazkiraNo: 'TZK-UNIQ-1' });
    const count = (db.prepare('SELECT COUNT(*) c FROM visitors WHERE tazkira_no=?').get('TZK-UNIQ-1') as { c: number }).c;
    expect(count).toBe(1);
  });
});

// ===========================================================================
// V-3 (HIGH) — serial_no has no uniqueness guarantee
// ===========================================================================
describe('V-3 — visitor serial numbers are unique', () => {
  it('enforces uniqueness in the DATABASE, not just in application code', () => {
    // The route computes MAX(serial)+1 inside a transaction, which holds for a
    // single process. Behind two workers (or any second connection) both read
    // the same max and both inserts are accepted, because no constraint exists.
    db.prepare(`INSERT INTO visitors (id,serial_no,full_name,gender,source,visit_date,status,branch_id,placement_status)
                VALUES ('vsa_dup1','V-8000','Dup One','male','walk_in',?, 'visited',?,'not_started')`)
      .run(today(), BRANCH_A);
    expect(() =>
      db.prepare(`INSERT INTO visitors (id,serial_no,full_name,gender,source,visit_date,status,branch_id,placement_status)
                  VALUES ('vsa_dup2','V-8000','Dup Two','male','walk_in',?, 'visited',?,'not_started')`)
        .run(today(), BRANCH_A)
    ).toThrow();
  });
});

// ===========================================================================
// V-4 (HIGH) — PATCH skips the input validation CREATE enforces
// ===========================================================================
describe('V-3 — cross-process serial allocation', () => {
  it('two independent connections cannot mint the same serial', () => {
    // The original defect was `SELECT MAX(serial)+1`: two connections read the
    // same maximum and both inserts were accepted, because nothing in the
    // schema said otherwise. This models the multi-worker deployment that a
    // single-process Promise.all test can never reach.
    const dbPath = process.env.DB_PATH || 'src/tests/test.sqlite';
    const connA = new Database(dbPath);
    const connB = new Database(dbPath);
    try {
      const insert = (conn: InstanceType<typeof Database>, id: string, serial: string) =>
        conn.prepare(`INSERT INTO visitors (id,serial_no,full_name,gender,source,visit_date,status,branch_id,placement_status)
                      VALUES (?,?,?,'male','walk_in',?, 'visited',?,'not_started')`)
          .run(id, serial, 'Race ' + id, today(), BRANCH_A);

      insert(connA, 'vsa_race_a', 'V-77001');
      // Connection B tries to reuse the identical serial, exactly as the old
      // MAX+1 read-then-write produced. The database must refuse it.
      expect(() => insert(connB, 'vsa_race_b', 'V-77001')).toThrow(/UNIQUE/i);
    } finally {
      connA.close();
      connB.close();
    }
  });

  it('allocates from a counter, not from the maximum existing serial', async () => {
    // Mutation M10 (revert to SELECT MAX(serial)+1) survived, because in one
    // process that read-then-write is serialised and still yields unique
    // values. The observable difference is that MAX+1 DEPENDS on the rows
    // present: insert a far-future serial and a MAX+1 allocator jumps to follow
    // it, while a counter is unaffected. That is the property under test.
    db.prepare(`INSERT INTO visitors (id,serial_no,full_name,gender,source,visit_date,status,branch_id,placement_status)
                VALUES ('vsa_high','V-990000','High Serial','male','walk_in',?, 'visited',?,'not_started')`)
      .run(today(), BRANCH_A);
    const res = await createVisitor(registrarA, { fullName: 'After High', phone: '0755500098' });
    expect(res.status).toBe(201);
    const allocated = Number(String(res.body.serialNo).replace('V-', ''));
    expect(allocated).toBeLessThan(990000);
  });

  it('the allocator is atomic, so concurrent creates never collide', async () => {
    const before = (db.prepare('SELECT COUNT(*) c FROM visitors').get() as { c: number }).c;
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) =>
      createVisitor(registrarA, { fullName: `Serial Race ${i}`, phone: `07555${String(i).padStart(5, '0')}` })
    ));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const serials = new Set(results.map((r) => r.body.serialNo));
    expect(serials.size).toBe(25);
    const after = (db.prepare('SELECT COUNT(*) c FROM visitors').get() as { c: number }).c;
    expect(after - before).toBe(25);
  });
});

describe('V-2 — national ID uniqueness is enforced by the database', () => {
  it('rejects a duplicate tazkira at the DB layer even if a check is bypassed', () => {
    db.prepare(`INSERT INTO visitors (id,serial_no,full_name,gender,source,visit_date,status,branch_id,placement_status,tazkira_no)
                VALUES ('vsa_tz_1','V-77101','TZ One','male','walk_in',?, 'visited',?,'not_started','TZK-DB-1')`)
      .run(today(), BRANCH_A);
    expect(() =>
      db.prepare(`INSERT INTO visitors (id,serial_no,full_name,gender,source,visit_date,status,branch_id,placement_status,tazkira_no)
                  VALUES ('vsa_tz_2','V-77102','TZ Two','male','walk_in',?, 'visited',?,'not_started','TZK-DB-1')`)
        .run(today(), BRANCH_A)
    ).toThrow(/UNIQUE/i);
  });

  it('applies the same rule across branches, matching the students policy', async () => {
    await createVisitor(registrarA, { fullName: 'Global One', phone: '0755500091', tazkiraNo: 'TZK-GLOBAL-1' });
    const other = await createVisitor(owner, {
      fullName: 'Global Two', phone: '0755500092', tazkiraNo: 'TZK-GLOBAL-1', branchId: BRANCH_B,
    });
    expect(other.status).toBe(409);
  });

  it('normalises surrounding whitespace so padding cannot defeat the check', async () => {
    await createVisitor(registrarA, { fullName: 'Pad One', phone: '0755500093', tazkiraNo: 'TZK-PAD-1' });
    const padded = await createVisitor(registrarA, { fullName: 'Pad Two', phone: '0755500094', tazkiraNo: '  TZK-PAD-1  ' });
    expect(padded.status).toBe(409);
  });

  it('treats a blank tazkira as absent, not as a duplicate key', async () => {
    const a = await createVisitor(registrarA, { fullName: 'Blank One', phone: '0755500095', tazkiraNo: '' });
    const b = await createVisitor(registrarA, { fullName: 'Blank Two', phone: '0755500096', tazkiraNo: '   ' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it('refuses a visitor whose national ID already belongs to a student', async () => {
    db.prepare(`INSERT INTO students (id,student_code,full_name,status,registration_date,branch_id,gender,discount_percent,tazkira_no)
                VALUES ('vsa_stu_tz','VSA-TZ','Existing Student','active',?,?, 'male',0,'TZK-STUDENT-1')`)
      .run(today(), BRANCH_A);
    const res = await createVisitor(registrarA, { fullName: 'Clash', phone: '0755500097', tazkiraNo: 'TZK-STUDENT-1' });
    expect(res.status).toBe(409);
  });
});

describe('V-4 — update validation matches create validation', () => {
  let visitorId: string;
  beforeEach(async () => {
    visitorId = (await createVisitor(registrarA, { fullName: 'Patch Subject', phone: '0700000095' })).body.id;
  });

  it('CREATE rejects an oversized name (control — this passes today)', async () => {
    const res = await createVisitor(registrarA, { fullName: 'A'.repeat(100_000), phone: '0700000094' });
    expect(res.status).toBe(400);
  });

  it('PATCH also rejects an oversized name', async () => {
    const res = await supertest(app).patch(`/api/visitors/${visitorId}`)
      .set(authHeader(registrarA)).send({ fullName: 'A'.repeat(100_000) });
    expect(res.status).toBe(400);
  });

  it('PATCH does not persist unbounded free text', async () => {
    await supertest(app).patch(`/api/visitors/${visitorId}`)
      .set(authHeader(registrarA)).send({ notes: 'X'.repeat(50_000), tazkiraNo: 'Y'.repeat(50_000) });
    const row = db.prepare('SELECT LENGTH(notes) n, LENGTH(tazkira_no) t FROM visitors WHERE id=?')
      .get(visitorId) as { n: number; t: number };
    expect(Math.max(row.n ?? 0, row.t ?? 0)).toBeLessThan(5_000);
  });

  it('PATCH rejects a non-string phone instead of coercing it', async () => {
    const res = await supertest(app).patch(`/api/visitors/${visitorId}`)
      .set(authHeader(registrarA)).send({ phone: ['injected'] });
    expect(res.status).toBe(400);
  });

  it('PATCH rejects a malformed date instead of storing it', async () => {
    const res = await supertest(app).patch(`/api/visitors/${visitorId}`)
      .set(authHeader(registrarA)).send({ nextContactDate: '9999-99-99' });
    expect(res.status).toBe(400);
  });

  it('PATCH returns 400, not 500, for a null required field', async () => {
    // A raw SQLite constraint message reaching the client as a 500 is both an
    // error-handling gap and an internal-detail leak.
    const res = await supertest(app).patch(`/api/visitors/${visitorId}`)
      .set(authHeader(registrarA)).send({ fullName: null });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).not.toMatch(/constraint|sqlite/i);
  });
});

// ===========================================================================
// V-5 (HIGH) — global search leaks leads to roles without Lead.View
// ===========================================================================
describe('V-5 — lead data is not readable without Lead.View', () => {
  beforeEach(async () => {
    await createVisitor(registrarA, { fullName: 'Searchable Lead', phone: '0700000093' });
  });

  it('a teacher is denied the visitors list (control — this passes today)', async () => {
    await supertest(app).get('/api/visitors').set(authHeader(teacherA)).expect(403);
  });

  it('a teacher cannot read the same leads through global search', async () => {
    const res = await supertest(app).get('/api/search?q=Searchable').set(authHeader(teacherA));
    const items: any[] = Array.isArray(res.body) ? res.body : (res.body.results ?? []);
    expect(items.filter((i) => i.tab === 'visitors')).toHaveLength(0);
  });

  it('a teacher cannot confirm a lead exists by searching their phone number', async () => {
    const res = await supertest(app).get('/api/search?q=0700000093').set(authHeader(teacherA));
    const items: any[] = Array.isArray(res.body) ? res.body : (res.body.results ?? []);
    expect(items.filter((i) => i.tab === 'visitors')).toHaveLength(0);
  });
});

// ===========================================================================
// V-6 (MEDIUM) — closed (lost) leads silently resurrect on conversion
// ===========================================================================
describe('V-6 — closure is respected by conversion', () => {
  it('a lead marked lost cannot be converted without an explicit reopen', async () => {
    const vid = (await createVisitor(registrarA, { fullName: 'Lost Subject', phone: '0700000092' , programVersionId: 'vsa_pv_open'})).body.id;
    await supertest(app).post(`/api/visitors/${vid}/advance-stage`)
      .set(authHeader(registrarA)).send({ stage: 'lost', fromStage: 'lead' }).expect(200);

    const res = await supertest(app).post(`/api/visitors/${vid}/convert`)
      .set(authHeader(registrarA)).send({ classId: 'vsa_open', amountPaid: 0 });
    // The state machine refuses lost -> inquiry, yet conversion rewrites the
    // stage straight to 'enrollment'. Either closure means something or it does not.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ===========================================================================
// V-7 (MEDIUM) — concurrent advance-stage walks the pipeline
// ===========================================================================
describe('V-7 — stage advancement is one step per request', () => {
  it('refuses an advance that does not declare the stage it is leaving', async () => {
    // Mutation M8 showed that making `fromStage` optional survived every test,
    // because they all supplied it. An optional guard protects only callers who
    // already thought about the race, so the requirement itself is asserted.
    const vid = (await createVisitor(registrarA, { fullName: 'Bodyless Subject', phone: '0700000079' })).body.id;
    const res = await supertest(app).post(`/api/visitors/${vid}/advance-stage`)
      .set(authHeader(registrarA)).send({});
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/fromStage/i);
    expect((db.prepare('SELECT stage FROM visitors WHERE id=?').get(vid) as { stage: string }).stage).toBe('lead');
  });

  it('refuses an advance whose declared stage is stale', async () => {
    const vid = (await createVisitor(registrarA, { fullName: 'Stale Subject', phone: '0700000078' })).body.id;
    await supertest(app).post(`/api/visitors/${vid}/advance-stage`)
      .set(authHeader(registrarA)).send({ fromStage: 'lead' }).expect(200);
    const stale = await supertest(app).post(`/api/visitors/${vid}/advance-stage`)
      .set(authHeader(registrarA)).send({ fromStage: 'lead' });
    expect(stale.status).toBe(409);
  });

  it('ten concurrent advance calls do not move a lead ten stages', async () => {
    const vid = (await createVisitor(registrarA, { fullName: 'Race Subject', phone: '0700000091' })).body.id;
    // All ten believe the lead is at 'lead'. Exactly one may win.
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      supertest(app).post(`/api/visitors/${vid}/advance-stage`)
        .set(authHeader(registrarA)).send({ fromStage: 'lead' })
    ));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const stage = (db.prepare('SELECT stage FROM visitors WHERE id=?').get(vid) as { stage: string }).stage;
    // Reaching 'enrollment' from 'lead' means the lead traversed the entire
    // funnel — including placement_booking/fee/completed — from one user action.
    expect(['lead', 'inquiry']).toContain(stage);
  });
});

// ===========================================================================
// V-8 (MEDIUM) — audit trail records no before/after values
// ===========================================================================
describe('V-8 — visitor edits are forensically reconstructable', () => {
  it('records the old and new value when a program is detached', async () => {
    const vid = (await createVisitor(registrarA, { fullName: 'Audit Subject', phone: '0700000090', programVersionId: 'vsa_pv' })).body.id;
    await supertest(app).patch(`/api/visitors/${vid}`).set(authHeader(registrarA)).send({ programVersionId: null });

    const row = db.prepare(`SELECT old_value, new_value FROM audit_logs
                            WHERE action LIKE 'Updated visitor%' ORDER BY id DESC LIMIT 1`)
      .get() as { old_value: string | null; new_value: string | null } | undefined;
    // Without values, the exploit step in V-1 leaves no evidence of what changed.
    expect(row?.old_value ?? null).not.toBeNull();
  });
});

// ===========================================================================
// CONTROLS — invariants that currently HOLD and must not regress.
// ===========================================================================
describe('Controls — verified-sound behaviour that must not regress', () => {
  it('rejects client-forged identity, status and placement fields on create', async () => {
    const res = await createVisitor(registrarA, {
      fullName: 'Forged Subject', phone: '0700000089',
      id: 'v_attacker', serialNo: 'V-999999', status: 'registered',
      placementStatus: 'completed', placementScore: '{"fake":100}', visitDate: '1999-01-01',
    });
    const row = db.prepare('SELECT * FROM visitors WHERE id=?').get(res.body.id) as any;
    expect(row.id).not.toBe('v_attacker');
    expect(row.serial_no).not.toBe('V-999999');
    expect(row.status).toBe('visited');
    expect(row.placement_status).toBe('not_started');
    expect(row.placement_score).toBeNull();
    expect(row.visit_date).toBe(today());
  });

  it('refuses a stage change through PATCH', async () => {
    const vid = (await createVisitor(registrarA, { fullName: 'Stage Guard', phone: '0700000088' })).body.id;
    const res = await supertest(app).patch(`/api/visitors/${vid}`).set(authHeader(registrarA)).send({ stage: 'active' });
    expect(res.status).toBe(400);
  });

  it('refuses an out-of-order stage jump', async () => {
    const vid = (await createVisitor(registrarA, { fullName: 'Jump Guard', phone: '0700000087' })).body.id;
    const res = await supertest(app).post(`/api/visitors/${vid}/advance-stage`)
      .set(authHeader(registrarA)).send({ stage: 'enrollment', fromStage: 'lead' });
    expect(res.status).toBe(400);
  });

  it('converts at most one student per visitor under concurrency', async () => {
    const vid = (await createVisitor(registrarA, { fullName: 'Concurrent Subject', phone: '0700000086' , programVersionId: 'vsa_pv_open'})).body.id;
    await Promise.all(Array.from({ length: 8 }, () =>
      supertest(app).post(`/api/visitors/${vid}/convert`).set(authHeader(registrarA))
        .send({ classId: 'vsa_open', amountPaid: 1000 })
    ));
    const students = (db.prepare('SELECT COUNT(*) c FROM students WHERE lead_id=?').get(vid) as { c: number }).c;
    const payments = (db.prepare('SELECT COUNT(*) c FROM payments WHERE idempotency_key=?')
      .get(`visitor-convert:${vid}`) as { c: number }).c;
    expect(students).toBe(1);
    expect(payments).toBe(1);
  });

  it('blocks a second conversion at EVERY layer, not just the status check', async () => {
    // Mutation testing showed the `status === 'registered'` guard can be
    // deleted with no test failing, because two deeper layers still hold. That
    // is defence-in-depth working as intended — but it must be asserted, or a
    // future change could remove all three without warning.
    const vid = (await createVisitor(registrarA, { fullName: 'Layer Subject', phone: '0700000083' , programVersionId: 'vsa_pv_open'})).body.id;
    await supertest(app).post(`/api/visitors/${vid}/convert`)
      .set(authHeader(registrarA)).send({ classId: 'vsa_open', amountPaid: 0 }).expect(201);

    // Layer 1: the visitor status guard.
    const second = await supertest(app).post(`/api/visitors/${vid}/convert`)
      .set(authHeader(registrarA)).send({ classId: 'vsa_open', amountPaid: 0 });
    expect(second.status).toBe(409);

    // Layer 2: the lead_id lookup. Layer 3: a partial UNIQUE index. Assert the
    // database itself refuses a second student for this lead.
    expect(() =>
      db.prepare(`INSERT INTO students (id,student_code,full_name,status,registration_date,branch_id,gender,discount_percent,lead_id)
                  VALUES ('vsa_dupstu','VSA-DUP','Dup Student','active',?,?, 'male',0,?)`)
        .run(today(), BRANCH_A, vid)
    ).toThrow(/UNIQUE|constraint/i);
  });

  it('rejects payment greater than the payable fee', async () => {
    const vid = (await createVisitor(registrarA, { fullName: 'Overpay Subject', phone: '0700000085' , programVersionId: 'vsa_pv_open'})).body.id;
    const res = await supertest(app).post(`/api/visitors/${vid}/convert`)
      .set(authHeader(registrarA)).send({ classId: 'vsa_open', amountPaid: 999_999 });
    expect(res.status).toBe(400);
  });

  it('keeps a cross-branch visitor unreachable', async () => {
    const vid = (await createVisitor(registrarA, { fullName: 'Branch Guard', phone: '0700000084' })).body.id;
    db.prepare('UPDATE visitors SET branch_id=? WHERE id=?').run(BRANCH_B, vid);
    await supertest(app).patch(`/api/visitors/${vid}`)
      .set(authHeader(registrarA)).send({ fullName: 'Hijacked' }).expect(403);
  });
});
