/**
 * Employee salary validation — regression suite.
 *
 * FINDING: `PUT /api/employees/:id` wrote `baseSalary` with NO validation of
 * any kind, and `POST /api/employees` was equally unvalidated. The raw request
 * value was bound straight to a `REAL NOT NULL` column.
 *
 * WHY A REAL COLUMN DID NOT SAVE US (proven against better-sqlite3 directly):
 * SQLite type affinity converts text that *looks* numeric, but stores
 * non-numeric text VERBATIM rather than rejecting it. So 'abc', '50abc' and ''
 * persisted as TEXT in a REAL column. `SUM(base_salary)` then evaluates those
 * rows as 0, so branch payroll totals silently under-report — the row is still
 * there, the money simply vanishes from every aggregate.
 *
 * PRE-FIX BEHAVIOUR, reproduced live on a fresh database before any change,
 * each case paired with the teacher control (which already used assertMoney):
 *
 *   value      PUT(employee)              POST(employee)  POST(teacher)
 *   1e15       200, stored 1e15           201             400
 *   -5000      200, stored -5000          201             400
 *   'abc'      200, stored TEXT 'abc'     201             400
 *   ''         200, stored TEXT ''        201             400
 *   '   '      200, stored TEXT '   '     201             400
 *   '0x10'     200, stored TEXT '0x10'    201             400
 *   '50abc'    200, stored TEXT '50abc'   201             400
 *   [5]        200, stored 5              201             400
 *   true       500 (raw SQLite bind error leaked)  500     400
 *   {}         500 (same)                 500             400
 *
 * The fix routes both writers through `assertMoney`, the same boundary the
 * teacher writers use. No new business rule: the accepted range is whatever
 * assertMoney already defines for every other salary field in this codebase.
 */
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import Database from 'better-sqlite3';
import { db, initSchema } from '../db/connection.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';
import { teachersRouter, employeesRouter } from '../routes/teachers.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'esv_branch';
let app: express.Express;
let owner: TokenPayload;
const auth = () => ({ Authorization: `Bearer ${signToken(owner)}` });

/** Values that are not amounts. Every one was either stored verbatim or
 *  crashed with a 500 pre-fix. */
const NON_AMOUNTS: Array<[string, unknown]> = [
  ['huge 1e15', 1e15],
  ['negative', -5000],
  ['text', 'abc'],
  ['empty string', ''],
  ['whitespace', '   '],
  ['hex string', '0x10'],
  ['trailing garbage', '50abc'],
  ['boolean true', true],
  ['boolean false', false],
  ['array', [5]],
  ['object', {}],
];

let seq = 0;
function mkEmployee(baseSalary = 10000) {
  const eid = `esv_e${++seq}`;
  db.prepare(
    `INSERT OR REPLACE INTO employees (id, full_name, role, branch_id, base_salary, status, joined_date)
     VALUES (?, ?, 'clerk', ?, ?, 'active', ?)`,
  ).run(eid, `Employee ${eid}`, BRANCH, baseSalary, today());
  return eid;
}
const rowOf = (eid: string) =>
  db.prepare('SELECT base_salary, full_name, role, status FROM employees WHERE id = ?').get(eid) as Record<string, unknown>;
const salaryTypeOf = (eid: string) =>
  String((db.prepare('SELECT typeof(base_salary) t FROM employees WHERE id = ?').get(eid) as { t: string }).t);
const putEmp = (eid: string, body: Record<string, unknown>) =>
  supertest(app).put(`/api/employees/${eid}`).set(auth()).send(body);
const postEmp = (body: Record<string, unknown>) =>
  supertest(app).post('/api/employees').set(auth()).send({ fullName: 'Control Employee', role: 'clerk', ...body });
const postTeacher = (body: Record<string, unknown>) =>
  supertest(app).post('/api/teachers').set(auth()).send({ fullName: 'Control Teacher', ...body });

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'ESV Branch', 'Kabul');
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
     VALUES ('esv_owner', 'esv_owner', 'ESV Owner', ?, ?, 1, 0)`,
  ).run(BRANCH, await hashPassword('pw'));
  assignRole('esv_owner', 'owner', BRANCH);

  owner = { userId: 'esv_owner', username: 'esv_owner', branchId: BRANCH, fullName: 'ESV Owner' };
  app = express();
  app.use(express.json());
  app.use('/api/teachers', teachersRouter);
  app.use('/api/employees', employeesRouter);
  app.use(errorHandler);
});

describe('employee salary · the storage layer cannot be relied on to validate', () => {
  it('a REAL column stores non-numeric TEXT verbatim and aggregates it as zero', () => {
    // This is WHY route-level validation is required rather than optional.
    const mem = new Database(':memory:');
    mem.exec('CREATE TABLE t (s REAL NOT NULL DEFAULT 0)');
    for (const v of ['abc', '50abc', '']) mem.prepare('INSERT INTO t (s) VALUES (?)').run(v);
    mem.prepare('INSERT INTO t (s) VALUES (?)').run(1000);
    const types = (mem.prepare('SELECT typeof(s) t FROM t').all() as Array<{ t: string }>).map((r) => r.t);
    expect(types).toEqual(['text', 'text', 'text', 'real']);
    // Worse than "text contributes zero": SUM() coerces each TEXT value with
    // SQLite's leading-numeric-prefix rule, so 'abc' and '' contribute 0 while
    // '50abc' silently contributes 50. A payroll total therefore comes out
    // wrong in a way no constraint or error ever reveals.
    expect(Number((mem.prepare('SELECT SUM(s) s FROM t').get() as { s: number }).s)).toBe(1050);
    mem.close();
  });
});

describe('employee salary · PUT rejects every non-amount, exactly as the teacher writer does', () => {
  for (const [label, value] of NON_AMOUNTS) {
    it(`rejects ${label} on PUT and stores nothing`, async () => {
      const eid = mkEmployee(10000);
      const before = rowOf(eid);

      const updated = await putEmp(eid, { baseSalary: value });
      const createdEmp = await postEmp({ baseSalary: value });
      const createdTeacher = await postTeacher({ baseSalary: value });

      // All three writers must now agree that this is a client error.
      expect(updated.status).toBe(400);
      expect(createdEmp.status).toBe(400);
      expect(createdTeacher.status).toBe(400);
      // Pre-fix `true` and `{}` leaked a raw SQLite bind error as a 500.
      expect(String(updated.body?.error ?? '')).not.toMatch(/SQLite|constraint|bind/i);
      // The row must be untouched, and still genuinely numeric.
      expect(rowOf(eid)).toEqual(before);
      expect(salaryTypeOf(eid)).toBe('integer');
    });
  }

  it('never leaves a TEXT value in a REAL salary column', async () => {
    // The corruption that made aggregates silently wrong.
    for (const [, value] of NON_AMOUNTS) {
      const eid = mkEmployee(5000);
      await putEmp(eid, { baseSalary: value });
      expect(salaryTypeOf(eid)).toBe('integer');
      expect(Number(rowOf(eid).base_salary)).toBe(5000);
    }
  });

  it('keeps branch payroll aggregates exact after a barrage of rejected updates', async () => {
    const a = mkEmployee(1000);
    const b = mkEmployee(2000);
    for (const [, value] of NON_AMOUNTS) {
      await putEmp(a, { baseSalary: value });
      await putEmp(b, { baseSalary: value });
    }
    const sum = Number(
      (db.prepare('SELECT SUM(base_salary) s FROM employees WHERE id IN (?, ?)').get(a, b) as { s: number }).s,
    );
    expect(sum).toBe(3000);
  });
});

describe('employee salary · POST rejects every non-amount', () => {
  for (const [label, value] of NON_AMOUNTS) {
    it(`rejects ${label} on POST and creates no employee`, async () => {
      const before = Number((db.prepare('SELECT COUNT(*) c FROM employees').get() as { c: number }).c);
      const res = await postEmp({ baseSalary: value });
      expect(res.status).toBe(400);
      expect(String(res.body?.error ?? '')).not.toMatch(/SQLite|constraint|bind/i);
      expect(Number((db.prepare('SELECT COUNT(*) c FROM employees').get() as { c: number }).c)).toBe(before);
    });
  }

  it('still requires a base salary to be supplied, with the required-fields message', async () => {
    // The explicit `baseSalary == null` check and assertMoney BOTH answer 400,
    // so a status-only assertion cannot distinguish them. The required-fields
    // message names all three fields and is what tells a caller a field is
    // MISSING rather than malformed.
    for (const body of [{}, { baseSalary: null }, { baseSalary: undefined }]) {
      const res = await postEmp(body);
      expect(res.status).toBe(400);
      expect(String(res.body?.error ?? '')).toMatch(/Full name, role, and base salary are required/i);
    }
  });
});

describe('employee salary · legitimate values are preserved', () => {
  it.each([
    ['whole number', 35000, 35000],
    ['numeric string', '24000', 24000],
    ['large whole number', 12346, 12346],
    ['one afghani', 1, 1],
    ['zero is legal', 0, 0],
  ])('accepts %s on PUT', async (_label, sent, stored) => {
    const eid = mkEmployee(10000);
    const res = await putEmp(eid, { baseSalary: sent });
    expect(res.status).toBe(200);
    expect(Number(rowOf(eid).base_salary)).toBe(stored);
    expect(salaryTypeOf(eid)).toBe('integer');
    // The API must report the stored numeric value, not the raw request value.
    expect(res.body.baseSalary).toBe(stored);
    expect(typeof res.body.baseSalary).toBe('number');
  });

  it.each([
    ['whole number', 30000, 30000],
    ['numeric string', '18000', 18000],
    ['one afghani', 1, 1],
    ['zero', 0, 0],
  ])('accepts %s on POST and PERSISTS the parsed number', async (_label, sent, stored) => {
    const res = await postEmp({ baseSalary: sent });
    expect(res.status).toBe(201);
    expect(res.body.baseSalary).toBe(stored);
    expect(typeof res.body.baseSalary).toBe('number');
    // Assert the STORED value and its SQLite storage class, not just the
    // response. Mutation testing showed a response-only assertion cannot tell
    // whether the raw body value or the parsed one reached the column: a
    // numeric string would be stored as TEXT while still serialising fine.
    const created = res.body.id as string;
    expect(Number(rowOf(created).base_salary)).toBe(stored);
    expect(salaryTypeOf(created)).toBe('integer');
  });

  it('leaves the salary untouched when baseSalary is omitted', async () => {
    const eid = mkEmployee(31337);
    const res = await putEmp(eid, { fullName: 'Renamed Only' });
    expect(res.status).toBe(200);
    expect(rowOf(eid).full_name).toBe('Renamed Only');
    expect(Number(rowOf(eid).base_salary)).toBe(31337);
    expect(salaryTypeOf(eid)).toBe('integer');
  });

  it('treats an explicit null baseSalary as "leave unchanged"', async () => {
    // Pre-existing contract: `baseSalary ?? existing.base_salary`. Preserved.
    const eid = mkEmployee(4242);
    const res = await putEmp(eid, { baseSalary: null });
    expect(res.status).toBe(200);
    expect(Number(rowOf(eid).base_salary)).toBe(4242);
  });

  it('still updates other fields alongside a valid salary', async () => {
    const eid = mkEmployee(10000);
    const res = await putEmp(eid, { fullName: 'New Name', role: 'accountant', baseSalary: 27500, status: 'inactive' });
    expect(res.status).toBe(200);
    const row = rowOf(eid);
    expect(row.full_name).toBe('New Name');
    expect(row.role).toBe('accountant');
    expect(Number(row.base_salary)).toBe(27500);
    expect(row.status).toBe('inactive');
  });

  it('still rejects an invalid status at the ROUTE, not merely at the schema CHECK', async () => {
    const eid = mkEmployee(9000);
    const res = await putEmp(eid, { status: 'deleted' });
    expect(res.status).toBe(400);
    // `employees.status` also carries a CHECK constraint, so removing the route
    // guard still fails — but as a leaked constraint error, not a clean 400
    // with a useful message. Asserting the route's own message is what
    // distinguishes the two (mutation testing proved a status-only assertion
    // cannot).
    expect(String(res.body?.error ?? '')).toMatch(/Invalid status/i);
    expect(String(res.body?.error ?? '')).not.toMatch(/CHECK constraint|SQLITE_|SqliteError/i);
    expect(Number(rowOf(eid).base_salary)).toBe(9000);
    expect(rowOf(eid).status).toBe('active');
  });
});

describe('employee salary · a rejected update is atomic', () => {
  it('writes no field at all when the salary is invalid', async () => {
    const eid = mkEmployee(10000);
    const before = rowOf(eid);
    const res = await putEmp(eid, { fullName: 'Should Not Persist', role: 'manager', baseSalary: 'abc' });
    expect(res.status).toBe(400);
    expect(rowOf(eid)).toEqual(before);
  });
});

describe('employee salary · corrupt salaries cannot reach payroll', () => {
  it('an employee whose salary update was rejected keeps a payable numeric salary', async () => {
    const eid = mkEmployee(8000);
    await putEmp(eid, { baseSalary: 1e15 });
    expect(Number(rowOf(eid).base_salary)).toBe(8000);
    expect(salaryTypeOf(eid)).toBe('integer');
  });
});
