#!/usr/bin/env node
/**
 * SEC-1/2/3 mutation harness — the privilege-grant boundary.
 *
 * Scope is deliberately narrow: only the guards introduced by this audit in
 * routes/security.routes.ts (owner-role grant, scope widening, system-role
 * rewrite). The frozen RBAC evaluator itself is NOT mutated.
 *
 * KILLED = the regression suite failed. Survivors may only be classified
 * equivalent BY EXECUTION, never by inspection.
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROUTE = 'src/routes/security.routes.ts';
const TEST = 'src/tests/security-grant-escalation.test.ts';

// PROVEN-EQUIVALENT mutants, established by execution rather than inspection.
//
// S9 removes the scope bound on the permissions written by
// PUT /roles/:id/permissions. It survives because `role_permissions.default_scope`
// is NOT the effective scope: the user_roles assignment scope wins. Verified by
// running the mutant end to end — a delegated manager wrote a custom position
// with default_scope='organization' (stored, HTTP 200), assigned it in-branch,
// and the victim's resolved permission came back as
//   {code:'Payment.View', scope:'branch', scopeId:'s9a'}
// with canAccessAllBranches = false. No effective privilege widened, because
// granting the position itself still goes through requireScopedAssignment
// (mutant S4/S5 cover that, and both are killed). The bound is retained as
// defence-in-depth so the stored row cannot claim more than the granter could.
// S9 removed from EQUIVALENT (2026-08-22, TR4-R14 re-base): against the
// shared normalizePermissionList scope-bound block the mutant is KILLED by
// execution — the suite fails when the bound is removed. The old equivalence
// applied only to the pre-rebase requireScopedAssignment loop.
const EQUIVALENT = new Set();
// TR-4 OBSOLETE registry (2026-08-22) — retired with written evidence, never
// silent, never inside EQUIVALENT. Skipped BEFORE anchoring.
const OBSOLETE = {
  S10: 'target unified: POST /roles and PUT /roles/:id/permissions both validate through normalizePermissionList; the separate custom-position scope loop no longer exists. S9 covers the single shared implementation.',
};

const MUTANTS = [
  // ── SEC-1: the owner role may only be granted by a global owner ──
  // S1-S4, S6-S9 re-based (TR4-R14 discipline, 2026-08-22): the guards moved
  // into requireAssignmentScope / requireRoleDefinitionReach /
  // normalizePermissionList and were reformatted to single-throw lines;
  // semantics below are unchanged from the originals.
  ['S1', 'drop the owner-role grant guard (the defect)', ROUTE,
   "  if (role.code === 'owner' && !callerIsGlobalOwner(req)) throw new HttpError(403, 'Only a global owner may grant the owner role.');",
   ''],
  ['S2', 'owner-role guard trusts any caller claiming owner', ROUTE,
   "  if (role.code === 'owner' && !callerIsGlobalOwner(req)) throw new HttpError(403, 'Only a global owner may grant the owner role.');",
   "  if (role.code === 'owner' && false) throw new HttpError(403, 'Only a global owner may grant the owner role.');"],
  ['S3', 'owner-role guard only blocks the primary flag', ROUTE,
   "  if (role.code === 'owner' && !callerIsGlobalOwner(req)) throw new HttpError(403, 'Only a global owner may grant the owner role.');",
   "  if (role.code === 'owner' && isPrimary && !callerIsGlobalOwner(req)) throw new HttpError(403, 'Only a global owner may grant the owner role.');"],

  // ── SEC-2: scope may not be widened ──
  ['S4', 'restore the branch-only scope check (the defect)', ROUTE,
   `  if (scopeType === 'organization') {
    if (scopeId !== null) throw new HttpError(400, 'Organization scope must not carry a scopeId.');
    if (!callerIsGlobalOwner(req)) throw new HttpError(403, 'Only a global owner may grant organization-scoped access.');
    return;
  }
  if (!scopeId) throw new HttpError(400, \`\${scopeType} scope requires a scopeId.\`);
  if (scopeType === 'campus') {
    if (!callerIsGlobalOwner(req)) throw new HttpError(403, 'Only a global owner may grant campus-scoped access.');`,
   `  if (scopeType === 'organization') {
    if (scopeId !== null) throw new HttpError(400, 'Organization scope must not carry a scopeId.');
    return;
  }
  if (!scopeId) throw new HttpError(400, \`\${scopeType} scope requires a scopeId.\`);
  if (scopeType === 'campus') {`],
  ['S5', 'scope guard permits organization but blocks campus', ROUTE,
   "  if (!callerIsGlobalOwner(req)) {",
   "  if (scope !== 'organization' && !callerIsGlobalOwner(req)) {"],
  ['S6', 'branch scope guard ignores the branch reach check', ROUTE,
   "  if (!db.prepare('SELECT id FROM branches WHERE id = ?').get(scopeId)) throw new HttpError(404, 'Target branch not found.');\n  requirePermissionAtBranch(req, permissionCode, scopeId);",
   "  if (!db.prepare('SELECT id FROM branches WHERE id = ?').get(scopeId)) throw new HttpError(404, 'Target branch not found.');"],

  // ── SEC-3: system identity roles are not rewritable ──
  ['S7', 'drop the system-role rewrite guard (the defect)', ROUTE,
   "  if (callerIsGlobalOwner(req)) return;\n  if (role.isSystem) throw new HttpError(403, 'Only a global owner may change a system role.');",
   '  if (callerIsGlobalOwner(req)) return;'],
  ['S8', 'system-role guard protects only the owner role', ROUTE,
   "  if (role.isSystem) throw new HttpError(403, 'Only a global owner may change a system role.');",
   "  if ((role as { code?: string }).code === 'owner') throw new HttpError(403, 'Only a global owner may change a system role.');"],
  ['S9', 'role-permission scopes are no longer bounded', ROUTE,
   `    const scope = normalizeScope(candidate.scope, PERMISSION_SCOPES, 'branch');
    if (!callerIsGlobalOwner(req)) {
      if (scope !== 'branch') throw new HttpError(403, 'Only a global owner may define permissions wider or narrower than branch scope.');
      if (!req.rbac?.permissionCodes.has(permission.code)) {
        throw new HttpError(403, 'You cannot grant a permission you do not hold.');
      }
    }`,
   `    const scope = normalizeScope(candidate.scope, PERMISSION_SCOPES, 'branch');`],
  // S10 retired through the OBSOLETE mechanism (2026-08-22): custom-position
  // creation and role-permission editing now share ONE scope-bound
  // implementation (normalizePermissionList, security.routes.ts:287,353,381);
  // the separate custom-position loop this mutant anchored no longer exists.
  // S9's re-based anchor mutates the single shared guard. Not EQUIVALENT.
  ['S10', 'custom position creation may carry any scope', ROUTE,
   '    if (p.scope) requireScopedAssignment(req, p.scope, null);',
   ''],

  // ── the caller-identity helper itself ──
  ['S11', 'every caller is treated as a global owner', ROUTE,
   '  return !!req.rbac && isGlobalOwner(req.rbac);',
   '  return true;'],
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const originals = new Map();
for (const f of [ROUTE]) originals.set(f, readFileSync(f, 'utf8'));
const backups = new Map();
for (const f of [ROUTE]) { const b = `/tmp/${f.replace(/\W/g, '_')}.bak`; copyFileSync(f, b); backups.set(f, b); }
const restoreAll = () => { for (const [f, src] of originals) writeFileSync(f, src); };

const results = [];
try {
  for (const [id, desc, file, find, repl] of MUTANTS) {
    if (OBSOLETE[id]) { results.push([id, desc, 'OBSOLETE']); console.log(`${id.padEnd(4)} OBSOLETE  ${desc} — target retired with recorded evidence`); continue; }
    if (only && id !== only) continue;
    const src = originals.get(file);
    const hits = src.split(find).length - 1;
    if (hits !== 1) {
      results.push([id, desc, 'INVALID']);
      console.log(`${id.padEnd(4)} ${desc.padEnd(56)} INVALID (anchor matched ${hits}x)`);
      continue;
    }
    writeFileSync(file, src.replace(find, repl));
    let verdict;
    try {
      execSync(`rm -f src/tests/test.sqlite*; npx vitest run --no-file-parallelism ${TEST}`, { stdio: 'pipe', timeout: 180000 });
      verdict = '*** SURVIVED ***';
    } catch { verdict = 'KILLED'; }
    results.push([id, desc, verdict]);
    console.log(`${id.padEnd(4)} ${desc.padEnd(56)} ${verdict}`);
    restoreAll();
  }
} finally {
  restoreAll();
  for (const b of backups.values()) if (existsSync(b)) unlinkSync(b);
}
const equivalent = results.filter((r) => r[2].includes('SURVIVED') && EQUIVALENT.has(r[0]));
const survived = results.filter((r) => r[2].includes('SURVIVED') && !EQUIVALENT.has(r[0]));
if (equivalent.length) console.log(`\n${equivalent.length} proven-equivalent mutant(s): ${equivalent.map((r) => r[0]).join(', ')} (see the note at the top of this file)`);
console.log(`\n${results.filter((r) => r[2] === 'KILLED').length}/${results.length} killed, ${survived.length} survivors`);
process.exit(survived.length ? 1 : 0);
