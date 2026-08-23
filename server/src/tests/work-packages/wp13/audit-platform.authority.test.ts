import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { db, initSchema } from '../../../db/connection.js';
import { bootstrapRbacCatalog } from '../../../core/rbac/rbac-service.js';
import { errorHandler } from '../../../middleware/errorHandler.js';
import { auditRouter } from '../../../routes/audit.routes.js';
import { bearerFor, seedUser } from '../../support/identity.js';

const BR_A = 'wp13_a';
const BR_B = 'wp13_b';
const OWNER = 'wp13_owner';
const AUDITOR = 'wp13_audit_viewer';
const FINANCE = 'wp13_finance_only';

let app: express.Express;

function createApp() {
  const next = express();
  next.use(express.json());
  next.use('/api/audit-logs', auditRouter);
  next.use(errorHandler);
  return next;
}

function addCustomRole(code: string, permissionCodes: string[]): string {
  const roleId = `role_${code}`;
  db.prepare(
    `INSERT OR IGNORE INTO roles (id, code, name, is_system, is_active)
     VALUES (?, ?, ?, 0, 1)`,
  ).run(roleId, code, code);
  for (const permissionCode of permissionCodes) {
    const permission = db.prepare('SELECT id FROM permissions WHERE code = ?').get(permissionCode) as { id: string };
    db.prepare(
      `INSERT OR IGNORE INTO role_permissions (id, role_id, permission_id, default_scope)
       VALUES (?, ?, ?, 'branch')`,
    ).run(randomUUID(), roleId, permission.id);
  }
  return roleId;
}

function assignRoleId(userId: string, roleId: string, branchId: string): void {
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
  db.prepare(
    `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by)
     VALUES (?, ?, ?, 'branch', ?, 1, 'wp13-fixture')`,
  ).run(randomUUID(), userId, roleId, branchId);
}

function seedAuditFixtures() {
  db.prepare(
    `INSERT INTO audit_logs
      (id, operator_id, operator_name, operator_role, action, date, time, old_value, new_value, ip, device, branch_id)
     VALUES
      ('wp13_log_a', ?, 'Audit Owner', 'owner', 'Changed 100% discount cap', '2026-08-22', '10:00:00', '{"before":10}', '{"after":15}', '10.0.0.1', 'Chrome', ?),
      ('wp13_log_b', ?, 'Audit Owner', 'owner', 'Changed 1000 discount cap', '2026-08-21', '09:00:00', '{"before":15}', '{"after":20}', '10.0.0.2', 'Firefox', ?)
    `,
  ).run(OWNER, BR_A, OWNER, BR_B);

  db.prepare(
    `INSERT INTO audit_failures
      (id, occurred_at, request_id, operator_id, branch_id, action, error, payload)
     VALUES
      ('wp13_fail_a', '2026-08-22T10:15:00Z', 'req-a', ?, ?, 'Changed 100% discount cap', 'UNIQUE constraint failed: audit_logs.id', '{"id":"wp13_log_a"}'),
      ('wp13_fail_b', '2026-08-21T09:15:00Z', 'req-b', ?, ?, 'Cross-branch reconciliation', 'write timeout 100%', '{"branch":"wp13_b"}')
    `,
  ).run(OWNER, BR_A, OWNER, BR_B);
}

beforeAll(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  db.prepare("INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'Kabul')").run(BR_A, 'WP13 A');
  db.prepare("INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, 'Kabul')").run(BR_B, 'WP13 B');

  seedUser({ id: OWNER, role: 'owner', branchId: BR_A });
  seedUser({ id: FINANCE, role: 'finance_manager', branchId: BR_A });
  seedUser({ id: AUDITOR, role: 'receptionist', branchId: BR_A });

  const roleId = addCustomRole('wp13_audit_observer', ['Audit.View']);
  assignRoleId(AUDITOR, roleId, BR_A);

  app = createApp();
});

beforeEach(() => {
  db.prepare('DELETE FROM audit_logs').run();
  db.prepare('DELETE FROM audit_failures').run();
  seedAuditFixtures();
});

describe('WP-13 audit visibility is permission-driven and scoped by authorized branch reach', () => {
  it('admits a custom role that holds Audit.View and refuses a finance role without that permission', async () => {
    const allowed = await supertest(app).get('/api/audit-logs').set(bearerFor(AUDITOR));
    expect(allowed.status).toBe(200);
    expect(allowed.body.total).toBe(1);
    expect(allowed.body.rows.map((row: { id: string }) => row.id)).toEqual(['wp13_log_a']);
    expect(allowed.body.rows[0]).toMatchObject({
      operator_name: 'Audit Owner',
      branch_id: BR_A,
      old_value: '{"before":10}',
      new_value: '{"after":15}',
    });

    const denied = await supertest(app).get('/api/audit-logs').set(bearerFor(FINANCE));
    expect(denied.status).toBe(403);
    expect(denied.body.required).toEqual(['Audit.View']);
  });

  it('treats % and _ in filters as literals so an operator can find the exact event they typed', async () => {
    const res = await supertest(app)
      .get('/api/audit-logs')
      .query({ branchId: 'all', action: '100%' })
      .set(bearerFor(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows.map((row: { id: string }) => row.id)).toEqual(['wp13_log_a']);
  });

  it('surfaces audit write failures through the same permission and branch-scope authority', async () => {
    const scoped = await supertest(app).get('/api/audit-logs/failures').set(bearerFor(AUDITOR));
    expect(scoped.status).toBe(200);
    expect(scoped.body.total).toBe(1);
    expect(scoped.body.rows).toEqual([
      expect.objectContaining({
        id: 'wp13_fail_a',
        branch_id: BR_A,
        request_id: 'req-a',
        action: 'Changed 100% discount cap',
      }),
    ]);

    const aggregate = await supertest(app)
      .get('/api/audit-logs/failures')
      .query({ branchId: 'all', error: '100%' })
      .set(bearerFor(OWNER));
    expect(aggregate.status).toBe(200);
    expect(aggregate.body.total).toBe(1);
    expect(aggregate.body.rows[0]).toMatchObject({ id: 'wp13_fail_b', branch_id: BR_B, request_id: 'req-b' });
  });
});
