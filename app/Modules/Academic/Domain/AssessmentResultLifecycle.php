<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Placement/Assessment lifecycle registry: scored -> moderated ->
 * approved -> released, with appealed reachable from released and
 * corrected closing a superseded result. A score is never a decision
 * automatically: only released results exist for students and only
 * approved progression decides advancement.
 */
final class AssessmentResultLifecycle
{
    public const STATE_SCORED = 'scored';

    public const STATE_MODERATED = 'moderated';

    public const STATE_APPROVED = 'approved';

    public const STATE_RELEASED = 'released';

    public const STATE_APPEALED = 'appealed';

    public const STATE_CORRECTED = 'corrected';

    /** @var array<string, list<string>> */
    private const TRANSITIONS = [
        self::STATE_SCORED => [self::STATE_MODERATED],
        self::STATE_MODERATED => [self::STATE_APPROVED],
        self::STATE_APPROVED => [self::STATE_RELEASED],
        self::STATE_RELEASED => [self::STATE_APPEALED, self::STATE_CORRECTED],
        self::STATE_APPEALED => [self::STATE_CORRECTED],
        self::STATE_CORRECTED => [],
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
            throw BusinessRejection::forCode('academic.result_unknown_state', sprintf('unknown result lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('academic.result_transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
