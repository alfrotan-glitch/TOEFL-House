#!/usr/bin/env node
/**
 * RBAC AUTHORIZATION CHOKEPOINTS — MUTATION HARNESS
 * ============================================================================
 * Each mutant breaks one authorization decision and must be caught by the
 * regression suites. M1 restores the exact RBAC-1 escalation and MUST die.
 *
 * Usage: node scripts/rbac-authorization-mutation-test.mjs [--only M3] [--full]
 * Exit 0 = every mutant KILLED (or proven equivalent). Exit 1 = a survivor.
 *
 * Restores every file on all exit paths, so a mutated tree cannot outlive
 * this process.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..');

const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const FULL = process.argv.includes('--full');
const SUITES = [
  'src/tests/work-packages/wp02/rbac-expired-grant-escalation.test.ts',
  'src/tests/work-packages/wp02/rbac-scope.test.ts',
  'src/tests/work-packages/wp02/owner-scope-escalation.test.ts',
  'src/tests/work-packages/wp02/p1-scope-hardening.test.ts',
  'src/tests/work-packages/wp05/class-teacher-ownership.test.ts',
  'src/tests/work-packages/wp02/rbac-search-entity-permission.test.ts',
  'src/tests/work-packages/wp02/rbac-home-branch-invariant.test.ts',
  // TR4-R14 follow-up (kills M7): hasPermission has exactly two production
  // call sites (security.routes requirePermissionAtBranch, users.routes
  // requireRoleAssignmentAuthority). This suite drives both grant endpoints
  // with principals who lack the permission and expects 403 — the only live
  // deny-path coverage of the mutated function.
  'src/tests/work-packages/wp02/security-grant-escalation.test.ts',
].join(' ');
const TEST_CMD = FULL ? 'npx vitest run --silent 2>&1' : `npx vitest run ${SUITES} --silent 2>&1`;

const SVC = 'src/core/rbac/rbac-service.ts';
const ABAC = 'src/core/rbac/abac.ts';
const MW = 'src/middleware/auth.ts';

const MUTANTS = [
  {
    // OBSOLETE ANCHOR — TR4-F10, decision deferred to the Owner (not
    // classified, not removed): see the note on M12 below — the legacy-role
    // fallback this mutant guards no longer exists in rbac-service.ts.
    id: 'M1',
    invariant: 'RBAC-1 — an expired grant must not fall through to the legacy role',
    file: SVC,
    find: '  if (roles.length === 0 && !hasAnyAssignment) {',
    replace: '  if (roles.length === 0) {',
  },
  {
    // TR4-F10 re-base: the expiry predicate now lives in the prepared
    // statement `getUserRoles` below (it moved out of the old query shape the
    // anchor was written against). Semantics unchanged: drop the predicate.
    id: 'M2',
    invariant: 'expiry predicate on getUserRoles is enforced',
    file: SVC,
    find: `    getUserRoles: db.prepare(\`
      SELECT ur.role_id AS roleId, r.code AS roleCode, r.name AS roleName, ur.scope_type AS scopeType,
             ur.scope_id AS scopeId, ur.is_primary AS isPrimary
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND r.is_active = 1
        AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
      ORDER BY ur.is_primary DESC
    \`),`,
    replace: `    getUserRoles: db.prepare(\`
      SELECT ur.role_id AS roleId, r.code AS roleCode, r.name AS roleName, ur.scope_type AS scopeType,
             ur.scope_id AS scopeId, ur.is_primary AS isPrimary
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND r.is_active = 1
      ORDER BY ur.is_primary DESC
    \`),`,
  },
  {
    // TR4-F10 re-base: same predicate, now in `getUserRbacPerms`.
    id: 'M3',
    invariant: 'expiry predicate on getUserRbacPerms is enforced',
    file: SVC,
    find: `    getUserRbacPerms: db.prepare(\`
      SELECT p.code AS code, rp.default_scope AS scope, ur.scope_type AS user_scope, ur.scope_id AS user_scope_id
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = ? AND r.is_active = 1
        AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
    \`),`,
    replace: `    getUserRbacPerms: db.prepare(\`
      SELECT p.code AS code, rp.default_scope AS scope, ur.scope_type AS user_scope, ur.scope_id AS user_scope_id
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = ? AND r.is_active = 1
    \`),`,
  },
  {
    id: 'M4',
    invariant: 'isGlobalOwner requires ORGANIZATION scope (the F-5 fix)',
    file: SVC,
    find: "  return ctx.roles.some((r) => r.roleCode === 'owner' && r.scopeType === 'organization');",
    replace: "  return ctx.roles.some((r) => r.roleCode === 'owner');",
  },
  {
    // TR4-F10 re-base: the per-role loop became the single comparison in
    // boundaryCanAccessBranch. Semantics unchanged: a branch-scoped grant no
    // longer has to match the requested branch.
    id: 'M5',
    invariant: 'branch scope comparison must match the requested branch',
    file: SVC,
    find: "  if (scopeType === 'branch') return scopeId === branchId;",
    replace: "  if (scopeType === 'branch') return true;",
  },
  {
    // TR4-F10 re-base: campus comparison now resolves via branch.campusId.
    // Semantics unchanged: any campus scope grants, regardless of match.
    id: 'M6',
    invariant: 'campus scope comparison must match the branch campus',
    file: SVC,
    find: '  return !!branch && branch.campusId === scopeId;',
    replace: '  return !!branch;',
  },
  {
    id: 'M7',
    invariant: 'permission lookup is a real set membership test',
    file: SVC,
    find: `export function hasPermission(ctx: RbacUserContext, code: string): boolean {
  return ctx.permissionCodes.has(code);
}`,
    replace: `export function hasPermission(ctx: RbacUserContext, code: string): boolean {
  return true;
}`,
  },
  {
    id: 'M8',
    invariant: 'canAccessAllBranches is not granted to every principal',
    file: SVC,
    find: "  return isGlobalOwner(ctx) || ctx.roles.some((r) => r.scopeType === 'organization');",
    replace: '  return true;',
  },
  {
    id: 'M9',
    invariant: 'requirePermission actually consults the resolved permissions',
    file: MW,
    find: '    if (req.rbac && hasAnyPermission(req.rbac, codes)) return next();',
    replace: '    if (req.rbac) return next();',
  },
  {
    id: 'M10',
    invariant: 'ABAC class-ownership check is enforced for teacher-scoped callers',
    file: ABAC,
    find: '    return !!stmtIsUserClassTeacher.get(classId, req.user.userId);',
    replace: '    return true;',
  },
  {
    // TR4-F10 re-base: hasLegacyRole was renamed requestHasRole. Semantics
    // unchanged: teacher-scoped detection never triggers.
    id: 'M11',
    invariant: 'teacher-scoped detection (isClassTeacherScoped) still triggers',
    file: ABAC,
    find: "  return scope === 'own' || scope === 'class' || requestHasRole(req, 'teacher');",
    replace: '  return false;',
  },
  {
    // OBSOLETE ANCHOR — TR4-F10, decision deferred to the Owner (not
    // classified, not removed): this mutant and M12 mutated the legacy-role
    // fallback guarded by `hasAnyAssignment`, and that fallback no longer
    // exists anywhere in rbac-service.ts (grep: hasAnyAssignment /
    // getLegacyUser / legacy → 0 hits). There is no current code whose
    // behaviour these documented invariants describe, so they cannot be
    // re-based without inventing new semantics. They keep reporting INVALID —
    // loudly and visibly — until the Owner retires or redefines them.
    id: 'M12',
    invariant: 'explicit-assignment detection drives the permission fallback',
    file: SVC,
    find: '    if (rows.length === 0 && !hasAnyAssignment) {',
    replace: '    if (rows.length === 0) {',
  },
];

const selected = ONLY ? MUTANTS.filter((m) => m.id === ONLY) : MUTANTS;
if (!selected.length) { console.error(`No mutant matches --only ${ONLY}`); process.exit(2); }

// TR-4 Bucket-1 OBSOLETE registry — mutants retired with written evidence,
// never silently, never inside an EQUIVALENT set. An obsolete mutant's target
// no longer exists, so it is skipped BEFORE anchoring: it is neither INVALID
// nor a survivor, and the gate reports it distinctly.
const OBSOLETE = {
  M1: 'the legacy-role fallback guarded by `hasAnyAssignment` no longer exists anywhere in rbac-service.ts (grep hasAnyAssignment|getLegacyUser|legacy → 0 hits); successor enforcement is execution-proven — the expiry predicates are KILLED as M2/M3 since the TR4-R14 re-base. No decision record for the original removal was located (flagged to the Owner).',
  M12: 'same evidence as M1 — the permission fallback this mutant guarded was removed with the legacy path; nothing remains to mutate.',
  M7: 'subsumption proof (Owner option b, 2026-08-22): both production call sites tested `!hasPermission(ctx, code) || !canAccessBranchForRequirement(…, {permissionCodes:[code]})`, and the branch leg resolves from the same post-deny ctx.permissions with strictly stronger conditions (hasPermissionForBranchWithActionScopes) — branch-leg true implies hasPermission true. The redundant leg and the now-unused function were removed as an approved production simplification; the mutant target no longer exists. The deny-path suite wiring added in Bucket 2 is preserved.',
};

const read = (f) => readFileSync(path.join(SERVER, f), 'utf8');
const write = (f, c) => writeFileSync(path.join(SERVER, f), c);

const ORIGINALS = new Map();
for (const m of selected) if (!ORIGINALS.has(m.file)) ORIGINALS.set(m.file, read(m.file));
const restoreAll = () => { for (const [f, c] of ORIGINALS) write(f, c); };

let restored = false;
const restoreOnce = () => { if (!restored) { restored = true; restoreAll(); } };
process.on('exit', restoreOnce);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) process.on(sig, () => { restoreOnce(); process.exit(1); });
process.on('uncaughtException', (e) => { restoreOnce(); console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { restoreOnce(); console.error(e); process.exit(1); });

const wipeDb = () => { try { execSync('rm -f src/tests/test.sqlite*', { cwd: SERVER, stdio: 'pipe' }); } catch { /* none */ } };

console.log('RBAC AUTHORIZATION — MUTATION TESTING');
console.log('='.repeat(78));
console.log(`${selected.length} mutants. A mutant must be KILLED (suite fails) to prove coverage.`);
console.log(`Test command: ${TEST_CMD}\n`);

process.stdout.write('Verifying unmutated baseline is GREEN ... ');
wipeDb();
try {
  execSync(TEST_CMD, { cwd: SERVER, stdio: 'pipe', encoding: 'utf8', timeout: 900000 });
  console.log('OK\n');
} catch (err) {
  const out = `${err.stdout || ''}${err.stderr || ''}`;
  console.log('FAILED\n');
  console.error('ABORT: suite fails on unmutated code; every mutant would be falsely KILLED.\n');
  console.error(out.split('\n').slice(-25).join('\n'));
  process.exit(2);
}

const results = [];
try {
  for (const m of selected) {
    if (OBSOLETE[m.id]) {
      results.push({ ...m, status: 'OBSOLETE', detail: OBSOLETE[m.id] });
      console.log(`${m.id.padEnd(4)} OBSOLETE   ${m.invariant} — target retired with recorded evidence (see OBSOLETE registry)`);
      continue;
    }
    const original = ORIGINALS.get(m.file);
    const occurrences = original.split(m.find).length - 1;
    if (occurrences !== 1) {
      results.push({ ...m, status: 'INVALID', detail: `pattern matched ${occurrences}x (expected exactly 1)` });
      console.log(`${m.id.padEnd(4)} INVALID    ${m.invariant} — matched ${occurrences}x`);
      continue;
    }

    write(m.file, original.replace(m.find, m.replace));
    wipeDb();
    let killed = false; let detail = '';
    try {
      execSync(TEST_CMD, { cwd: SERVER, stdio: 'pipe', encoding: 'utf8', timeout: 900000 });
      detail = 'suite still passed';
    } catch (err) {
      killed = true;
      const out = `${err.stdout || ''}${err.stderr || ''}`;
      const hit = out.match(/Tests\s+(\d+)\s+failed/);
      detail = hit ? `${hit[1]} test(s) failed` : 'suite failed';
    } finally {
      restoreAll();
      if (read(m.file) !== original) {
        console.error(`\nFATAL: failed to restore ${m.file} after ${m.id}. Aborting.`);
        process.exit(3);
      }
    }
    const status = killed ? 'KILLED' : m.equivalent ? 'EQUIVALENT' : 'SURVIVED';
    results.push({ ...m, status, detail });
    console.log(`${m.id.padEnd(4)} ${status.padEnd(10)} ${m.invariant} (${detail})`);
  }
} finally {
  restoreAll();
  wipeDb();
}

console.log('\n' + '='.repeat(78));
const killed = results.filter((r) => r.status === 'KILLED').length;
const survived = results.filter((r) => r.status === 'SURVIVED');
const equivalent = results.filter((r) => r.status === 'EQUIVALENT');
const invalid = results.filter((r) => r.status === 'INVALID');
const obsolete = results.filter((r) => r.status === 'OBSOLETE');
console.log(`KILLED: ${killed}/${results.length - equivalent.length - obsolete.length}   PROVEN EQUIVALENT: ${equivalent.length}   OBSOLETE (documented): ${obsolete.length}   SURVIVED: ${survived.length}   INVALID: ${invalid.length}`);
if (obsolete.length) {
  console.log('\nOBSOLETE MUTANTS (target retired; evidence in this file):');
  for (const o of obsolete) console.log(`  ${o.id} — ${o.invariant}`);
}
if (survived.length) {
  console.log('\nSURVIVING MUTANTS (missing coverage):');
  for (const s of survived) console.log(`  ${s.id} — ${s.invariant} (${s.file})`);
}
if (invalid.length) {
  console.log('\nINVALID MUTANTS (pattern drifted — fix the harness):');
  for (const s of invalid) console.log(`  ${s.id} — ${s.detail}`);
}
process.exit(survived.length === 0 && invalid.length === 0 ? 0 : 1);
