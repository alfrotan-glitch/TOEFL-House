<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Registry rules (foundation 32/36 and the concurrency contract):
 * payroll periods close under control and never reopen; calculations are
 * prepared, held for review when the contract is silent, consumed by an
 * approved result, or superseded by a recalculation — history retained.
 */
final class PayrollLifecycle
{
    public const PERIOD_OPEN = 'open';

    public const PERIOD_CALCULATING = 'calculating';

    public const PERIOD_CLOSED = 'closed';

    public const CALC_PREPARED = 'prepared';

    public const CALC_HELD = 'held';

    public const CALC_RESULTED = 'resulted';

    public const CALC_SUPERSEDED = 'superseded';

    private const PERIOD_TRANSITIONS = [
        self::PERIOD_OPEN => [self::PERIOD_CALCULATING, self::PERIOD_CLOSED],
        self::PERIOD_CALCULATING => [self::PERIOD_CLOSED],
        self::PERIOD_CLOSED => [],
    ];

    private const CALC_TRANSITIONS = [
        self::CALC_PREPARED => [self::CALC_RESULTED, self::CALC_SUPERSEDED],
        self::CALC_HELD => [self::CALC_SUPERSEDED],
        self::CALC_RESULTED => [],
        self::CALC_SUPERSEDED => [],
    ];

    public static function allowsPeriodTransition(string $from, string $to): bool
    {
        return in_array($to, self::PERIOD_TRANSITIONS[$from] ?? [], true);
    }

    public static function requirePeriodTransition(string $from, string $to): void
    {
        if (! self::allowsPeriodTransition($from, $to)) {
            throw BusinessRejection::forCode('payroll.period_transition_forbidden', sprintf('payroll period cannot move from %s to %s', $from, $to));
        }
    }

    public static function allowsCalculationTransition(string $from, string $to): bool
    {
        return in_array($to, self::CALC_TRANSITIONS[$from] ?? [], true);
    }

    public static function requireCalculationTransition(string $from, string $to): void
    {
        if (! self::allowsCalculationTransition($from, $to)) {
            throw BusinessRejection::forCode('payroll.calculation_transition_forbidden', sprintf('payroll calculation cannot move from %s to %s', $from, $to));
        }
    }
}
