<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Room resource lifecycle. A room is available or in maintenance while it
 * can be scheduled; retired is terminal and is refused while future
 * sessions still reference the room.
 */
final class RoomLifecycle
{
    public const STATE_AVAILABLE = 'available';

    public const STATE_MAINTENANCE = 'maintenance';

    public const STATE_RETIRED = 'retired';

    /** @var array<string, list<string>> */
    private const TRANSITIONS = [
        self::STATE_AVAILABLE => [self::STATE_MAINTENANCE, self::STATE_RETIRED],
        self::STATE_MAINTENANCE => [self::STATE_AVAILABLE, self::STATE_RETIRED],
        self::STATE_RETIRED => [],
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
            throw BusinessRejection::forCode('academic.room_unknown_state', sprintf('unknown room lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('academic.room_transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
