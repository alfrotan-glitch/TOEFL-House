#!/usr/bin/env node
/**
 * TEACHER UPDATE VALIDATION (audit finding T-2) — MUTATION TESTING HARNESS
 * ============================================================================
 * Green tests prove the code passes, not that the tests would notice if a
 * guard stopped guarding. This harness disables each T-2 invariant one at a
 * time and requires the regression suite to FAIL.
 *
 * Usage: node scripts/teacher-update-mutation-test.mjs [--only M3] [--full]
 * Exit 0 = every mutant KILLED. Exit 1 = at least one SURVIVED or was INVALID.
 *
 * Mutants target both layers the fix relies on:
 *   - the ROUTE wiring (PUT actually calls the shared boundary)
 *   - the BOUNDARY itself (assertMoney / assertPerformanceScore checks)
 * A route-only harness would miss a weakened boundary, and a boundary-only
 * harness would miss a PUT that silently stopped calling it.
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
  : 'npx vitest run src/tests/work-packages/wp05/teacher-update-validation.test.ts --silent 2>&1';

const ROUTES = 'src/routes/teachers.routes.ts';
const MONEY = 'src/utils/money.ts';

const MUTANTS = [
  // ── Route wiring: PUT must call the same authority POST uses ────────────
  {
    id: 'M1',
    invariant: 'T-2 PUT routes baseSalary through assertMoney',
    file: ROUTES,
    find: "    try { nextBaseSalary = assertMoney(baseSalary, 'Base salary'); }\n    catch (err) { throw err instanceof HttpError ? err : new HttpError(400, 'Base salary must be a non-negative number.'); }",
    // The exact pre-fix logic: a coercion with a finite/negative check.
    replace: "    nextBaseSalary = Number(baseSalary);\n    if (!Number.isFinite(nextBaseSalary) || nextBaseSalary < 0) throw new HttpError(400, 'Base salary must be a non-negative number.');",
  },
  {
    id: 'M2',
    invariant: 'T-2 PUT routes defaultSkillRate through assertMoney',
    file: ROUTES,
    find: "    try { nextDefaultSkillRate = assertMoney(req.body.defaultSkillRate, 'Default skill rate'); }\n    catch (err) { throw err instanceof HttpError ? err : new HttpError(400, 'Default skill rate must be a non-negative number.'); }",
    replace: "    nextDefaultSkillRate = Number(req.body.defaultSkillRate);\n    if (!Number.isFinite(nextDefaultSkillRate) || nextDefaultSkillRate < 0) throw new HttpError(400, 'Default skill rate must be a non-negative number.');",
  },
  {
    id: 'M3',
    invariant: 'WP-05 generic teacher PUT rejects every performanceScore write',
    file: ROUTES,
    find: "  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'performanceScore')) {\n    throw new HttpError(400, 'Performance score can only be changed through the teacher evaluation command.');\n  }",
    replace: "  if (false) {\n    throw new HttpError(400, 'Performance score can only be changed through the teacher evaluation command.');\n  }",
  },
  // ── Boundary: the shared guards must actually guard ──────────────────────
  {
    id: 'M4',
    invariant: 'T-2 assertMoney enforces the safe-integer-cents ceiling (blocks 1e15)',
    file: MONEY,
    find: "  if (!Number.isSafeInteger(Math.round(Math.abs(rounded) * 100))) throw new HttpError(400, `${field} exceeds supported monetary precision.`);",
    replace: '  void rounded;',
  },
  {
    id: 'M5',
    invariant: 'T-2 assertMoney rejects non-numeric types (booleans, arrays, objects, null)',
    file: MONEY,
    find: "  } else {\n    // Booleans, arrays, objects, null and undefined are never amounts.\n    throw new HttpError(400, `${field} must be a finite number.`);\n  }",
    replace: '  } else {\n    n = Number(value);\n  }',
  },
  {
    id: 'M6',
    invariant: 'T-2 assertMoney rejects non-decimal strings ("", "0x10", "abc")',
    file: MONEY,
    find: "    if (trimmed === '' || !DECIMAL_NUMERAL.test(trimmed)) {\n      throw new HttpError(400, `${field} must be a finite number.`);\n    }",
    replace: '    /* mutant: accept any string */',
  },
  {
    id: 'M7',
    invariant: 'T-2 assertMoney rejects negatives',
    file: MONEY,
    find: "  if (!opts.allowNegative && n < 0) throw new HttpError(400, `${field} cannot be negative.`);",
    replace: '  void opts;',
  },
  // ── M8 REMOVED: PROVEN EQUIVALENT MUTANT ────────────────────────────────
  // Disabling assertMoney's `Number.isFinite` check changes NO observable
  // behaviour, so no test can kill it and adding one would be theatre:
  //     Infinity  -> Math.round(Infinity*100) is not a safe integer
  //                  => still 400 via the precision ceiling
  //     -Infinity -> caught earlier by the negative check => still 400
  //     NaN       -> Math.round(NaN) is not a safe integer
  //                  => still 400 via the precision ceiling
  // Verified by executing a hand-built copy of the mutated function against all
  // three values. The finiteness check is retained in the source because it is
  // the clearest expression of intent and guards the contract for callers that
  // pass allowNegative:true, but it is defence in depth, not a load-bearing
  // guard, and is therefore not a meaningful mutation target.
  // The finiteness CONTRACT is still asserted by the suite's direct
  // assertMoney(Infinity/-Infinity/NaN) tests.
  {
    id: 'M9',
    invariant: 'T-2 assertPerformanceScore enforces the upper bound of 100',
    file: MONEY,
    find: '  if (n > 100) throw new HttpError(400, `${field} cannot exceed 100.`);',
    replace: '  void n;',
  },
  {
    id: 'M10',
    invariant: 'T-2 assertPerformanceScore rejects negative scores',
    file: MONEY,
    find: '  if (n < 0) throw new HttpError(400, `${field} cannot be negative.`);\n  if (!allowZero',
    replace: '  if (false) throw new HttpError(400, `${field} cannot be negative.`);\n  if (!allowZero',
  },
  {
    id: 'M11',
    invariant: 'T-2 assertPerformanceScore rejects non-numeric types',
    file: MONEY,
    find: "  } else {\n    throw new HttpError(400, `${field} must be a number between ${allowZero ? 0 : 1} and 100.`);\n  }\n  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number between ${allowZero ? 0 : 1} and 100.`);",
    replace: '  } else {\n    n = Number(value);\n  }\n  if (false) throw new HttpError(400, `${field} must be a number.`);',
  },
  {
    id: 'M12',
    invariant: 'T-2 assertPerformanceScore rejects non-decimal strings',
    file: MONEY,
    find: "    if (trimmed === '' || !DECIMAL_NUMERAL.test(trimmed)) {\n      throw new HttpError(400, `${field} must be a number between ${allowZero ? 0 : 1} and 100.`);\n    }",
    replace: '    /* mutant: accept any string */',
  },
  {
    id: 'M13',
    invariant: 'T-2 assertPerformanceScore honours allowZero:false for evaluation events',
    file: MONEY,
    find: '  if (!allowZero && n === 0) throw new HttpError(400, `${field} must be greater than zero.`);',
    replace: '  void allowZero;',
  },
  {
    id: 'M14',
    invariant: 'T-2 assertMoney rounds to two decimals',
    file: MONEY,
    find: '  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;',
    replace: '  const rounded = n;',
  },
];

// WP-05 owns evaluation provenance, not compensation/payroll boundaries. The
// scoped mode therefore mutates only the generic-score-writer retirement; the
// remaining historical T-2 mutants stay available to their owning package.
const selected = ONLY
  ? MUTANTS.filter((m) => m.id === ONLY)
  : WP05
    ? MUTANTS.filter((m) => m.id === 'M3')
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

console.log('TEACHER UPDATE VALIDATION (T-2) — MUTATION TESTING');
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
