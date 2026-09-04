<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Offering packaging lifecycle. An offering opens inside an open term and
 * active availability, closes to new registration, and is cancelled or
 * completed only when no open (requested/active/frozen) seat references it.
 */
final class OfferingLifecycle
{
    public const STATE_OPEN = 'open';

    public const STATE_CLOSED = 'closed';

    public const STATE_CANCELLED = 'cancelled';

    public const STATE_COMPLETED = 'completed';

    private const TRANSITIONS = [
        self::STATE_OPEN => [self::STATE_CLOSED, self::STATE_CANCELLED, self::STATE_COMPLETED],
        self::STATE_CLOSED => [self::STATE_OPEN, self::STATE_CANCELLED, self::STATE_COMPLETED],
        self::STATE_CANCELLED => [],
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
            throw BusinessRejection::forCode('academic.offering_unknown_state', sprintf('unknown offering lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('academic.offering_transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
