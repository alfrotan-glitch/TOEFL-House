#!/usr/bin/env node
/**
 * MUTATION HARNESS GATE
 * ============================================================================
 * Runs every `*-mutation-test.mjs` harness in this directory and fails if any
 * of them fails.
 *
 * WHY THIS EXISTS
 * ---------------
 * The harnesses are the only artifacts in this repository that test whether the
 * TESTS work: each restores a known defect and requires the suite to fail. No
 * gate executed them, so they rotted unnoticed — an independent run found three
 * of five already failing, one of them carrying the original defect it was
 * written to catch (TR4-F1, TR4-F2).
 *
 * WHAT THIS SCRIPT DOES NOT DO
 * ----------------------------
 * It does not edit a harness, weaken an assertion, or decide that a surviving
 * mutant is "equivalent". A survivor is an unresolved finding until a reviewer
 * classifies it, and classification belongs in the harness's own EQUIVALENT set
 * with a written reason — never here, and never silently.
 *
 * EXIT CODE IS READ FROM THE PROCESS, NOT FROM A PIPE. Piping a harness into
 * `tail` returns tail's status and made three failing harnesses look green.
 *
 * Usage:
 *   node scripts/run-mutation-harnesses.mjs            # all harnesses
 *   node scripts/run-mutation-harnesses.mjs --only finance-money-writer
 *   node scripts/run-mutation-harnesses.mjs --json out.json
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;

const harnesses = readdirSync(HERE)
  .filter((f) => f.endsWith('-mutation-test.mjs'))
  .filter((f) => (only ? f.includes(only) : true))
  .sort();

if (harnesses.length === 0) {
  console.error(only ? `No harness matches "${only}".` : 'No mutation harnesses found.');
  process.exit(1);
}

/** Pull the harness's own tally out of its output without interpreting it. */
function summarise(output) {
  const survivors = [...output.matchAll(/^\s*(\S+)\s+.*\*\*\* SURVIVED \*\*\*/gm)].map((m) => m[1]);
  const alt = [...output.matchAll(/^\s*(\S+)\s+SURVIVED\s/gm)].map((m) => m[1]);
  // TR4-F10: anchors that match 0x mean the harness measured LESS than it
  // claims. Surfaced here so drift is visible without reading per-mutant logs.
  // (Also matches the array-style harnesses that print the description between
  // the id and the verdict — journey prints "J1 <desc> INVALID (anchor …)".)
  const invalid = [
    ...output.matchAll(/^\s*(\S+)\s+INVALID/gm),
    ...output.matchAll(/^\s*(\S+)\s+.*\sINVALID\s/gm),
  ].map((m) => m[1]);
  const voidRuns = [...output.matchAll(/^\s*(\S+)\s+.*MEASUREMENT VOID/gm)].map((m) => m[1]);
  // TR-4 Bucket-1: retired mutants with written evidence, reported distinctly.
  const obsolete = [...output.matchAll(/^\s*(\S+)\s+OBSOLETE/gm)].map((m) => m[1]);
  // Harnesses classify their own proven-equivalent survivors and print a
  // summary line naming them. Those ids SURVIVED by execution but carry a
  // written proof of equivalence — counting them in the survivor line
  // overstates the unresolved finding count (audit F-M note: the gate line
  // used to say "10 surviving reported" with 0 actual findings).
  const provenEquivalent = [
    ...output.matchAll(/proven-equivalent mutant\(s\):\s*([A-Za-z0-9_,\s]+?)(?:\s*\(see|$)/gm),
  ].flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
  const tallyLine = output.match(/^.*killed.*$/m) ?? output.match(/^KILLED:.*$/m);
  const tally = tallyLine ? String(tallyLine[0]).trim() : '';
  return {
    survivors: [...new Set([...survivors, ...alt])].filter((id) => !provenEquivalent.includes(id)),
    invalid: [...new Set(invalid)],
    voidRuns: [...new Set(voidRuns)],
    obsolete: [...new Set(obsolete)],
    equivalent: [...new Set(provenEquivalent)],
    tally,
  };
}

console.log(`Mutation harness gate — ${harnesses.length} harness(es)\n`);

const results = [];
for (const file of harnesses) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join('scripts', file)], {
    cwd: SERVER,
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const code = run.status === null ? 124 : run.status;
  const { survivors, invalid, voidRuns, obsolete, tally } = summarise(output);
  const seconds = Math.round((Date.now() - started) / 1000);
  results.push({ harness: file, exitCode: code, survivors, invalid, voidRuns, obsolete, tally, seconds });

  const verdict = code === 0 ? 'PASS' : 'FAIL';
  console.log(
    `  ${verdict.padEnd(4)}  ${file.replace('-mutation-test.mjs', '').padEnd(34)} ${String(seconds).padStart(4)}s  ${tally}`,
  );
  if (survivors.length > 0) console.log(`        survivors: ${survivors.join(', ')}`);
  if (invalid.length > 0) console.log(`        INVALID anchors (measurement lost): ${invalid.join(', ')}`);
  if (voidRuns.length > 0) console.log(`        VOID runs (target suite skipped): ${voidRuns.join(', ')}`);
  if (obsolete.length > 0) console.log(`        obsolete (documented retirement): ${obsolete.join(', ')}`);
}

const failed = results.filter((r) => r.exitCode !== 0);
const survivorCount = results.reduce((n, r) => n + r.survivors.length, 0);
const invalidCount = results.reduce((n, r) => n + r.invalid.length, 0);
const voidCount = results.reduce((n, r) => n + r.voidRuns.length, 0);
const obsoleteCount = results.reduce((n, r) => n + r.obsolete.length, 0);

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`\n  results written to ${jsonOut}`);
}

console.log(`\n──────────────────────────────────────────────────────────`);
console.log(`  ${results.length - failed.length} passed · ${failed.length} failed · ${survivorCount} surviving mutant(s) reported`);
const equivalentCount = results.reduce((n, r) => n + (r.equivalent?.length ?? 0), 0);
if (equivalentCount > 0) console.log(`  ${equivalentCount} proven-equivalent mutant(s) — survived by execution, equivalence proven and documented in the harness`);
if (invalidCount > 0) console.log(`  ${invalidCount} INVALID anchor(s) — intended measurement(s) that could not be applied`);
if (voidCount > 0) console.log(`  ${voidCount} VOID run(s) — target suite executed no tests\n`);
if (obsoleteCount > 0) console.log(`  ${obsoleteCount} obsolete mutant(s) — retired with recorded evidence in the harness`);

if (failed.length > 0) {
  console.error('  MUTATION GATE FAILED');
  console.error('  A surviving mutant means the suite cannot detect a defect it is');
  console.error('  supposed to detect. Classify it in the harness EQUIVALENT set with');
  console.error('  a written reason, or repair the coverage. Do not silence it here.\n');
  process.exit(1);
}

console.log('  MUTATION GATE PASSED\n');
