/**
 * One answer to "what may this user see and do".
 * ============================================================================
 * The question was being answered in four places with three different rules:
 *
 *   server  /auth/login  and  /auth/me   tabAccess[t] = has(perm) || isGlobalOwner
 *   server  /security/me/permissions     tabAccess[t] = has(perm)
 *   client  canAccessTab()               tabAccess, else permissions, else a
 *                                        role list compiled from the sidebar
 *   client  hasPermission()              role === 'owner' || permissions
 *
 * Two defects came out of that spread, both reproduced before being fixed:
 *
 *   THE PLACEMENT TEST BANK WAS INVISIBLE TO EVERYONE
 *     `test-bank` is a routed screen with a sidebar entry, but it had no entry
 *     in TAB_PERMISSION_MAP. `tabAccess['test-bank']` was therefore undefined,
 *     and every resolution path turns undefined into false — including for the
 *     owner. A screen that shipped could not be opened from the sidebar.
 *
 *   THE SIDEBAR CARRIED A SECOND AUTHORIZATION VOCABULARY
 *     Each of the 18 navigation items declared its own `roles: [...]` list,
 *     compiled into TAB_ACCESS and consulted when no permission set was
 *     present. Compared against the permissions the catalog actually grants,
 *     those lists disagreed in at least four places (students/counselor,
 *     classes/counselor, workflows/finance_manager, funding/general_manager).
 *     They were dead in practice — the client always has a permission set — so
 *     the disagreements were latent rather than live, which is exactly why they
 *     survived unnoticed.
 *
 * The rule these tests pin: the server computes effective access once, the
 * client reads it, and nothing else has an opinion.
 *
 * This test lives in the server suite because it is the only test runner in the
 * repository; it asserts against frontend source files on disk.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PERMISSION_CATALOG,
  TAB_PERMISSION_MAP,
  ROLE_DEFINITIONS,
} from '../core/rbac/permission-catalog.js';
import { effectivePermissionCodes, effectiveTabAccess } from '../core/rbac/rbac-service.js';
import type { RbacUserContext } from '../core/rbac/rbac-service.js';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const navTypesFile = path.join(repoRoot, 'src', 'types', 'navigation.ts');
const navConfigFile = path.join(repoRoot, 'src', 'config', 'navigation.ts');
const permissionsFile = path.join(repoRoot, 'src', 'config', 'permissions.ts');

const read = (f: string) => fs.readFileSync(f, 'utf8');

/** The `AppTabId` union members — every screen the router can show. */
function declaredTabIds(): string[] {
  const src = read(navTypesFile);
  const block = /export type AppTabId =([\s\S]*?);\n/.exec(src);
  if (!block) throw new Error('AppTabId union not found');
  return [...block[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
}

/** Item ids in the sidebar configuration (section ids are not items). */
function navItemIds(): string[] {
  const src = read(navConfigFile);
  return [...src.matchAll(/\{\s*\n\s*id: '([\w-]+)',\s*\n\s*label: '[^']*',\s*\n\s*icon: '/g)].map(
    (m) => m[1],
  );
}

function ownerContext(): RbacUserContext {
  const owner = ROLE_DEFINITIONS.find((r) => r.code === 'owner')!;
  return {
    userId: 'owner-probe',
    username: 'owner-probe',
    fullName: 'Owner Probe',
    branchId: '1',
    roles: [
      {
        roleId: 'r-owner',
        roleCode: 'owner',
        roleName: 'Owner',
        scopeType: 'organization',
        scopeId: null,
      },
    ],
    permissions: [],
    permissionCodes: new Set(Object.keys(owner.permissions)),
  } as unknown as RbacUserContext;
}

function receptionistContext(): RbacUserContext {
  const r = ROLE_DEFINITIONS.find((x) => x.code === 'receptionist')!;
  return {
    userId: 'recep-probe',
    username: 'recep-probe',
    fullName: 'Receptionist Probe',
    branchId: '1',
    roles: [
      {
        roleId: 'r-recep',
        roleCode: 'receptionist',
        roleName: 'Receptionist',
        scopeType: 'branch',
        scopeId: '1',
      },
    ],
    permissions: [],
    permissionCodes: new Set(Object.keys(r.permissions)),
  } as unknown as RbacUserContext;
}

describe('every reachable screen has a permission that governs it', () => {
  it('each AppTabId appears in TAB_PERMISSION_MAP', () => {
    const missing = declaredTabIds().filter((tab) => !(tab in TAB_PERMISSION_MAP));
    expect(missing).toEqual([]);
  });

  it('each sidebar item appears in TAB_PERMISSION_MAP', () => {
    const missing = navItemIds().filter((tab) => !(tab in TAB_PERMISSION_MAP));
    expect(missing).toEqual([]);
  });

  it('TAB_PERMISSION_MAP names no tab the router cannot show', () => {
    const declared = new Set(declaredTabIds());
    expect(Object.keys(TAB_PERMISSION_MAP).filter((t) => !declared.has(t))).toEqual([]);
  });

  it('every mapped permission exists in the catalog', () => {
    const codes = new Set(PERMISSION_CATALOG.map((p) => p.code));
    const unknown = Object.entries(TAB_PERMISSION_MAP).filter(([, perm]) => !codes.has(perm));
    expect(unknown).toEqual([]);
  });
});

describe('effective access is computed once, on the server', () => {
  it('a global owner is reported as holding every permission in the catalog', () => {
    // The catalog withholds four codes from the owner's stored grant for audit
    // reasons, but requirePermission() bypasses the owner entirely, so the
    // owner really can perform them. The payload has to say what is true, or
    // the UI hides controls the server would accept.
    expect(effectivePermissionCodes(ownerContext()).sort()).toEqual(
      PERMISSION_CATALOG.map((p) => p.code).sort(),
    );
  });

  it('the four audit-withheld codes are among them', () => {
    const codes = effectivePermissionCodes(ownerContext());
    for (const code of ['Attendance.Edit', 'Grade.Edit', 'Student.Delete', 'Payment.Delete']) {
      expect(codes).toContain(code);
    }
  });

  it('a global owner can reach every tab', () => {
    const access = effectiveTabAccess(ownerContext());
    expect(Object.values(access).every(Boolean)).toBe(true);
    expect(Object.keys(access).sort()).toEqual(Object.keys(TAB_PERMISSION_MAP).sort());
  });

  it('a non-owner is not widened', () => {
    const ctx = receptionistContext();
    const stored = new Set(ctx.permissionCodes);
    expect(effectivePermissionCodes(ctx).sort()).toEqual([...stored].sort());
  });

  it('a non-owner reaches a tab only when holding its permission', () => {
    const ctx = receptionistContext();
    const access = effectiveTabAccess(ctx);
    for (const [tab, perm] of Object.entries(TAB_PERMISSION_MAP)) {
      expect(access[tab]).toBe(ctx.permissionCodes.has(perm));
    }
  });

  it('tab access is derived from effective permissions, not computed twice', () => {
    for (const ctx of [ownerContext(), receptionistContext()]) {
      const granted = new Set(effectivePermissionCodes(ctx));
      const access = effectiveTabAccess(ctx);
      for (const [tab, perm] of Object.entries(TAB_PERMISSION_MAP)) {
        expect(access[tab]).toBe(granted.has(perm));
      }
    }
  });
});

describe('the client keeps no authorization vocabulary of its own', () => {
  it('the sidebar configuration declares no role lists', () => {
    expect(read(navConfigFile)).not.toMatch(/^\s*roles:/m);
  });

  it('no TAB_ACCESS map is compiled from the sidebar', () => {
    expect(read(permissionsFile)).not.toContain('TAB_ACCESS');
  });

  it('no client helper short-circuits on a role name', () => {
    const src = read(permissionsFile);
    expect(src).not.toMatch(/role\s*===\s*'owner'/);
  });

  it('tab access is read from the server answer alone', () => {
    const src = read(permissionsFile);
    const fn = /export function canAccessTab\(([\s\S]*?)\n\}/.exec(src);
    expect(fn).not.toBeNull();
    // No role parameter, and no permission-set second-guessing.
    expect(fn![1]).not.toMatch(/\brole\b/);
    expect(fn![1]).not.toMatch(/permissionCodes/);
  });
});
