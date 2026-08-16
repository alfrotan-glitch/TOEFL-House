import type BetterSqlite3 from 'better-sqlite3';
import { SYSTEM_DEFAULTS } from './policy-catalog.js';

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

export function resolveFee(db: BetterSqlite3.Database, branchId: string | null | undefined, key: FeeKey): number {
  const fallback = DEFAULT_FEE_MAP[key];
  if (!branchId) return fallback;
  const column = PROFILE_COLUMNS[key];
  const row = db.prepare(`SELECT ${column} AS value FROM branch_academic_profiles WHERE branch_id = ?`).get(branchId) as { value?: number | null } | undefined;
  return row?.value != null && Number.isFinite(Number(row.value)) ? Number(row.value) : fallback;
}

