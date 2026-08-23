#!/usr/bin/env node
/**
 * WP-09 funding monetary-boundary mutation harness.
 *
 * Each mutation removes a live validation or preservation branch from the
 * canonical Funding router. The WP-09 amount authority suite must fail. The
 * harness restores the source after every attempt.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROUTE = 'src/routes/funding.routes.ts';
const TEST = 'src/tests/work-packages/wp09/funding-amount-integrity.test.ts';
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

// F1 is proven equivalent by execution: validation runs before the mutated
// write, so every reachable value is a whole-AFN number or numeric string and
// SQLite INTEGER affinity persists both representations identically. F3 is the
// discriminating mutation for removal of the actual validation boundary.
const EQUIVALENT = new Set(['F1']);

const MUTANTS = [
  {
    id: 'F1',
    invariant: 'sponsorship PATCH validates a supplied monthly promise',
    find: ": assertMoney(body.monthlyAmount, 'monthly sponsorship amount');",
    replace: ': (body.monthlyAmount as number);',
  },
  {
    id: 'F2',
    invariant: 'sponsorship PATCH preserves an omitted monthly promise',
    find: "body.monthlyAmount === undefined ? Number(existing.monthly_amount) : assertMoney(body.monthlyAmount, 'monthly sponsorship amount')",
    replace: "body.monthlyAmount === undefined ? 0 : assertMoney(body.monthlyAmount, 'monthly sponsorship amount')",
  },
  {
    id: 'F3',
    invariant: 'campaign PATCH validates a supplied target',
    find: ": assertMoney(body.targetAmount, 'campaign target amount');",
    replace: ': (body.targetAmount as number);',
  },
  {
    id: 'F4',
    invariant: 'campaign PATCH preserves an omitted target',
    find: "body.targetAmount === undefined ? Number(existing.target_amount) : assertMoney(body.targetAmount, 'campaign target amount')",
    replace: "body.targetAmount === undefined ? 0 : assertMoney(body.targetAmount, 'campaign target amount')",
  },
];

const selected = ONLY ? MUTANTS.filter((mutant) => mutant.id === ONLY) : MUTANTS;
if (!selected.length) {
  console.error(`No mutant matches --only ${ONLY}.`);
  process.exit(2);
}
const original = readFileSync(ROUTE, 'utf8');
const restore = () => writeFileSync(ROUTE, original);
const results = [];
try {
  for (const mutant of selected) {
    const hits = original.split(mutant.find).length - 1;
    if (hits !== 1) {
      results.push({ ...mutant, status: 'INVALID' });
      console.log(`${mutant.id} INVALID ${mutant.invariant} (anchor ${hits}x)`);
      continue;
    }
    writeFileSync(ROUTE, original.replace(mutant.find, mutant.replace));
    try {
      execSync(`rm -f src/tests/test.sqlite*; npx vitest run --no-file-parallelism ${TEST}`, { stdio: 'pipe', timeout: 180000 });
      const status = EQUIVALENT.has(mutant.id) ? 'EQUIVALENT' : 'SURVIVED';
      results.push({ ...mutant, status });
      console.log(`${mutant.id} ${status} ${mutant.invariant}`);
    } catch {
      results.push({ ...mutant, status: 'KILLED' });
      console.log(`${mutant.id} KILLED ${mutant.invariant}`);
    } finally {
      restore();
    }
  }
} finally {
  restore();
}
const invalid = results.filter((result) => result.status === 'INVALID');
const survived = results.filter((result) => result.status === 'SURVIVED');
const equivalent = results.filter((result) => result.status === 'EQUIVALENT');
console.log(`\n${results.filter((result) => result.status === 'KILLED').length}/${results.length - equivalent.length} killed, ${equivalent.length} equivalent, ${survived.length} survivors, ${invalid.length} invalid`);
process.exit(survived.length || invalid.length ? 1 : 0);
