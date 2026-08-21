import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { seedUser, bearerFor } from '../../support/identity.js';
import {
  organizationRouter,
  campusesRouter,
  branchesRouter,
  partnersRouter,
} from '../../../routes/branches.routes.js';
import { systemSettingsRouter } from '../../../routes/settings.routes.js';
import { rulesRouter } from '../../../routes/rules.routes.js';
import { catalogRouter } from '../../../routes/catalog.routes.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { resolveBranchScope } from '../../../middleware/auth.js';

const CAMPUS_A = 'wp01_auth_campus_a';
const CAMPUS_B = 'wp01_auth_campus_b';
const EMPTY_CAMPUS = 'wp01_auth_empty_campus';
const BRANCH_A = 'wp01_auth_branch_a';
const BRANCH_A2 = 'wp01_auth_branch_a2';
const BRANCH_B = 'wp01_auth_branch_b';
const PROGRAM_A = 'wp01_auth_program_a';
const PROGRAM_B = 'wp01_auth_program_b';
const VERSION_A = 'wp01_auth_version_a';
const VERSION_B = 'wp01_auth_version_b';

const GLOBAL_OWNER = 'wp01_auth_global_owner';
const SCOPED_OWNER = 'wp01_auth_scoped_owner';
const MANAGER_A = 'wp01_auth_manager_a';
const CAMPUS_MANAGER = 'wp01_auth_campus_manager';
const EMPTY_CAMPUS_MANAGER = 'wp01_auth_empty_campus_manager';
const MISALIGNED = 'wp01_auth_misaligned';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/organization', organizationRouter);
  app.use('/api/campuses', campusesRouter);
  app.use('/api/branches', branchesRouter);
  app.use('/api/partners', partnersRouter);
  app.use('/api/settings', systemSettingsRouter);
  app.use('/api/rules', rulesRouter);
  app.use('/api/catalog', catalogRouter);
  app.use(errorHandler);
  return app;
}

let http: ReturnType<typeof supertest>;

beforeAll(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  for (const [id, code] of [[CAMPUS_A, 'WP01-AA'], [CAMPUS_B, 'WP01-AB'], [EMPTY_CAMPUS, 'WP01-EMPTY']]) {
    db.prepare(
      `INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active)
       VALUES (?, 'org_toefl_house', ?, ?, 1)`,
    ).run(id, id, code);
  }
  for (const [id, campus] of [[BRANCH_A, CAMPUS_A], [BRANCH_A2, CAMPUS_A], [BRANCH_B, CAMPUS_B]]) {
    db.prepare(
      `INSERT OR IGNORE INTO branches (id, campus_id, name, code, location, is_active)
       VALUES (?, ?, ?, ?, 'Kabul', 1)`,
    ).run(id, campus, id, `CODE-${id}`);
  }

  seedUser({ id: GLOBAL_OWNER, role: 'owner', branchId: BRANCH_A });
  seedUser({ id: SCOPED_OWNER, role: 'owner', branchId: BRANCH_A, scopeType: 'branch', scopeId: BRANCH_A });
  seedUser({ id: MANAGER_A, role: 'general_manager', branchId: BRANCH_A });
  seedUser({ id: CAMPUS_MANAGER, role: 'general_manager', branchId: BRANCH_A, scopeType: 'campus', scopeId: CAMPUS_A });
  seedUser({ id: EMPTY_CAMPUS_MANAGER, role: 'general_manager', branchId: BRANCH_A, scopeType: 'campus', scopeId: EMPTY_CAMPUS });
  seedUser({ id: MISALIGNED, role: 'general_manager', branchId: BRANCH_A, scopeType: 'branch', scopeId: BRANCH_B });

  for (const [programId, versionId, branchId] of [
    [PROGRAM_A, VERSION_A, BRANCH_A],
    [PROGRAM_B, VERSION_B, BRANCH_B],
  ]) {
    db.prepare('INSERT OR IGNORE INTO programs (id, name, branch_id) VALUES (?, ?, ?)')
      .run(programId, programId, branchId);
    db.prepare(
      `INSERT OR IGNORE INTO program_versions (id, program_id, version_label, version_number, status)
       VALUES (?, ?, 'v1', 1, 'draft')`,
    ).run(versionId, programId);
  }

  db.prepare(
    `INSERT OR REPLACE INTO rule_definitions
       (id, name, category, conditions, actions, scope_branch_id, version, last_modified_by)
     VALUES ('wp01_auth_global_rule', 'Global rule', 'discount', '[]',
             '[{"type":"warn","targetKey":"warning","message":"global"}]', NULL, 1, 'test')`,
  ).run();
  db.prepare(
    `INSERT OR REPLACE INTO rule_definitions
       (id, name, category, conditions, actions, scope_branch_id, version, last_modified_by)
     VALUES ('wp01_auth_rule_b', 'Branch B rule', 'discount', '[]',
             '[{"type":"warn","targetKey":"warning","message":"b"}]', ?, 1, 'test')`,
  ).run(BRANCH_B);
  db.prepare(
    `INSERT OR REPLACE INTO class_generation_runs
       (id, branch_id, program_version_id, status, params_json)
     VALUES ('wp01_auth_run_b', ?, ?, 'draft', '{}')`,
  ).run(BRANCH_B, VERSION_B);

  http = supertest(makeApp());
});

const as = (userId: string) => bearerFor(userId);

describe('WP-01 organization-global authority', () => {
  it.each([
    ['post', '/api/campuses', { name: 'Escalated', code: 'WP01-BAD' }],
    ['post', '/api/partners', { fullName: 'Escalated', sharePercent: 10 }],
  ] as const)('a branch-scoped owner is denied %s %s', async (method, path, body) => {
    const response = await (http as any)[method](path).set(as(SCOPED_OWNER)).send(body);
    expect(response.status).toBe(403);
  });

  it('a branch-scoped owner cannot read organization-global system settings', async () => {
    expect((await http.get('/api/settings/system').set(as(SCOPED_OWNER))).status).toBe(403);
    expect((await http.get('/api/settings/system').set(as(GLOBAL_OWNER))).status).toBe(200);
  });

  it('labels and returns cash for the branch explicitly selected by the organization owner', async () => {
    db.prepare(
      `INSERT INTO finance_accounts (id, scope_type, scope_id, main_balance, saving_balance)
       VALUES (?, 'branch', ?, 41, 9)
       ON CONFLICT(scope_type, scope_id) DO UPDATE SET main_balance = 41, saving_balance = 9`,
    ).run(`branch:${BRANCH_B}`, BRANCH_B);
    const response = await http.get(`/api/settings/system?branchId=${BRANCH_B}`).set(as(GLOBAL_OWNER));
    expect(response.status).toBe(200);
    expect(response.body.finance).toMatchObject({ branchId: BRANCH_B, mainAccountBalance: 41, savingBalance: 9 });
  });

  it('a branch-scoped owner cannot delete another branch', async () => {
    const before = db.prepare('SELECT is_active FROM branches WHERE id = ?').get(BRANCH_B);
    const response = await http.delete(`/api/branches/${BRANCH_B}`).set(as(SCOPED_OWNER));
    expect(response.status).toBe(403);
    expect(db.prepare('SELECT is_active FROM branches WHERE id = ?').get(BRANCH_B)).toEqual(before);
  });

  it('does not treat an unauthorized identity home branch as fallback authority', () => {
    const request = (query: Record<string, string>) => ({
      user: { userId: MISALIGNED, username: MISALIGNED, fullName: MISALIGNED, branchId: BRANCH_A },
      query,
    } as any);
    expect(() => resolveBranchScope(request({}))).toThrow(/No authorized branch scope/i);
    expect(resolveBranchScope(request({ branchId: BRANCH_B }))).toEqual({ branchId: BRANCH_B, isAll: false });
  });

  it('organization counts expose only the caller-authorized topology', async () => {
    const limited = await http.get('/api/organization').set(as(MANAGER_A));
    expect(limited.status).toBe(200);
    expect(limited.body).toMatchObject({ campusCount: 1, branchCount: 1 });

    const global = await http.get('/api/organization').set(as(GLOBAL_OWNER));
    expect(global.status).toBe(200);
    expect(global.body.branchCount).toBeGreaterThan(limited.body.branchCount);
  });

  it('recognizes a direct campus assignment even before that campus has a branch', async () => {
    const organization = await http.get('/api/organization').set(as(EMPTY_CAMPUS_MANAGER));
    expect(organization.status).toBe(200);
    expect(organization.body).toMatchObject({ campusCount: 1, branchCount: 0 });

    const campuses = await http.get('/api/campuses').set(as(EMPTY_CAMPUS_MANAGER));
    expect(campuses.status).toBe(200);
    expect(campuses.body.map((row: any) => row.id)).toEqual([EMPTY_CAMPUS]);

    const created = await http.post('/api/branches').set(as(EMPTY_CAMPUS_MANAGER)).send({
      name: 'First empty-campus branch', code: 'WP01-FIRST', campusId: EMPTY_CAMPUS, address: 'Kabul',
    });
    expect(created.status).toBe(201);
    expect(created.body.campusId).toBe(EMPTY_CAMPUS);
  });
});

describe('WP-01 generic-rule scope follows assignments, not role names or home branch', () => {
  const validRule = {
    name: 'Scoped warning', category: 'discount', conditions: [],
    actions: [{ type: 'warn', targetKey: 'warning', message: 'test' }],
  };

  it('a campus-scoped manager can target another branch in the assigned campus', async () => {
    const response = await http.post('/api/rules').set(as(CAMPUS_MANAGER))
      .send({ ...validRule, scopeBranchId: BRANCH_A2 });
    expect(response.status).toBe(201);
    expect(response.body.scopeBranchId).toBe(BRANCH_A2);
  });

  it('a non-global writer cannot create or mutate a global rule', async () => {
    const created = await http.post('/api/rules').set(as(SCOPED_OWNER)).send(validRule);
    expect(created.status).toBe(201);
    expect(created.body.scopeBranchId).toBe(BRANCH_A);

    const patch = await http.patch('/api/rules/wp01_auth_global_rule').set(as(SCOPED_OWNER))
      .send({ priority: 9 });
    expect(patch.status).toBe(403);
  });

  it('a scoped writer cannot read or mutate another branch rule', async () => {
    expect((await http.get('/api/rules/wp01_auth_rule_b').set(as(MANAGER_A))).status).toBe(403);
    expect((await http.patch('/api/rules/wp01_auth_rule_b').set(as(MANAGER_A)).send({ priority: 4 })).status).toBe(403);
  });

  it('an organization owner can create a global rule', async () => {
    const response = await http.post('/api/rules').set(as(GLOBAL_OWNER)).send({ ...validRule, name: 'Owner global' });
    expect(response.status).toBe(201);
    expect(response.body.scopeBranchId).toBeNull();
  });

  it.each([
    [{ category: 'discount', data: {}, branchId: 7 }, 'non-text branch'],
    [{ category: 'discount', data: {}, dryRun: 'false' }, 'non-boolean dry-run flag'],
  ])('rejects %s evaluation input instead of silently substituting scope or mode', async (payload, _label) => {
    const response = await http.post('/api/rules/evaluate').set(as(MANAGER_A)).send(payload);
    expect(response.status).toBe(400);
  });
});

describe('WP-01 catalog identifiers cannot bypass branch scope', () => {
  it('filters version collections and denies another branch detail', async () => {
    const list = await http.get('/api/catalog/program-versions').set(as(MANAGER_A));
    expect(list.status).toBe(200);
    expect(list.body.map((row: any) => row.id)).toContain(VERSION_A);
    expect(list.body.map((row: any) => row.id)).not.toContain(VERSION_B);
    expect((await http.get(`/api/catalog/program-versions/${VERSION_B}`).set(as(MANAGER_A))).status).toBe(403);
  });

  it('denies creating or publishing another branch program version', async () => {
    const create = await http.post('/api/catalog/program-versions').set(as(MANAGER_A))
      .send({ programId: PROGRAM_B, versionLabel: 'attack' });
    expect(create.status).toBe(403);
    const publish = await http.post(`/api/catalog/program-versions/${VERSION_B}/publish`).set(as(MANAGER_A));
    expect(publish.status).toBe(403);
  });

  it('denies cross-branch promotion, fee and class-generation access', async () => {
    const promotion = await http.post('/api/catalog/promotion-rules').set(as(MANAGER_A))
      .send({ programVersionId: VERSION_A, name: 'Attack', branchId: BRANCH_B });
    expect(promotion.status).toBe(403);

    const fee = await http.post('/api/catalog/fees/snapshot').set(as(MANAGER_A))
      .send({ branchId: BRANCH_B });
    expect(fee.status).toBe(403);

    expect((await http.get('/api/catalog/class-generation/wp01_auth_run_b').set(as(MANAGER_A))).status).toBe(403);
    expect((await http.post('/api/catalog/class-generation/wp01_auth_run_b/publish').set(as(MANAGER_A))).status).toBe(403);
  });

  it('rejects a promotion-rule branch that differs from its version even when both are authorized', async () => {
    const response = await http.post('/api/catalog/promotion-rules').set(as(CAMPUS_MANAGER)).send({
      programVersionId: VERSION_A,
      name: 'Authorized branches must still agree',
      branchId: BRANCH_A2,
    });
    expect(response.status).toBe(400);
    expect(db.prepare("SELECT id FROM promotion_rules WHERE name = 'Authorized branches must still agree'").get()).toBeUndefined();
  });

  it('derives an omitted promotion-rule branch from the version, not identity home', async () => {
    const response = await http.post('/api/catalog/promotion-rules').set(as(MISALIGNED)).send({
      programVersionId: VERSION_B,
      name: 'Version-derived branch',
    });
    expect(response.status).toBe(201);
    expect(db.prepare('SELECT branch_id FROM promotion_rules WHERE id = ?').get(response.body.id))
      .toEqual({ branch_id: BRANCH_B });
  });
});
