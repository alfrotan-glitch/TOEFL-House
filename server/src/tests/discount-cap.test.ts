/**
Integration test: Discount Cap Enforcement (Audit §8.1)
Verifies that the Rule Engine caps cumulative discounts at 30%,
even when the input context requests a higher value.
*/
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { seedDefaultRules, evaluateRules } from '../core/configuration/rule-engine.js';

beforeAll(() => {
  initSchema();
  seedDefaultRules();
  // Seed a branch so branch-scoped queries don't fail
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(
    'b1', 'Test Branch', 'Test Location'
  );
});

afterAll(() => {
  // Shared test DB lifecycle is managed by the Vitest process; do not close the singleton here.
});

/**
 * SCOPE: the rule ENGINE, not the discount authority.
 *
 * `evaluateRules` clamps a percent it derives itself from configuration. The
 * 30% here is a rule in this fixture's configuration, NOT the operative
 * discount ceiling — the ordinary ceiling is resolved by
 * `resolveAuthorizedDiscount` and proven at 20% in
 * `discount-authorization-boundary.test.ts`, which overrides whatever the rule
 * engine derives. Read together, not separately.
 */
describe('Discount rule engine — derived-percent clamping (subordinate to the discount authority)', () => {
  it('caps discount at 30% when input exceeds the limit', () => {
    const result = evaluateRules({
      category: 'discount',
      branchId: 'b1',
      data: { discountPercent: 50 },
    });

    expect(result.finalOutputs.discountPercent).toBe(30);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('leaves discount unchanged when below the cap', () => {
    const result = evaluateRules({
      category: 'discount',
      branchId: 'b1',
      data: { discountPercent: 15 },
    });

    // No rule matches (15 is not > 30), so discountPercent stays as-is
    expect(result.finalOutputs.discountPercent).toBeUndefined();
  });

  it('applies friend referral discount correctly', () => {
    const result = evaluateRules({
      category: 'discount',
      branchId: 'b1',
      data: { leadSource: 'friend', discountPercent: 0 },
    });

    expect(result.finalOutputs.discountPercent).toBe(10);
  });
});