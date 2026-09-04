#!/usr/bin/env node
/**
 * EMPLOYEE SALARY VALIDATION — MUTATION TESTING HARNESS
 * ============================================================================
 * Green tests prove the code passes, not that the tests would notice if a
 * guard stopped guarding. Each mutant restores the exact pre-fix code at one
 * of the two employee salary writers and requires the suite to FAIL.
 *
 * Usage: node scripts/employee-salary-mutation-test.mjs [--only M2] [--full]
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
const TEST_CMD = FULL
  ? 'npx vitest run --silent 2>&1'
  : 'npx vitest run src/tests/employee-salary-validation.test.ts --silent 2>&1';

const ROUTES = 'src/routes/teachers.routes.ts';

const MUTANTS = [
  {
    id: 'M1',
    invariant: 'PUT parses baseSalary through assertMoney (restores the unvalidated writer)',
    file: ROUTES,
    find: "  const nextBaseSalary = baseSalary != null ? assertMoney(baseSalary, 'Base salary') : Number(existing.base_salary);",
    // The exact pre-fix expression, inlined at the call site.
    replace: '  const nextBaseSalary = baseSalary ?? existing.base_salary;',
  },
  {
    id: 'M2',
    invariant: 'PUT writes the PARSED salary, not the raw body value',
    file: ROUTES,
    find: 'role ?? existing.role, nextBaseSalary, status ?? existing.status, existing.id);',
    replace: 'role ?? existing.role, baseSalary ?? existing.base_salary, status ?? existing.status, existing.id);',
  },
  {
    id: 'M3',
    invariant: 'PUT keeps "omitted means unchanged" (parsing must not reject a missing salary)',
    file: ROUTES,
    find: "  const nextBaseSalary = baseSalary != null ? assertMoney(baseSalary, 'Base salary') : Number(existing.base_salary);",
    replace: "  const nextBaseSalary = assertMoney(baseSalary, 'Base salary');",
  },
  {
    id: 'M4',
    invariant: 'POST parses baseSalary through assertMoney',
    file: ROUTES,
    find: "  const numericBaseSalary = assertMoney(baseSalary, 'Base salary');",
    replace: '  const numericBaseSalary = baseSalary;',
  },
  {
    id: 'M5',
    invariant: 'POST inserts the PARSED salary, not the raw body value',
    file: ROUTES,
    find: 'stmtInsertEmployee.run(newId, fullName, phone || null, email || null, role, numericBaseSalary, resolvedBranchId, today());',
    replace: 'stmtInsertEmployee.run(newId, fullName, phone || null, email || null, role, baseSalary, resolvedBranchId, today());',
  },
  {
    id: 'M6',
    invariant: 'POST still requires baseSalary to be supplied',
    file: ROUTES,
    find: "  if (!fullName || !role || baseSalary == null) throw new HttpError(400, 'Full name, role, and base salary are required.');",
    replace: "  if (!fullName || !role) throw new HttpError(400, 'Full name, role, and base salary are required.');",
  },
  {
    id: 'M7',
    invariant: 'PUT still validates the status enum',
    file: ROUTES,
    find: "  if (status && !['active', 'inactive'].includes(status)) throw new HttpError(400, 'Invalid status.');\n\n  // This writer had NO validation of any kind",
    replace: '  if (false) throw new HttpError(400, \'Invalid status.\');\n\n  // This writer had NO validation of any kind',
  },
];

const selected = ONLY ? MUTANTS.filter((m) => m.id === ONLY) : MUTANTS;
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

console.log('EMPLOYEE SALARY VALIDATION — MUTATION TESTING');
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
// PROVEN EQUIVALENT — TR-4 review by execution (2026-08-22): M2 and M5 swap
// the parsed salary for the raw body value on PUT/POST. Applied mutants with
// baseSalary ' 5000 ' / ' 6000 ' (whitespace strings) stored
// {5000|6000, typeof 'integer'} byte-identically to baseline: the column is
// INTEGER-affinity, only assertMoney-valid numerals reach the write, and every
// valid numeral affinity-coerces. Durable pins: the suite's numeric-string
// typeof tests. Evidence: docs/work-packages/WP-07-TR4-independent-review-verdicts.md.
const EQUIVALENT = new Set(['M2', 'M5']);
const survived = results.filter((r) => r.status === 'SURVIVED' && !EQUIVALENT.has(r.id));
const equivalent = results.filter((r) => r.status === 'SURVIVED' && EQUIVALENT.has(r.id));
const invalid = results.filter((r) => r.status === 'INVALID');
console.log(`KILLED: ${killed}/${results.length - equivalent.length}   PROVEN EQUIVALENT: ${equivalent.length}   SURVIVED: ${survived.length}   INVALID: ${invalid.length}`);
if (equivalent.length) console.log(`\n${equivalent.length} proven-equivalent mutant(s): ${equivalent.map((r) => r.id).join(', ')} (see the note at the top of this file)`);
if (survived.length) {
  console.log('\nSURVIVING MUTANTS (missing test coverage):');
  for (const s of survived) console.log(`  ${s.id} — ${s.invariant} (${s.file})`);
}
if (invalid.length) {
  console.log('\nINVALID MUTANTS (pattern drifted — fix the harness):');
  for (const s of invalid) console.log(`  ${s.id} — ${s.detail}`);
}
process.exit(survived.length === 0 && invalid.length === 0 ? 0 : 1);
