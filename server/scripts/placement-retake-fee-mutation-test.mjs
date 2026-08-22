#!/usr/bin/env node
/**
 * PLC-1 mutation harness — placement retake fee configuration boundary.
 *
 * Scope is deliberately narrow: only the money boundary introduced by this
 * audit (retakeFeeAmount validation on the placement-profile configuration
 * endpoint) and the billing decision it feeds. Already-frozen logic is not
 * mutated.
 *
 * KILLED = the regression suite failed. Survivors may only be classified
 * equivalent BY EXECUTION, never by inspection.
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROUTE = 'src/routes/academic.routes.ts';
const POLICY = 'src/core/placement/placement-policy.ts';
// Re-pointed (TR4-R14 / TR4-F11): the original target
// `src/tests/placement-retake-fee-integrity.test.ts` is one of the 13 legacy
// placement suites D-85 retired as explicit skipped knowledge records, so the
// harness measured vacuously (every applicable mutant "survived" against a
// suite that cannot fail). The live WP-04 replacements below drive the exact
// mutated route (`PUT /api/academic/program-versions/:id/placement-profile`)
// and the mutated billing decision (`feeCharged`, `payment.amount`).
const TESTS =
  'src/tests/work-packages/wp04/retake-billing.integration.test.ts ' +
  'src/tests/work-packages/wp04/profile-policy.integration.test.ts';

// PROVEN-EQUIVALENT mutants, established by execution rather than inspection.
//
// P5 drops the `>= 0` filter on the configured retake fee. Executing both
// expressions side by side shows they DIFFER for a negative fee (fixed: falls
// back to the 300 base fee; mutant: bills 0 and marks it unbillable) and are
// identical for 0, 150 and null. The mutant is nevertheless unobservable,
// because a negative value cannot reach the column: grep shows exactly one
// writer of `retake_fee_amount` (stmtUpsertPlacementProfile in
// academic.routes.ts), and driving that route with -5, -0.01, '-250' and -1e9
// now returns HTTP 400 with the column left null every time, leaving 0 negative
// rows in the table. The `>= 0` guard is defence-in-depth against a legacy row
// (migration 070 added the column as nullable with no CHECK and backfilled only
// NULL), so it is retained deliberately rather than removed.
const EQUIVALENT = new Set(['P5']);

// P1–P3 re-based (TR4-R14 / TR4-F10): the route now reads
// `const retakeFeeAmount = validateMoney(body.retakeFeeAmount, 'retakeFeeAmount');`
// (validateMoney = assertMoney behind a nullable wrapper), so the original
// anchors — written against the pre-refactor inline `assertMoney` conditional —
// matched 0x. Each mutant below preserves its documented semantics against the
// current code shape.
const MUTANTS = [
  ['P1', 'restore the original weak guard (the defect)', ROUTE,
   `  const retakeFeeAmount = validateMoney(body.retakeFeeAmount, 'retakeFeeAmount');`,
   `  const retakeFeeAmount = body.retakeFeeAmount == null || body.retakeFeeAmount === ''
    ? null
    : Number(body.retakeFeeAmount);
  if (retakeFeeAmount != null && (!Number.isFinite(retakeFeeAmount) || retakeFeeAmount < 0)) throw new HttpError(400, 'retakeFeeAmount must be a non-negative amount.');`],

  ['P2', 'bypass the validator entirely, coerce the raw input', ROUTE,
   `  const retakeFeeAmount = validateMoney(body.retakeFeeAmount, 'retakeFeeAmount');`,
   `  const retakeFeeAmount = body.retakeFeeAmount == null || body.retakeFeeAmount === '' ? null : Number(body.retakeFeeAmount);`],

  ['P3', 'treat an omitted retake fee as zero rather than null', ROUTE,
   `  const retakeFeeAmount = validateMoney(body.retakeFeeAmount, 'retakeFeeAmount');`,
   `  const retakeFeeAmount = body.retakeFeeAmount == null || body.retakeFeeAmount === ''
    ? 0
    : validateMoney(body.retakeFeeAmount, 'retakeFeeAmount');`],

  // ── the billing decision this fee feeds ──
  ['P4', 'retake billing ignores the configured retake fee and uses the base fee', POLICY,
   '  const retakeFee = policy.retakeFeeAmount != null && policy.retakeFeeAmount >= 0 ? policy.retakeFeeAmount : baseFee;',
   '  const retakeFee = baseFee;'],

  ['P5', 'retake billing accepts a negative configured fee', POLICY,
   '  const retakeFee = policy.retakeFeeAmount != null && policy.retakeFeeAmount >= 0 ? policy.retakeFeeAmount : baseFee;',
   '  const retakeFee = policy.retakeFeeAmount != null ? policy.retakeFeeAmount : baseFee;'],

  ['P6', 'first sitting is billed at the retake fee', POLICY,
   "      ? { billable: true, amount: baseFee, reason: 'first_attempt' }",
   "      ? { billable: true, amount: policy.retakeFeeAmount ?? baseFee, reason: 'first_attempt' }"],

  ['P7', 'retakes become unbillable regardless of policy', POLICY,
   "  if (!policy.retakeBillable) return { billable: false, amount: 0, reason: 'policy_retakes_free' };",
   "  if (true) return { billable: false, amount: 0, reason: 'policy_retakes_free' };"],
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const FILES = [ROUTE, POLICY];
const originals = new Map();
for (const f of FILES) originals.set(f, readFileSync(f, 'utf8'));
const backups = new Map();
for (const f of FILES) { const b = `/tmp/${f.replace(/\W/g, '_')}.bak`; copyFileSync(f, b); backups.set(f, b); }
const restoreAll = () => { for (const [f, src] of originals) writeFileSync(f, src); };

const results = [];
try {
  for (const [id, desc, file, find, repl] of MUTANTS) {
    if (only && id !== only) continue;
    const src = originals.get(file);
    const hits = src.split(find).length - 1;
    if (hits !== 1) {
      results.push([id, desc, 'INVALID']);
      console.log(`${id.padEnd(4)} ${desc.padEnd(64)} INVALID (anchor matched ${hits}x)`);
      continue;
    }
    writeFileSync(file, src.replace(find, repl));
    let verdict;
    let out = '';
    let threw = false;
    try {
      out = execSync(`rm -f src/tests/test.sqlite*; npx vitest run --no-file-parallelism ${TESTS}`, { encoding: 'utf8', timeout: 180000 });
    } catch (e) {
      threw = true;
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    // TR4-F11 guard: a suite that executes zero tests (everything skipped or
    // missing) cannot fail, so it can kill nothing. That is a VOID measurement,
    // never a survivor — and it fails the harness so the drift is visible.
    if (/No test files found/.test(out)) {
      verdict = 'INVALID (target suite not found)';
    } else if (/Tests\s+0\s+passed/.test(out)) {
      verdict = '*** SUITE-SKIPPED — MEASUREMENT VOID ***';
    } else {
      verdict = threw ? 'KILLED' : '*** SURVIVED ***';
    }
    results.push([id, desc, verdict]);
    console.log(`${id.padEnd(4)} ${desc.padEnd(64)} ${verdict}`);
    restoreAll();
  }
} finally {
  restoreAll();
  for (const b of backups.values()) if (existsSync(b)) unlinkSync(b);
}
const equivalent = results.filter((r) => r[2].includes('SURVIVED') && EQUIVALENT.has(r[0]));
const survived = results.filter((r) => r[2].includes('SURVIVED') && !EQUIVALENT.has(r[0]));
const voidRuns = results.filter((r) => r[2].includes('VOID'));
if (equivalent.length) console.log(`\n${equivalent.length} proven-equivalent mutant(s): ${equivalent.map((r) => r[0]).join(', ')} (see the note at the top of this file)`);
if (voidRuns.length) console.log(`${voidRuns.length} VOID measurement(s): ${voidRuns.map((r) => r[0]).join(', ')} — the target suite executed 0 tests; a suite that cannot fail cannot kill`);
console.log(`\n${results.filter((r) => r[2] === 'KILLED').length}/${results.length} killed, ${survived.length} survivors`);
process.exit(survived.length || voidRuns.length ? 1 : 0);
