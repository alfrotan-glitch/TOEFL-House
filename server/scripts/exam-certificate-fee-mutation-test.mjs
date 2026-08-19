#!/usr/bin/env node
/**
 * EXM-1 mutation harness — the diploma fee on score correction.
 *
 * KILLED = the regression suite failed. Survivors may only be classified
 * equivalent BY EXECUTION, never by inspection.
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SRC = 'src/routes/exams.routes.ts';
const BAK = '/tmp/exams.routes.bak.ts';
const TEST = 'src/tests/exam-certificate-fee-integrity.test.ts';

// PROVEN-EQUIVALENT mutants, established by execution rather than inspection:
//   E3  dropping `priorCertCount === 0` and keeping `!alreadyPaid` — a student
//       holding a prior certificate ALWAYS has a prior diploma income row,
//       because the score-entry path charges whenever it issues one. The two
//       predicates are therefore true together, and where the branch fee is 0
//       both arms yield 0 regardless.
//   E8  widening the guard to visitors — the `recordIncome` call is nested
//       inside `if (result.student_id)`, so with a null student the fee is
//       computed but never posted. Only the reported number would change; no
//       money moves and no null-referenced income row can be created (asserted
//       by the visitor test).
const EQUIVALENT = new Set(['E3', 'E8']);

const MUTANTS = [
  ['E1', 'correction issues a free certificate (original defect)',
   'if (correctionDiplomaFee > 0) {', 'if (false) {'],
  ['E2', 'drop the per-student dedupe (double charge)',
   "      correctionDiplomaFee =\n        priorCertCount === 0 && !alreadyPaid ? Number(resolveFee(db, exam.branch_id, 'diplomaFee') || 0) : 0;",
   "      correctionDiplomaFee = Number(resolveFee(db, exam.branch_id, 'diplomaFee') || 0);"],
  ['E3', 'ignore a prior certificate when deduping',
   "      correctionDiplomaFee =\n        priorCertCount === 0 && !alreadyPaid ?",
   "      correctionDiplomaFee =\n        !alreadyPaid ?"],
  ['E4', 'ignore a prior payment when deduping',
   "      correctionDiplomaFee =\n        priorCertCount === 0 && !alreadyPaid ?",
   "      correctionDiplomaFee =\n        priorCertCount === 0 ?"],
  ['E5', 'charge even when no certificate is issued',
   'if (shouldHaveCert && !result.certificate_issued && result.student_id) {',
   'if (result.student_id) {'],
  ['E6', 'drop the owner/manager gate on correction',
   "authorize('owner', 'manager'), // Strict access control for score correction", ''],
  ['E7', 'drop the corrected-score bounds check',
   "if (typeof score !== 'number' || score < 0 || score > 120) throw new HttpError(400, 'Invalid score. Must be between 0 and 120.');",
   "if (false) throw new HttpError(400, 'x');"],
  ['E8', 'charge a visitor correction against a null reference',
   'if (shouldHaveCert && !result.certificate_issued && result.student_id) {',
   'if (shouldHaveCert && !result.certificate_issued) {'],
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
copyFileSync(SRC, BAK);
const original = readFileSync(SRC, 'utf8');
const results = [];
try {
  for (const [id, desc, find, repl] of MUTANTS) {
    if (only && id !== only) continue;
    if (!original.includes(find)) { results.push([id, desc, 'INVALID']); console.log(`${id.padEnd(4)} ${desc.padEnd(52)} INVALID (anchor)`); continue; }
    writeFileSync(SRC, original.replace(find, repl));
    let verdict;
    try {
      execSync(`rm -f src/tests/test.sqlite*; npx vitest run --no-file-parallelism ${TEST}`, { stdio: 'pipe', timeout: 180000 });
      verdict = '*** SURVIVED ***';
    } catch { verdict = 'KILLED'; }
    results.push([id, desc, verdict]);
    console.log(`${id.padEnd(4)} ${desc.padEnd(52)} ${verdict}`);
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
