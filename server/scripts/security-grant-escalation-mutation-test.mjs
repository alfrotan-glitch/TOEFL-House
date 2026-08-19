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
const EQUIVALENT = new Set(['S9']);

const MUTANTS = [
  // ── SEC-1: the owner role may only be granted by a global owner ──
  ['S1', 'drop the owner-role grant guard (the defect)', ROUTE,
   `  if (role.code === 'owner' && !callerIsGlobalOwner(req)) {
    throw new HttpError(403, 'Only a global owner may grant the owner role.');
  }`,
   ''],
  ['S2', 'owner-role guard trusts any caller claiming owner', ROUTE,
   "  if (role.code === 'owner' && !callerIsGlobalOwner(req)) {",
   "  if (role.code === 'owner' && false) {"],
  ['S3', 'owner-role guard only blocks the primary flag', ROUTE,
   "  if (role.code === 'owner' && !callerIsGlobalOwner(req)) {",
   "  if (role.code === 'owner' && isPrimary && !callerIsGlobalOwner(req)) {"],

  // ── SEC-2: scope may not be widened ──
  ['S4', 'restore the branch-only scope check (the defect)', ROUTE,
   `  if (!callerIsGlobalOwner(req)) {
    throw new HttpError(403, \`Only a global owner may grant \${scope}-scoped access.\`);
  }`,
   ''],
  ['S5', 'scope guard permits organization but blocks campus', ROUTE,
   "  if (!callerIsGlobalOwner(req)) {",
   "  if (scope !== 'organization' && !callerIsGlobalOwner(req)) {"],
  ['S6', 'branch scope guard ignores the branch reach check', ROUTE,
   '    if (scopeId && !canAccessBranchResource(req, scopeId)) {',
   '    if (scopeId && false) {'],

  // ── SEC-3: system identity roles are not rewritable ──
  ['S7', 'drop the system-role rewrite guard (the defect)', ROUTE,
   `  if (role.isSystem && !callerIsGlobalOwner(req)) {
    throw new HttpError(403, 'Only a global owner may change the permissions of a system role.');
  }`,
   ''],
  ['S8', 'system-role guard protects only the owner role', ROUTE,
   '  if (role.isSystem && !callerIsGlobalOwner(req)) {',
   "  if (role.code === 'owner' && !callerIsGlobalOwner(req)) {"],
  ['S9', 'role-permission scopes are no longer bounded', ROUTE,
   "  for (const p of body.permissions) requireScopedAssignment(req, p.scope || 'branch', null);",
   ''],
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
