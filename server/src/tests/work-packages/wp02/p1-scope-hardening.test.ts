/**
 * Phase 2 P1 Scope Hardening
 *
 * Regression coverage for branch/campus/global configuration boundaries that
 * are not covered by the P0 isolation suite.
 */
import { assignRole } from '../../support/identity.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { db, initSchema } from '../../../db/connection.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { signToken, hashPassword, type TokenPayload } from '../../../utils/auth.js';
import { id } from '../../../utils/ids.js';
import { academicRouter } from '../../../routes/academic.routes.js';
import { campusesRouter, branchesRouter, partnersRouter } from '../../../routes/branches.routes.js';
import { automationsRouter } from '../../../routes/automations.routes.js';
import { workflowsRouter } from '../../../routes/workflows.routes.js';
import { rulesRouter } from '../../../routes/rules.routes.js';
import { eventsRouter } from '../../../routes/events.routes.js';
import { bosRouter } from '../../../routes/bos.routes.js';
import { setSetting } from '../../../utils/settings.js';
import { errorHandler } from '../../../middleware/errorHandler.js';

const A = 'p1_branch_a';
const B = 'p1_branch_b';
const CAMPUS_A = 'p1_campus_a';
const CAMPUS_B = 'p1_campus_b';
const ORG = 'org_toefl_house';

function token(userId: string, role: string, branchId: string): TokenPayload {
  return { userId, username: userId, branchId, fullName: role === 'owner' ? 'P1 Owner' : 'P1 Manager' };
}

function auth(user: TokenPayload) {
  return { Authorization: `Bearer ${signToken(user)}` };
}

async function seedUser(userId: string, role: string, branchId: string) {
  db.prepare(`INSERT OR IGNORE INTO users
    ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
    VALUES (?, ?, ?, ?, ?, 1, 0)`)
    .run(userId, userId, role === 'owner' ? 'P1 Owner' : 'P1 Manager', branchId, await hashPassword('p1-test-password'));
  assignRole(userId, role, branchId);
}

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/academic', academicRouter);
  instance.use('/api/campuses', campusesRouter);
  instance.use('/api/branches', branchesRouter);
  instance.use('/api/partners', partnersRouter);
  instance.use('/api/automations', automationsRouter);
  instance.use('/api/workflows', workflowsRouter);
  instance.use('/api/rules', rulesRouter);
  instance.use('/api/events', eventsRouter);
  instance.use('/api/bos', bosRouter);
  instance.use(errorHandler);
  return instance;
}

describe('Phase 2 P1 — scope hardening', () => {
  const manager = token('p1_manager', 'manager', A);
  const owner = token('p1_owner', 'owner', A);
  let http: ReturnType<typeof supertest>;

  beforeAll(async () => {
    initSchema();
    bootstrapRbacCatalog(db);

    db.prepare(`INSERT OR IGNORE INTO campuses
      (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)`)
      .run(CAMPUS_A, ORG, 'P1 Campus A', 'P1-A');
    db.prepare(`INSERT OR IGNORE INTO campuses
      (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)`)
      .run(CAMPUS_B, ORG, 'P1 Campus B', 'P1-B');
    db.prepare(`INSERT OR IGNORE INTO branches
      (id, campus_id, name, location, address, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
      .run(A, CAMPUS_A, 'P1 Branch A', 'A', 'A');
    db.prepare(`INSERT OR IGNORE INTO branches
      (id, campus_id, name, location, address, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
      .run(B, CAMPUS_B, 'P1 Branch B', 'B', 'B');

    await seedUser('p1_manager', 'manager', A);
    await seedUser('p1_owner', 'owner', A);

    const programA = 'p1_program_a';
    const programB = 'p1_program_b';
    db.prepare(`INSERT OR IGNORE INTO programs
      (id, name, duration_months, branch_id, code, is_active)
      VALUES (?, ?, 6, ?, ?, 1)`)
      .run(programA, 'Program A', A, 'P1-A');
    db.prepare(`INSERT OR IGNORE INTO programs
      (id, name, duration_months, branch_id, code, is_active)
      VALUES (?, ?, 6, ?, ?, 1)`)
      .run(programB, 'Program B', B, 'P1-B');

    http = supertest(app());
  });

  afterAll(() => {
    // Shared singleton DB lifecycle is owned by the Vitest process.
  });

  it('manager cannot read another branch academic programs', async () => {
    const res = await http.get('/api/academic/programs').set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.every((p: any) => p.branchId === A)).toBe(true);
  });

  it('manager cannot update another branch academic program', async () => {
    const res = await http.put('/api/academic/programs/p1_program_b')
      .set(auth(manager))
      .send({ name: 'ATTACKED' });
    expect(res.status).toBe(403);
  });

  it('manager cannot create a time slot for another branch', async () => {
    const res = await http.post('/api/academic/time-slots')
      .set(auth(manager))
      .send({ branchId: B, code: 'ATTACK', label: 'Attack', startTime: '08:00', endTime: '09:00' });
    expect(res.status).toBe(403);
  });

  it('manager cannot administer a global campus hierarchy', async () => {
    const res = await http.post('/api/campuses')
      .set(auth(manager))
      .send({ name: 'Unauthorized Campus', code: 'BAD-CAMPUS' });
    expect(res.status).toBe(403);
  });

  it('manager cannot mutate global automation definitions', async () => {
    const res = await http.post('/api/automations')
      .set(auth(manager))
      .send({ name: 'Unauthorized', trigger: 'student.created', conditions: [], actions: [{ type: 'notify', config: { message: 'x' } }] });
    expect(res.status).toBe(403);
  });

  it('manager cannot mutate global workflow definitions', async () => {
    const res = await http.post('/api/workflows/definitions')
      .set(auth(manager))
      .send({ name: 'Unauthorized', trigger: 'student.created', steps: [] });
    expect(res.status).toBe(403);
  });


  it('manager cannot read another branch rule by id or evaluate it', async () => {
    db.prepare(`INSERT OR REPLACE INTO rule_definitions
      (id, name, description, category, conditions, actions, priority, is_active, scope_branch_id, version, last_modified_by)
      VALUES (?, ?, '', 'fee', '[]', ?, 1, 1, ?, 1, 'p1')`)
      .run('p1_rule_b', 'Branch B rule', '[{"type":"set","key":"fee","value":999}]', B);

    const detail = await http.get('/api/rules/p1_rule_b').set(auth(manager));
    expect(detail.status).toBe(403);

    const evaluation = await http.post('/api/rules/evaluate')
      .set(auth(manager))
      .send({ category: 'fee', branchId: B, data: {} });
    expect(evaluation.status).toBe(403);
  });

  it('manager cannot request another branch event statistics or stream', async () => {
    db.prepare(`INSERT OR REPLACE INTO domain_events
      (id, type, aggregate_type, aggregate_id, payload, occurred_at, operator_id, branch_id, correlation_id, schema_version, published)
      VALUES (?, 'student.registered', 'student', ?, '{}', datetime('now'), ?, ?, ?, 1, 1)`)
      .run('p1_event_b', 'p1_student_b', 'p1_manager', B, 'p1_corr_b');

    const stream = await http.get('/api/events/stream').query({ branchId: B }).set(auth(manager));
    expect(stream.status).toBe(403);

    const stats = await http.get('/api/events/stats').query({ branchId: B }).set(auth(manager));
    expect(stats.status).toBe(403);
  });

  it('manager cannot withdraw from the organization-wide main account', async () => {
    setSetting('main_account_balance', '1000000');
    setSetting('saving_balance', '1000000');
    const res = await http.post('/api/bos/profit-distribution/withdraw')
      .set(auth(manager))
      .send({ amount: 100 });
    expect(res.status).toBe(403);
  });

  it('owner retains global campus and configuration administration', async () => {
    const campus = await http.post('/api/campuses')
      .set(auth(owner))
      .send({ name: 'Owner Campus', code: `OWNER-${id('x').slice(-6)}` });
    expect(campus.status).toBe(201);
  });
});
