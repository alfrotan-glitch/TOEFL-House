<?php

declare(strict_types=1);

namespace App\Modules\Admissions\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Applicant lifecycle registry: prospect -> applicant, then the admission
 * decision admits or rejects. Prior decisions are retained; a rejected
 * applicant may be decided on again only through a new decision.
 */
final class ApplicantLifecycle
{
    public const STATE_PROSPECT = 'prospect';

    public const STATE_APPLICANT = 'applicant';

    public const STATE_ADMITTED = 'admitted';

    public const STATE_REJECTED = 'rejected';

    private const TRANSITIONS = [
        self::STATE_PROSPECT => [self::STATE_APPLICANT],
        self::STATE_APPLICANT => [self::STATE_ADMITTED, self::STATE_REJECTED],
        self::STATE_ADMITTED => [],
        self::STATE_REJECTED => [self::STATE_APPLICANT],
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
            throw BusinessRejection::forCode('admissions.unknown_state', sprintf('unknown applicant lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('admissions.transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
