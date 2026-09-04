#!/usr/bin/env node
/**
 * BOS-1 mutation harness — the cumulative profit-withdrawal ceiling.
 *
 * KILLED = the regression suite failed. Survivors may only be classified
 * equivalent BY EXECUTION, never by inspection.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const TEST = 'src/tests/work-packages/wp11/bos-profit-withdrawal-integrity.test.ts';

// B6 is a PROVEN-EQUIVALENT mutant, established by execution rather than
// inspection. Removing the route's `amount > currentMainBalance` pre-check does
// not let the money out: `decrementMainBalanceIfSufficient` is a single
// conditional UPDATE (`... WHERE main_balance >= ?`) that returns false when the
// cash is short, and the route then raises the same HTTP 409. Verified by
// running the mutated route against the cash-shortfall test. The pre-check is
// deliberate defence-in-depth and produces the clearer error message.
const EQUIVALENT = new Set(['B6']);

// TR4-R14 re-base (2026-08-22): B1/B2/B4/B10's subjects moved into the shared
// authority src/core/finance/profit-distribution.ts (computeProfitDistribution
// and resolveDistributionTier); B3/B5/B6 remain route-level guards. Entry
// format gained a per-mutant file element; semantics are unchanged.
const ROUTE = 'src/routes/bos.routes.ts';
const CORE = 'src/core/finance/profit-distribution.ts';

const MUTANTS = [
  ['B1', 'ceiling ignores prior distributions (original defect)', CORE,
   "assertComputedMoney(periodAllowance - distributed, 'remaining allowance', {",
   "assertComputedMoney(periodAllowance - 0, 'remaining allowance', {"],
  ['B2', 'gross profit reverts to net (tier replenishes)', CORE,
   "const profit = assertComputedMoney(revenue - expense + distributed, 'calculated profit', {",
   "const profit = assertComputedMoney(revenue - expense, 'calculated profit', {"],
  ['B3', 'remove the over-limit check entirely', ROUTE,
   'if (amount > position.remainingAllowance) {', 'if (false) {'],
  ['B4', 'calculate endpoint reports the replenished ceiling', CORE,
   '  const maxWithdrawable = reserveFundMet\n    ? Math.min(remainingAllowance, mainBalance, liquidityHeadroom)\n    : 0;',
   '  const maxWithdrawable = reserveFundMet\n    ? Math.min(periodAllowance, mainBalance, liquidityHeadroom)\n    : 0;'],
  ['B5', 'remove the reserve-fund guard', ROUTE,
   'if (!position.reserveFundMet) {', 'if (false) {'],
  ['B6', 'remove the cash-sufficiency guard', ROUTE,
   'if (amount > position.mainBalance) {', 'if (false) {'],
  ['B7', 'remove the owner-only gate', ROUTE,
   "  '/profit-distribution/withdraw',\n  requireGlobalOwner,",
   "  '/profit-distribution/withdraw',\n  (_req, _res, next) => { next(); },"],
  ['B8', 'accept any amount (drop assertMoney)', ROUTE,
   "try { amount = assertMoney(rawAmount, 'withdrawal amount'); }", 'try { amount = Number(rawAmount); }'],
  ['B9', 'allow zero/negative withdrawal', ROUTE,
   'if (amount <= 0) throw new HttpError(400, ', 'if (false) throw new HttpError(400, '],
  ['B10', 'tier floor removed (withdraw below 10% margin)', CORE,
   '  return 0;\n}',
   '  return TREASURY_DEFAULTS.profitDistributionTiers[TREASURY_DEFAULTS.profitDistributionTiers.length - 1].sharePercent;\n}'],
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const originals = new Map();
for (const f of [ROUTE, CORE]) originals.set(f, readFileSync(f, 'utf8'));
const restoreAll = () => { for (const [f, src] of originals) writeFileSync(f, src); };
const results = [];
try {
  for (const [id, desc, file, find, repl] of MUTANTS) {
    if (only && id !== only) continue;
    const src = originals.get(file);
    const hits = src.split(find).length - 1;
    if (hits !== 1) { results.push([id, desc, 'INVALID']); console.log(`${id.padEnd(5)} ${desc.padEnd(52)} INVALID (anchor matched ${hits}x)`); continue; }
    writeFileSync(file, src.replace(find, repl));
    let verdict;
    try {
      execSync(`rm -f src/tests/test.sqlite*; npx vitest run --no-file-parallelism ${TEST}`, { stdio: 'pipe', timeout: 180000 });
      verdict = '*** SURVIVED ***';
    } catch { verdict = 'KILLED'; }
    results.push([id, desc, verdict]);
    console.log(`${id.padEnd(5)} ${desc.padEnd(52)} ${verdict}`);
    writeFileSync(file, src);
  }
} finally {
  restoreAll();
}
const equivalent = results.filter((r) => r[2].includes('SURVIVED') && EQUIVALENT.has(r[0]));
const survived = results.filter((r) => r[2].includes('SURVIVED') && !EQUIVALENT.has(r[0]));
if (equivalent.length) console.log(`\n${equivalent.length} proven-equivalent mutant(s): ${equivalent.map((r) => r[0]).join(', ')} (see the note at the top of this file)`);
console.log(`\n${results.filter((r) => r[2] === 'KILLED').length}/${results.length} killed, ${survived.length} survivors`);
process.exit(survived.length ? 1 : 0);
