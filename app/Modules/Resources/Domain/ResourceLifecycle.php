<?php

declare(strict_types=1);

namespace App\Modules\Resources\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Registry row (foundation 32): Issuance/Asset/Work Order — Requested,
 * Approved, Issued/In Progress, Returned/Completed, Lost/Disposed/
 * Cancelled; custody and work evidence required; disposal requires
 * approval.
 */
final class ResourceLifecycle
{
    public const WORK_REQUESTED = 'requested';

    public const WORK_APPROVED = 'approved';

    public const WORK_IN_PROGRESS = 'in_progress';

    public const WORK_COMPLETED = 'completed';

    public const WORK_CANCELLED = 'cancelled';

    public const ISSUANCE_ISSUED = 'issued';

    public const ISSUANCE_RETURNED = 'returned';

    public const ISSUANCE_LOST = 'lost';

    private const WORK_TRANSITIONS = [
        self::WORK_REQUESTED => [self::WORK_APPROVED, self::WORK_CANCELLED],
        self::WORK_APPROVED => [self::WORK_IN_PROGRESS, self::WORK_CANCELLED],
        self::WORK_IN_PROGRESS => [self::WORK_COMPLETED, self::WORK_CANCELLED],
        self::WORK_COMPLETED => [],
        self::WORK_CANCELLED => [],
    ];

    private const ISSUANCE_TRANSITIONS = [
        self::ISSUANCE_ISSUED => [self::ISSUANCE_RETURNED, self::ISSUANCE_LOST],
        self::ISSUANCE_RETURNED => [],
        self::ISSUANCE_LOST => [],
    ];

    public static function allowsWorkTransition(string $from, string $to): bool
    {
        return in_array($to, self::WORK_TRANSITIONS[$from] ?? [], true);
    }

    public static function requireWorkTransition(string $from, string $to): void
    {
        if (! self::allowsWorkTransition($from, $to)) {
            throw BusinessRejection::forCode('resources.work_transition_forbidden', sprintf('work order cannot move from %s to %s', $from, $to));
        }
    }

    public static function allowsIssuanceTransition(string $from, string $to): bool
    {
        return in_array($to, self::ISSUANCE_TRANSITIONS[$from] ?? [], true);
    }

    public static function requireIssuanceTransition(string $from, string $to): void
    {
        if (! self::allowsIssuanceTransition($from, $to)) {
            throw BusinessRejection::forCode('resources.issuance_transition_forbidden', sprintf('issuance cannot move from %s to %s', $from, $to));
        }
    }
}
