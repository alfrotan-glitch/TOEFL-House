<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Appeal registry (Incident/Complaint/Appeal row): open -> assigned ->
 * investigating -> resolved/rejected/escalated -> closed, with outcome
 * and evidence required and no silent closure.
 */
final class AppealLifecycle
{
    public const STATE_OPEN = 'open';

    public const STATE_ASSIGNED = 'assigned';

    public const STATE_INVESTIGATING = 'investigating';

    public const STATE_RESOLVED = 'resolved';

    public const STATE_REJECTED = 'rejected';

    public const STATE_ESCALATED = 'escalated';

    public const STATE_CLOSED = 'closed';

    /** @var array<string, list<string>> */
    private const TRANSITIONS = [
        self::STATE_OPEN => [self::STATE_ASSIGNED],
        self::STATE_ASSIGNED => [self::STATE_INVESTIGATING, self::STATE_ESCALATED],
        self::STATE_INVESTIGATING => [self::STATE_RESOLVED, self::STATE_REJECTED, self::STATE_ESCALATED],
        self::STATE_RESOLVED => [self::STATE_CLOSED],
        self::STATE_REJECTED => [self::STATE_CLOSED],
        self::STATE_ESCALATED => [self::STATE_ASSIGNED],
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
            throw BusinessRejection::forCode('academic.appeal_unknown_state', sprintf('unknown appeal lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('academic.appeal_transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
