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
  const tallyLine = output.match(/^.*killed.*$/m) ?? output.match(/^KILLED:.*$/m);
  const tally = tallyLine ? String(tallyLine[0]).trim() : '';
  return { survivors: [...new Set([...survivors, ...alt])], tally };
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
  const { survivors, tally } = summarise(output);
  const seconds = Math.round((Date.now() - started) / 1000);
  results.push({ harness: file, exitCode: code, survivors, tally, seconds });

  const verdict = code === 0 ? 'PASS' : 'FAIL';
  console.log(
    `  ${verdict.padEnd(4)}  ${file.replace('-mutation-test.mjs', '').padEnd(34)} ${String(seconds).padStart(4)}s  ${tally}`,
  );
  if (survivors.length > 0) console.log(`        survivors: ${survivors.join(', ')}`);
}

const failed = results.filter((r) => r.exitCode !== 0);
const survivorCount = results.reduce((n, r) => n + r.survivors.length, 0);

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`\n  results written to ${jsonOut}`);
}

console.log(`\n──────────────────────────────────────────────────────────`);
console.log(`  ${results.length - failed.length} passed · ${failed.length} failed · ${survivorCount} surviving mutant(s) reported\n`);

if (failed.length > 0) {
  console.error('  MUTATION GATE FAILED');
  console.error('  A surviving mutant means the suite cannot detect a defect it is');
  console.error('  supposed to detect. Classify it in the harness EQUIVALENT set with');
  console.error('  a written reason, or repair the coverage. Do not silence it here.\n');
  process.exit(1);
}

console.log('  MUTATION GATE PASSED\n');
