/**
 * Canonical owner profit-distribution authority.
 *
 * Both the published position and the enforcing mutation call this module. The
 * authority computes the period allowance, subtracts prior distributions, and
 * preserves the owner-approved minimum post-withdrawal liquidity reserve.
 */
import { TREASURY_DEFAULTS } from '../configuration/policy-catalog.js';
import { assertComputedMoney, assertMoney } from '../../utils/money.js';

export interface ProfitDistributionInput {
  /** Operating income for the period. */
  revenue: number;
  /** Operating expense for the period. Owner drawings are NOT operating cost —
   *  the taxonomy classifies them non_expense_cash_movement, so OPERATING
   *  expense never contains them and prior distributions must not be added
   *  back here. The period's allowance still subtracts them below. */
  expense: number;
  /** Owner drawings already taken in this period. */
  distributed: number;
  /** Total monthly fixed cost, the basis for treasury thresholds. */
  fixedTotal: number;
  /** Branch cash available for a withdrawal. */
  mainBalance: number;
  /** Branch savings included in total liquidity but never debited by a withdrawal. */
  savingBalance: number;
}

export interface ProfitDistribution {
  /** Profit before distributions, which is the tier basis. */
  profit: number;
  marginPercent: number;
  tierPercent: number;
  /** Total period allowance before prior drawings are subtracted. */
  periodAllowance: number;
  /** Allowance remaining after prior drawings. */
  remainingAllowance: number;
  distributed: number;
  mainBalance: number;
  savingBalance: number;
  /** Main cash plus savings before a proposed withdrawal. */
  totalLiquidity: number;
  reserveFundTarget: number;
  reserveFundMet: boolean;
  /** Amount total liquidity can lose while still meeting the reserve target. */
  liquidityHeadroom: number;
  /** Executable ceiling after allowance, cash, and reserve limits. */
  maxWithdrawable: number;
}

/** Returns the owner-approved profit share for a margin percentage. */
export function resolveDistributionTier(marginPercent: number): number {
  for (const band of TREASURY_DEFAULTS.profitDistributionTiers) {
    if (marginPercent >= band.minMarginPercent) return band.sharePercent;
  }
  return 0;
}

/** Minimum total branch liquidity that must remain after a withdrawal. */
export function reserveFundTargetFor(fixedTotal: number): number {
  return assertComputedMoney(
    fixedTotal * TREASURY_DEFAULTS.reserveFundMonths,
    'reserve fund target',
  );
}

/** Main-cash level below which the BOS raises an operational warning. */
export function cashReserveWarningThresholdFor(fixedTotal: number): number {
  return assertComputedMoney(
    fixedTotal * TREASURY_DEFAULTS.cashReserveWarningMonths,
    'cash reserve warning threshold',
  );
}

/** Resolves the complete, executable distribution position for a period. */
export function computeProfitDistribution(input: ProfitDistributionInput): ProfitDistribution {
  const distributed = assertMoney(input.distributed, 'distributed this period');
  const revenue = assertComputedMoney(input.revenue, 'period revenue', { allowNegative: true });
  const expense = assertComputedMoney(input.expense, 'period expense', { allowNegative: true });
  const mainBalance = assertMoney(input.mainBalance, 'main account balance');
  const savingBalance = assertMoney(input.savingBalance, 'saving account balance');

  // Owner drawings are an equity transfer, not an operating cost: the
  // classification authority already excludes them from `expense`, so the
  // pre-distribution profit is simply revenue − expense. Adding `distributed`
  // back here as well double-counted every withdrawal: each one grew profit,
  // lifted the tier basis, and replenished 15% of itself — a geometric drain
  // proven live (ceiling 24,000 AFN paid out 28,234 AFN and still counting).
  const profit = assertComputedMoney(revenue - expense, 'calculated profit', {
    allowNegative: true,
  });
  const marginPercent = revenue > 0 ? (profit / revenue) * 100 : 0;
  const tierPercent = resolveDistributionTier(marginPercent);
  const periodAllowance =
    profit > 0
      ? Math.max(
          0,
          assertComputedMoney((profit * tierPercent) / 100, 'period allowance', {
            allowNegative: true,
          }),
        )
      : 0;
  const remainingAllowance = Math.max(
    0,
    assertComputedMoney(periodAllowance - distributed, 'remaining allowance', {
      allowNegative: true,
    }),
  );

  const totalLiquidity = assertComputedMoney(
    mainBalance + savingBalance,
    'total branch liquidity',
  );
  const reserveFundTarget = reserveFundTargetFor(input.fixedTotal);
  const liquidityHeadroom = Math.max(
    0,
    assertComputedMoney(totalLiquidity - reserveFundTarget, 'liquidity above reserve', {
      allowNegative: true,
    }),
  );
  const reserveFundMet = totalLiquidity >= reserveFundTarget;
  const maxWithdrawable = reserveFundMet
    ? Math.min(remainingAllowance, mainBalance, liquidityHeadroom)
    : 0;

  return {
    profit,
    marginPercent,
    tierPercent,
    periodAllowance,
    remainingAllowance,
    distributed,
    mainBalance,
    savingBalance,
    totalLiquidity,
    reserveFundTarget,
    reserveFundMet,
    liquidityHeadroom,
    maxWithdrawable,
  };
}
