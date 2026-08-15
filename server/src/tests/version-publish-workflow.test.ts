/**
 * Program-version publish workflow — regression suite
 * ============================================================================
 * Locks in the publish flow the user reported as broken ("stays draft, warns
 * setPlacementProfile is not a function"). The backend publish is verified
 * end-to-end: draft -> published + is_default=1, and the placement profile
 * endpoint (which the frontend tree loads after publish) returns 200 with a
 * valid payload. The frontend bug (state destructure binding the value to
 * setPlacementProfile) is guarded by typecheck/build; this suite guards the
 * API contract it depends on.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../db/connection.js';
import { signToken, hashPassword, type TokenPayload } from '../utils/auth.js';
import { bootstrapRbacCatalog, syncLegacyUserRoles } from '../core/rbac/rbac-service.js';
import { academicRouter } from '../routes/academic.routes.js';
import { catalogRouter } from '../routes/catalog.routes.js';
import { errorHandler } from '../middleware/errorHandler.js';

const BRANCH = 'publish_regression_branch';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/academic', academicRouter);
  app.use('/api/catalog', catalogRouter);
  app.use(errorHandler);
  return app;
}

function makeUser(overrides: Partial<TokenPayload> & { userId: string }): TokenPayload {
  return {
    userId: overrides.userId, username: overrides.username || overrides.userId,
    role: overrides.role || 'owner', branchId: overrides.branchId || BRANCH, fullName: 'Publish Test User',
  };
}
function authHeader(user: TokenPayload): { Authorization: string } {
  return { Authorization: `Bearer ${signToken(user)}` };
}

let app: express.Express;
let owner: TokenPayload;

beforeAll(async () => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(BRANCH, 'Publish Branch', 'Loc');
  await db.prepare(`INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password) VALUES (?, ?, ?, 'owner', ?, ?, 1, 0)`)
    .run('u_pub_owner', 'pub_owner', 'Publish Owner', BRANCH, await hashPassword('x'));
  syncLegacyUserRoles(db);
  owner = makeUser({ userId: 'u_pub_owner', role: 'owner', branchId: BRANCH });
  app = createApp();
});

describe('Program version publish workflow', () => {
  it('creates a version (draft), publishes it (published + default), and serves its placement profile', async () => {
    const prog = await supertest(app).post('/api/academic/programs').set(authHeader(owner)).send({
      name: 'Publish Program', code: 'PUBR', durationMonths: 6, branchId: BRANCH,
    });
    expect(prog.status).toBe(201);
    const programId = prog.body.id;

    const created = await supertest(app).post('/api/catalog/program-versions').set(authHeader(owner)).send({
      programId, versionLabel: 'v1',
    });
    expect(created.status).toBe(201);
    const versionId = created.body.version.id;
    expect(created.body.version.status).toBe('draft');

    const published = await supertest(app).post(`/api/catalog/program-versions/${versionId}/publish`).set(authHeader(owner)).send({});
    expect(published.status).toBe(200);
    expect(published.body.version.status).toBe('published');
    expect(published.body.version.is_default).toBe(1);

    const fetched = await supertest(app).get(`/api/catalog/program-versions/${versionId}`).set(authHeader(owner));
    expect(fetched.status).toBe(200);
    expect(fetched.body.version.status).toBe('published');

    const profile = await supertest(app).get(`/api/academic/program-versions/${versionId}/placement-profile`).set(authHeader(owner));
    expect(profile.status).toBe(200);
    expect(profile.body).toHaveProperty('configured');
    expect(Array.isArray(profile.body.components)).toBe(true);
    expect(profile.body.components.length).toBeGreaterThan(0);
  });

  it('publishing again is idempotent (no error, stays published)', async () => {
    const prog = await supertest(app).post('/api/academic/programs').set(authHeader(owner)).send({
      name: 'Publish Program 2', code: 'PUBR2', durationMonths: 6, branchId: BRANCH,
    });
    const created = await supertest(app).post('/api/catalog/program-versions').set(authHeader(owner)).send({
      programId: prog.body.id, versionLabel: 'v1',
    });
    const versionId = created.body.version.id;
    await supertest(app).post(`/api/catalog/program-versions/${versionId}/publish`).set(authHeader(owner)).send({});
    const again = await supertest(app).post(`/api/catalog/program-versions/${versionId}/publish`).set(authHeader(owner)).send({});
    expect(again.status).toBe(200);
    expect(again.body.version.status).toBe('published');
  });
});
