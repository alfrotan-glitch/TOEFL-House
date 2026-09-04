#!/usr/bin/env node
/**
 * CFG-2/3/4 mutation harness — branch academic profile fee validation.
 *
 * Each mutant weakens one configuration-write invariant. A mutant is KILLED
 * when the regression suite fails. A SURVIVOR means the suite cannot detect
 * that weakening. Survivors may only be classified equivalent by execution.
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SRC = 'src/routes/catalog.routes.ts';
const BAK = '/tmp/catalog.routes.bak.ts';
const TEST = 'src/tests/work-packages/wp01/organization-configuration.api.test.ts';

const MUTANTS = [
  // Re-based against the per-rule fee design: the branch-profile fee loop was
  // replaced by parseFeeRuleBody, whose single amount parse is the boundary
  // every fee-rule writer shares. F1/F3 preserve the original defect
  // semantics against that shape; F2/F4-F6 retired below.
  ['F1', 'remove fee validation entirely (raw passthrough)',
   'const amount = assertMoney(body.amount ?? 0, `${feeType} fee amount`);',
   'const amount = Number(body.amount ?? 0);'],
  ['F2', 'bypass canonical validator, accept any number',
   'const amount = assertMoney(body.amount ?? 0, `${feeType} fee amount`);',
   'const amount = Number(body.amount ?? 0) || 0;'],
  ['F3', 'allow negative fees',
   'const amount = assertMoney(body.amount ?? 0, `${feeType} fee amount`);',
   'const amount = assertMoney(body.amount ?? 0, `${feeType} fee amount`, { allowNegative: true });'],
  ['F4', 'silently round sub-cent instead of rejecting',
   'const amount = assertMoney(body.amount ?? 0, `${feeType} fee amount`);',
   'const amount = Math.round(Number(body.amount ?? 0) * 100) / 100;'],
  ['F5', 'validate only the first fee field', 'RETIRED', 'RETIRED'],
  ['F6', 'skip validation when value is a string (coerce text)', 'RETIRED', 'RETIRED'],
  ['F7', 'drop the pass-mark/attendance percent bound',
   'if (n < 0 || n > 100) throw new HttpError(400, `${field} must be between 0 and 100.`);', 'if (false) throw new HttpError(400, \'x\');'],
  ['F8', 'percent accepts non-finite',
   'if (typeof n !== \'number\' || !Number.isFinite(n)) throw new HttpError(400, `${field} must be a finite number.`);', 'if (false) throw new HttpError(400, \'x\');'],
  ['F9', 'CFG-4: revert to NULL placeholders (partial PUT 500s)',
   'keep(null, \'registration_fee\', 0),', 'null,'],
  ['F10', 'CFG-4: partial update clobbers untouched fee with 0',
   'keep(null, \'card_fee\', 0),', '0,'],
  // F11 is a PROVEN-EQUIVALENT mutant, established by execution rather than
  // inspection. With the route-level scope check deleted, a live server was
  // attacked on a second branch: manager -> 403, registrar -> 403, owner ->
  // 200. The requirePermission('AcademicSetup.Edit','Settings.Edit') gate
  // already denies every non-owner principal, and an owner writing another
  // branch is correct behaviour. The in-route check is defence-in-depth, so no
  // test can distinguish its removal. It is retained deliberately.
  // F11 re-based (same discipline): the inline guard became requireCatalogBranch.
  ['F11', 'branch scope check removed (cross-branch config write)',
   '  requireCatalogBranch(req, req.params.branchId);\n  const b = (req.body ?? {}) as Record<string, unknown>;',
   '  const b = (req.body ?? {}) as Record<string, unknown>;'],
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

// Retired mutants — targets that ceased to exist when branch-profile fee
// editing moved to per-rule fee rows (parseFeeRuleBody). Recorded so the
// measurement history stays auditable; none of these code paths can be
// reached today:
//   F4/F5/F6  the per-field fees[key] loop and its FEE_FIELDS iteration were
//             removed with the profile-fee design; sub-cent rounding and
//             per-field/string-coercion variants have no remaining site.
//   F9/F10    the branch-profile PUT no longer accepts fee fields at all —
//             legacy fee fields are rejected outright and fee values are
//             edited as fee-rule rows, so neither placeholder nor clobber
//             behaviour exists to weaken.
const OBSOLETE = {
  F4: 'per-field fee loop removed with the profile-fee design; single-site parse measured by F1-F3',
  F5: 'FEE_FIELDS iteration no longer exists; one amount field per fee rule',
  F6: 'per-field string-coercion path no longer exists; measured at the single parse by F1',
  F9: 'branch-profile PUT rejects legacy fee fields; fee values live in fee-rule rows',
  F10: 'branch-profile PUT rejects legacy fee fields; fee values live in fee-rule rows',
};

copyFileSync(SRC, BAK);
const original = readFileSync(SRC, 'utf8');
const results = [];
try {
  for (const [id, desc, find, repl] of MUTANTS) {
    if (only && id !== only) continue;
    if (OBSOLETE[id]) { results.push([id, desc, 'OBSOLETE']); console.log(`${id.padEnd(5)} OBSOLETE   ${desc} — ${OBSOLETE[id]}`); continue; }
    if (!original.includes(find)) { results.push([id, desc, 'INVALID (anchor not found)']); console.log(`${id.padEnd(5)} ${desc.padEnd(52)} INVALID`); continue; }
    writeFileSync(SRC, original.replace(find, repl));
    let verdict;
    try {
      execSync(`rm -f src/tests/test.sqlite*; npx vitest run --no-file-parallelism ${TEST}`, { stdio: 'pipe', timeout: 180000 });
      verdict = '*** SURVIVED ***';
    } catch { verdict = 'KILLED'; }
    results.push([id, desc, verdict]);
    console.log(`${id.padEnd(5)} ${desc.padEnd(52)} ${verdict}`);
    writeFileSync(SRC, original);
  }
} finally {
  writeFileSync(SRC, original);
  if (existsSync(BAK)) unlinkSync(BAK);
}
// F11 removed from EQUIVALENT (2026-08-22, TR4-R14 re-base): against the
// re-pointed requireCatalogBranch guard the mutant is KILLED by execution —
// the suite's cross-branch case fails when the guard is removed. The old
// equivalence applied only to the pre-rebase inline canAccessBranchResource
// copy, which no longer exists.
const EQUIVALENT = new Set();
const survived = results.filter(r => r[2].includes('SURVIVED') && !EQUIVALENT.has(r[0]));
const equivalent = results.filter(r => r[2].includes('SURVIVED') && EQUIVALENT.has(r[0]));
if (equivalent.length) console.log(`\n${equivalent.length} proven-equivalent mutant(s): ${equivalent.map(r => r[0]).join(', ')} (see comment in this file)`);
console.log(`\n${results.filter(r => r[2] === 'KILLED').length}/${results.length} killed, ${survived.length} survivors`);
process.exit(survived.length ? 1 : 0);
