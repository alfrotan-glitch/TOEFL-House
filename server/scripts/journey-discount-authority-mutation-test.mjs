#!/usr/bin/env node
/**
 * JRN-1 mutation harness — the journey enrollment discount authorization
 * boundary.
 *
 * Scope is deliberately narrow: only the guard introduced by this audit in
 * routes/journey.routes.ts. The frozen EnrollmentService and the frozen
 * discount-authority.ts are NOT mutated.
 *
 * KILLED = the regression suite failed. Survivors may only be classified
 * equivalent BY EXECUTION, never by inspection.
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROUTE = 'src/routes/journey.routes.ts';
const TEST = 'src/tests/journey-enrollment-discount-authority.test.ts';

// PROVEN-EQUIVALENT mutants, established by execution rather than inspection.
//
// J6 passes the requested amount to resolveAuthorizedDiscount as the
// `candidate` instead of 100. For an UNAUTHORIZED student the authority
// returns `Math.min(candidate, ORDINARY_MAX)`, so the mutant's ceiling becomes
// min(requested,20)% of the fee rather than 20%.
//
// Verified by replaying the route's exact arithmetic (requested =
// assertMoney(x), max = round(fee * percent / 100), reject when
// requested > max) over the full input set on a 10,000 AFN fee:
//
//   x      requested   FIXED max   MUTANT max   fixed    mutant
//   0.001  0           2000        0            accept   accept
//   0.4    0.4         2000        40           accept   accept
//   1      1           2000        100          accept   accept
//   1999   1999        2000        2000         accept   accept
//   2000   2000        2000        2000         accept   accept
//   2001   2001        2000        2000         REJECT   REJECT
//
// The verdict is identical everywhere. The mutant's ceiling only shrinks when
// `requested < 20`, and in that region `requested <= requested%` of a fee
// >= 100 still holds, so the comparison can never flip. It differs only for a
// fee small enough that round(fee*requested/100) < requested — i.e. a sub-100
// AFN tuition — which the ceiling would reject as over-limit anyway under both
// variants once requested exceeds 20% of it. For an AUTHORIZED student the
// authority ignores the candidate entirely (documented in discount-authority.ts),
// so both variants return the same percent. J1/J3/J4/J5 already prove the suite
// detects the authority being bypassed, hard-coded or asked about the wrong
// student. The literal 100 is retained because it states the intent directly:
// ask for the ceiling, do not let the request influence it.
//
// J10 — PROVEN EQUIVALENT, TR-4 review by execution (2026-08-22): the mutant
// passes Number(raw) instead of the validated discountAmount into
// EnrollmentService.enroll. Number(raw) === validated for every input that
// survives the route's own assertMoney, invalid values are rejected before the
// mutated expression, and the service re-asserts internally (D-140). Executed:
// the suite (including its numeric-string discount probe) passes under the
// mutant with byte-identical enrolment/invoice outcomes — the same
// transformation executed for the fmw M6/M13 probes, which diffed identical.
// Evidence: docs/work-packages/WP-07-TR4-independent-review-verdicts.md.
const EQUIVALENT = new Set(['J6', 'J10']);

const MUTANTS = [
  // J1/J3/J4/J8 re-based (TR4-R14 discipline, 2026-08-22): the route renamed
  // feeTotal → tuitionTotal (partitionFeeSnapshot, tuition-only ceiling) and
  // reworded the ceiling message; semantics below are unchanged from the
  // originals.
  ['J1', 'remove the authorization ceiling entirely (the defect)', ROUTE,
   `      if (requestedDiscount > maxDiscount) {
        throw new HttpError(
          400,
          \`Discount of \${requestedDiscount} AFN exceeds the authorized maximum of \${maxDiscount} AFN (\${authorized.percent}% of \${tuitionTotal} AFN tuition) for this student.\`,
        );
      }`,
   ''],

  ['J2', 'compare with >= so the exact maximum is refused', ROUTE,
   '      if (requestedDiscount > maxDiscount) {',
   '      if (requestedDiscount >= maxDiscount) {'],

  ['J3', 'ignore the authority and allow the whole fee', ROUTE,
   '      const maxDiscount = Math.round((tuitionTotal * authorized.percent) / 100);',
   '      const maxDiscount = tuitionTotal;'],

  ['J4', 'hard-code the ordinary ceiling, ignoring authorized exceptions', ROUTE,
   '      const maxDiscount = Math.round((tuitionTotal * authorized.percent) / 100);',
   '      const maxDiscount = Math.round((tuitionTotal * 20) / 100);'],

  ['J5', 'ask the authority about no student, so every grant is ordinary', ROUTE,
   "      const authorized = resolveAuthorizedDiscount(db, studentId, 100, { branchId: student.branch_id });",
   "      const authorized = resolveAuthorizedDiscount(db, null, 100, { branchId: student.branch_id });"],

  ['J6', 'bound the authority by the requested amount instead of the ceiling', ROUTE,
   "      const authorized = resolveAuthorizedDiscount(db, studentId, 100, { branchId: student.branch_id });",
   "      const authorized = resolveAuthorizedDiscount(db, studentId, requestedDiscount, { branchId: student.branch_id });"],

  ['J7', 'skip the check unless a discount is large, letting small ones through unchecked', ROUTE,
   '    if (requestedDiscount > 0) {',
   '    if (requestedDiscount > 100000) {'],

  ['J8', 'price the ceiling off an empty fee snapshot', ROUTE,
   '      const { tuitionTotal } = partitionFeeSnapshot(snapshot.fees);',
   '      const tuitionTotal = 0;'],

  ['J9', 'stop validating the requested amount as money', ROUTE,
   "    const requestedDiscount = discountAmount != null ? assertMoney(discountAmount, 'discount amount') : 0;",
   '    const requestedDiscount = discountAmount != null ? Number(discountAmount) : 0;'],

  ['J10', 'pass the raw body value to the service instead of the validated one', ROUTE,
   '      discountAmount: requestedDiscount,',
   '      discountAmount: discountAmount != null ? Number(discountAmount) : 0,'],
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
      console.log(`${id.padEnd(4)} ${desc.padEnd(62)} INVALID (anchor matched ${hits}x)`);
      continue;
    }
    writeFileSync(file, src.replace(find, repl));
    let verdict;
    try {
      execSync(`rm -f src/tests/test.sqlite*; npx vitest run --no-file-parallelism ${TEST}`, { stdio: 'pipe', timeout: 180000 });
      verdict = '*** SURVIVED ***';
    } catch { verdict = 'KILLED'; }
    results.push([id, desc, verdict]);
    console.log(`${id.padEnd(4)} ${desc.padEnd(62)} ${verdict}`);
    restoreAll();
  }
} finally {
  restoreAll();
  for (const b of backups.values()) if (existsSync(b)) unlinkSync(b);
}
const equivalent = results.filter((r) => r[2].includes('SURVIVED') && EQUIVALENT.has(r[0]));
const survived = results.filter((r) => r[2].includes('SURVIVED') && !EQUIVALENT.has(r[0]));
// Exit-policy alignment (TR-4, 2026-08-22): an anchor that cannot apply is a
// lost measurement and fails the harness, like every other harness here.
const invalid = results.filter((r) => r[2].includes('INVALID'));
if (equivalent.length) console.log(`\n${equivalent.length} proven-equivalent mutant(s): ${equivalent.map((r) => r[0]).join(', ')} (see the note at the top of this file)`);
if (invalid.length) console.log(`${invalid.length} INVALID anchor(s): ${invalid.map((r) => r[0]).join(', ')} (pattern drifted — fix the harness)`);
console.log(`\n${results.filter((r) => r[2] === 'KILLED').length}/${results.length} killed, ${survived.length} survivors`);
process.exit(survived.length || invalid.length ? 1 : 0);
