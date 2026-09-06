<?php

declare(strict_types=1);

namespace App\Modules\Hr\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Registry row (foundation 32): Employment/Contract — Candidate, Active,
 * Leave, Suspended, Terminated (Settled/Archived arrive with payroll
 * settlement). Every transition is an approved employment transition with
 * appended status history; payroll can never invent silent terms.
 */
final class EmploymentLifecycle
{
    public const STATE_CANDIDATE = 'candidate';

    public const STATE_ACTIVE = 'active';

    public const STATE_ON_LEAVE = 'on_leave';

    public const STATE_SUSPENDED = 'suspended';

    public const STATE_TERMINATED = 'terminated';

    private const TRANSITIONS = [
        self::STATE_CANDIDATE => [self::STATE_ACTIVE, self::STATE_TERMINATED],
        self::STATE_ACTIVE => [self::STATE_ON_LEAVE, self::STATE_SUSPENDED, self::STATE_TERMINATED],
        self::STATE_ON_LEAVE => [self::STATE_ACTIVE, self::STATE_SUSPENDED, self::STATE_TERMINATED],
        self::STATE_SUSPENDED => [self::STATE_ACTIVE, self::STATE_TERMINATED],
        self::STATE_TERMINATED => [],
    ];

    public static function allowsTransition(string $from, string $to): bool
    {
        return in_array($to, self::TRANSITIONS[$from] ?? [], true);
    }

    public static function requireTransition(string $from, string $to): void
    {
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('hr.employment_transition_forbidden', sprintf('employment cannot move from %s to %s', $from, $to));
        }
    }
}
