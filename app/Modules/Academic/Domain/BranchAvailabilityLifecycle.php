<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Branch availability lifecycle. A declaration opens (active) and closes;
 * closing requires that no open offering still references the triple.
 */
final class BranchAvailabilityLifecycle
{
    public const STATE_ACTIVE = 'active';

    public const STATE_CLOSED = 'closed';

    private const TRANSITIONS = [
        self::STATE_ACTIVE => [self::STATE_CLOSED],
        self::STATE_CLOSED => [self::STATE_ACTIVE],
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
            throw BusinessRejection::forCode('academic.availability_unknown_state', sprintf('unknown availability lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('academic.availability_transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
