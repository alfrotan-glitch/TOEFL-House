#!/usr/bin/env node
/**
 * BOS-1 mutation harness — the cumulative profit-withdrawal ceiling.
 *
 * KILLED = the regression suite failed. Survivors may only be classified
 * equivalent BY EXECUTION, never by inspection.
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SRC = 'src/routes/bos.routes.ts';
const BAK = '/tmp/bos.routes.bak.ts';
const TEST = 'src/tests/bos-profit-withdrawal-integrity.test.ts';

// B6 is a PROVEN-EQUIVALENT mutant, established by execution rather than
// inspection. Removing the route's `amount > currentMainBalance` pre-check does
// not let the money out: `decrementMainBalanceIfSufficient` is a single
// conditional UPDATE (`... WHERE main_balance >= ?`) that returns false when the
// cash is short, and the route then raises the same HTTP 409. Verified by
// running the mutated route against the cash-shortfall test. The pre-check is
// deliberate defence-in-depth and produces the clearer error message.
const EQUIVALENT = new Set(['B6']);

const MUTANTS = [
  ['B1', 'ceiling ignores prior distributions (original defect)',
   'const maxWithdrawable = Math.max(0, assertMoney(periodAllowance - distributed,',
   'const maxWithdrawable = Math.max(0, assertMoney(periodAllowance - 0,'],
  ['B2', 'gross profit reverts to net (tier replenishes)',
   "const profit = assertMoney(revenue - expense + distributed, 'calculated profit', { allowNegative: true });",
   "const profit = assertMoney(revenue - expense, 'calculated profit', { allowNegative: true });"],
  ['B3', 'remove the over-limit check entirely',
   'if (amount > maxWithdrawable) {', 'if (false) {'],
  ['B4', 'calculate endpoint reports the replenished ceiling',
   'const maxWithdrawable = reserveMet ? Math.max(0, periodAllowance - distributed) : 0;',
   'const maxWithdrawable = reserveMet ? periodAllowance : 0;'],
  ['B5', 'remove the reserve-fund guard',
   'if (reserveFundBalance < reserveFundTarget) {', 'if (false) {'],
  ['B6', 'remove the cash-sufficiency guard',
   'if (amount > currentMainBalance) throw new HttpError(409,',
   'if (false) throw new HttpError(409,'],
  ['B7', 'remove the owner-only gate',
   'if (!req.rbac || !isGlobalOwner(req.rbac)) {', 'if (false) {'],
  ['B8', 'accept any amount (drop assertMoney)',
   "try { amount = assertMoney(rawAmount, 'withdrawal amount'); }", 'try { amount = Number(rawAmount); }'],
  ['B9', 'allow zero/negative withdrawal',
   'if (amount <= 0) throw new HttpError(400, ', 'if (false) throw new HttpError(400, '],
  ['B10', 'tier floor removed (withdraw below 10% margin)',
   'if (marginPercent < 10) return 0;', 'if (marginPercent < 10) return 20;'],
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
copyFileSync(SRC, BAK);
const original = readFileSync(SRC, 'utf8');
const results = [];
try {
  for (const [id, desc, find, repl] of MUTANTS) {
    if (only && id !== only) continue;
    if (!original.includes(find)) { results.push([id, desc, 'INVALID']); console.log(`${id.padEnd(5)} ${desc.padEnd(52)} INVALID (anchor)`); continue; }
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
const equivalent = results.filter((r) => r[2].includes('SURVIVED') && EQUIVALENT.has(r[0]));
const survived = results.filter((r) => r[2].includes('SURVIVED') && !EQUIVALENT.has(r[0]));
if (equivalent.length) console.log(`\n${equivalent.length} proven-equivalent mutant(s): ${equivalent.map((r) => r[0]).join(', ')} (see the note at the top of this file)`);
console.log(`\n${results.filter((r) => r[2] === 'KILLED').length}/${results.length} killed, ${survived.length} survivors`);
process.exit(survived.length ? 1 : 0);
