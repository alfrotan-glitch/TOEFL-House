/**
 * The configured rule is the discount authority, not a literal in a route
 * ============================================================================
 * `visitors.routes` computed the discount through the rule engine and then
 * re-clamped the answer with a hardcoded `Math.min(30, ...)`. The institutional
 * cap lives in `rule_default_discount_cap`, which an admin can edit at runtime,
 * so raising the cap to 50% silently had no effect on conversions: the engine
 * returned 50 and the route quietly clamped it back to 30.
 *
 * Proven before the fix by editing the rule and comparing:
 *   rule engine -> 50 ;  route's Math.min(30, 50) -> 30
 *
 * A policy that cannot be changed from the place it is configured is not a
 * policy, so this locks the engine as the single source of the ceiling.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initSchema } from '../db/connection.js';
import { evaluateRules } from '../core/configuration/rule-engine.js';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const RULE = 'rule_default_discount_cap';
let original: { conditions: string; actions: string } | undefined;

beforeAll(() => {
  initSchema();
  original = db.prepare('SELECT conditions, actions FROM rule_definitions WHERE id = ?').get(RULE) as typeof original;
});

afterEach(() => {
  if (original) {
    db.prepare('UPDATE rule_definitions SET conditions = ?, actions = ? WHERE id = ?')
      .run(original.conditions, original.actions, RULE);
  }
});

describe('discount ceiling is configuration, not a hardcoded literal', () => {
  it('the conversion route does not re-clamp the rule engine with a magic number', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'server/src/routes/visitors.routes.ts'), 'utf8');
    // The regression: Math.min(30, <engine answer>).
    expect(src).not.toMatch(/Math\.min\(\s*30\s*,/);
  });

  it('honours a cap the administrator raises at runtime', () => {
    if (!original) return; // rule catalogue not seeded in this DB
    db.prepare('UPDATE rule_definitions SET conditions = ?, actions = ? WHERE id = ?').run(
      JSON.stringify([{ field: 'discountPercent', operator: 'gt', value: 50 }]),
      JSON.stringify([{ type: 'set_value', targetKey: 'discountPercent', value: 50 }]),
      RULE,
    );
    const out = evaluateRules({ category: 'discount', branchId: '1', data: { discountPercent: 50, leadSource: 'walk_in' }, dryRun: true });
    // With the cap raised, 50 must survive. Under the old route logic the
    // caller saw 30 no matter what the administrator configured.
    expect(Number(out.finalOutputs.discountPercent)).toBe(50);
  });

  it('still enforces the default ceiling when the rule is left alone', () => {
    if (!original) return;
    const out = evaluateRules({ category: 'discount', branchId: '1', data: { discountPercent: 90, leadSource: 'walk_in' }, dryRun: true });
    expect(Number(out.finalOutputs.discountPercent)).toBe(30);
  });
});
