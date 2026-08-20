/**
 * THE profit-distribution authority.
 * ============================================================================
 * How much of a period's profit an owner may withdraw, and how much of that
 * remains after what has already been taken.
 *
 * WHY THIS IS ONE MODULE AND NOT TWO ROUTE HANDLERS
 *
 * The rule was implemented twice: once in `GET /profit-distribution/calculate`,
 * which PUBLISHES the ceiling to the dashboard, and once in
 * `POST /profit-distribution/withdraw`, which ENFORCES it. Two implementations
 * of one rule is LAW 1's definition of failure, and the two had already drifted
 * in a way that matters: `calculate` accepted a caller-supplied period while
 * `withdraw` always used the current month, so the figure on screen could be
 * computed over a different span than the one the server would honour.
 *
 * A published limit that the enforcing path does not share is not a limit. Both
 * endpoints now call `computeProfitDistribution` and neither owns any part of
 * the arithmetic.
 *
 * THE SUBTRACTION IS THE WHOLE POINT (BOS-1)
 *
 * A withdrawal is booked as an expense, so it reduces profit by 100% of itself
 * while the ceiling is only a tier share of profit. Recomputing the ceiling from
 * net profit therefore removes a fraction of each payout from the limit and the
 * limit REPLENISHES: a branch with a published 32,000 AFN maximum paid out
 * 140,630 AFN across ten sequential calls. So the basis is GROSS profit —
 * distributions added back — and the amount already distributed is subtracted
 * from the ceiling instead. The period total can then never exceed the figure
 * that was published.
 *
 * Both halves of that subtraction must be measured over the SAME period, which
 * is why the caller passes figures already scoped by the calendar authority
 * rather than a date range this module would re-interpret.
 */
import { TREASURY_DEFAULTS } from '../configuration/policy-catalog.js';
import { assertComputedMoney, assertMoney } from '../../utils/money.js';

export interface ProfitDistributionInput {
  /** Operating income for the period. */
  revenue: number;
  /** Operating expense for the period, INCLUDING owner drawings already taken. */
  expense: number;
  /** Owner drawings already taken in this period. */
  distributed: number;
  /** Total monthly FIXED cost, the basis for the reserve target. */
  fixedTotal: number;
  /** Current contingency reserve (savings) balance. */
  reserveBalance: number;
}

export interface ProfitDistribution {
  /** Profit BEFORE distributions — the basis for the tier. */
  profit: number;
  /** Profit margin as a percentage of revenue. */
  marginPercent: number;
  /** Share of profit this margin earns, from the declared tier table. */
  tierPercent: number;
  /** The period's total allowance, before subtracting what was taken. */
  periodAllowance: number;
  distributed: number;
  reserveFundTarget: number;
  reserveFundBalance: number;
  reserveFundMet: boolean;
  /** What may still be withdrawn right now. Zero while the reserve is short. */
  maxWithdrawable: number;
}

/**
 * The share of profit a given margin earns.
 *
 * Bands are read highest-first from the declared table. A margin that reaches
 * no band — including a negative one, i.e. a loss — earns nothing.
 */
export function resolveDistributionTier(marginPercent: number): number {
  for (const band of TREASURY_DEFAULTS.profitDistributionTiers) {
    if (marginPercent >= band.minMarginPercent) return band.sharePercent;
  }
  return 0;
}

/** The reserve a branch must hold before any profit may be withdrawn. */
export function reserveFundTargetFor(fixedTotal: number): number {
  return assertComputedMoney(
    fixedTotal * TREASURY_DEFAULTS.reserveFundMonths,
    'reserve fund target',
  );
}

/**
 * Resolves the complete distribution position for a period.
 *
 * Pure: it performs no queries and reads no clock, so both endpoints and the
 * tests compute the identical answer from identical inputs.
 */
export function computeProfitDistribution(input: ProfitDistributionInput): ProfitDistribution {
  const distributed = assertMoney(input.distributed, 'distributed this period');
  const revenue = assertComputedMoney(input.revenue, 'period revenue', { allowNegative: true });
  const expense = assertComputedMoney(input.expense, 'period expense', { allowNegative: true });

  // Gross profit: distributions are added back so paying one out cannot lower
  // the tier and re-open the ceiling.
  const profit = assertComputedMoney(revenue - expense + distributed, 'calculated profit', {
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

  const reserveFundTarget = reserveFundTargetFor(input.fixedTotal);
  const reserveFundBalance = assertMoney(input.reserveBalance, 'reserve balance');
  const reserveFundMet = reserveFundBalance >= reserveFundTarget;

  const remaining = Math.max(
    0,
    assertComputedMoney(periodAllowance - distributed, 'remaining allowance', {
      allowNegative: true,
    }),
  );

  return {
    profit,
    marginPercent,
    tierPercent,
    periodAllowance,
    distributed,
    reserveFundTarget,
    reserveFundBalance,
    reserveFundMet,
    // The reserve gate closes the ceiling entirely; it does not merely warn.
    maxWithdrawable: reserveFundMet ? remaining : 0,
  };
}
