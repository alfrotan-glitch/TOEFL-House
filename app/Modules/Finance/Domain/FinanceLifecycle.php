<?php

declare(strict_types=1);

namespace App\Modules\Finance\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Finance lifecycles: financial periods close under control and never
 * reopen (coordination with payroll periods is an explicit status check);
 * reconciliation observations lock on approval.
 */
final class FinanceLifecycle
{
    public const PERIOD_OPEN = 'open';

    public const PERIOD_CLOSED = 'closed';

    public const RECON_DRAFT = 'draft';

    public const RECON_APPROVED = 'approved';

    private const PERIOD_TRANSITIONS = [
        self::PERIOD_OPEN => [self::PERIOD_CLOSED],
        self::PERIOD_CLOSED => [],
    ];

    private const RECON_TRANSITIONS = [
        self::RECON_DRAFT => [self::RECON_APPROVED],
        self::RECON_APPROVED => [],
    ];

    public static function allowsPeriodTransition(string $from, string $to): bool
    {
        return in_array($to, self::PERIOD_TRANSITIONS[$from] ?? [], true);
    }

    public static function requirePeriodTransition(string $from, string $to): void
    {
        if (! self::allowsPeriodTransition($from, $to)) {
            throw BusinessRejection::forCode('finance.period_transition_forbidden', sprintf('financial period cannot move from %s to %s', $from, $to));
        }
    }

    public static function allowsReconciliationTransition(string $from, string $to): bool
    {
        return in_array($to, self::RECON_TRANSITIONS[$from] ?? [], true);
    }

    public static function requireReconciliationTransition(string $from, string $to): void
    {
        if (! self::allowsReconciliationTransition($from, $to)) {
            throw BusinessRejection::forCode('finance.reconciliation_transition_forbidden', sprintf('reconciliation cannot move from %s to %s', $from, $to));
        }
    }
}
