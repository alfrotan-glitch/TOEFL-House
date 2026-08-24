import type BetterSqlite3 from 'better-sqlite3';
import { assertMoney } from '../../utils/money.js';

export type FeeKey = 'placementTestFee' | 'registrationFee' | 'cardIssuanceFee' | 'diplomaFee';
export type FeeRuleType = 'registration' | 'placement' | 'semester' | 'retake' | 'diploma' | 'card';

const FEE_TYPE_BY_KEY: Record<FeeKey, FeeRuleType> = {
  placementTestFee: 'placement',
  registrationFee: 'registration',
  cardIssuanceFee: 'card',
  diplomaFee: 'diploma',
};

export interface FeeRuleScope {
  programVersionId?: string | null;
  levelId?: string | null;
  /** yyyy-mm-dd; defaults to today in local calendar-neutral ISO form. */
  asOfDate?: string | null;
}

export interface ResolvedFeeRule {
  id: string;
  feeType: FeeRuleType;
  name: string;
  amount: number;
  branchId: string | null;
  programVersionId: string | null;
  levelId: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  isOptional: boolean;
  version: number;
  isActive: boolean;
}

const LOOKUP_SQL = `
  SELECT id, fee_type, name, amount, branch_id, program_version_id, level_id,
         effective_from, effective_to, is_optional, version, is_active
    FROM fee_rules
   WHERE fee_type = ?
     AND branch_id = ?
     AND is_active = 1
     AND (program_version_id IS NULL OR program_version_id = ?)
     AND (level_id IS NULL OR level_id = ?)
     AND (effective_from IS NULL OR effective_from <= ?)
     AND (effective_to IS NULL OR effective_to >= ?)
   ORDER BY
     CASE WHEN level_id = ? THEN 1 ELSE 0 END DESC,
     CASE WHEN program_version_id = ? THEN 1 ELSE 0 END DESC,
     version DESC,
     created_at DESC,
     id DESC
   LIMIT 1
`;

const lookupStatement = (db: BetterSqlite3.Database) => db.prepare(LOOKUP_SQL);

function normalizeAsOfDate(value: string | null | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || new Date().toISOString().slice(0, 10);
}

function normalizeAmount(row: { amount: unknown; fee_type: string }): number {
  return assertMoney(row.amount, `Stored ${row.fee_type} fee`);
}

export function resolveFeeRule(
  db: BetterSqlite3.Database,
  branchId: string | null | undefined,
  feeType: FeeRuleType,
  scope: FeeRuleScope = {},
): ResolvedFeeRule | null {
  if (!branchId) return null;
  const programVersionId = scope.programVersionId ?? null;
  const levelId = scope.levelId ?? null;
  const asOfDate = normalizeAsOfDate(scope.asOfDate);
  const row = lookupStatement(db).get(
    feeType,
    branchId,
    programVersionId,
    levelId,
    asOfDate,
    asOfDate,
    levelId,
    programVersionId,
  ) as {
    id: string;
    fee_type: FeeRuleType;
    name: string;
    amount: unknown;
    branch_id: string | null;
    program_version_id: string | null;
    level_id: string | null;
    effective_from: string | null;
    effective_to: string | null;
    is_optional: number;
    version: number;
    is_active: number;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    feeType: row.fee_type,
    name: row.name,
    amount: normalizeAmount(row),
    branchId: row.branch_id,
    programVersionId: row.program_version_id,
    levelId: row.level_id,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    isOptional: !!row.is_optional,
    version: Number(row.version ?? 1),
    isActive: !!row.is_active,
  };
}

/**
 * Returns the configured fee amount or null when no active applicable rule
 * exists. It never falls back to a hard-coded default or to the retired branch
 * profile columns.
 */
export function resolveFee(
  db: BetterSqlite3.Database,
  branchId: string | null | undefined,
  key: FeeKey,
  scope: FeeRuleScope = {},
): number | null {
  return resolveFeeRule(db, branchId, FEE_TYPE_BY_KEY[key], scope)?.amount ?? null;
}
