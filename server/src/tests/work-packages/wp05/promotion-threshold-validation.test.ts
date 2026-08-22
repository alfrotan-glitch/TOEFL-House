/**
 * ACFG-1 — promotion-threshold configuration integrity.
 *
 * The promotion authority (core/academic/promotion-engine.ts,
 * resolvePromotionCriteria) reads its score threshold from three layers:
 *
 *   Layer 1  promotion_rules.min_score          <- POST /catalog/promotion-rules
 *   Layer 2  levels.pass_mark                   <- POST/PUT /academic/levels
 *   Layer 3  branch_academic_profiles.default_pass_mark
 *                                               <- PUT /catalog/branch-profile/:id
 *
 * Layer 3 was already guarded by a 0..100 percentage check. Layers 1 and 2 were
 * not, even though they OUTRANK it:
 *
 *   POST /academic/levels        Number(passMark) || ACADEMIC_DEFAULTS.levelPassMark
 *                                -> 'abc'/NaN/0 silently became 70
 *   PUT  /academic/levels/:id    passMark ?? existing.pass_mark
 *                                -> completely raw; -1, 1e9, 'abc', true all stored
 *   POST /catalog/promotion-rules  b.minScore ?? 60 / b.minAttendancePct ?? 75
 *                                -> completely raw
 *
 * `levels.pass_mark REAL DEFAULT 60` and `promotion_rules.min_score REAL NOT
 * NULL DEFAULT 60` carry no CHECK, so SQLite stored whatever arrived.
 *
 * The consumer applies `scoreOk = factors.finalPercentage >= criteria.minScore`
 * and the resulting outcome writes `student_semesters.status` and drives
 * EnrollmentService transitions. A threshold of 0 therefore passes every
 * student; a threshold of 101 fails every student; a non-numeric threshold
 * makes the comparison NaN, which is always false.
 *
 * The invariant: a promotion threshold is a percentage — finite and within
 * 0..100 — validated at the write boundary, which must be at least as strict
 * as the branch-profile boundary that already enforced it.
 *
 * `assertPerformanceScore` in utils/money.ts is the existing canonical 0..100
 * boundary (finite, 0..100, same type discipline as assertMoney: '' is missing
 * rather than zero, and booleans/arrays/objects are never scores). It is reused
 * rather than adding a fourth percentage rule.
 *
 * NOTE ON POLICY: 0 and 100 remain ACCEPTED. Layer 3 has always accepted them
 * via its own 0..100 check, and rejecting them here would invent a business
 * rule this audit has no authority to introduce. See the report's policy note.
 */
import { assignRole } from '../../support/identity.js';
import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { resolvePromotionCriteria } from '../../../core/academic/promotion-engine.js';
import academicRouter from '../../../routes/academic.routes.js';
import catalogRouter from '../../../routes/catalog.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';

const BRANCH = 'pth_branch';
const PROGRAM = 'pth_program';
const VERSION = 'pth_version';

let app: express.Express;
let owner: TokenPayload;
let manager: TokenPayload;

const authHeader = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let seq = 0;

/** Create a level through the real route; returns the HTTP response. */
const postLevel = (body: Record<string, unknown>, as: TokenPayload = manager) =>
  supertest(app)
    .post('/api/academic/levels')
    .set(authHeader(as))
    .send({ programId: PROGRAM, name: `PTH Level ${++seq}`, ...body });

const putLevel = (levelId: string, body: Record<string, unknown>, as: TokenPayload = manager) =>
  supertest(app).put(`/api/academic/levels/${levelId}`).set(authHeader(as)).send(body);

const postRule = (body: Record<string, unknown>, as: TokenPayload = owner) =>
  supertest(app)
    .post('/api/catalog/promotion-rules')
    .set(authHeader(as))
    .send({ programVersionId: VERSION, name: `PTH Rule ${++seq}`, ...body });

const levelRow = (id: string) =>
  db.prepare('SELECT pass_mark AS passMark FROM levels WHERE id = ?').get(id) as { passMark: number | null } | undefined;

const ruleRow = (id: string) =>
  db.prepare('SELECT min_score AS minScore, min_attendance_pct AS minAtt FROM promotion_rules WHERE id = ?').get(id) as
    | { minScore: number; minAtt: number }
    | undefined;

/** Seed a level under a specific program version. */
function seedLevelIn(versionId: string, passMark: number | null): string {
  const lid = `pth_lvl_${++seq}`;
  db.prepare(
    `INSERT INTO levels (id, program_id, program_version_id, name, code, "order", is_active, default_fee, pass_mark)
     VALUES (?, ?, ?, ?, ?, 1, 1, 1000, ?)`,
  ).run(lid, PROGRAM, versionId, `Seeded ${seq}`, `S${seq}`, passMark);
  return lid;
}

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  app = express();
  app.use(express.json());
  app.use('/api/academic', academicRouter);
  app.use('/api/catalog', catalogRouter);
  app.use(errorHandler);

  db.prepare("INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'T')").run(BRANCH, 'PTH Branch');
  db.prepare("INSERT OR IGNORE INTO programs (id, name, code, branch_id) VALUES (?, 'PTH Program', 'PTHP', ?)").run(PROGRAM, BRANCH);
  db.prepare(
    "INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status) VALUES (?, ?, 'v1', 1, 'published')",
  ).run(VERSION, PROGRAM);

  const pwd = await hashPassword('Str0ng!Pass2026');
  const ins = db.prepare(
    'INSERT OR IGNORE INTO users (id, username, password_hash, full_name, branch_id, must_change_password) VALUES (?, ?, ?, ?, ?, 0)',
  );
  ins.run('pth_owner', 'pth_owner', pwd, 'Owner', BRANCH);
  assignRole('pth_owner', 'owner', BRANCH)
  ins.run('pth_manager', 'pth_manager', pwd, 'Manager', BRANCH);
  assignRole('pth_manager', 'manager', BRANCH)

  owner = { userId: 'pth_owner', username: 'pth_owner', branchId: BRANCH, fullName: 'Owner' } as TokenPayload;
  manager = { userId: 'pth_manager', username: 'pth_manager', branchId: BRANCH, fullName: 'Manager' } as TokenPayload;
});

describe('ACFG-1 · Layer 2 — POST /academic/levels validates passMark', () => {
  it.each([
    ['a negative threshold', -1],
    ['a wildly negative threshold', -1000],
    ['a threshold above 100', 101],
    ['an absurd threshold', 1e9],
    ['a non-numeric threshold', 'abc'],
    ['a boolean', true],
    ['an array', [[50]]],
    ['an object', { v: 50 }],
    ['an empty string', ''],
  ])('rejects %s and creates no level', async (_label, passMark) => {
    const before = (db.prepare('SELECT COUNT(*) AS c FROM levels').get() as { c: number }).c;
    const res = await postLevel({ passMark });
    expect(res.status).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS c FROM levels').get() as { c: number }).c).toBe(before);
  });

  it.each([
    ['zero', 0],
    ['a normal threshold', 60],
    ['the maximum', 100],
    ['a numeric string', '75'],
    ['a fractional threshold', 62.5],
  ])('accepts %s and stores it verbatim', async (_label, passMark) => {
    const res = await postLevel({ passMark });
    expect(res.status).toBe(201);
    expect(levelRow(res.body.id)!.passMark).toBe(Number(passMark));
  });

  it('falls back to the configured default when passMark is omitted', async () => {
    const res = await postLevel({});
    expect(res.status).toBe(201);
    expect(levelRow(res.body.id)!.passMark).toBe(70); // ACADEMIC_DEFAULTS.levelPassMark
  });

  it('treats an explicit null as omitted, not as zero', async () => {
    const res = await postLevel({ passMark: null });
    expect(res.status).toBe(201);
    expect(levelRow(res.body.id)!.passMark).toBe(70);
  });

  it('no longer silently coerces a bad value to the default', async () => {
    // The defect: Number('abc') is NaN, `NaN || 70` is 70, so a typo became a
    // valid-looking 70% threshold with no error surfaced to the operator.
    const res = await postLevel({ passMark: 'abc' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/pass mark/i);
  });
});

describe('ACFG-1 · Layer 2 — PUT /academic/levels/:id validates passMark', () => {
  it.each([
    ['a negative threshold', -1],
    ['a threshold above 100', 101],
    ['a non-numeric threshold', 'abc'],
    ['a boolean', true],
    ['an array', [[50]]],
  ])('rejects %s and leaves the stored threshold untouched', async (_label, passMark) => {
    const created = await postLevel({ passMark: 60 });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const res = await putLevel(id, { passMark });
    expect(res.status).toBe(400);
    expect(levelRow(id)!.passMark).toBe(60);
  });

  it.each([
    ['zero', 0],
    ['a normal threshold', 80],
    ['the maximum', 100],
    ['a numeric string', '45'],
  ])('accepts %s', async (_label, passMark) => {
    const created = await postLevel({ passMark: 60 });
    const res = await putLevel(created.body.id, { passMark });
    expect(res.status).toBe(200);
    expect(levelRow(created.body.id)!.passMark).toBe(Number(passMark));
  });

  it('leaves the threshold unchanged when passMark is absent from the patch', async () => {
    const created = await postLevel({ passMark: 55 });
    const res = await putLevel(created.body.id, { name: 'Renamed Level' });
    expect(res.status).toBe(200);
    expect(levelRow(created.body.id)!.passMark).toBe(55);
  });

  it('treats an explicit null as leave-unchanged', async () => {
    const created = await postLevel({ passMark: 55 });
    const res = await putLevel(created.body.id, { passMark: null });
    expect(res.status).toBe(200);
    expect(levelRow(created.body.id)!.passMark).toBe(55);
  });
});

describe('ACFG-1 · Layer 1 — POST /catalog/promotion-rules validates its thresholds', () => {
  it.each([
    ['a negative minScore', { minScore: -1 }],
    ['a minScore above 100', { minScore: 101 }],
    ['a non-numeric minScore', { minScore: 'abc' }],
    ['a boolean minScore', { minScore: true }],
    ['a negative minAttendancePct', { minAttendancePct: -5 }],
    ['a minAttendancePct above 100', { minAttendancePct: 150 }],
    ['a non-numeric minAttendancePct', { minAttendancePct: 'abc' }],
  ])('rejects %s and creates no rule', async (_label, body) => {
    const before = (db.prepare('SELECT COUNT(*) AS c FROM promotion_rules').get() as { c: number }).c;
    const res = await postRule(body);
    expect(res.status).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS c FROM promotion_rules').get() as { c: number }).c).toBe(before);
  });

  it('accepts a legitimate rule and stores both thresholds', async () => {
    const res = await postRule({ minScore: 65, minAttendancePct: 80 });
    expect(res.status).toBe(201);
    expect(ruleRow(res.body.id)).toMatchObject({ minScore: 65, minAtt: 80 });
  });

  it('accepts the 0 and 100 boundaries', async () => {
    const res = await postRule({ minScore: 0, minAttendancePct: 100 });
    expect(res.status).toBe(201);
    expect(ruleRow(res.body.id)).toMatchObject({ minScore: 0, minAtt: 100 });
  });

  it('applies the documented defaults when the thresholds are omitted', async () => {
    const res = await postRule({});
    expect(res.status).toBe(201);
    expect(ruleRow(res.body.id)).toMatchObject({ minScore: 60, minAtt: 75 });
  });
});

describe('ACFG-1 · the promotion authority sees only valid thresholds', () => {
  it('Layer 1 outranks Layer 2, and both are now bounded', async () => {
    // A dedicated program version, so rules created by earlier tests in this
    // file cannot satisfy the Layer 1 lookup for this class.
    const pv = `pth_ver_${++seq}`;
    db.prepare(
      "INSERT INTO program_versions (id, program_id, version_label, version_number, status) VALUES (?, ?, ?, 2, 'published')",
    ).run(pv, PROGRAM, `v${seq}`);
    const level = seedLevelIn(pv, 72);
    const cls = `pth_cls_${++seq}`;
    db.prepare(
      `INSERT INTO classes (id, name, branch_id, capacity, status, lifecycle_stage, level, fee, program_id, level_id)
       VALUES (?, ?, ?, 30, 'active', 'activated', 'A1', 1000, ?, ?)`,
    ).run(cls, `PTH Class ${seq}`, BRANCH, PROGRAM, level);

    // resolvePromotionCriteria takes the class ROW, not an id.
    const clsRow = db.prepare('SELECT level_id, branch_id, offering_id FROM classes WHERE id = ?').get(cls) as never;

    // With no rule, Layer 2 (levels.pass_mark) governs.
    const layer2 = resolvePromotionCriteria(db, clsRow);
    expect(layer2.source).toBe('level_pass_mark');
    expect(layer2.minScore).toBe(72);

    // Adding a Layer 1 rule through the real route takes precedence.
    const rule = await postRule({ programVersionId: pv, minScore: 55, minAttendancePct: 70, fromLevelId: level });
    expect(rule.status).toBe(201);
    const layer1 = resolvePromotionCriteria(db, clsRow);
    expect(layer1.source).toBe('promotion_rules');
    expect(layer1.minScore).toBe(55);
  });

  it('every stored threshold in the database is a valid percentage', () => {
    const badLevels = db
      .prepare('SELECT COUNT(*) AS c FROM levels WHERE pass_mark IS NOT NULL AND (pass_mark < 0 OR pass_mark > 100)')
      .get() as { c: number };
    const badRules = db
      .prepare(
        `SELECT COUNT(*) AS c FROM promotion_rules
          WHERE min_score < 0 OR min_score > 100 OR min_attendance_pct < 0 OR min_attendance_pct > 100`,
      )
      .get() as { c: number };
    expect(badLevels.c).toBe(0);
    expect(badRules.c).toBe(0);
  });

  it('no threshold is stored as a non-numeric type', () => {
    const badLevels = db
      .prepare("SELECT COUNT(*) AS c FROM levels WHERE pass_mark IS NOT NULL AND typeof(pass_mark) NOT IN ('real','integer')")
      .get() as { c: number };
    const badRules = db
      .prepare("SELECT COUNT(*) AS c FROM promotion_rules WHERE typeof(min_score) NOT IN ('real','integer')")
      .get() as { c: number };
    expect(badLevels.c).toBe(0);
    expect(badRules.c).toBe(0);
  });
});
