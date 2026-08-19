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
  'src/tests/rbac-expired-grant-escalation.test.ts',
  'src/tests/rbac-scope.test.ts',
  'src/tests/owner-scope-escalation.test.ts',
  'src/tests/branch-scope-not-home-branch.test.ts',
  'src/tests/p1-scope-hardening.test.ts',
  'src/tests/class-teacher-ownership.test.ts',
  'src/tests/rbac-search-entity-permission.test.ts',
  'src/tests/rbac-home-branch-invariant.test.ts',
].join(' ');
const TEST_CMD = FULL ? 'npx vitest run --silent 2>&1' : `npx vitest run ${SUITES} --silent 2>&1`;

const SVC = 'src/core/rbac/rbac-service.ts';
const ABAC = 'src/core/rbac/abac.ts';
const MW = 'src/middleware/auth.ts';

const MUTANTS = [
  {
    id: 'M1',
    invariant: 'RBAC-1 — an expired grant must not fall through to the legacy role',
    file: SVC,
    find: '  if (roles.length === 0 && !hasAnyAssignment) {',
    replace: '  if (roles.length === 0) {',
  },
  {
    id: 'M2',
    invariant: 'expiry predicate on getUserRoles is enforced',
    file: SVC,
    find: `      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND r.is_active = 1
        AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
    \`),
    getLegacyUser:`,
    replace: `      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ? AND r.is_active = 1
    \`),
    getLegacyUser:`,
  },
  {
    id: 'M3',
    invariant: 'expiry predicate on getUserRbacPerms is enforced',
    file: SVC,
    find: `      WHERE ur.user_id = ? AND r.is_active = 1
        AND (ur.expires_at IS NULL OR ur.expires_at > datetime('now'))
    \`),
    getDelegations:`,
    replace: `      WHERE ur.user_id = ? AND r.is_active = 1
    \`),
    getDelegations:`,
  },
  {
    id: 'M4',
    invariant: 'isGlobalOwner requires ORGANIZATION scope (the F-5 fix)',
    file: SVC,
    find: "  return ctx.roles.some((r) => r.roleCode === 'owner' && r.scopeType === 'organization');",
    replace: "  return ctx.roles.some((r) => r.roleCode === 'owner');",
  },
  {
    id: 'M5',
    invariant: 'branch scope comparison must match the requested branch',
    file: SVC,
    find: "    if (role.scopeType === 'branch' && role.scopeId === branchId) return true;",
    replace: "    if (role.scopeType === 'branch') return true;",
  },
  {
    id: 'M6',
    invariant: 'campus scope comparison must match the branch campus',
    file: SVC,
    find: "    if (role.scopeType === 'campus' && role.scopeId && role.scopeId === branch.campusId) return true;",
    replace: "    if (role.scopeType === 'campus') return true;",
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
    id: 'M11',
    invariant: 'teacher-scoped detection (isClassTeacherScoped) still triggers',
    file: ABAC,
    find: "  return scope === 'own' || scope === 'class' || hasLegacyRole(req, 'teacher');",
    replace: '  return false;',
  },
  {
    id: 'M12',
    invariant: 'explicit-assignment detection drives the permission fallback',
    file: SVC,
    find: '    if (rows.length === 0 && !hasAnyAssignment) {',
    replace: '    if (rows.length === 0) {',
  },
];

const selected = ONLY ? MUTANTS.filter((m) => m.id === ONLY) : MUTANTS;
if (!selected.length) { console.error(`No mutant matches --only ${ONLY}`); process.exit(2); }

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
console.log(`KILLED: ${killed}/${results.length - equivalent.length}   PROVEN EQUIVALENT: ${equivalent.length}   SURVIVED: ${survived.length}   INVALID: ${invalid.length}`);
if (survived.length) {
  console.log('\nSURVIVING MUTANTS (missing coverage):');
  for (const s of survived) console.log(`  ${s.id} — ${s.invariant} (${s.file})`);
}
if (invalid.length) {
  console.log('\nINVALID MUTANTS (pattern drifted — fix the harness):');
  for (const s of invalid) console.log(`  ${s.id} — ${s.detail}`);
}
process.exit(survived.length === 0 && invalid.length === 0 ? 0 : 1);
