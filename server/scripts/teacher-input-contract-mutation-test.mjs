#!/usr/bin/env node
/**
 * INPUT ERROR CONTRACT (audit finding T-3) — MUTATION TESTING HARNESS
 * ============================================================================
 * Green tests prove the code passes, not that the tests would notice if a
 * guard stopped guarding. Each mutant restores the exact pre-fix code at one
 * of the three T-3 sites and requires the regression suite to FAIL.
 *
 * Usage: node scripts/teacher-input-contract-mutation-test.mjs [--only M2] [--full]
 * Exit 0 = every mutant KILLED. Exit 1 = at least one SURVIVED or was INVALID.
 *
 * Restores every file on all exit paths, so a mutated tree can never outlive
 * this process.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..');

const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const FULL = process.argv.includes('--full');
const WP05 = process.argv.includes('--wp05');
const TEST_CMD = FULL
  ? 'npx vitest run --silent 2>&1'
  : WP05
    ? 'npx vitest run src/tests/work-packages/wp05/teacher-evaluation-integrity.test.ts --silent 2>&1'
    : 'npx vitest run src/tests/teacher-input-error-contract.test.ts --silent 2>&1';

const ROUTES = 'src/routes/teachers.routes.ts';

const MUTANTS = [
  {
    id: 'M1',
    invariant: 'T-3 evaluation score is PARSED (restores the raw comparison that let NaN through)',
    file: ROUTES,
    find: "  const numericScore = assertPerformanceScore(score, 'Evaluation score', { allowZero: false });",
    // The exact pre-fix guard.
    replace: "  if (score == null || score <= 0 || score > 100) {\n    throw new HttpError(400, 'Evaluation score must be a positive number between 1 and 100.');\n  }\n  const numericScore = Number(score);",
  },
  {
    id: 'M2',
    invariant: 'T-3 evaluation rejects zero and negative scores (allowZero:false)',
    file: ROUTES,
    find: "assertPerformanceScore(score, 'Evaluation score', { allowZero: false })",
    replace: "assertPerformanceScore(score, 'Evaluation score', { allowZero: true })",
  },
  // ── M3 and M4 REMOVED: PROVEN EQUIVALENT MUTANTS ────────────────────────
  // They swapped the persisted `numericScore` back to `Number(score)` at the
  // two write sites. By the time either line runs, assertPerformanceScore has
  // already returned, which means the input was a number or a plain decimal
  // numeral — and for EVERY such value the two expressions are identical:
  //     1 / 50 / 87.5 / 100 / '75' / ' 75 ' / '87.50'
  //       -> parsed === Number(v) in all cases
  // Every input where they WOULD differ ('0x10' -> 16, true -> 1, 'abc' -> NaN)
  // is rejected before these lines are reached. No observable behaviour
  // changes, so no test can kill them and any test claiming to would be
  // asserting a distinction that cannot exist.
  //
  // NOTE: the equivalence holds only because the PARSE runs first. Mutant M1
  // removes that parse and IS killed, which is what actually protects these
  // write sites. M5 (the response value) is NOT equivalent and is killed,
  // because pre-fix the response echoed the raw body while the row held the
  // coerced number.
  {
    id: 'M5',
    invariant: 'T-3 the response reports the parsed score, not the raw body value',
    file: ROUTES,
    find: "  res.status(201).json({ ok: true, score: numericScore });",
    replace: '  res.status(201).json({ ok: true, score });',
  },
  {
    id: 'M6',
    invariant: 'T-3 employee pay-salary PARSES the amount (restores Number() coercion)',
    file: ROUTES,
    find: "  const resolvedAmount = assertMoney(amountPaid, 'Payment amount');\n  if (resolvedAmount <= 0) throw new HttpError(400, 'Payment amount must be greater than zero.');",
    replace: "  const resolvedAmount = Number(amountPaid);\n  if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) throw new HttpError(400, 'Payment amount must be greater than zero.');",
  },
  {
    id: 'M7',
    invariant: 'T-3 employee pay-salary still rejects a non-positive parsed amount',
    file: ROUTES,
    find: "  if (resolvedAmount <= 0) throw new HttpError(400, 'Payment amount must be greater than zero.');",
    replace: '  void resolvedAmount;',
  },
  {
    id: 'M8',
    invariant: 'T-3 teacher pay-salary PARSES the amount (restores Number() coercion)',
    file: ROUTES,
    find: "  const numericAmount = amountPaid == null ? undefined : assertMoney(amountPaid, 'Payment amount');\n  if (numericAmount != null && numericAmount <= 0) throw new HttpError(400, 'Payment amount must be greater than zero.');",
    replace: "  const numericAmount = amountPaid == null ? undefined : Number(amountPaid);\n  if (numericAmount != null && (!Number.isFinite(numericAmount) || numericAmount <= 0)) throw new HttpError(400, 'Payment amount must be greater than zero.');",
  },
  {
    id: 'M9',
    invariant: 'T-3 teacher pay-salary still rejects a non-positive parsed amount',
    file: ROUTES,
    find: "  if (numericAmount != null && numericAmount <= 0) throw new HttpError(400, 'Payment amount must be greater than zero.');",
    replace: '  void numericAmount;',
  },
  {
    id: 'M10',
    invariant: 'T-3 teacher pay-salary preserves the OPTIONAL-amount contract (omitted => full balance)',
    file: ROUTES,
    // Forces the optional amount through the parser, which rejects null/undefined.
    find: "  const numericAmount = amountPaid == null ? undefined : assertMoney(amountPaid, 'Payment amount');",
    replace: "  const numericAmount = assertMoney(amountPaid, 'Payment amount');",
  },
  {
    id: 'M11',
    invariant: 'T-3 evaluation still rejects malformed criteria',
    file: ROUTES,
    find: "  if (criteria && (typeof criteria !== 'object' || Array.isArray(criteria))) {",
    replace: '  if (false) {',
  },
];

// WP-05 claims only teacher evaluation behavior. M2 and M11 are deliberately
// excluded from mutation claims because canonical storage independently rejects
// zero-score and non-object-criteria rows, making those route-only mutants
// observably equivalent. Payroll mutants remain with WP-08.
const wp05Mutants = new Set(['M1', 'M5']);
const selected = ONLY
  ? MUTANTS.filter((m) => m.id === ONLY)
  : WP05
    ? MUTANTS.filter((m) => wp05Mutants.has(m.id))
    : MUTANTS;
if (!selected.length) { console.error(`No mutant matches --only ${ONLY}`); process.exit(2); }

const read = (f) => readFileSync(path.join(SERVER, f), 'utf8');
const write = (f, c) => writeFileSync(path.join(SERVER, f), c);

const ORIGINALS = new Map();
for (const m of selected) if (!ORIGINALS.has(m.file)) ORIGINALS.set(m.file, read(m.file));
const restoreAll = () => { for (const [f, c] of ORIGINALS) write(f, c); };

let restored = false;
const restoreOnce = () => { if (!restored) { restored = true; restoreAll(); } };
process.on('exit', restoreOnce);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) process.on(sig, () => { restoreOnce(); process.exit(1); });
process.on('uncaughtException', (e) => { restoreOnce(); console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { restoreOnce(); console.error(e); process.exit(1); });

const wipeDb = () => { try { execSync('rm -f src/tests/test.sqlite*', { cwd: SERVER, stdio: 'pipe' }); } catch { /* none */ } };

console.log('INPUT ERROR CONTRACT (T-3) — MUTATION TESTING');
console.log('='.repeat(78));
console.log(`${selected.length} mutants. A mutant must be KILLED (suite fails) to prove coverage.`);
console.log(`Test command: ${TEST_CMD}\n`);

process.stdout.write('Verifying unmutated baseline is GREEN ... ');
wipeDb();
try {
  execSync(TEST_CMD, { cwd: SERVER, stdio: 'pipe', encoding: 'utf8', timeout: 900000 });
  console.log('OK\n');
} catch (err) {
  const out = `${err.stdout || ''}${err.stderr || ''}`;
  console.log('FAILED\n');
  console.error('ABORT: suite fails on unmutated code; every mutant would be falsely KILLED.\n');
  console.error(out.split('\n').slice(-25).join('\n'));
  process.exit(2);
}

const results = [];
try {
  for (const m of selected) {
    const original = ORIGINALS.get(m.file);
    const occurrences = original.split(m.find).length - 1;
    if (occurrences !== 1) {
      results.push({ ...m, status: 'INVALID', detail: `pattern matched ${occurrences}x (expected exactly 1)` });
      console.log(`${m.id.padEnd(4)} INVALID  ${m.invariant} — matched ${occurrences}x`);
      continue;
    }

    write(m.file, original.replace(m.find, m.replace));
    wipeDb();
    let killed = false; let detail = '';
    try {
      execSync(TEST_CMD, { cwd: SERVER, stdio: 'pipe', encoding: 'utf8', timeout: 900000 });
      detail = 'suite still passed';
    } catch (err) {
      killed = true;
      const out = `${err.stdout || ''}${err.stderr || ''}`;
      const hit = out.match(/Tests\s+(\d+)\s+failed/);
      detail = hit ? `${hit[1]} test(s) failed` : 'suite failed';
    } finally {
      restoreAll();
      if (read(m.file) !== original) {
        console.error(`\nFATAL: failed to restore ${m.file} after ${m.id}. Aborting.`);
        process.exit(3);
      }
    }
    results.push({ ...m, status: killed ? 'KILLED' : 'SURVIVED', detail });
    console.log(`${m.id.padEnd(4)} ${killed ? 'KILLED  ' : 'SURVIVED'} ${m.invariant} (${detail})`);
  }
} finally {
  restoreAll();
  wipeDb();
}

console.log('\n' + '='.repeat(78));
const killed = results.filter((r) => r.status === 'KILLED').length;
const survived = results.filter((r) => r.status === 'SURVIVED');
const invalid = results.filter((r) => r.status === 'INVALID');
console.log(`KILLED: ${killed}/${results.length}   SURVIVED: ${survived.length}   INVALID: ${invalid.length}`);
if (survived.length) {
  console.log('\nSURVIVING MUTANTS (missing test coverage):');
  for (const s of survived) console.log(`  ${s.id} — ${s.invariant} (${s.file})`);
}
if (invalid.length) {
  console.log('\nINVALID MUTANTS (pattern drifted — fix the harness):');
  for (const s of invalid) console.log(`  ${s.id} — ${s.detail}`);
}
process.exit(survived.length === 0 && invalid.length === 0 ? 0 : 1);
