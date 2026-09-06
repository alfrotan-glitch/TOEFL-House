<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Academic periods are the temporal authority for delivery. A period is
 * published once, then closed only after every delivery class and seat has
 * reached a terminal state; closed periods never reopen.
 */
final class AcademicPeriodLifecycle
{
    public const STATE_DRAFT = 'draft';

    public const STATE_PUBLISHED = 'published';

    public const STATE_CLOSED = 'closed';

    /** @var array<string, list<string>> */
    private const TRANSITIONS = [
        self::STATE_DRAFT => [self::STATE_PUBLISHED],
        self::STATE_PUBLISHED => [self::STATE_CLOSED],
        self::STATE_CLOSED => [],
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
            throw BusinessRejection::forCode('academic.period_unknown_state', sprintf('unknown academic period lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('academic.period_transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
