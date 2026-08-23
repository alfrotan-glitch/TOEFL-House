/**
 * Every mutation that moves CASH must refresh the finance overview.
 * ============================================================================
 * DEFECT CLASS: stale financial state in the UI after a successful mutation.
 *
 * `GET /finance/overview` returns `income`, `expense` and `net`. Three
 * apiStore mutators wrote an `expense` ledger row and then reloaded budget
 * lines, transactions and notifications — but not the overview itself. The
 * header therefore kept showing the pre-payment net until some unrelated
 * action happened to refresh it.
 *
 * Reproduced against the live API:
 *
 *   payTeacherSalary       expense 0     -> 20000, net 500000 -> 480000
 *   payEmployeeSalary      (same path, same ledger row)
 *   processExpenseApproval expense 20000 -> 27000, net 480000 -> 473000
 *
 * Deliberately NOT changed: `issueInvoice` and `cancelInvoice`. Verified live
 * that neither moves income/expense/net — an invoice is an obligation, not
 * cash, and it only affects the overview once a payment is recorded (and that
 * path already reloads). `classifyBudgetLine` and `editDonor` move no money.
 *
 * This test asserts the rule for every cash mutator rather than the three that
 * were broken, so the next one that forgets fails here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const apiStore = fs.readFileSync(path.join(repoRoot, 'src', 'apiStore.ts'), 'utf8');

/** Extract the body of a top-level `const name = async (...) => { ... };` */
function bodyOf(name: string): string {
  const re = new RegExp(`const ${name} = async \\(([\\s\\S]*?)\\) => \\{([\\s\\S]*?)\\n  \\};`);
  const m = apiStore.match(re);
  if (!m) throw new Error(`mutator ${name} not found in apiStore.ts`);
  return m[2];
}

/** Mutators that write a financial_transactions row and therefore move the overview. */
const CASH_MUTATORS = [
  'payTeacherSalary',
  'payEmployeeSalary',
  'processExpenseApproval',
  'recordBookSale',
  'returnBookSale',
];

describe('cash mutations refresh the finance overview', () => {
  for (const name of CASH_MUTATORS) {
    it(`${name} reloads the finance overview`, () => {
      expect(bodyOf(name)).toContain('reloadFinanceOverview()');
    });
  }

  it('every cash mutator also invalidates the finance dataset', () => {
    for (const name of CASH_MUTATORS) {
      expect(bodyOf(name), `${name} must invalidate finance`).toMatch(/invalidate\([^)]*'finance'/);
    }
  });

  it('the overview endpoint really does expose the totals these mutators move', () => {
    // If this ever stops being true the rule above is pointless, so pin it.
    const financeRoutes = fs.readFileSync(
      path.join(repoRoot, 'server', 'src', 'routes', 'finance.routes.ts'), 'utf8',
    );
    expect(financeRoutes).toContain('income, expense, net: income - expense');
  });
});
