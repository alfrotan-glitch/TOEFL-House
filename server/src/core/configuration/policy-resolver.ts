import type BetterSqlite3 from 'better-sqlite3';
import { SYSTEM_DEFAULTS } from './policy-catalog.js';
import { assertMoney } from '../../utils/money.js';

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
 * written before that fix are untouched by it, and the previous guard here was
 * only `Number.isFinite` — which let legacy values through:
 *   -100  -> returned as-is (Finance rejected it late, as a 500)
 *   1e20  -> returned as-is (rejected late)
 *   0.001 -> returned as-is and ACCEPTED by Finance, silently
 *
 * A value that `assertMoney` cannot accept, or that would be silently rounded
 * into a DIFFERENT fee, is treated as unusable configuration and falls back to
 * the system default. Failing to the documented default is safe and visible;
 * charging a corrupt amount is neither. `scripts/legacy-config-data-audit.mjs`
 * inventories any row in this state so it can be corrected at the source.
 */
export function resolveFee(db: BetterSqlite3.Database, branchId: string | null | undefined, key: FeeKey): number {
  const fallback = DEFAULT_FEE_MAP[key];
  if (!branchId) return fallback;
  const column = PROFILE_COLUMNS[key];
  const row = db.prepare(`SELECT ${column} AS value FROM branch_academic_profiles WHERE branch_id = ?`).get(branchId) as { value?: number | null } | undefined;
  if (row?.value == null) return fallback;
  try {
    const money = assertMoney(row.value, key);
    // Reject rather than silently charge a rounded amount (0.001 -> 0).
    if (typeof row.value === 'number' && row.value !== money) return fallback;
    return money;
  } catch {
    return fallback;
  }
}

