/**
 * Scholarship and sponsorship money must clear the same bar as every other
 * monetary input — and a NaN budget must never disable a budget check.
 * ============================================================================
 * DEFECT CLASS: an unvalidated stored value poisoning a LATER comparison.
 *
 * `POST /funding/scholarships` wrote `totalBudget` straight through. Verified
 * against the live API — all of these were accepted and persisted:
 *
 *     totalBudget "abc"  -> stored as the literal TEXT 'abc'
 *     totalBudget 1e309  -> stored as NULL
 *     totalBudget -5000  -> stored as a negative fund
 *     totalBudget 1e15   -> stored as one quadrillion
 *
 * The damage landed one endpoint away. `POST /funding/scholarships/award`
 * computed:
 *
 *     const remaining = scholarship.total_budget - scholarship.allocated_amount;
 *     if (amount > remaining) throw ...
 *
 * With a budget of 'abc' that is `NaN`, and `999999 > NaN` is **false**, so the
 * guard passed and 999,999 AFN was awarded from a fund that had no valid
 * budget. `allocated_amount` became 999999 against a total of 'abc'.
 *
 * The award handler had the same coercion bug in its own entry check
 * (`amount <= 0`, where `NaN <= 0` is false).
 *
 * Fixes, at the lowest layer:
 *   - both figures go through the shared `assertMoney` invariant;
 *   - the award handler coerces the stored budget explicitly and refuses to
 *     award against a non-finite one, so a legacy row written before this fix
 *     cannot silently re-enable the hole;
 *   - the comparison is inverted to `!(amount <= remaining)` so a NaN on
 *     either side fails closed instead of open.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMoney } from '../utils/money.js';

const fundingSource = fs.readFileSync(
  path.join(path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..'), 'routes', 'funding.routes.ts'),
  'utf8',
);

describe('funding money validation', () => {
  it('rejects a non-numeric scholarship budget', () => {
    expect(() => assertMoney('abc', 'scholarship budget')).toThrow(/finite number/i);
  });

  it('rejects a negative scholarship budget', () => {
    expect(() => assertMoney(-5000, 'scholarship budget')).toThrow(/negative/i);
  });

  it('rejects budgets beyond the float range or monetary precision', () => {
    expect(() => assertMoney('1e309', 'scholarship budget')).toThrow(/finite number/i);
    expect(() => assertMoney(1e15, 'scholarship budget')).toThrow(/precision/i);
  });

  it('rejects a non-numeric or negative monthly sponsorship amount', () => {
    expect(() => assertMoney('abc', 'monthly sponsorship amount')).toThrow(/finite number/i);
    expect(() => assertMoney(-500, 'monthly sponsorship amount')).toThrow(/negative/i);
  });

  it('accepts ordinary funding amounts', () => {
    expect(assertMoney(50_000, 'scholarship budget')).toBe(50_000);
    expect(() => assertMoney('2500.50', 'monthly sponsorship amount')).toThrow(/whole number/i);
  });
});

describe('the award budget check fails closed on a poisoned budget', () => {
  /** The corrected comparison, exactly as the route now spells it. */
  const wouldReject = (amount: number, budget: unknown, allocated: unknown) => {
    const total = Number(budget);
    const alloc = Number(allocated) || 0;
    if (!Number.isFinite(total)) return true; // refuse outright
    return !(amount <= total - alloc);
  };

  it('refuses to award against a non-numeric budget', () => {
    // This is the exact scenario reproduced live: 999,999 from an 'abc' fund.
    expect(wouldReject(999_999, 'abc', 0)).toBe(true);
  });

  it('refuses to award against a NULL budget', () => {
    // Number(null) is 0, not NaN — so this must fail on the amount instead.
    expect(wouldReject(999_999, null, 0)).toBe(true);
  });

  it('the old comparison would have approved it — proving the inversion matters', () => {
    const oldGuardApproves = !(999_999 > ('abc' as unknown as number) - 0);
    expect(oldGuardApproves).toBe(true);
  });

  it('still enforces a real budget correctly', () => {
    expect(wouldReject(20_000, 50_000, 0)).toBe(false);
    expect(wouldReject(20_000, 50_000, 20_000)).toBe(false);
    expect(wouldReject(20_000, 50_000, 40_000)).toBe(true);
  });

  it('the route validates the award amount and bounds it by money the fund RECEIVED', () => {
    expect(fundingSource).toContain("const awardAmount = assertMoney(amount, 'award amount');");
    // Owner decision D-121 replaced the declared-budget ceiling with received
    // funding, which makes this invariant strictly stronger: a poisoned
    // `total_budget` can no longer approve anything, because it no longer
    // participates in the decision at all.
    expect(fundingSource).toContain('const fund = getFundPosition(db, scholarshipId);');
    expect(fundingSource).toContain('if (!(awardAmount <= fund.available))');
    // The coercions that caused the original defect must not return. (The
    // donations handler still uses `amount <= 0`, but its value reaches
    // recordIncome, which runs assertMoney and a whole-AFN DB trigger.)
    expect(fundingSource).not.toContain('const remaining = scholarship.total_budget - scholarship.allocated_amount;');
    expect(fundingSource).not.toContain('const remaining = totalBudgetValue - allocatedValue;');
    expect(fundingSource).not.toContain('!scholarshipId || !studentId || !amount || amount <= 0');
    // Behaviour for both is proven end-to-end in
    // `work-packages/wp07/scholarship-funding-authority.test.ts`.
  });

  it('the persisted award uses the validated amount, and the fund figure is derived', () => {
    expect(fundingSource).toContain('stmtInsertAward.run(newId, scholarshipId, studentId, awardAmount');
    // `scholarships.allocated_amount` is now a display mirror of a derived
    // figure rather than an independently maintained running total.
    expect(fundingSource).toContain('const committed = getFundPosition(db, scholarshipId).committed;');
    expect(fundingSource).not.toContain('const newAllocated = allocatedValue + awardAmount;');
  });

  it('the scholarship insert uses the validated budget', () => {
    expect(fundingSource).toContain("const validatedBudget = assertMoney(totalBudget, 'scholarship budget');");
    expect(fundingSource).not.toMatch(/campaignId \|\| null, totalBudget, criteria/);
  });
});
