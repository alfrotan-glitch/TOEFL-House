<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Class/Session lifecycle registry: planned -> published -> active ->
 * completed -> archived, with cancellation preserving the record at any
 * pre-completion point. Cancelled sessions never take attendance without
 * a correction.
 */
final class ClassLifecycle
{
    public const STATE_PLANNED = 'planned';

    public const STATE_PUBLISHED = 'published';

    public const STATE_ACTIVE = 'active';

    public const STATE_CANCELLED = 'cancelled';

    public const STATE_COMPLETED = 'completed';

    public const STATE_ARCHIVED = 'archived';

    /** @var array<string, list<string>> */
    private const TRANSITIONS = [
        self::STATE_PLANNED => [self::STATE_PUBLISHED, self::STATE_CANCELLED],
        self::STATE_PUBLISHED => [self::STATE_ACTIVE, self::STATE_CANCELLED],
        self::STATE_ACTIVE => [self::STATE_COMPLETED, self::STATE_CANCELLED],
        self::STATE_CANCELLED => [self::STATE_ARCHIVED],
        self::STATE_COMPLETED => [self::STATE_ARCHIVED],
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
            throw BusinessRejection::forCode('academic.class_unknown_state', sprintf('unknown class lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('academic.class_transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
