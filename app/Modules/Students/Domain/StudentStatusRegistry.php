<?php

declare(strict_types=1);

namespace App\Modules\Students\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Student status registry: verified ordered transitions only. Suspension,
 * withdrawal, completion, and alumni transitions are management actions;
 * reactivation (suspended or withdrawn back to active) requires approval
 * and is never silent. Status is history, never an overwrite.
 */
final class StudentStatusRegistry
{
    public const STATUS_ACTIVE = 'active';

    public const STATUS_SUSPENDED = 'suspended';

    public const STATUS_WITHDRAWN = 'withdrawn';

    public const STATUS_COMPLETED = 'completed';

    public const STATUS_ALUMNI = 'alumni';

    /** @var array<string, list<string>> */
    private const TRANSITIONS = [
        self::STATUS_ACTIVE => [self::STATUS_SUSPENDED, self::STATUS_WITHDRAWN, self::STATUS_COMPLETED],
        self::STATUS_SUSPENDED => [self::STATUS_ACTIVE],
        self::STATUS_WITHDRAWN => [self::STATUS_ACTIVE],
        self::STATUS_COMPLETED => [self::STATUS_ALUMNI],
        self::STATUS_ALUMNI => [],
    ];

    /** @return list<string> */
    public static function statuses(): array
    {
        return array_keys(self::TRANSITIONS);
    }

    /** @return list<string> */
    public static function reactivationTargets(): array
    {
        return [self::STATUS_SUSPENDED, self::STATUS_WITHDRAWN];
    }

    public static function allowsTransition(string $from, string $to): bool
    {
        return in_array($to, self::TRANSITIONS[$from] ?? [], true);
    }

    public static function requireTransition(string $from, string $to): void
    {
        if (! array_key_exists($from, self::TRANSITIONS)) {
            throw BusinessRejection::forCode('students.unknown_status', sprintf('unknown student status %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('students.transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
