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
const TEST = 'src/tests/branch-profile-fee-validation.test.ts';

const MUTANTS = [
  // F1-F4 re-based (TR4-R14 discipline, 2026-08-22): the fee loop assigns
  // directly into fees[key] and D-23 replaced the round-check with outright
  // assertMoney rejection; mutants below preserve the original defect
  // semantics against the current shape.
  ['F1', 'remove fee validation entirely (raw passthrough)',
   '    fees[key] = assertMoney(b[key], label);', '    fees[key] = Number(b[key]);'],
  ['F2', 'bypass canonical validator, accept any number',
   '    fees[key] = assertMoney(b[key], label);', '    fees[key] = Number(b[key]) || 0;'],
  ['F3', 'allow negative fees',
   '    fees[key] = assertMoney(b[key], label);', '    fees[key] = assertMoney(b[key], label, { allowNegative: true });'],
  ['F4', 'silently round sub-cent instead of rejecting',
   '    fees[key] = assertMoney(b[key], label);', '    fees[key] = Math.round(Number(b[key]) * 100) / 100;'],
  ['F5', 'validate only the first fee field',
   'for (const [key, label] of FEE_FIELDS) {', 'for (const [key, label] of FEE_FIELDS.slice(0, 1)) {'],
  ['F6', 'skip validation when value is a string (coerce text)',
   'if (b[key] === undefined || b[key] === null) { fees[key] = null; continue; }',
   'if (b[key] === undefined || b[key] === null || typeof b[key] === \'string\') { fees[key] = (b[key] ?? null); continue; }'],
  ['F7', 'drop the pass-mark/attendance percent bound',
   'if (n < 0 || n > 100) throw new HttpError(400, `${field} must be between 0 and 100.`);', 'if (false) throw new HttpError(400, \'x\');'],
  ['F8', 'percent accepts non-finite',
   'if (typeof n !== \'number\' || !Number.isFinite(n)) throw new HttpError(400, `${field} must be a finite number.`);', 'if (false) throw new HttpError(400, \'x\');'],
  ['F9', 'CFG-4: revert to NULL placeholders (partial PUT 500s)',
   'keep(fees.registrationFee, \'registration_fee\', 0),', 'fees.registrationFee,'],
  ['F10', 'CFG-4: partial update clobbers untouched fee with 0',
   'keep(fees.cardFee, \'card_fee\', 0),', '(fees.cardFee ?? 0),'],
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
copyFileSync(SRC, BAK);
const original = readFileSync(SRC, 'utf8');
const results = [];
try {
  for (const [id, desc, find, repl] of MUTANTS) {
    if (only && id !== only) continue;
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
