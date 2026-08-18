#!/usr/bin/env node
/**
 * EMPLOYEE PAYROLL (teacher audit T-1) — MUTATION TESTING HARNESS
 * ============================================================================
 * Green tests prove the code passes, not that the tests would notice if a
 * guard stopped guarding. This harness disables each critical T-1 invariant
 * one at a time and requires the regression suite to FAIL. A surviving mutant
 * means that invariant is not actually defended by any test.
 *
 * Usage: node scripts/employee-payroll-mutation-test.mjs
 *        node scripts/employee-payroll-mutation-test.mjs --only M3
 * Exit 0 = every mutant KILLED. Exit 1 = at least one SURVIVED or was INVALID.
 *
 * Runs ONLY the employee payroll suite by default so a full-suite run is not
 * needed per mutant; pass --full to mutate against the entire test suite.
 *
 * The harness restores every file from the on-disk original after each run,
 * including on crash/interrupt, so it can never leave a mutated tree behind.
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
  : 'npx vitest run src/tests/employee-payroll-idempotency.test.ts --silent 2>&1';

const ROUTES = 'src/routes/teachers.routes.ts';
const MIGRATION = 'src/db/migrations/075_employee_salary_ledger.sql';
const SCHEMA = 'src/db/schema.sql';

/**
 * Each mutant removes ONE guard. `find` must match exactly once so a mutation
 * can never silently no-op (a no-op would look "killed" for the wrong reason,
 * or "survive" while having changed nothing).
 */
const MUTANTS = [
  {
    id: 'M1',
    invariant: 'T-1 server-side idempotency key is actually derived and used',
    file: ROUTES,
    // Make every request produce a UNIQUE key => idempotency silently disabled,
    // which is precisely the pre-fix behaviour.
    find: "    route: 'employee-pay-salary',\n    employeeId: employee.id,",
    replace: "    route: 'employee-pay-salary-' + Math.random(),\n    employeeId: employee.id,",
  },
  {
    id: 'M2',
    invariant: 'T-1 the idempotency key is persisted (so the unique index can arbitrate)',
    file: ROUTES,
    find: 'stmtInsertEmployeeSalaryLedger.run(ledgerId, employee.id, periodKey, periodLabel, resolvedAmount, type, txId, null, employee.branch_id, user.fullName, idempotencyKey);',
    replace: 'stmtInsertEmployeeSalaryLedger.run(ledgerId, employee.id, periodKey, periodLabel, resolvedAmount, type, txId, null, employee.branch_id, user.fullName, null);',
  },
  {
    id: 'M3',
    invariant: 'T-1 replay pre-check returns the existing payment instead of paying again',
    file: ROUTES,
    find: '      if (replay) {',
    replace: '      if (false && replay) {',
  },
  {
    id: 'M4',
    invariant: 'T-1 replay pre-check verifies the key belongs to THIS employee/period',
    file: ROUTES,
    find: "        if (replay.employee_id !== employee.id || replay.period_key !== periodKey) {",
    replace: '        if (false) {',
  },
  {
    id: 'M5',
    invariant: 'T-1 unique index on idempotency_key (the concurrency race arbiter)',
    file: MIGRATION,
    find: 'CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_salary_idempotency',
    replace: 'CREATE INDEX IF NOT EXISTS uq_employee_salary_idempotency',
    also: [{
      file: SCHEMA,
      find: 'CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_salary_idempotency',
      replace: 'CREATE INDEX IF NOT EXISTS uq_employee_salary_idempotency',
    }],
  },
  {
    id: 'M6',
    invariant: 'T-1 unique index preventing two FULL payments for one period',
    file: MIGRATION,
    find: 'CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_salary_full_period',
    replace: 'CREATE INDEX IF NOT EXISTS uq_employee_salary_full_period',
    also: [{
      file: SCHEMA,
      find: 'CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_salary_full_period',
      replace: 'CREATE INDEX IF NOT EXISTS uq_employee_salary_full_period',
    }],
  },
  {
    id: 'M7',
    invariant: 'T-1 conditional budget debit (balance re-checked in the spending statement)',
    file: ROUTES,
    find: "      const debited = db.prepare('UPDATE budget_lines SET current_amount = current_amount - ? WHERE id = ? AND current_amount >= ?')\n        .run(resolvedAmount, budgetLine.id, resolvedAmount);",
    replace: "      const debited = db.prepare('UPDATE budget_lines SET current_amount = current_amount - ? WHERE id = ?')\n        .run(resolvedAmount, budgetLine.id);",
  },
  {
    id: 'M8',
    invariant: 'T-1 insufficient-budget rejection (changes !== 1 => 409)',
    file: ROUTES,
    find: "      if (debited.changes !== 1) throw new HttpError(409, `Insufficient employee salary budget. Balance: ${budgetLine.current_amount} AFN.`);",
    replace: '      void debited;',
  },
  {
    id: 'M9',
    invariant: 'T-1 unique-violation backstop replays the winner instead of double-paying',
    file: ROUTES,
    // The teacher path contains a byte-identical line, so anchor on the
    // employee-specific lookup that follows it.
    find: "      if (isUniqueViolation(err)) {\n        const winner = stmtGetEmployeeSalaryByIdempotency.get(idempotencyKey)",
    replace: "      if (false && isUniqueViolation(err)) {\n        const winner = stmtGetEmployeeSalaryByIdempotency.get(idempotencyKey)",
  },
  {
    id: 'M10',
    invariant: 'T-1 canonical ledger row is written for every payment',
    file: ROUTES,
    find: '      stmtInsertEmployeeSalaryLedger.run(ledgerId,',
    replace: '      if (false) stmtInsertEmployeeSalaryLedger.run(ledgerId,',
  },
  {
    id: 'M11',
    invariant: 'T-1 atomic transaction boundary (debit + expense + ledger commit as ONE unit)',
    file: ROUTES,
    // Commit the budget debit and the expense row BEFORE the ledger insert, so
    // a ledger failure can no longer roll them back. This is the real-world
    // corruption: money leaves the budget and an expense is recorded while the
    // canonical ledger row is missing.
    // NOTE: an earlier version of this mutant committed an empty transaction
    // and re-opened one around every write — an EQUIVALENT mutant that changed
    // no behaviour and therefore "survived" for a meaningless reason.
    find: "      // The canonical financial trail this endpoint never had.",
    replace: "      db.exec('COMMIT'); db.exec('BEGIN IMMEDIATE');\n      // The canonical financial trail this endpoint never had.",
  },
  {
    id: 'M12',
    invariant: 'T-1 period normalisation (same month in two formats is one period)',
    file: ROUTES,
    find: '  const periodKey = toPeriodKey(monthName) || String(monthName).trim();',
    replace: '  const periodKey = String(monthName).trim();',
  },
  {
    id: 'M13',
    invariant: 'T-1 amount validation rejects zero/negative/non-finite',
    file: ROUTES,
    find: "  if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) throw new HttpError(400, 'Payment amount must be greater than zero.');",
    replace: '  void resolvedAmount;',
  },
  {
    id: 'M14',
    invariant: 'T-1 inactive employees cannot be paid',
    file: ROUTES,
    find: "  if (employee.status === 'inactive') throw new HttpError(400, 'Cannot pay salary to an inactive employee.');",
    replace: '  void employee;',
  },
];

const selected = ONLY ? MUTANTS.filter((m) => m.id === ONLY) : MUTANTS;
if (!selected.length) {
  console.error(`No mutant matches --only ${ONLY}`);
  process.exit(2);
}

function read(file) { return readFileSync(path.join(SERVER, file), 'utf8'); }
function write(file, content) { writeFileSync(path.join(SERVER, file), content); }

// Snapshot every file we may touch, once, before anything is mutated.
const ORIGINALS = new Map();
for (const m of selected) {
  for (const f of [m.file, ...(m.also ?? []).map((a) => a.file)]) {
    if (!ORIGINALS.has(f)) ORIGINALS.set(f, read(f));
  }
}
const restoreAll = () => { for (const [file, content] of ORIGINALS) write(file, content); };

// RESTORE ON EVERY EXIT PATH. A mutated tree must never outlive this process.
// `finally` alone is not enough: a killed child, an uncaught throw or a signal
// can end the run between "write mutant" and "write original". During the
// Class audit exactly this left a mutant behind in the source tree.
let restored = false;
const restoreOnce = () => { if (!restored) { restored = true; restoreAll(); } };
process.on('exit', restoreOnce);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(sig, () => { restoreOnce(); process.exit(1); });
}
process.on('uncaughtException', (e) => { restoreOnce(); console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { restoreOnce(); console.error(e); process.exit(1); });

// The suite builds its database from schema.sql + migrations, so a stale
// SQLite file would mask index mutations entirely.
const wipeDb = () => {
  try { execSync('rm -f src/tests/test.sqlite*', { cwd: SERVER, stdio: 'pipe' }); } catch { /* nothing to remove */ }
};

console.log('EMPLOYEE PAYROLL (T-1) — MUTATION TESTING');
console.log('='.repeat(78));
console.log(`${selected.length} mutants. A mutant must be KILLED (suite fails) to prove coverage.`);
console.log(`Test command: ${TEST_CMD}\n`);

// ── GREEN-BASELINE PRECONDITION ────────────────────────────────────────────
// A mutant is "killed" when the suite fails. If the suite ALREADY fails on
// unmutated code, every mutant is reported killed and the run is meaningless.
process.stdout.write('Verifying unmutated baseline is GREEN ... ');
wipeDb();
try {
  execSync(TEST_CMD, { cwd: SERVER, stdio: 'pipe', encoding: 'utf8', timeout: 900000 });
  console.log('OK\n');
} catch (err) {
  const out = `${err.stdout || ''}${err.stderr || ''}`;
  console.log('FAILED\n');
  console.error('ABORT: the suite does not pass on unmutated code, so every mutant');
  console.error('would be reported KILLED for the wrong reason. Fix the suite first.\n');
  console.error(out.split('\n').slice(-25).join('\n'));
  process.exit(2);
}

const results = [];
try {
  for (const m of selected) {
    const edits = [{ file: m.file, find: m.find, replace: m.replace }, ...(m.also ?? [])];
    let invalid = null;
    for (const e of edits) {
      const occurrences = ORIGINALS.get(e.file).split(e.find).length - 1;
      if (occurrences !== 1) invalid = `pattern matched ${occurrences}x in ${e.file} (expected exactly 1)`;
    }
    if (invalid) {
      results.push({ ...m, status: 'INVALID', detail: invalid });
      console.log(`${m.id.padEnd(4)} INVALID  ${m.invariant} — ${invalid}`);
      continue;
    }

    for (const e of edits) write(e.file, ORIGINALS.get(e.file).replace(e.find, e.replace));
    wipeDb();

    let killed = false;
    let detail = '';
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
      for (const e of edits) {
        if (read(e.file) !== ORIGINALS.get(e.file)) {
          console.error(`\nFATAL: failed to restore ${e.file} after ${m.id}. Aborting.`);
          process.exit(3);
        }
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
const invalidResults = results.filter((r) => r.status === 'INVALID');
console.log(`KILLED: ${killed}/${results.length}   SURVIVED: ${survived.length}   INVALID: ${invalidResults.length}`);
if (survived.length) {
  console.log('\nSURVIVING MUTANTS (missing test coverage):');
  for (const s of survived) console.log(`  ${s.id} — ${s.invariant} (${s.file})`);
}
if (invalidResults.length) {
  console.log('\nINVALID MUTANTS (pattern drifted — fix the harness):');
  for (const s of invalidResults) console.log(`  ${s.id} — ${s.detail}`);
}
process.exit(survived.length === 0 && invalidResults.length === 0 ? 0 : 1);
