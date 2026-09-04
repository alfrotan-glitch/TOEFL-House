<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Class-section lifecycle. A section is planned, then opened for scheduling,
 * and closes/archives at the end of delivery; cancellation preserves the
 * record and moves to archived when the term evidence is retained.
 */
final class ClassSectionLifecycle
{
    public const STATE_PLANNED = 'planned';

    public const STATE_OPEN = 'open';

    public const STATE_CLOSED = 'closed';

    public const STATE_CANCELLED = 'cancelled';

    public const STATE_ARCHIVED = 'archived';

    /** @var array<string, list<string>> */
    private const TRANSITIONS = [
        self::STATE_PLANNED => [self::STATE_OPEN, self::STATE_CANCELLED],
        self::STATE_OPEN => [self::STATE_CLOSED, self::STATE_CANCELLED],
        self::STATE_CLOSED => [self::STATE_ARCHIVED],
        self::STATE_CANCELLED => [self::STATE_ARCHIVED],
        self::STATE_ARCHIVED => [],
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
            throw BusinessRejection::forCode('academic.section_unknown_state', sprintf('unknown class-section lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('academic.section_transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
