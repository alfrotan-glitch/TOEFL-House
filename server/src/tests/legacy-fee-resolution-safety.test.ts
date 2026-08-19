/**
 * LEGACY DATA SAFETY — resolveFee() must never hand a malformed legacy value
 * to a money writer.
 *
 * CFG-2 fixed the WRITE path, so no NEW malformed fee can be stored. Rows that
 * were already stored are untouched by that fix, and `resolveFee` only checked
 * Number.isFinite — so a legacy -100, 0.001 or 1e20 was still returned as
 * authoritative money.
 *
 * Proven against a seeded legacy database before this guard existed:
 *   placement_test_fee = -100   -> resolveFee returned -100
 *   registration_fee   = 0.001  -> resolveFee returned 0.001, and Finance
 *                                  ACCEPTED it (silently, no error)
 *   diploma_fee        = 1e20   -> resolveFee returned 1e20
 *
 * -100 and 1e20 were caught late by assertMoney (as HTTP 500s); 0.001 was not
 * caught at all. Reading is the last boundary before money, so an unusable
 * stored value falls back to the system default rather than being charged.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db, initSchema } from '../db/connection.js';
import { ensureOrganizationHierarchy, FIXED_ORG_ID } from '../db/organizationHierarchy.js';
import { resolveFee } from '../core/configuration/policy-resolver.js';
import { SYSTEM_DEFAULTS } from '../core/configuration/policy-catalog.js';
import { assertMoney } from '../utils/money.js';

const BR = 'legacyfee_branch';

/** Write directly to the table, bypassing the (now validated) route. */
function storeLegacyFee(column: string, value: unknown) {
  db.prepare(`UPDATE branch_academic_profiles SET ${column} = ? WHERE branch_id = ?`).run(value as never, BR);
}

beforeAll(() => {
  initSchema();
  ensureOrganizationHierarchy(db);
  db.prepare('INSERT OR IGNORE INTO campuses (id, organization_id, name, code, is_active) VALUES (?,?,?,?,1)')
    .run('legacyfee_campus', FIXED_ORG_ID, 'Legacy Fee Campus', 'LGF');
  db.prepare('INSERT OR IGNORE INTO branches (id, name, location, campus_id) VALUES (?,?,?,?)')
    .run(BR, BR, 'Loc', 'legacyfee_campus');
  db.prepare(
    `INSERT OR REPLACE INTO branch_academic_profiles
       (branch_id, placement_test_fee, registration_fee, card_fee, diploma_fee,
        default_pass_mark, default_min_attendance, updated_at)
     VALUES (?, 300, 0, 200, 500, 60, 75, datetime('now'))`,
  ).run(BR);
});

describe('legacy malformed fees cannot become authoritative money', () => {
  it.each([
    ['negative', 'placement_test_fee', -100, 'placementTestFee'],
    ['sub-cent', 'placement_test_fee', 0.001, 'placementTestFee'],
    ['beyond precision', 'placement_test_fee', 1e20, 'placementTestFee'],
    ['non-finite text', 'card_fee', 'abc', 'cardIssuanceFee'],
  ])('a legacy %s fee falls back to the system default', (_label, column, value, key) => {
    storeLegacyFee(column, value);
    const resolved = resolveFee(db, BR, key as never);

    // Whatever is returned must be chargeable money.
    expect(() => assertMoney(resolved, 'amount')).not.toThrow();
    expect(resolved).toBeGreaterThanOrEqual(0);
    expect(Math.round(resolved * 100)).toBe(resolved * 100); // at most 2dp
    expect(resolved).toBe(SYSTEM_DEFAULTS[key as keyof typeof SYSTEM_DEFAULTS]);
  });

  it('a valid stored fee is still returned unchanged', () => {
    storeLegacyFee('placement_test_fee', 450);
    expect(resolveFee(db, BR, 'placementTestFee')).toBe(450);
    storeLegacyFee('placement_test_fee', 450.25);
    expect(resolveFee(db, BR, 'placementTestFee')).toBe(450.25);
  });

  it('zero remains a legitimate fee', () => {
    storeLegacyFee('registration_fee', 0);
    expect(resolveFee(db, BR, 'registrationFee')).toBe(0);
  });

  it('every fee key is guarded, not just placement', () => {
    for (const [column, key] of [
      ['placement_test_fee', 'placementTestFee'],
      ['registration_fee', 'registrationFee'],
      ['card_fee', 'cardIssuanceFee'],
      ['diploma_fee', 'diplomaFee'],
    ] as const) {
      storeLegacyFee(column, -1);
      const resolved = resolveFee(db, BR, key);
      expect(resolved, `${key} must not resolve to a negative fee`).toBeGreaterThanOrEqual(0);
      expect(() => assertMoney(resolved, 'amount')).not.toThrow();
    }
  });
});
