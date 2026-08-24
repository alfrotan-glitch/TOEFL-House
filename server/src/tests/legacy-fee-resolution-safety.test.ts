/**
 * CANONICAL FEE-RULE SAFETY — malformed stored fee rules must fail CLOSED.
 *
 * Fixed operational fees are now read only from `fee_rules`. There is no
 * hard-coded fallback and no second authority in branch profiles, so a corrupt
 * stored amount must stop the charge instead of being substituted.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { resolveFee } from '../core/configuration/policy-resolver.js';

const BR = 'legacyfee_branch';

function storeRule(id: string, feeType: string, amount: unknown) {
  db.prepare('DELETE FROM fee_rules WHERE id = ?').run(id);
  db.prepare(
    `INSERT INTO fee_rules (id, branch_id, fee_type, name, amount, version, is_active)
     VALUES (?, ?, ?, ?, ?, 1, 1)`,
  ).run(id, BR, feeType, `${feeType} fee`, amount as never);
}

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?,?,?,?,1)')
    .run('legacyfee_campus', FIXED_ORG_ID, 'Legacy Fee Campus', 'LGF');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?,?,?,?)')
    .run(BR, BR, 'Loc', 'legacyfee_campus');
});

describe('canonical fee rules fail closed on malformed stored money', () => {
  it.each([
    ['negative', -100, /cannot be negative/i],
    ['fractional', 0.001, /whole number/i],
    ['beyond precision', 1e20, /precision/i],
    ['non-finite text', 'abc', /finite number/i],
  ])('rejects a %s placement fee rule at read time', (_label, amount, message) => {
    storeRule('legacyfee_bad', 'placement', amount);
    expect(() => resolveFee(db, BR, 'placementTestFee')).toThrow(message);
  });

  it('returns a valid stored fee unchanged', () => {
    storeRule('legacyfee_ok', 'placement', 450);
    expect(resolveFee(db, BR, 'placementTestFee')).toBe(450);
  });

  it('keeps zero as an explicit configured fee', () => {
    storeRule('legacyfee_zero', 'registration', 0);
    expect(resolveFee(db, BR, 'registrationFee')).toBe(0);
  });

  it('returns null when no active applicable rule exists', () => {
    db.prepare("DELETE FROM fee_rules WHERE branch_id = ? AND fee_type = 'card'").run(BR);
    expect(resolveFee(db, BR, 'cardIssuanceFee')).toBeNull();
  });
});
