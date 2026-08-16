/**
 * A scoped owner grant must not become a global owner.
 * ============================================================================
 * F-5 HIGH (proven live, 2026-08-16 second audit pass):
 *
 *   Granting the `owner` role scoped to ONE campus produced a FULL superuser.
 *   A user holding owner@campus_kbl read students and finance belonging to a
 *   DIFFERENT campus, because every superuser short-circuit in the codebase
 *   called `hasRole(ctx, 'owner')`, which ignores scope entirely:
 *
 *     canAccessBranch()      if (hasRole(ctx,'owner')) return true;
 *     canAccessAllBranches() hasRole(ctx,'owner') || ...
 *     authorize()            if (hasRole(req.rbac,'owner')) return next();
 *     requirePermission()    if (hasRole(req.rbac,'owner')) return next();
 *     + bos / branches / events route guards
 *
 *   Scoping the grant did nothing at all — the scope column was written and
 *   then never consulted for owners.
 *
 * The owner model itself is intentional and documented. What must hold is that
 * ONLY an organization-scoped owner is global. Both the seeded owner and the
 * legacy-role fallback are organization-scoped, so this preserves every
 * legitimate owner.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initSchema } from '../db/connection.js';
import {
  bootstrapRbacCatalog, buildRbacContext, isGlobalOwner,
  canAccessBranch, canAccessAllBranches,
} from '../core/rbac/rbac-service.js';

const CAMPUS_A = 'campus_scope_a';
const CAMPUS_B = 'campus_scope_b';
const BRANCH_A = 'branch_scope_a';
const BRANCH_B = 'branch_scope_b';

/** Builds an RBAC context for a user carrying exactly one role grant. */
function ctxWithRole(userId: string, roleCode: string, scopeType: string, scopeId: string | null) {
  const role = db.prepare('SELECT id FROM roles WHERE code = ?').get(roleCode) as { id: string };
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
  db.prepare(
    `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id, is_primary)
     VALUES (?, ?, ?, ?, ?, 1)`,
  ).run(`ur_${userId}_${scopeType}`, userId, role.id, scopeType, scopeId);
  return buildRbacContext(db, {
    id: userId, username: userId, full_name: userId, role: 'teacher', branch_id: BRANCH_A,
  });
}

beforeAll(() => {
  initSchema();
  bootstrapRbacCatalog(db);
  const org = (db.prepare('SELECT id FROM organizations LIMIT 1').get() as { id: string } | undefined)?.id ?? 'org_toefl_house';
  db.prepare(`INSERT OR IGNORE INTO organizations (id, name) VALUES (?, 'Scope Org')`).run(org);
  for (const [cid, name] of [[CAMPUS_A, 'Scope Campus A'], [CAMPUS_B, 'Scope Campus B']]) {
    db.prepare(
      `INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active)
       VALUES (?, ?, ?, ?, 1)`,
    ).run(cid, org, name, cid);
  }
  db.prepare(`INSERT OR IGNORE INTO branches (id, campus_id, name, location) VALUES (?, ?, 'Scope Branch A', 'A')`).run(BRANCH_A, CAMPUS_A);
  db.prepare(`INSERT OR IGNORE INTO branches (id, campus_id, name, location) VALUES (?, ?, 'Scope Branch B', 'B')`).run(BRANCH_B, CAMPUS_B);
  for (const uid of ['u_scope_campus_owner', 'u_scope_branch_owner', 'u_scope_org_owner']) {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, full_name, role, branch_id, password_hash, is_active, must_change_password)
       VALUES (?, ?, ?, 'teacher', ?, 'x', 1, 0)`,
    ).run(uid, uid, uid, BRANCH_A);
  }
});

describe('only an organization-scoped owner is a global owner', () => {
  it('an ORGANIZATION-scoped owner is global (the real owner keeps every power)', () => {
    const ctx = ctxWithRole('u_scope_org_owner', 'owner', 'organization', null);
    expect(isGlobalOwner(ctx)).toBe(true);
    expect(canAccessAllBranches(ctx)).toBe(true);
    expect(canAccessBranch(db, ctx, BRANCH_A)).toBe(true);
    expect(canAccessBranch(db, ctx, BRANCH_B)).toBe(true);
  });

  it('a CAMPUS-scoped owner is NOT global and cannot reach another campus', () => {
    const ctx = ctxWithRole('u_scope_campus_owner', 'owner', 'campus', CAMPUS_A);
    expect(isGlobalOwner(ctx)).toBe(false);
    expect(canAccessAllBranches(ctx)).toBe(false);
    // Its own campus stays reachable — the grant must still mean something.
    expect(canAccessBranch(db, ctx, BRANCH_A)).toBe(true);
    // THE ESCALATION: this returned true before the fix.
    expect(canAccessBranch(db, ctx, BRANCH_B)).toBe(false);
  });

  it('a BRANCH-scoped owner reaches only its own branch', () => {
    const ctx = ctxWithRole('u_scope_branch_owner', 'owner', 'branch', BRANCH_A);
    expect(isGlobalOwner(ctx)).toBe(false);
    expect(canAccessAllBranches(ctx)).toBe(false);
    expect(canAccessBranch(db, ctx, BRANCH_A)).toBe(true);
    expect(canAccessBranch(db, ctx, BRANCH_B)).toBe(false);
  });

  it('no non-owner role is accidentally treated as a global owner', () => {
    for (const code of ['general_manager', 'finance_manager', 'receptionist', 'teacher']) {
      const exists = db.prepare('SELECT 1 FROM roles WHERE code = ?').get(code);
      if (!exists) continue;
      const ctx = ctxWithRole('u_scope_branch_owner', code, 'organization', null);
      expect(isGlobalOwner(ctx), `${code} must not be a global owner`).toBe(false);
    }
  });

  it('the superuser short-circuits use the scope-aware check, not bare hasRole', () => {
    // Structural guard: a future edit that reintroduces `hasRole(ctx,'owner')`
    // as a bypass silently restores the escalation, and no behavioural test
    // would catch it until a second campus exists in production.
    const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
    const files = [
      'middleware/auth.ts', 'core/rbac/rbac-service.ts',
      'routes/bos.routes.ts', 'routes/branches.routes.ts', 'routes/events.routes.ts',
      'routes/auth.routes.ts',
    ];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      const offending = src
        .split('\n')
        .filter((line) => /hasRole\(\s*(req\.)?rbac\s*,\s*'owner'\s*\)/.test(line) && !line.trim().startsWith('*'));
      expect(offending, `${rel} must use isGlobalOwner() for owner bypasses`).toEqual([]);
    }
  });
});
