/**
Integration test: Branch Scoping (Audit §6.3)
Verifies that resolveBranchScope locks branch-scoped users and only permits cross-branch access through explicit RBAC scope.
*/
import { assignRole } from './support/identity.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolveBranchScope } from '../middleware/auth.js';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { bootstrapRbacCatalog } from '../core/rbac/rbac-service.js';

/**
 * Each principal below is a real user holding a real assignment, because that
 * is the only thing that grants scope. Fabricating a `role` string on the
 * request object proves nothing about authorization.
 */
const PRINCIPALS: Record<string, { roleCode: string; scopeType: string; scopeId: string | null }> = {
  registrar: { roleCode: 'receptionist', scopeType: 'branch', scopeId: 'b1' },
  teacher: { roleCode: 'teacher', scopeType: 'branch', scopeId: 'b1' },
  owner: { roleCode: 'owner', scopeType: 'organization', scopeId: null },
  manager: { roleCode: 'general_manager', scopeType: 'branch', scopeId: 'b1' },
  finance: { roleCode: 'finance_manager', scopeType: 'branch', scopeId: 'b1' },
};

const userIdFor = (role: string) => `bs_${role}`;

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  bootstrapRbacCatalog(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
    .run('bs_campus', FIXED_ORG_ID, 'BS Campus', 'BSC');
  for (const b of ['b1', 'b2']) {
    db.prepare('INSERT OR REPLACE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
      .run(b, b, 'Kabul', 'bs_campus');
  }
  for (const [role, grant] of Object.entries(PRINCIPALS)) {
    const id = userIdFor(role);
    db.prepare(
      `INSERT OR REPLACE INTO users ( id, username, full_name, branch_id, password_hash, is_active, must_change_password )
       VALUES (?, ?, ?, 'b1', 'test-hash', 1, 0)`,
    ).run(id, id, id);
    assignRole(id, role, 'b1');
    const roleRow = db.prepare('SELECT id FROM roles WHERE code = ?').get(grant.roleCode) as { id: string };
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
    db.prepare(
      `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by)
       VALUES (?, ?, ?, ?, ?, 1, 'test')`,
    ).run(randomUUID(), id, roleRow.id, grant.scopeType, grant.scopeId);
  }
});

function mockReq(role: string, branchId: string, queryBranchId?: string) {
  return {
    user: {
      userId: userIdFor(role),
      username: userIdFor(role),
      branchId,
      fullName: 'Test User',
    },
    query: queryBranchId ? { branchId: queryBranchId } : {},
  } as any;
}

describe('Branch Scoping', () => {
  it('locks registrar to their own branch regardless of query param', () => {
    const scope = resolveBranchScope(mockReq('registrar', 'b1', 'b2'));
    expect(scope.branchId).toBe('b1');
    expect(scope.isAll).toBe(false);
  });

  it('locks teacher to their own branch regardless of query param', () => {
    const scope = resolveBranchScope(mockReq('teacher', 'b1', 'b2'));
    expect(scope.branchId).toBe('b1');
    expect(scope.isAll).toBe(false);
  });

  it('allows owner to request all branches', () => {
    const scope = resolveBranchScope(mockReq('owner', 'b1', 'all'));
    expect(scope.branchId).toBeNull();
    expect(scope.isAll).toBe(true);
  });

  it('denies a branch-scoped manager from requesting another branch', () => {
    const scope = resolveBranchScope(mockReq('manager', 'b1', 'b2'));
    expect(scope.branchId).toBe('b1');
    expect(scope.isAll).toBe(false);
  });

  it('defaults to user branch when no query param is provided', () => {
    const scope = resolveBranchScope(mockReq('finance', 'b1'));
    expect(scope.branchId).toBe('b1');
    expect(scope.isAll).toBe(false);
  });

  it('does not allow registrar to request all branches', () => {
    const scope = resolveBranchScope(mockReq('registrar', 'b1', 'all'));
    expect(scope.branchId).toBe('b1');
    expect(scope.isAll).toBe(false);
  });
});