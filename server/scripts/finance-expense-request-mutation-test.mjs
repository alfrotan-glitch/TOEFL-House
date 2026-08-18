#!/usr/bin/env node
/**
 * EXPENSE REQUEST INTEGRITY (finance findings F-3, F-4) — MUTATION HARNESS
 * ============================================================================
 * Each mutant restores the exact pre-fix code at one guard and requires the
 * regression suite to FAIL. A survivor means the invariant is undefended.
 *
 * Usage: node scripts/finance-expense-request-mutation-test.mjs [--only M2] [--full]
 * Exit 0 = every mutant KILLED. Exit 1 = a survivor or an invalid pattern.
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
  : 'npx vitest run src/tests/finance-expense-request-integrity.test.ts --silent 2>&1';

const F = 'src/routes/finance.routes.ts';
const N = 'src/utils/notifications.ts';
const SCHEMA = 'src/db/schema.sql';

const MUTANTS = [
  {
    id: 'M1',
    invariant: 'F-3a request amount is parsed with assertMoney (restores validate-one/store-another)',
    file: F,
    find: "    let resolvedAmount: number;\n    try { resolvedAmount = assertMoney(amount, 'Expense amount'); }\n    catch { throw new HttpError(400, 'Title, a positive amount, and a valid budget line are required.'); }\n    if (!title?.trim() || resolvedAmount <= 0 || !budgetLine) {",
    replace: "    const resolvedAmount = Number(amount);\n    if (!title?.trim() || !Number.isFinite(Number(amount)) || Number(amount) <= 0 || !budgetLine) {",
  },
  {
    id: 'M2',
    invariant: 'F-3a the PARSED amount is stored, not the raw body value',
    file: F,
    find: "      newId, title, resolvedAmount, budgetLineId, user.fullName, 'pending', today(), requestBranchId,",
    replace: "      newId, title, amount, budgetLineId, user.fullName, 'pending', today(), requestBranchId,",
  },
  {
    id: 'M3',
    invariant: 'F-3a the positive-amount rule applies to the parsed value',
    file: F,
    // /operational-payments now contains a byte-identical line (same fix
    // pattern), so anchor on this endpoint's distinct error message.
    find: "    if (!title?.trim() || resolvedAmount <= 0 || !budgetLine) {\n      throw new HttpError(400, 'Title, a positive amount, and a valid budget line are required.');",
    replace: "    if (!title?.trim() || !budgetLine) {\n      throw new HttpError(400, 'Title, a positive amount, and a valid budget line are required.');",
  },
  {
    id: 'M4',
    invariant: 'F-3b the request is booked to the budget line branch',
    file: F,
    find: '    const requestBranchId = budgetLine.branch_id || user.branchId;',
    replace: '    const requestBranchId = user.branchId;',
  },
  {
    id: 'M5',
    invariant: 'F-3b requestBranchId is actually used in the INSERT',
    file: F,
    find: "'pending', today(), requestBranchId,",
    replace: "'pending', today(), user.branchId,",
  },
  {
    id: 'M6',
    invariant: 'F-4 rejection notification uses a schema-legal type',
    file: F,
    find: "was rejected by the course owner. Reason: ${rejectReason || 'Not specified'}`, 'warning', user.branchId);",
    replace: "was rejected by the course owner. Reason: ${rejectReason || 'Not specified'}`, 'alert' as never, user.branchId);",
  },
  {
    id: 'M7',
    invariant: 'F-4 NotificationType stays in lockstep with the schema CHECK',
    file: N,
    find: "export type NotificationType = 'info' | 'warning' | 'critical' | 'success';",
    replace: "export type NotificationType = 'alert' | 'info' | 'warning' | 'critical' | 'success';",
    // Widening the union alone changes no runtime behaviour, so this mutant is
    // paired with the schema to prove the CHECK itself is asserted.
    also: [{
      file: SCHEMA,
      find: "type      TEXT NOT NULL DEFAULT 'info' CHECK (type IN ('info','warning','critical','success')), ",
      replace: "type      TEXT NOT NULL DEFAULT 'info', ",
    }],
  },
  {
    id: 'M8',
    invariant: 'branch isolation guard on the requested budget line',
    file: F,
    find: "    const budgetLine = stmtGetBudgetLineById.get(budgetLineId) as any;\n    if (budgetLine) requireBudgetLine(req, String(budgetLineId));\n\n    // F-3a:",
    replace: "    const budgetLine = stmtGetBudgetLineById.get(budgetLineId) as any;\n    if (false) requireBudgetLine(req, String(budgetLineId));\n\n    // F-3a:",
  },
];

const selected = ONLY ? MUTANTS.filter((m) => m.id === ONLY) : MUTANTS;
if (!selected.length) { console.error(`No mutant matches --only ${ONLY}`); process.exit(2); }

const read = (f) => readFileSync(path.join(SERVER, f), 'utf8');
const write = (f, c) => writeFileSync(path.join(SERVER, f), c);

const ORIGINALS = new Map();
for (const m of selected) {
  for (const f of [m.file, ...(m.also ?? []).map((a) => a.file)]) {
    if (!ORIGINALS.has(f)) ORIGINALS.set(f, read(f));
  }
}
const restoreAll = () => { for (const [f, c] of ORIGINALS) write(f, c); };

let restored = false;
const restoreOnce = () => { if (!restored) { restored = true; restoreAll(); } };
process.on('exit', restoreOnce);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) process.on(sig, () => { restoreOnce(); process.exit(1); });
process.on('uncaughtException', (e) => { restoreOnce(); console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { restoreOnce(); console.error(e); process.exit(1); });

const wipeDb = () => { try { execSync('rm -f src/tests/test.sqlite*', { cwd: SERVER, stdio: 'pipe' }); } catch { /* none */ } };

console.log('EXPENSE REQUEST INTEGRITY (F-3, F-4) — MUTATION TESTING');
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
    const edits = [{ file: m.file, find: m.find, replace: m.replace }, ...(m.also ?? [])];
    let invalid = null;
    for (const e of edits) {
      const n = ORIGINALS.get(e.file).split(e.find).length - 1;
      if (n !== 1) invalid = `pattern matched ${n}x in ${e.file} (expected exactly 1)`;
    }
    if (invalid) {
      results.push({ ...m, status: 'INVALID', detail: invalid });
      console.log(`${m.id.padEnd(4)} INVALID  ${m.invariant} — ${invalid}`);
      continue;
    }

    for (const e of edits) write(e.file, ORIGINALS.get(e.file).replace(e.find, e.replace));
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
