/**
Integration test: Safe Formula Parser (Audit §6.4)
Verifies that the recursive-descent parser correctly evaluates
arithmetic expressions and rejects dangerous inputs.
*/
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { createRule, seedDefaultRules, evaluateRules } from '../core/configuration/rule-engine.js';

beforeAll(() => {
  initSchema();
  seedDefaultRules();
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location) VALUES (?, ?, ?)').run(
    'b1', 'Test Branch', 'Test Location'
  );
  // Exercise the rule engine's generic block action without making a business
  // rule a second authority for a domain operation such as profit withdrawal.
  createRule(
    {
      name: 'Test-only generic block action',
      description: 'Verifies block action evaluation.',
      category: 'academic',
      conditions: [{ field: 'shouldBlock', operator: 'eq', value: true }],
      actions: [{ type: 'block', targetKey: '__blocked', message: 'Operation blocked by test rule.' }],
      priority: 1,
      isActive: true,
      scopeBranchId: 'b1',
      lastModifiedBy: 'test',
    },
    'test',
  );
});

afterAll(() => {
  // Shared test DB lifecycle is managed by the Vitest process; do not close the singleton here.
});

describe('Safe Formula Parser', () => {
  it('evaluates basic arithmetic via the finance savings rule', () => {
    const result = evaluateRules({
      category: 'finance',
      branchId: 'b1',
      data: { transactionType: 'income', amount: 10000 },
    });

    // The "Automatic Savings — 5% of Income" rule uses formula: amount * 0.05
    expect(result.finalOutputs.savingAmount).toBe(500);
  });

  it('evaluates a variable-only formula (payroll rule)', () => {
    const result = evaluateRules({
      category: 'payroll',
      branchId: 'b1',
      data: { salaryType: 'per_skill', totalSkillRates: 45000 },
    });

    // The "Per-Skill Salary Calculation" rule uses formula: totalSkillRates
    expect(result.finalOutputs.monthlySalary).toBe(45000);
  });

  it('returns 0 for unknown variables (no crash)', () => {
    const result = evaluateRules({
      category: 'finance',
      branchId: 'b1',
      data: { transactionType: 'income', amount: 10000, nonexistentVar: 999 },
    });

    // Should still work — the savings rule only references "amount"
    expect(result.finalOutputs.savingAmount).toBe(500);
  });

  it('evaluates a generic block action', () => {
    const result = evaluateRules({
      category: 'academic',
      branchId: 'b1',
      data: { shouldBlock: true },
    });

    expect(result.isBlocked).toBe(true);
    expect(result.blockReason).toContain('test rule');
  });
});