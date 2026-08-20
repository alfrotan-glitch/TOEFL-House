/**
 * One role vocabulary, shared by the server and the UI.
 * ============================================================================
 * The role names existed as four hand-maintained lists: `ROLE_CODES` on the
 * server, and `UserRole`, a `USER_ROLES` Set and a `ROLE_LABELS` map on the
 * frontend. Four copies of one vocabulary drift, and this set already had —
 * `ROLE_LABELS` carried three keys (`manager`, `finance`, `registrar`) that
 * were not roles at all, under a comment calling them the modern ones and
 * calling the four real codes beside them legacy aliases.
 *
 * Nothing failed loudly, which is the point: a label map with a wrong key
 * renders a plausible-looking string, and a dropdown that omits a role just
 * looks like a shorter dropdown. Only a comparison against the authority shows
 * it.
 *
 * The frontend now derives its type from `USER_ROLE_CODES` and its Set and
 * label map from that array. These tests hold that array identical to the
 * server's `ROLE_CODES`, which the compiler cannot do across the two packages.
 *
 * This test lives in the server suite because it is the only test runner in the
 * repository; it asserts against frontend source files on disk.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_CODES, ROLE_DEFINITIONS } from '../core/rbac/permission-catalog.js';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const typesFile = path.join(repoRoot, 'src', 'types.ts');
const rolesConfigFile = path.join(repoRoot, 'src', 'config', 'roles.ts');
const authContextFile = path.join(repoRoot, 'src', 'contexts', 'auth-context.ts');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** String literals inside the `USER_ROLE_CODES` array declaration. */
function frontendRoleCodes(): string[] {
  const src = read(typesFile);
  const block = /export const USER_ROLE_CODES = \[([\s\S]*?)\] as const;/.exec(src);
  if (!block) throw new Error('USER_ROLE_CODES array not found in src/types.ts');
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** Keys of the `ROLE_LABELS` object literal. */
function labelKeys(): string[] {
  const src = read(rolesConfigFile);
  const block = /export const ROLE_LABELS: Record<UserRole, string> = \{([\s\S]*?)\n\};/.exec(src);
  if (!block) throw new Error('ROLE_LABELS map not found in src/config/roles.ts');
  return [...block[1].matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
}

describe('the frontend and the server name roles identically', () => {
  it('USER_ROLE_CODES is exactly ROLE_CODES, in the same order', () => {
    expect(frontendRoleCodes()).toEqual([...ROLE_CODES]);
  });

  it('every role the catalog defines has a UI label', () => {
    expect(labelKeys().slice().sort()).toEqual([...ROLE_CODES].sort());
  });

  it('the label map has no key that is not a role', () => {
    const strays = labelKeys().filter((key) => !(ROLE_CODES as readonly string[]).includes(key));
    expect(strays).toEqual([]);
  });

  it('ROLE_DEFINITIONS covers the vocabulary once each', () => {
    expect(ROLE_DEFINITIONS.map((r) => r.code).sort()).toEqual([...ROLE_CODES].sort());
  });

  /**
   * Order is not cosmetic: it is the order the Add-user dropdown presents, so
   * it has to mean something. It means seniority, which the catalog already
   * declares as `sortOrder`.
   */
  it('ROLE_CODES is ordered by the seniority the catalog declares', () => {
    const declared = ROLE_DEFINITIONS.map((r) => r.sortOrder);
    expect(declared).toEqual([...declared].sort((a, b) => a - b));
    expect(ROLE_DEFINITIONS.map((r) => r.code)).toEqual([...ROLE_CODES]);
  });
});

describe('the vocabulary is declared once on each side', () => {
  it('src/types.ts derives UserRole from the array rather than retyping it', () => {
    expect(read(typesFile)).toContain('export type UserRole = (typeof USER_ROLE_CODES)[number];');
  });

  it('the auth context builds its Set from the array rather than retyping it', () => {
    const src = read(authContextFile);
    expect(src).toContain('new Set<UserRole>(USER_ROLE_CODES)');
    // A retyped Set would carry its own quoted role literals.
    const setBlock = /export const USER_ROLES = new Set<UserRole>\(([\s\S]*?)\);/.exec(src);
    expect(setBlock).not.toBeNull();
    expect(setBlock![1]).not.toMatch(/'[a-z_]+'/);
  });

  it('the assignable list is derived by exclusion, not retyped', () => {
    const src = read(rolesConfigFile);
    expect(src).toContain('USER_ROLE_CODES.filter(');
    const block = /export const ASSIGNABLE_ROLES: UserRole\[\] = ([\s\S]*?);\n/.exec(src);
    expect(block).not.toBeNull();
    expect(block![1]).not.toMatch(/'[a-z_]+'/);
  });
});

describe('roles excluded from a form are excluded on purpose', () => {
  /**
   * The exclusions are a policy statement, so they are asserted by name. A role
   * dropped from either list without a stated reason fails here rather than
   * quietly becoming unreachable.
   */
  it('the server withholds exactly data_entry from assignment', () => {
    const src = read(path.join(repoRoot, 'server', 'src', 'routes', 'users.routes.ts'));
    const block = /const NOT_ASSIGNABLE: ReadonlySet<RoleCode> = new Set<RoleCode>\(\[([\s\S]*?)\]\);/.exec(src);
    expect(block).not.toBeNull();
    expect([...block![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual(['data_entry']);
  });

  it('the Add-user form withholds exactly owner, data_entry and student', () => {
    const src = read(rolesConfigFile);
    const block = /const NOT_OFFERED_AS_ACCOUNT_TYPE: ReadonlySet<UserRole> = new Set<UserRole>\(\[([\s\S]*?)\]\);/.exec(src);
    expect(block).not.toBeNull();
    expect([...block![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([
      'data_entry',
      'owner',
      'student',
    ]);
  });

  it('every withheld role is a real role', () => {
    const src = read(rolesConfigFile);
    const block = /const NOT_OFFERED_AS_ACCOUNT_TYPE: ReadonlySet<UserRole> = new Set<UserRole>\(\[([\s\S]*?)\]\);/.exec(src);
    const withheld = [...block![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const role of withheld) {
      expect(ROLE_CODES as readonly string[]).toContain(role);
    }
  });
});
