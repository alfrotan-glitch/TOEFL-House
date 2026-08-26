<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Enrollment/membership registry: requested -> active, then freeze,
 * transfer, withdraw, or complete. Transfer closes the old enrollment and
 * opens a new one; there is never a duplicate active seat.
 */
final class EnrollmentLifecycle
{
    public const STATE_REQUESTED = 'requested';

    public const STATE_ACTIVE = 'active';

    public const STATE_FROZEN = 'frozen';

    public const STATE_TRANSFERRED = 'transferred';

    public const STATE_WITHDRAWN = 'withdrawn';

    public const STATE_COMPLETED = 'completed';

    /** @var array<string, list<string>> */
    private const TRANSITIONS = [
        self::STATE_REQUESTED => [self::STATE_ACTIVE, self::STATE_WITHDRAWN],
        self::STATE_ACTIVE => [self::STATE_FROZEN, self::STATE_TRANSFERRED, self::STATE_WITHDRAWN, self::STATE_COMPLETED],
        self::STATE_FROZEN => [self::STATE_ACTIVE, self::STATE_WITHDRAWN],
        self::STATE_TRANSFERRED => [],
        self::STATE_WITHDRAWN => [],
        self::STATE_COMPLETED => [],
    ];

    /** @return list<string> */
    public static function states(): array
    {
        return array_keys(self::TRANSITIONS);
    }

    public static function allowsTransition(string $from, string $to): bool
    {
        return in_array($to, self::TRANSITIONS[$from] ?? [], true);
    }

    public static function requireTransition(string $from, string $to): void
    {
        if (! array_key_exists($from, self::TRANSITIONS)) {
            throw BusinessRejection::forCode('academic.enrollment_unknown_state', sprintf('unknown enrollment lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('academic.enrollment_transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
