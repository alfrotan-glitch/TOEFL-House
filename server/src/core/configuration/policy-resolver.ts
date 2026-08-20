import type BetterSqlite3 from 'better-sqlite3';
import { SYSTEM_DEFAULTS } from './policy-catalog.js';
import { assertMoney, assertComputedMoney } from '../../utils/money.js';

export type FeeKey = 'placementTestFee' | 'registrationFee' | 'cardIssuanceFee' | 'diplomaFee';

const DEFAULT_FEE_MAP: Record<FeeKey, number> = {
  placementTestFee: SYSTEM_DEFAULTS.placementTestFee,
  registrationFee: SYSTEM_DEFAULTS.registrationFee,
  cardIssuanceFee: SYSTEM_DEFAULTS.cardIssuanceFee,
  diplomaFee: SYSTEM_DEFAULTS.diplomaFee,
};

const PROFILE_COLUMNS: Record<FeeKey, string> = {
  placementTestFee: 'placement_test_fee',
  registrationFee: 'registration_fee',
  cardIssuanceFee: 'card_fee',
  diplomaFee: 'diploma_fee',
};

/**
 * Reading a configured fee is the LAST boundary before the money writers, so a
 * stored value that is not usable money is not returned.
 *
 * CFG-2 validates the write path, so no new malformed fee can be stored. Rows
 * written before that fix are untouched by it, and a `Number.isFinite` guard
 * here would let these through:
 *   -100  -> returned as-is (Finance rejected it late, as a 500)
 *   1e20  -> returned as-is (rejected late)
 *   0.001 -> returned as-is and ACCEPTED by Finance, silently
 *
 * A value that `assertMoney` cannot accept, or that would be silently rounded
 * into a DIFFERENT fee, is treated as unusable configuration and falls back to
 * the system default. Failing to the documented default is safe and visible;
 * charging a corrupt amount is neither. `scripts/config-data-integrity-audit.mjs`
 * inventories any row in this state so it can be corrected at the source.
 */
export function resolveFee(db: BetterSqlite3.Database, branchId: string | null | undefined, key: FeeKey): number {
  const fallback = DEFAULT_FEE_MAP[key];
  if (!branchId) return fallback;
  const column = PROFILE_COLUMNS[key];
  const row = db.prepare(`SELECT ${column} AS value FROM branch_academic_profiles WHERE branch_id = ?`).get(branchId) as { value?: number | null } | undefined;
  if (row?.value == null) return fallback;
  try {
    // A stored value is not operator input, so it is SETTLED to the canonical
    // unit rather than refused: a read path that throws is worse than one that
    // rounds a stored row to the nearest afghani.
    const settled = assertComputedMoney(row.value, key);
    // But a non-zero fee that settles to nothing is not a rounding artifact —
    // it is a corrupt configuration, and charging 0 would silently make the
    // service free. That falls back to the configured default instead.
    if (Number(row.value) > 0 && settled === 0) return fallback;
    return settled;
  } catch {
    return fallback;
  }
}

