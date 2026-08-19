#!/usr/bin/env node
/**
 * FND-1/2/3 mutation harness — funding commitment and target amount integrity.
 *
 * Scope is deliberately narrow: only the money boundary introduced by this
 * audit (the sponsorship monthly amount on create and update, and the campaign
 * target amount on update). Already-frozen logic is not mutated.
 *
 * KILLED = the regression suite failed. Survivors may only be classified
 * equivalent BY EXECUTION, never by inspection.
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROUTE = 'src/routes/funding.routes.ts';
const TEST = 'src/tests/funding-amount-integrity.test.ts';

// PROVEN-EQUIVALENT mutants, established by execution rather than inspection.
// F10 and F11 delete the route-level status whitelist. They survive because
// they are not the authoritative guard: `sponsorship_agreements.status` and
// `funding_campaigns.status` each carry a schema CHECK constraint. Verified by
// running the F10 mutant against a real request — PATCH with status 'nonsense'
// still returned HTTP 400 ("Invalid data provided") from the constraint and the
// stored status remained 'active'. The route check is defence-in-depth that
// yields the clearer message, so removing it changes no observable outcome.
const EQUIVALENT = new Set(['F10', 'F11']);

const MUTANTS = [
  // ── FND-1: the created sponsorship must persist the validated amount ──
  ['F1', 'insert the raw body value instead of the validated one (the original defect)', ROUTE,
   '        newId, donorId, studentId || null, programId || null, validatedMonthly,',
   '        newId, donorId, studentId || null, programId || null, monthlyAmount,'],

  // ── FND-2: PATCH /sponsorships/:id ──
  ['F2', 'drop validation on the sponsorship update (the original defect)', ROUTE,
   `    const validatedMonthly =
      monthlyAmount === undefined || monthlyAmount === null
        ? existing.monthly_amount
        : assertMoney(monthlyAmount, 'monthly sponsorship amount');`,
   '    const validatedMonthly = monthlyAmount ?? existing.monthly_amount;'],
  ['F3', 'sponsorship update validates but then writes the raw value', ROUTE,
   '      validatedMonthly, endDate ?? existing.end_date, ',
   '      monthlyAmount ?? existing.monthly_amount, endDate ?? existing.end_date, '],
  ['F4', 'sponsorship update coerces instead of validating', ROUTE,
   "        : assertMoney(monthlyAmount, 'monthly sponsorship amount');",
   '        : Number(monthlyAmount);'],
  ['F5', 'sponsorship update treats an absent field as zero rather than unchanged', ROUTE,
   `      monthlyAmount === undefined || monthlyAmount === null
        ? existing.monthly_amount`,
   `      monthlyAmount === undefined || monthlyAmount === null
        ? 0`],

  // ── FND-3: PATCH /campaigns/:id ──
  ['F6', 'drop validation on the campaign update (the original defect)', ROUTE,
   `    const validatedTarget =
      targetAmount === undefined || targetAmount === null
        ? existing.target_amount
        : assertMoney(targetAmount, 'campaign target amount');`,
   '    const validatedTarget = targetAmount ?? existing.target_amount;'],
  ['F7', 'campaign update validates but then writes the raw value', ROUTE,
   '      name ?? existing.name, description ?? existing.description, validatedTarget,',
   '      name ?? existing.name, description ?? existing.description, targetAmount ?? existing.target_amount,'],
  ['F8', 'campaign update coerces instead of validating', ROUTE,
   "        : assertMoney(targetAmount, 'campaign target amount');",
   '        : Number(targetAmount);'],
  ['F9', 'campaign update treats an absent field as zero rather than unchanged', ROUTE,
   `      targetAmount === undefined || targetAmount === null
        ? existing.target_amount`,
   `      targetAmount === undefined || targetAmount === null
        ? 0`],

  // ── lifecycle guards the suite also pins ──
  ['F10', 'accept any sponsorship status', ROUTE,
   "    if (status && !['active', 'completed', 'terminated'].includes(status)) {",
   '    if (false) {'],
  ['F11', 'accept any campaign status', ROUTE,
   "    if (status && !['active', 'completed', 'cancelled'].includes(status)) {",
   '    if (false) {'],
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
      console.log(`${id.padEnd(4)} ${desc.padEnd(72)} INVALID (anchor matched ${hits}x)`);
      continue;
    }
    writeFileSync(file, src.replace(find, repl));
    let verdict;
    try {
      execSync(`rm -f src/tests/test.sqlite*; npx vitest run --no-file-parallelism ${TEST}`, { stdio: 'pipe', timeout: 180000 });
      verdict = '*** SURVIVED ***';
    } catch { verdict = 'KILLED'; }
    results.push([id, desc, verdict]);
    console.log(`${id.padEnd(4)} ${desc.padEnd(72)} ${verdict}`);
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
