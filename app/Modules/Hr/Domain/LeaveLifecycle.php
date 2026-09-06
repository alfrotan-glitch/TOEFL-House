<?php

declare(strict_types=1);

namespace App\Modules\Hr\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Leave lifecycle (foundation 36): approved absence with approval and
 * history retained.
 */
final class LeaveLifecycle
{
    public const STATE_REQUESTED = 'requested';

    public const STATE_APPROVED = 'approved';

    public const STATE_REJECTED = 'rejected';

    public const STATE_CANCELLED = 'cancelled';

    private const TRANSITIONS = [
        self::STATE_REQUESTED => [self::STATE_APPROVED, self::STATE_REJECTED, self::STATE_CANCELLED],
        self::STATE_APPROVED => [self::STATE_CANCELLED],
        self::STATE_REJECTED => [],
        self::STATE_CANCELLED => [],
    ];

    public static function allowsTransition(string $from, string $to): bool
    {
        return in_array($to, self::TRANSITIONS[$from] ?? [], true);
    }

    public static function requireTransition(string $from, string $to): void
    {
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('hr.leave_transition_forbidden', sprintf('leave cannot move from %s to %s', $from, $to));
        }
    }
}
