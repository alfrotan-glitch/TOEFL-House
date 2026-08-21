/**
 * CLOSURE-1 — student portal privilege boundary.
 * ============================================================================
 * The portal authenticates with student_code + full_name (no secret). That
 * mechanism is a documented product decision (see the handler comment in
 * auth.routes.ts and docs/AUDIT_PASS_3), rate-limited to 60 attempts / 15 min,
 * and is NOT changed here: replacing it would invent business policy about how
 * students receive credentials.
 *
 * What IS enforced here is the property that makes that decision defensible —
 * the blast radius. Role 'student' carries `permissions: {}` in the RBAC
 * catalog and can reach exactly ONE endpoint, object-scoped to its own linked
 * student. If anyone later widens the portal's reach, these tests fail and the
 * policy decision has to be re-taken deliberately instead of by accident.
 *
 * Verified live before writing this test (fresh DB, real portal token):
 *   GET  /students/me                 -> 200   (own profile only)
 *   GET  /students/:otherId           -> 403
 *   GET  /students                    -> 403
 *   POST /students/:id/payments       -> 403
 *   POST /students/:id/refund         -> 403
 *   GET  /payments|/invoices|/finance|/classes|/teachers|/bos|/security|/users -> 403
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { today } from '../../../utils/ids.js';
import { signToken, type TokenPayload } from '../../../utils/auth.js';
import studentsRouter from '../../../routes/students.routes.js';
import invoicesRouter from '../../../routes/invoices.routes.js';
import financeRouter from '../../../routes/finance.routes.js';
import classesRouter from '../../../routes/classes.routes.js';
import teachersRouter from '../../../routes/teachers.routes.js';
import bosRouter from '../../../routes/bos.routes.js';
import securityRouter from '../../../routes/security.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { ROLE_DEFINITIONS } from '../../../core/rbac/permission-catalog.js';

const BRANCH = 'spp_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/students', studentsRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/finance', financeRouter);
  app.use('/api/classes', classesRouter);
  app.use('/api/teachers', teachersRouter);
  app.use('/api/bos', bosRouter);
  app.use('/api/security', securityRouter);
  app.use(errorHandler);
  return app;
}

let app: express.Express;
let portalToken: string;

beforeAll(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Portal', 'Loc');
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES ('spp_s_self', 'TH-SPP-1', 'Portal Self', 'active', ?, ?, 'male', '0700222001')`
  ).run(today(), BRANCH);
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender, phone)
     VALUES ('spp_s_other', 'TH-SPP-2', 'Portal Other', 'active', ?, ?, 'male', '0700222002')`
  ).run(today(), BRANCH);
  db.prepare(
    `INSERT OR IGNORE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password, linked_student_id, session_version )
     VALUES ('spp_u', 'stu_TH-SPP-1', 'Portal Self', ?, 'unusable', 1, 0, 'spp_s_self', 1)`
  ).run(BRANCH);
  assignRole('spp_u', 'student', BRANCH);

  portalToken = signToken({
    userId: 'spp_u', username: 'stu_TH-SPP-1',
    branchId: BRANCH, fullName: 'Portal Self', sessionVersion: 1,
  } as TokenPayload);
  app = createApp();
});

const auth = () => ({ Authorization: `Bearer ${portalToken}` });

describe('CLOSURE-1 — the student role carries no permissions', () => {
  it('has an empty permission set in the RBAC catalog', () => {
    const role = ROLE_DEFINITIONS.find((r) => r.code === 'student');
    expect(role).toBeTruthy();
    expect(Object.keys(role!.permissions ?? {})).toHaveLength(0);
  });
});

describe('CLOSURE-1 — the portal reaches exactly one object-scoped endpoint', () => {
  it('can read its OWN profile', async () => {
    const res = await supertest(app).get('/api/students/me').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('spp_s_self');
    // The authoritative balance ships with it, same as staff surfaces.
    expect(res.body.balance).toBeTruthy();
  });

  it('cannot read another student by id (BOLA)', async () => {
    const res = await supertest(app).get('/api/students/spp_s_other').set(auth());
    expect(res.status).toBe(403);
  });

  it('cannot list students', async () => {
    expect((await supertest(app).get('/api/students').set(auth())).status).toBe(403);
  });
});

describe('CLOSURE-1 — the portal can move no money and reach no staff surface', () => {
  const moneyWrites: Array<[string, string, Record<string, unknown>]> = [
    ['post', '/api/students/spp_s_self/payments', { amount: 100, category: 'other', notes: 'x' }],
    ['post', '/api/students/spp_s_self/refund', { amount: 10, reason: 'x' }],
  ];

  for (const [method, path, body] of moneyWrites) {
    it(`refuses ${method.toUpperCase()} ${path}`, async () => {
      const res = await (supertest(app) as never as Record<string, (p: string) => supertest.Test>)[method](path)
        .set(auth())
        .send(body);
      expect(res.status).toBe(403);
      // Nothing was written.
      const rows = db.prepare(`SELECT COUNT(*) AS c FROM payments WHERE student_id = 'spp_s_self'`).get() as { c: number };
      expect(rows.c).toBe(0);
    });
  }

  const staffReads = [
    '/api/invoices',
    '/api/finance/overview',
    '/api/classes',
    '/api/teachers',
    '/api/bos/executive-dashboard',
    '/api/security/roles',
  ];

  for (const path of staffReads) {
    it(`refuses GET ${path}`, async () => {
      const res = await supertest(app).get(path).set(auth());
      expect(res.status).toBe(403);
    });
  }
});
