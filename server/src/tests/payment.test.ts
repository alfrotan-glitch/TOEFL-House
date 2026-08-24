/**
 * RETIRED KNOWLEDGE RECORD — Payment Recording (Audit §8.1).
 * ============================================================================
 * The original two examples were `describe.skip(...)` because they hand-wrote
 * `INSERT INTO payments` / `financial_transactions` directly and therefore did
 * not exercise any production writer. Leaving them skipped obscured whether the
 * skip was accidental. They now run as an active coverage-map guard instead.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const paymentTestPath = path.join(__dirname, 'payment.test.ts');
const replacementSuites = [
  'cash-position-reconciliation.test.ts',
  'refund-reclaims-savings.test.ts',
  'finance-money-writer-parity.test.ts',
  path.join('work-packages', 'wp07', 'cash-allocation-authority.test.ts'),
] as const;

describe('Payment Recording — retired coverage map', () => {
  it('keeps an explicit in-file explanation of why the direct-SQL examples are retired', () => {
    const source = fs.readFileSync(paymentTestPath, 'utf8');
    expect(source).toContain('WHY IT IS RETIRED');
    expect(source).toContain('hand-writes an');
    expect(source).toContain('No production code path can regress and make it fail.');
  });

  it('points at live replacement suites that exercise real money writers and authorities', () => {
    for (const relativePath of replacementSuites) {
      const absolutePath = path.join(__dirname, relativePath);
      expect(fs.existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
    }
  });
});
