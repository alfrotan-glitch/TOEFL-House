/**
 * CFG-1 — HTTP enforcement of discount approval authority.
 *
 * `discount-authority.ts` DEFINES who may approve each category. A constant is
 * not a control, so this suite proves the rule is enforced at the route:
 * a branch manager cannot grant a 100% first-degree or sponsorship discount,
 * cannot exceed a category maximum, and cannot reach another branch.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { today } from '../utils/ids.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { discountAuthorizationsRouter } from '../routes/discount-authorizations.routes.js';

const BR_A = 'dauth_branch_a';
const BR_B = 'dauth_branch_b';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/discount-authorizations', discountAuthorizationsRouter);
  app.use(errorHandler);
  return app;
}

function tok(userId: string, role: string, branchId: string): TokenPayload {
  return { userId, username: userId, role: role as TokenPayload['role'], branchId, fullName: userId };
}
const auth = (u: TokenPayload) => ({ Authorization: `Bearer ${signToken(u)}` });

let app: ReturnType<typeof createApp>;
const OWNER = tok('dauth_owner', 'owner', BR_A);
const MGR_A = tok('dauth_mgr_a', 'manager', BR_A);
const MGR_B = tok('dauth_mgr_b', 'manager', BR_B);

let seq = 0;
function seedStudent(branchId = BR_A) {
  const id = `dauth_stu_${++seq}`;
  db.prepare(
    `INSERT OR IGNORE INTO students (id, student_code, full_name, status, registration_date, branch_id, gender)
     VALUES (?, ?, ?, 'active', ?, ?, 'male')`,
  ).run(id, `TH-DA-${seq}`, `Student ${seq}`, today(), branchId);
  return id;
}

beforeAll(async () => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?,?,?,?,1)')
    .run('dauth_campus', FIXED_ORG_ID, 'DAuth Campus', 'DAUTH');
  for (const b of [BR_A, BR_B]) {
    db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?,?,?,?)')
      .run(b, b, 'Loc', 'dauth_campus');
  }
  const pw = await hashPassword('testpass123');
  for (const u of [OWNER, MGR_A, MGR_B]) {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
       VALUES (?,?,?,?,?,?,1,0)`,
    ).run(u.userId, u.username, u.fullName, u.role, u.branchId, pw);
  }
  syncLegacyUserRoles(db);
  app = createApp();
});

describe('CFG-1 · approval authority is enforced at the HTTP route', () => {
  it.each([
    ['COURSE_AMBASSADOR', 15],
    ['SECOND_DEGREE_RELATIVE', 50],
    ['FAMILY_OF_FOUR_PLUS', 50],
  ])('a manager may authorize %s up to %i%%', async (category, pct) => {
    const res = await supertest(app)
      .post('/api/discount-authorizations')
      .set(auth(MGR_A))
      .send({ studentId: seedStudent(), category, approvedPercent: pct, reason: 'policy' });
    expect(res.status).toBe(201);
    expect(res.body.approvedPercent).toBe(pct);
  });

  it.each([
    ['FIRST_DEGREE_RELATIVE', 100],
    ['SPONSORSHIP', 100],
  ])('a manager may NOT authorize %s — owner only', async (category, pct) => {
    const res = await supertest(app)
      .post('/api/discount-authorizations')
      .set(auth(MGR_A))
      .send({ studentId: seedStudent(), category, approvedPercent: pct, reason: 'policy' });
    expect(res.status).toBe(403);
  });

  it.each([
    ['FIRST_DEGREE_RELATIVE', 100],
    ['SPONSORSHIP', 100],
  ])('an owner may authorize %s at %i%%', async (category, pct) => {
    const res = await supertest(app)
      .post('/api/discount-authorizations')
      .set(auth(OWNER))
      .send({ studentId: seedStudent(), category, approvedPercent: pct, reason: 'policy' });
    expect(res.status).toBe(201);
  });

  it.each([
    ['COURSE_AMBASSADOR', 16],
    ['SECOND_DEGREE_RELATIVE', 51],
    ['FAMILY_OF_FOUR_PLUS', 99],
    ['SPONSORSHIP', 101],
  ])('%s above its maximum (%i%%) is rejected even for an owner', async (category, pct) => {
    const res = await supertest(app)
      .post('/api/discount-authorizations')
      .set(auth(OWNER))
      .send({ studentId: seedStudent(), category, approvedPercent: pct, reason: 'policy' });
    expect(res.status).toBe(400);
  });

  it('a manager cannot authorize a discount for another branch', async () => {
    const res = await supertest(app)
      .post('/api/discount-authorizations')
      .set(auth(MGR_B))
      .send({ studentId: seedStudent(BR_A), category: 'COURSE_AMBASSADOR', approvedPercent: 15, reason: 'x' });
    expect(res.status).toBe(403);
  });

  it('forged approver fields do not grant a manager owner authority', async () => {
    const res = await supertest(app)
      .post('/api/discount-authorizations')
      .set(auth(MGR_A))
      .send({
        studentId: seedStudent(),
        category: 'SPONSORSHIP',
        approvedPercent: 100,
        reason: 'x',
        approvedBy: 'owner',
        approved_by_user_id: OWNER.userId,
      });
    expect(res.status).toBe(403);
  });

  it('a reason is mandatory for every exception', async () => {
    const res = await supertest(app)
      .post('/api/discount-authorizations')
      .set(auth(MGR_A))
      .send({ studentId: seedStudent(), category: 'COURSE_AMBASSADOR', approvedPercent: 15 });
    expect(res.status).toBe(400);
  });

  it('an unknown category is rejected', async () => {
    const res = await supertest(app)
      .post('/api/discount-authorizations')
      .set(auth(OWNER))
      .send({ studentId: seedStudent(), category: 'FREE_FOR_ALL', approvedPercent: 100, reason: 'x' });
    expect(res.status).toBe(400);
  });

  it('a manager cannot revoke an owner-authority authorization; the owner can', async () => {
    const granted = await supertest(app)
      .post('/api/discount-authorizations')
      .set(auth(OWNER))
      .send({ studentId: seedStudent(), category: 'SPONSORSHIP', approvedPercent: 100, reason: 'x' });
    expect(granted.status).toBe(201);

    const denied = await supertest(app)
      .post(`/api/discount-authorizations/${granted.body.id}/revoke`)
      .set(auth(MGR_A));
    expect(denied.status).toBe(403);

    const allowed = await supertest(app)
      .post(`/api/discount-authorizations/${granted.body.id}/revoke`)
      .set(auth(OWNER));
    expect(allowed.status).toBe(200);

    const row = db
      .prepare('SELECT status FROM student_discount_authorizations WHERE id = ?')
      .get(granted.body.id) as { status: string };
    expect(row.status).toBe('revoked');
  });
});
