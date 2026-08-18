/**
 * Teacher update validation — regression suite for teacher-audit finding T-2.
 *
 * PRE-FIX BEHAVIOUR, reproduced live on a fresh database before any code was
 * changed. `PUT /api/teachers/:id` validated money only with
 * `!Number.isFinite(x) || x < 0` — a coercion, not a parse — while
 * `POST /api/teachers` routed the same fields through `assertMoney`:
 *
 *   PUT baseSalary 1e15    -> 200, stored, and computed-salary returned 1e15
 *   PUT baseSalary ''      -> 200, stored as 0     (blank field => ZERO salary)
 *   PUT baseSalary true    -> 200, stored as 1
 *   PUT baseSalary [5]     -> 200, stored as 5
 *   PUT baseSalary '0x10'  -> 200, stored as 16
 *   PUT defaultSkillRate 1e15 / true -> 200, stored
 *   PUT performanceScore 5000 -> 200, silently CLAMPED to 100
 *   PUT performanceScore -20  -> 200, silently clamped to 0
 *   PUT performanceScore 'abc'-> 500 (NaN reached the database)
 *   ...while POST refused every one of those with 400.
 *
 * Each test pairs the PUT assertion with the POST control for the same value,
 * because the defect was specifically a DISAGREEMENT between the two writers.
 *
 * SCOPE NOTE: `targetSkillsPerMonth` is deliberately NOT hardened here. The
 * audit listed it under T-2, but live reproduction refuted that: PUT already
 * rejects -3 and 'abc', and PUT and POST agree exactly on 7.5 and 1e15 (both
 * accept). There is no create/update divergence to close, and choosing a new
 * upper bound for a workload target would be inventing a business rule.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { teachersRouter } from '../routes/teachers.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { assertMoney, assertPerformanceScore } from '../utils/money.js';

const BRANCH = 'tuv_branch';
let app: express.Express;
let owner: TokenPayload;
const auth = () => ({ Authorization: `Bearer ${signToken(owner)}` });

/** Values that are not amounts. Every one was silently coerced and stored
 *  pre-fix; `assertMoney` refuses each with 400. */
const NON_AMOUNTS: Array<[string, unknown]> = [
  ['huge 1e15', 1e15],
  ['negative', -5000],
  ['text', 'abc'],
  ['empty string', ''],
  ['whitespace', '   '],
  ['boolean true', true],
  ['array [5]', [5]],
  ['hex string', '0x10'],
  ['object', { v: 1 }],
  // NOTE: bare `Infinity` cannot be tested over HTTP — JSON has no Infinity
  // literal, so JSON.stringify turns it into null, which this route correctly
  // reads as "field omitted". The string form is transmissible and is refused
  // by the decimal-numeral parse; the numeric form is covered by the direct
  // unit assertions on assertMoney/assertPerformanceScore below.
  ['string "Infinity"', 'Infinity'],
  ['string "NaN"', 'NaN'],
];

let seq = 0;
function mkTeacher(baseSalary = 10000, skillRate = 50, score = 40) {
  const tid = `tuv_t${++seq}`;
  db.prepare(
    `INSERT OR REPLACE INTO teachers (id, full_name, branch_id, base_salary, salary_type, status, joined_date, performance_score, default_skill_rate, target_skills_per_month)
     VALUES (?, ?, ?, ?, 'fixed', 'active', ?, ?, ?, 4)`,
  ).run(tid, `Teacher ${tid}`, BRANCH, baseSalary, today(), score, skillRate);
  return tid;
}
const rowOf = (tid: string) =>
  db.prepare('SELECT base_salary, default_skill_rate, performance_score, target_skills_per_month, full_name FROM teachers WHERE id = ?').get(tid) as Record<string, unknown>;
const put = (tid: string, body: Record<string, unknown>) =>
  supertest(app).put(`/api/teachers/${tid}`).set(auth()).send(body);
const post = (body: Record<string, unknown>) =>
  supertest(app).post('/api/teachers').set(auth()).send({ fullName: 'Control Teacher', ...body });
const histCount = (tid: string) =>
  Number((db.prepare('SELECT COUNT(*) c FROM teacher_compensation_history WHERE teacher_id = ?').get(tid) as { c: number }).c);

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'TUV Branch', 'Kabul');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
     VALUES ('tuv_owner', 'tuv_owner', 'TUV Owner', 'owner', ?, ?, 1, 0)`,
  ).run(BRANCH, await hashPassword('pw'));
  syncLegacyUserRoles(db);
  owner = { userId: 'tuv_owner', username: 'tuv_owner', role: 'owner' as never, branchId: BRANCH, fullName: 'TUV Owner' };
  app = express();
  app.use(express.json());
  app.use('/api/teachers', teachersRouter);
  app.use(errorHandler);
});

describe('T-2 · baseSalary is validated identically on create and update', () => {
  for (const [label, value] of NON_AMOUNTS) {
    it(`rejects baseSalary (${label}) on PUT, exactly as POST does, and stores nothing`, async () => {
      const tid = mkTeacher(10000);
      const before = rowOf(tid);

      const updated = await put(tid, { baseSalary: value });
      const created = await post({ baseSalary: value });

      expect(updated.status).toBe(400);
      expect(created.status).toBe(400);
      // The stored row must be byte-for-byte what it was before the attempt.
      expect(rowOf(tid)).toEqual(before);
      // A rejected update must not leave a compensation-history entry behind.
      expect(histCount(tid)).toBe(0);
    });
  }

  it('rejects a value that exceeds monetary precision rather than storing it', async () => {
    const tid = mkTeacher(10000);
    const res = await put(tid, { baseSalary: 1e15 });
    expect(res.status).toBe(400);
    expect(Number(rowOf(tid).base_salary)).toBe(10000);
  });
});

describe('T-2 · defaultSkillRate is validated identically on create and update', () => {
  for (const [label, value] of NON_AMOUNTS) {
    it(`rejects defaultSkillRate (${label}) on PUT, exactly as POST does`, async () => {
      const tid = mkTeacher(10000, 50);
      const before = rowOf(tid);

      const updated = await put(tid, { defaultSkillRate: value });
      const created = await post({ baseSalary: 1000, defaultSkillRate: value });

      expect(updated.status).toBe(400);
      expect(created.status).toBe(400);
      expect(rowOf(tid)).toEqual(before);
    });
  }
});

describe('T-2 · performanceScore is rejected, never silently clamped', () => {
  it('rejects a score above 100 instead of storing 100', async () => {
    const tid = mkTeacher(10000, 50, 40);
    const res = await put(tid, { performanceScore: 5000 });
    expect(res.status).toBe(400);
    // Pre-fix this returned 200 and stored 100 — a value the caller never sent.
    expect(Number(rowOf(tid).performance_score)).toBe(40);
  });

  it('rejects a negative score instead of storing 0', async () => {
    const tid = mkTeacher(10000, 50, 40);
    const res = await put(tid, { performanceScore: -20 });
    expect(res.status).toBe(400);
    expect(Number(rowOf(tid).performance_score)).toBe(40);
  });

  it('rejects a non-numeric score with 400, not 500', async () => {
    const tid = mkTeacher(10000, 50, 40);
    const res = await put(tid, { performanceScore: 'abc' });
    // Pre-fix: NaN reached the database and surfaced as HTTP 500.
    expect(res.status).toBe(400);
    expect(Number(rowOf(tid).performance_score)).toBe(40);
  });

  it.each([
    ['boolean', true],
    ['array', [50]],
    ['object', { score: 50 }],
    ['empty string', ''],
    ['string "Infinity"', 'Infinity'],
  ])('rejects a %s score', async (_label, value) => {
    const tid = mkTeacher(10000, 50, 40);
    const res = await put(tid, { performanceScore: value });
    expect(res.status).toBe(400);
    expect(Number(rowOf(tid).performance_score)).toBe(40);
  });

  it('accepts the full legitimate range, including fractions and the bounds', async () => {
    // performance_score is REAL, and 0 is the established "not yet evaluated"
    // sentinel that POST /api/teachers writes for every new teacher.
    for (const score of [0, 1, 50, 87.5, 99.99, 100]) {
      const tid = mkTeacher(10000, 50, 40);
      const res = await put(tid, { performanceScore: score });
      expect(res.status).toBe(200);
      expect(Number(rowOf(tid).performance_score)).toBe(score);
    }
  });
});

describe('T-2 · the shared guards reject non-finite numbers directly', () => {
  // These values cannot cross an HTTP/JSON boundary as numbers (JSON has no
  // Infinity or NaN literal), so they are asserted against the boundary
  // functions the routes call. Without this, a mutant that dropped the
  // finiteness check inside assertMoney would survive.
  it('assertMoney refuses Infinity, -Infinity and NaN', () => {
    for (const v of [Infinity, -Infinity, NaN]) {
      expect(() => assertMoney(v, 'Base salary')).toThrow();
    }
  });

  it('assertPerformanceScore refuses Infinity, -Infinity and NaN', () => {
    for (const v of [Infinity, -Infinity, NaN]) {
      expect(() => assertPerformanceScore(v)).toThrow();
    }
  });

  it('assertPerformanceScore enforces the 0..100 range and its zero sentinel', () => {
    expect(assertPerformanceScore(0)).toBe(0);
    expect(assertPerformanceScore(100)).toBe(100);
    expect(assertPerformanceScore(87.5)).toBe(87.5);
    expect(() => assertPerformanceScore(100.01)).toThrow();
    expect(() => assertPerformanceScore(-0.01)).toThrow();
    // The stricter evaluation-event rule shares the same implementation.
    expect(() => assertPerformanceScore(0, 'Score', { allowZero: false })).toThrow();
    expect(assertPerformanceScore(1, 'Score', { allowZero: false })).toBe(1);
  });
});

describe('T-2 · payroll propagation is closed', () => {
  it('cannot drive computed-salary to an absurd figure through PUT', async () => {
    // The concrete harm: pre-fix, PUT baseSalary 1e15 returned 200 and
    // GET /:id/computed-salary then returned due = 1e15, which flows into
    // budget consumption and the salary expense ledger.
    const tid = mkTeacher(10000);
    const res = await put(tid, { baseSalary: 1e15 });
    expect(res.status).toBe(400);

    const computed = await supertest(app).get(`/api/teachers/${tid}/computed-salary?month=1405-05`).set(auth());
    expect(computed.status).toBe(200);
    expect(Number(computed.body.due)).toBe(10000);
  });
});

describe('T-2 · legitimate behaviour is preserved', () => {
  it('applies a normal salary change and records compensation history', async () => {
    const tid = mkTeacher(10000);
    const res = await put(tid, { baseSalary: 35000, compensationReason: 'Annual review' });
    expect(res.status).toBe(200);
    expect(Number(rowOf(tid).base_salary)).toBe(35000);
    expect(histCount(tid)).toBe(1);
  });

  it('accepts numeric strings, as the create route does', async () => {
    const tid = mkTeacher(10000);
    const res = await put(tid, { baseSalary: '24000.50' });
    expect(res.status).toBe(200);
    expect(Number(rowOf(tid).base_salary)).toBe(24000.5);
  });

  it('rounds to two decimals exactly as POST does', async () => {
    const tid = mkTeacher(10000);
    const res = await put(tid, { baseSalary: 1.005 });
    expect(res.status).toBe(200);
    expect(Number(rowOf(tid).base_salary)).toBe(1.01);
  });

  it('accepts zero as a legitimate salary and rate', async () => {
    const tid = mkTeacher(10000, 50);
    const res = await put(tid, { baseSalary: 0, defaultSkillRate: 0 });
    expect(res.status).toBe(200);
    expect(Number(rowOf(tid).base_salary)).toBe(0);
    expect(Number(rowOf(tid).default_skill_rate)).toBe(0);
  });

  it('leaves omitted money and score fields untouched', async () => {
    const tid = mkTeacher(12345, 678, 42);
    const res = await put(tid, { fullName: 'Renamed Only' });
    expect(res.status).toBe(200);
    const after = rowOf(tid);
    expect(after.full_name).toBe('Renamed Only');
    expect(Number(after.base_salary)).toBe(12345);
    expect(Number(after.default_skill_rate)).toBe(678);
    expect(Number(after.performance_score)).toBe(42);
    // An update that changes no compensation field writes no history row.
    expect(histCount(tid)).toBe(0);
  });

  it('applies a legitimate defaultSkillRate change', async () => {
    const tid = mkTeacher(10000, 50);
    const res = await put(tid, { defaultSkillRate: 750 });
    expect(res.status).toBe(200);
    expect(Number(rowOf(tid).default_skill_rate)).toBe(750);
  });

  it('still accepts targetSkillsPerMonth unchanged (explicitly out of T-2 scope)', async () => {
    // Documents the refuted audit claim: PUT and POST already agree here.
    const tid = mkTeacher(10000);
    expect((await put(tid, { targetSkillsPerMonth: 6 })).status).toBe(200);
    expect(Number(rowOf(tid).target_skills_per_month)).toBe(6);
    expect((await put(tid, { targetSkillsPerMonth: -3 })).status).toBe(400);
    expect((await post({ baseSalary: 1000, targetSkillsPerMonth: -3 })).status).toBe(400);
  });
});

describe('T-2 · a rejected update is fully atomic', () => {
  it('writes no field at all when one field in a multi-field update is invalid', async () => {
    const tid = mkTeacher(10000, 50, 40);
    const before = rowOf(tid);
    // A valid name and rate alongside an invalid salary: nothing may persist.
    const res = await put(tid, { fullName: 'Should Not Persist', defaultSkillRate: 999, baseSalary: 1e15 });
    expect(res.status).toBe(400);
    expect(rowOf(tid)).toEqual(before);
    expect(histCount(tid)).toBe(0);
  });

  it('writes nothing when the score is invalid but the salary is valid', async () => {
    const tid = mkTeacher(10000, 50, 40);
    const before = rowOf(tid);
    const res = await put(tid, { baseSalary: 22000, performanceScore: 5000 });
    expect(res.status).toBe(400);
    expect(rowOf(tid)).toEqual(before);
    expect(histCount(tid)).toBe(0);
  });
});
