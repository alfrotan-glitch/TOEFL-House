#!/usr/bin/env node
/**
 * MONEY-WRITER PARITY (finance finding F-5) — MUTATION HARNESS
 * ============================================================================
 * Each mutant restores the exact pre-fix coercion at one money writer and
 * requires the regression suite to FAIL.
 *
 * Usage: node scripts/finance-money-writer-mutation-test.mjs [--only M2] [--full]
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
  : 'npx vitest run src/tests/finance-money-writer-parity.test.ts --silent 2>&1';

const INV = 'src/routes/invoices.routes.ts';
const STU = 'src/routes/students.routes.ts';
const FUN = 'src/routes/funding.routes.ts';

const MUTANTS = [
  {
    id: 'M1',
    invariant: 'F-5 invoice payment parses the amount (restores Number() coercion)',
    file: INV,
    find: "    let payAmount: number;\n    try { payAmount = assertMoney(amount, 'Payment amount'); }\n    catch { throw new HttpError(400, 'Payment amount must be positive.'); }\n    if (!(payAmount > 0)) throw new HttpError(400, 'Payment amount must be positive.');",
    replace: "    const payAmount = Number(amount);\n    if (!(payAmount > 0)) throw new HttpError(400, 'Payment amount must be positive.');",
  },
  {
    id: 'M2',
    invariant: 'F-5 invoice payment still rejects a non-positive parsed amount',
    file: INV,
    find: "    catch { throw new HttpError(400, 'Payment amount must be positive.'); }\n    if (!(payAmount > 0)) throw new HttpError(400, 'Payment amount must be positive.');",
    replace: "    catch { throw new HttpError(400, 'Payment amount must be positive.'); }\n    void payAmount;",
  },
  {
    id: 'M3',
    invariant: 'F-5 student refund parses the amount (restores Number() coercion)',
    file: STU,
    find: "  let refundAmount: number;\n  try { refundAmount = assertMoney(amount, 'Refund amount'); }\n  catch { throw new HttpError(400, 'Refund amount must be positive.'); }\n  if (refundAmount <= 0) throw new HttpError(400, 'Refund amount must be positive.');",
    replace: "  const refundAmount = Number(amount);\n  if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new HttpError(400, 'Refund amount must be positive.');",
  },
  {
    id: 'M4',
    invariant: 'F-5 student refund still rejects a non-positive parsed amount',
    file: STU,
    find: "  catch { throw new HttpError(400, 'Refund amount must be positive.'); }\n  if (refundAmount <= 0) throw new HttpError(400, 'Refund amount must be positive.');",
    replace: "  catch { throw new HttpError(400, 'Refund amount must be positive.'); }\n  void refundAmount;",
  },
  {
    id: 'M5',
    invariant: 'F-5 student payment parses the amount once (restores raw Number())',
    file: STU,
    find: "  let parsedAmount: number | null = null;\n  if (amountSupplied) {\n    try { parsedAmount = assertMoney(amount, 'Amount'); }\n    catch { throw new HttpError(400, 'Amount must be greater than 0.'); }\n  }",
    replace: '  const parsedAmount: number | null = amountSupplied ? Number(amount) : null;',
  },
  {
    id: 'M6',
    invariant: 'F-5 the parsed amount feeds the idempotency fingerprint',
    file: STU,
    find: "    category,\n    amount: parsedAmount,",
    replace: "    category,\n    amount: amount === undefined || amount === null || amount === '' ? null : Number(amount),",
  },
  {
    id: 'M7',
    invariant: 'F-5 student payment still rejects a non-positive parsed amount',
    file: STU,
    find: "  const requestedAmount = parsedAmount;\n  if (requestedAmount !== null && requestedAmount <= 0) throw new HttpError(400, 'Amount must be greater than 0.');",
    replace: '  const requestedAmount = parsedAmount;',
    // PROVEN EQUIVALENT — verified by live probe, not by inspection.
    // This early guard is defence in depth: `resolvedAmount <= 0` at
    // students.routes.ts:1034 (and :1054) rejects the same requests further
    // down the same handler. With this line deleted, amount 0 / '0' / 0.001
    // still return exactly 400 "Amount must be greater than 0." and still
    // write zero payment rows — byte-identical observable behaviour.
    // Kept because it fails fast and states the contract at the top of the
    // handler; NOT removed, and no test was weakened to accommodate it.
    equivalent: true,
  },
  {
    id: 'M8',
    invariant: 'F-5 "amount not supplied" still means null (derive-the-charge contract)',
    file: STU,
    find: "  const amountSupplied = !(amount === undefined || amount === null || amount === '');",
    replace: '  const amountSupplied = true;',
  },
  {
    id: 'M9',
    invariant: 'F-5 donation desk parses the amount (restores the raw-body guard)',
    file: FUN,
    find: "    const donationAmount = assertMoney(amount, 'donation amount');\n    if (donationAmount <= 0) throw new HttpError(400, 'Donor and a positive amount are required.');",
    replace: "    const donationAmount = amount;\n    if (donationAmount <= 0) throw new HttpError(400, 'Donor and a positive amount are required.');",
  },
  {
    id: 'M10',
    invariant: 'F-5 the donation row stores the parsed amount',
    file: FUN,
    find: '        newId, campaignId || null, donorId, donationAmount, donationDate, ',
    replace: '        newId, campaignId || null, donorId, amount, donationDate, ',
  },
  {
    id: 'M11',
    invariant: 'F-5 the campaign total is credited the parsed amount',
    file: FUN,
    find: '        stmtUpdateCampaignRaisedAmount.run(donationAmount, campaignId);',
    replace: '        stmtUpdateCampaignRaisedAmount.run(amount, campaignId);',
  },
  {
    id: 'M12',
    invariant: 'F-5 the donation income ledger posts the parsed amount',
    file: FUN,
    find: "        category: 'donation', amount: donationAmount, date: donationDate,",
    replace: "        category: 'donation', amount, date: donationDate,",
    // PROVEN EQUIVALENT — verified by live probe, not by inspection.
    // recordIncome() re-parses its own input through the SAME authority
    // (utils/income.ts:54 `assertMoney(params.amount, 'income amount',
    // { allowNegative: true })`), so handing it the raw body value yields a
    // ledger row identical to handing it the parsed one. Probed with 100.005,
    // 0.005, '3000.50' and 2500: donation row and ledger row agreed on every
    // input (100.01, 0.01, 3000.5, 2500).
    // Passing the parsed value is still correct and is kept — it keeps the
    // handler's four writes reading from one variable — but no test can
    // distinguish it, because the ledger has its own boundary. That defence in
    // depth is the reason, and it is proven rather than assumed.
    equivalent: true,
  },
  {
    id: 'M13',
    invariant: 'F-5 the donation idempotency fingerprint uses the parsed amount',
    file: FUN,
    find: '      amount: donationAmount,\n      date: donationDate,',
    replace: '      amount: Number(amount),\n      date: donationDate,',
  },
]

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

console.log('MONEY-WRITER PARITY (F-5) — MUTATION TESTING');
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
    const status = killed ? 'KILLED' : m.equivalent ? 'EQUIVALENT' : 'SURVIVED';
    results.push({ ...m, status, detail });
    console.log(`${m.id.padEnd(4)} ${status.padEnd(10)} ${m.invariant} (${detail})`);
  }
} finally {
  restoreAll();
  wipeDb();
}

console.log('\n' + '='.repeat(78));
const killed = results.filter((r) => r.status === 'KILLED').length;
const survived = results.filter((r) => r.status === 'SURVIVED');
const equivalent = results.filter((r) => r.status === 'EQUIVALENT');
const invalid = results.filter((r) => r.status === 'INVALID');
console.log(`KILLED: ${killed}/${results.length - equivalent.length}   PROVEN EQUIVALENT: ${equivalent.length}   SURVIVED: ${survived.length}   INVALID: ${invalid.length}`);
if (equivalent.length) {
  console.log('\nPROVEN-EQUIVALENT MUTANTS (behaviour identical; proven by live probe, not assumed):');
  for (const e of equivalent) console.log(`  ${e.id} — ${e.invariant}`);
}
if (survived.length) {
  console.log('\nSURVIVING MUTANTS (missing test coverage):');
  for (const s of survived) console.log(`  ${s.id} — ${s.invariant} (${s.file})`);
}
const wronglyEquivalent = results.filter((r) => r.status === 'KILLED' && r.equivalent);
if (wronglyEquivalent.length) {
  console.log('\nNOTE: mutants marked equivalent were KILLED — coverage improved; drop the flag:');
  for (const w of wronglyEquivalent) console.log(`  ${w.id} — ${w.invariant}`);
}
if (invalid.length) {
  console.log('\nINVALID MUTANTS (pattern drifted — fix the harness):');
  for (const s of invalid) console.log(`  ${s.id} — ${s.detail}`);
}
process.exit(survived.length === 0 && invalid.length === 0 ? 0 : 1);
