#!/usr/bin/env node
/**
 * OPERATIONAL PAYMENT INTEGRITY (finance findings F-1, F-2) — MUTATION HARNESS
 * ============================================================================
 * Each mutant restores the exact pre-fix code at one guard and requires the
 * regression suite to FAIL. A survivor means the invariant is undefended.
 *
 * Usage: node scripts/finance-operational-payment-mutation-test.mjs [--only M2] [--full]
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
  : 'npx vitest run src/tests/finance-operational-payment-integrity.test.ts --silent 2>&1';

const F = 'src/routes/finance.routes.ts';

const MUTANTS = [
  {
    id: 'M1',
    invariant: 'F-2 amount is parsed with assertMoney (restores Number() coercion)',
    file: F,
    find: "    let resolvedAmount: number;\n    try { resolvedAmount = assertMoney(amount, 'Expense amount'); }\n    catch { throw new HttpError(400, 'Title, a valid amount, and a budget line are required.'); }",
    replace: '    const resolvedAmount = Number(amount);',
  },
  {
    id: 'M2',
    invariant: 'F-2 the positive-amount rule still applies to the parsed value',
    file: F,
    find: "    if (!title?.trim() || resolvedAmount <= 0 || !budgetLine) {",
    replace: '    if (!title?.trim() || !budgetLine) {',
  },
  {
    id: 'M3',
    invariant: 'F-1 the LEDGER row is booked to the budget line branch',
    file: F,
    find: 'budgetLine, amount: resolvedAmount, title: title.trim(), date, operatorName: user.fullName, branchId: expenseBranchId, requestId: newId, paymentMethod,',
    replace: 'budgetLine, amount: resolvedAmount, title: title.trim(), date, operatorName: user.fullName, branchId: user.branchId, requestId: newId, paymentMethod,',
  },
  {
    id: 'M4',
    invariant: 'F-1 the APPROVED expense_request row is booked to the budget line branch',
    file: F,
    find: "        newId, title.trim(), resolvedAmount, budgetLineId, user.fullName, 'approved', date, expenseBranchId,",
    replace: "        newId, title.trim(), resolvedAmount, budgetLineId, user.fullName, 'approved', date, user.branchId,",
  },
  {
    id: 'M5',
    invariant: 'F-1 the PENDING expense_request row is booked to the budget line branch',
    file: F,
    find: "        newId, title.trim(), resolvedAmount, budgetLineId, user.fullName, 'pending', date, expenseBranchId,",
    replace: "        newId, title.trim(), resolvedAmount, budgetLineId, user.fullName, 'pending', date, user.branchId,",
  },
  {
    id: 'M6',
    invariant: 'F-1 expenseBranchId prefers the budget line branch over the actor branch',
    file: F,
    find: '    const expenseBranchId = budgetLine.branch_id || user.branchId;',
    replace: '    const expenseBranchId = user.branchId;',
  },
  {
    id: 'M7',
    invariant: 'branch isolation guard on the budget line (requireBudgetLine)',
    file: F,
    // The /expense-requests handler contains a byte-identical line, so anchor
    // on the assertMoney parse that immediately precedes this one.
    find: "    catch { throw new HttpError(400, 'Title, a valid amount, and a budget line are required.'); }\n    const budgetLine = stmtGetBudgetLineById.get(budgetLineId) as any;\n    if (budgetLine) requireBudgetLine(req, String(budgetLineId));",
    replace: "    catch { throw new HttpError(400, 'Title, a valid amount, and a budget line are required.'); }\n    const budgetLine = stmtGetBudgetLineById.get(budgetLineId) as any;\n    if (false) requireBudgetLine(req, String(budgetLineId));",
  },
  // ── M8 REMOVED: EQUIVALENT WITHIN A SINGLE PROCESS (proven) ─────────────
  // The mutant made payFromBudgetLine's debit unconditional. It survived, and
  // the reason is structural rather than a coverage gap: better-sqlite3 is
  // SYNCHRONOUS, so requests issued with Promise.all still execute one at a
  // time. The application-level `budgetLine.current_amount < resolvedAmount`
  // pre-check therefore always observes the true balance, and it alone already
  // produces the observable outcome. Verified by replaying the mutated
  // sequence directly:
  //     5 serialized attempts of 1000 against a 1000 balance, pre-check in
  //     front, UNCONDITIONAL debit -> paid=1, final balance=0
  // i.e. identical to the guarded version. No in-process test can distinguish
  // them, and one claiming to would be asserting a difference that cannot be
  // observed here.
  //
  // The guarded `WHERE current_amount >= ?` is deliberately KEPT in the source:
  // it is the only protection if the API is ever run in more than one process
  // (or against a concurrent driver), where the pre-check genuinely can be
  // bypassed. It is defence in depth, not a mutation target for this suite.
  // The concurrency behaviour that IS observable here is covered by the
  // "never drives a budget line negative under concurrent payments" test.
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

console.log('OPERATIONAL PAYMENT INTEGRITY (F-1, F-2) — MUTATION TESTING');
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
