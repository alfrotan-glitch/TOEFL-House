<?php

declare(strict_types=1);

namespace App\Modules\Access\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Transition table of the lifecycle registry for position assignments,
 * scope grants, and delegations: proposed -> active, active -> expired or
 * revoked. Expired access never continues; nothing is deleted.
 */
final class AccessLifecycle
{
    public const STATE_PROPOSED = 'proposed';

    public const STATE_ACTIVE = 'active';

    public const STATE_EXPIRED = 'expired';

    public const STATE_REVOKED = 'revoked';

    private const TRANSITIONS = [
        self::STATE_PROPOSED => [self::STATE_ACTIVE],
        self::STATE_ACTIVE => [self::STATE_EXPIRED, self::STATE_REVOKED],
        self::STATE_EXPIRED => [],
        self::STATE_REVOKED => [],
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
            throw BusinessRejection::forCode('access.lifecycle_unknown_state', sprintf('unknown lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('access.lifecycle_transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
