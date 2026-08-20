import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { canAccessClass } from '../core/rbac/abac.js';
import { bootstrapRbacCatalog, buildRbacContext, canAccessAllBranches, canAccessBranch, resolveUserPermissions } from '../core/rbac/rbac-service.js';

const BRANCH_A = 'rbac_scope_a';
const BRANCH_B = 'rbac_scope_b';
const BRANCH_C = 'rbac_scope_c';

function seedUser(userId: string, role: string, branchId: string) {
  db.prepare(`
    INSERT OR REPLACE INTO users
      (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
    VALUES (?, ?, ?, ?, ?, 'test-hash', 1, 0)
  `).run(userId, userId, userId, role, branchId);
}

describe('Phase 1 RBAC scope invariants', () => {
  beforeAll(() => {
    initSchema();
    ensureOrganizationHierarchy(db);
    // The roles/permissions tables are only populated by bootstrapRbacCatalog
    // (the same sync the server startup and seed flows run); without it the
    // role lookups below crash on an empty roles table.
    bootstrapRbacCatalog(db);
    db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
      .run('rbac_campus_a', FIXED_ORG_ID, 'RBAC Campus A', 'RBAC-A');
    db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?, ?, ?, ?, 1)')
      .run('rbac_campus_b', FIXED_ORG_ID, 'RBAC Campus B', 'RBAC-B');
    for (const [id, campus] of [[BRANCH_A, 'rbac_campus_a'], [BRANCH_C, 'rbac_campus_a'], [BRANCH_B, 'rbac_campus_b']]) {
      db.prepare('INSERT OR REPLACE INTO branches (id, name, location, campus_id) VALUES (?, ?, ?, ?)')
        .run(id, id, id, campus);
    }

    seedUser('rbac_owner', 'owner', BRANCH_A);
    seedUser('rbac_manager', 'manager', BRANCH_A);
    seedUser('rbac_campus_manager', 'manager', BRANCH_A);

    // Sync legacy assignments, then broaden only the dedicated campus manager.
    const managerRole = db.prepare('SELECT id FROM roles WHERE code = ?').get('general_manager') as { id: string };
    db.prepare('DELETE FROM user_roles WHERE user_id IN (?, ?, ?)').run('rbac_owner', 'rbac_manager', 'rbac_campus_manager');
    db.prepare(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by)
      VALUES (?, ?, ?, 'organization', NULL, 1, 'test')`).run('ur_owner_scope', 'rbac_owner', (db.prepare('SELECT id FROM roles WHERE code = ?').get('owner') as { id: string }).id);
    db.prepare(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by)
      VALUES (?, ?, ?, 'branch', ?, 1, 'test')`).run('ur_manager_scope', 'rbac_manager', managerRole.id, BRANCH_A);
    db.prepare(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by)
      VALUES (?, ?, ?, 'campus', ?, 1, 'test')`).run('ur_campus_scope', 'rbac_campus_manager', managerRole.id, 'rbac_campus_a');

    seedUser('rbac_teacher', 'teacher', BRANCH_A);
    // Authority comes from an assignment and nothing else, so the teacher gets
    // a real one. Previously this user had no user_roles row at all and was
    // carried entirely by the users.role fallback.
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run('rbac_teacher');
    db.prepare(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary, assigned_by)
      VALUES (?, ?, ?, 'branch', ?, 1, 'test')`).run(
        'ur_teacher_scope', 'rbac_teacher',
        (db.prepare('SELECT id FROM roles WHERE code = ?').get('teacher') as { id: string }).id, BRANCH_A);
    db.prepare(`INSERT OR REPLACE INTO teachers
      (id, full_name, branch_id, joined_date, user_id)
      VALUES (?, ?, ?, ?, ?)`).run('rbac_teacher_profile', 'RBAC Teacher', BRANCH_A, '2026-01-01', 'rbac_teacher');
    db.prepare(`INSERT OR REPLACE INTO teachers
      (id, full_name, branch_id, joined_date, user_id)
      VALUES (?, ?, ?, ?, NULL)`).run('rbac_other_teacher', 'Other Teacher', BRANCH_A, '2026-01-01');
    db.prepare('UPDATE users SET linked_teacher_id = ? WHERE id = ?').run('rbac_teacher_profile', 'rbac_teacher');
    db.prepare(`INSERT OR REPLACE INTO classes
      (id, name, teacher_id, level, branch_id)
      VALUES (?, ?, ?, ?, ?)`).run('rbac_class_own', 'Own Class', 'rbac_teacher_profile', '1', BRANCH_A);
    db.prepare(`INSERT OR REPLACE INTO classes
      (id, name, teacher_id, level, branch_id)
      VALUES (?, ?, ?, ?, ?)`).run('rbac_class_other', 'Other Class', 'rbac_other_teacher', '1', BRANCH_A);
  });

  afterAll(() => {
    // Shared singleton DB lifecycle is owned by the Vitest process.
  });

  it('organization scope grants all branches to owner', () => {
    const ctx = buildRbacContext(db, { id: 'rbac_owner', username: 'owner', full_name: 'Owner', role: 'owner', branch_id: BRANCH_A });
    expect(canAccessAllBranches(ctx)).toBe(true);
    expect(canAccessBranch(db, ctx, BRANCH_A)).toBe(true);
    expect(canAccessBranch(db, ctx, BRANCH_B)).toBe(true);
  });

  it('branch scope denies manager cross-branch access', () => {
    const ctx = buildRbacContext(db, { id: 'rbac_manager', username: 'manager', full_name: 'Manager', role: 'manager', branch_id: BRANCH_A });
    expect(canAccessBranch(db, ctx, BRANCH_A)).toBe(true);
    expect(canAccessBranch(db, ctx, BRANCH_B)).toBe(false);
    expect(canAccessAllBranches(ctx)).toBe(false);
  });

  it('campus scope permits branches in the assigned campus only', () => {
    const ctx = buildRbacContext(db, { id: 'rbac_campus_manager', username: 'campus', full_name: 'Campus Manager', role: 'manager', branch_id: BRANCH_A });
    expect(canAccessBranch(db, ctx, BRANCH_A)).toBe(true);
    expect(canAccessBranch(db, ctx, BRANCH_C)).toBe(true);
    expect(canAccessBranch(db, ctx, BRANCH_B)).toBe(false);
  });

  it('teacher own-class scope allows only the assigned class', () => {
    const ctx = buildRbacContext(db, { id: 'rbac_teacher', username: 'teacher', full_name: 'Teacher', role: 'teacher', branch_id: BRANCH_A });
    const req = { user: { userId: 'rbac_teacher', username: 'teacher', fullName: 'Teacher', role: 'teacher', branchId: BRANCH_A }, rbac: ctx } as any;
    expect(canAccessClass(req, 'rbac_class_own')).toBe(true);
    expect(canAccessClass(req, 'rbac_class_other')).toBe(false);
  });

  it('manager class access follows branch scope instead of the manager role name', () => {
    const ctx = buildRbacContext(db, { id: 'rbac_manager', username: 'manager', full_name: 'Manager', role: 'manager', branch_id: BRANCH_A });
    const req = { user: { userId: 'rbac_manager', username: 'manager', fullName: 'Manager', role: 'manager', branchId: BRANCH_A }, rbac: ctx } as any;
    expect(canAccessClass(req, 'rbac_class_own')).toBe(true);
  });

  it('preserves permission scopes without collapsing all grants into a role name', () => {
    const perms = resolveUserPermissions(db, 'rbac_campus_manager');
    expect(perms.some((p) => p.code === 'Class.View')).toBe(true);
  });
});
