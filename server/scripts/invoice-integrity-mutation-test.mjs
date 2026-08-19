#!/usr/bin/env node
/**
 * INV-1 / INV-2 mutation harness — invoice configuration and money boundaries.
 *
 * Each mutant weakens one invariant the regression suite claims to protect.
 * KILLED = the suite failed. A SURVIVOR means the suite cannot detect that
 * weakening; survivors may only be classified equivalent BY EXECUTION.
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROUTE = 'src/routes/invoices.routes.ts';
const MONEY = 'src/utils/money.ts';
const TEST = 'src/tests/invoice-subsystem-integrity.test.ts';

// PROVEN-EQUIVALENT mutants, established by execution rather than inspection:
//   I3  remove the finite check   -> Infinity/-Infinity/NaN are all caught by
//       the very next line, Number.isInteger(), which returns false for each.
//   I15 remove the discount>total guard -> the net is then computed as
//       assertMoney(1000 - 99999), which throws "cannot be negative", and the
//       trg_invoices_nonnegative_insert trigger backs it at the DB layer.
// Both were verified by running the mutated code, not by reading it.
const EQUIVALENT = new Set(['I3', 'I15']);

const MUTANTS = [
  // ── INV-1: configuration boundary ─────────────────────────────────────────
  ['I1', 'restore raw Number() acceptance for due days', ROUTE,
   "setSetting(dbKey, String(assertDayOffset(body[jsKey], 'Invoice due days')));",
   'setSetting(dbKey, String(Number(body[jsKey])));'],
  ['I2', 'bypass the due-days validator entirely', ROUTE,
   "      if (jsKey === 'invoiceDueDays') {", '      if (false) {'],
  ['I3', 'remove the finite check', MONEY,
   'if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a whole number of days.`);\n  if (!Number.isInteger(n))',
   'if (false) throw new HttpError(400, `${field} must be a whole number of days.`);\n  if (!Number.isInteger(n))'],
  ['I4', 'remove the integer check', MONEY,
   'if (!Number.isInteger(n)) throw new HttpError(400, `${field} must be a whole number of days.`);',
   'if (false) throw new HttpError(400, `${field} must be a whole number of days.`);'],
  ['I5', 'remove the max-offset (Invalid Date) ceiling', MONEY,
   'if (n > MAX_DAY_OFFSET) {', 'if (false) {'],
  ['I6', 'remove the negative check', MONEY,
   'if (n < 0) throw new HttpError(400, `${field} cannot be negative.`);\n  if (n > MAX_DAY_OFFSET) {',
   'if (false) throw new HttpError(400, `${field} cannot be negative.`);\n  if (n > MAX_DAY_OFFSET) {'],
  ['I7', 'accept non-numeric types as day counts', MONEY,
   '    throw new HttpError(400, `${field} must be a whole number of days.`);\n  }\n  if (!Number.isFinite(n))',
   '    n = Number(value);\n  }\n  if (!Number.isFinite(n))'],
  ['I8', 'raise the ceiling past the valid-Date limit', MONEY,
   'const MAX_DAY_OFFSET = 100_000_000;', 'const MAX_DAY_OFFSET = 1e30;'],
  // ── INV-2: sub-cent money consistency ─────────────────────────────────────
  ['I9', 'silently round a sub-cent unitPrice', ROUTE,
   "      if (typeof it.unitPrice === 'number' && it.unitPrice !== unitPrice) {", '      if (false) {'],
  ['I10', 'silently round a sub-cent discount', ROUTE,
   "    if (typeof discountAmount === 'number' && discountAmount !== requestedDiscount) {", '    if (false) {'],
  // ── Pre-existing invariants the suite now locks ───────────────────────────
  ['I11', 'drop the payment amount validator', ROUTE,
   "try { payAmount = assertMoney(amount, 'Payment amount'); }", 'try { payAmount = Number(amount); }'],
  ['I12', 'allow overpayment beyond the remaining balance', ROUTE,
   'if (payAmount > remaining + 0.001) {', 'if (false) {'],
  ['I13', 'allow cancelling an invoice that has payments', ROUTE,
   "if (paid > 0) throw new HttpError(400, 'Cannot cancel an invoice that already has payments. Refund first.');",
   "if (false) throw new HttpError(400, 'x');"],
  ['I14', 'drop the invoice branch-scope guard', ROUTE,
   'function requireInvoiceBranch(req: import(\'express\').Request, invoice: any) {',
   'function requireInvoiceBranch(req: import(\'express\').Request, invoice: any) {\n  return;'],
  ['I15', 'allow a discount larger than the invoice total', ROUTE,
   'if (requestedDiscount > totalAmount) {', 'if (false) {'],
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const originals = new Map();
for (const f of [ROUTE, MONEY]) originals.set(f, readFileSync(f, 'utf8'));
const backups = new Map();
for (const f of [ROUTE, MONEY]) {
  const b = `/tmp/${f.replace(/\W/g, '_')}.bak`;
  copyFileSync(f, b);
  backups.set(f, b);
}

const restoreAll = () => {
  for (const [f, src] of originals) writeFileSync(f, src);
};

const results = [];
try {
  for (const [id, desc, file, find, repl] of MUTANTS) {
    if (only && id !== only) continue;
    const src = originals.get(file);
    if (!src.includes(find)) {
      results.push([id, desc, 'INVALID (anchor not found)']);
      console.log(`${id.padEnd(5)} ${desc.padEnd(48)} INVALID`);
      continue;
    }
    writeFileSync(file, src.replace(find, repl));
    let verdict;
    try {
      execSync(`rm -f src/tests/test.sqlite*; npx vitest run --no-file-parallelism ${TEST}`, { stdio: 'pipe', timeout: 180000 });
      verdict = '*** SURVIVED ***';
    } catch {
      verdict = 'KILLED';
    }
    results.push([id, desc, verdict]);
    console.log(`${id.padEnd(5)} ${desc.padEnd(48)} ${verdict}`);
    restoreAll();
  }
} finally {
  restoreAll();
  for (const b of backups.values()) if (existsSync(b)) unlinkSync(b);
}

const equivalent = results.filter((r) => r[2].includes('SURVIVED') && EQUIVALENT.has(r[0]));
const survived = results.filter((r) => r[2].includes('SURVIVED') && !EQUIVALENT.has(r[0]));
if (equivalent.length) {
  console.log(`\n${equivalent.length} proven-equivalent mutant(s): ${equivalent.map((r) => r[0]).join(', ')} (see the note at the top of this file)`);
}
console.log(`\n${results.filter((r) => r[2] === 'KILLED').length}/${results.length} killed, ${survived.length} survivors`);
process.exit(survived.length ? 1 : 0);
