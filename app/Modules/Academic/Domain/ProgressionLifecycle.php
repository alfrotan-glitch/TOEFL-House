<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Progression/graduation decision registry: proposed -> reviewed ->
 * approved/rejected; an appeal marks the decision appealed and its
 * resolution supersedes it with a new decision — the original is always
 * retained.
 */
final class ProgressionLifecycle
{
    public const STATE_PROPOSED = 'proposed';

    public const STATE_REVIEWED = 'reviewed';

    public const STATE_APPROVED = 'approved';

    public const STATE_REJECTED = 'rejected';

    public const STATE_APPEALED = 'appealed';

    public const STATE_SUPERSEDED = 'superseded';

    /** @var array<string, list<string>> */
    private const TRANSITIONS = [
        self::STATE_PROPOSED => [self::STATE_REVIEWED],
        self::STATE_REVIEWED => [self::STATE_APPROVED, self::STATE_REJECTED],
        self::STATE_APPROVED => [self::STATE_APPEALED, self::STATE_SUPERSEDED],
        self::STATE_REJECTED => [self::STATE_APPEALED, self::STATE_SUPERSEDED],
        self::STATE_APPEALED => [self::STATE_SUPERSEDED],
        self::STATE_SUPERSEDED => [],
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
            throw BusinessRejection::forCode('academic.progression_unknown_state', sprintf('unknown decision lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('academic.progression_transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
