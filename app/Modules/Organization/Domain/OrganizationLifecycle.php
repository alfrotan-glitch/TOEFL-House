<?php

declare(strict_types=1);

namespace App\Modules\Organization\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Explicit transition table of the lifecycle registry for
 * organization/campus/branch/department: draft->active, active<->suspended,
 * active->closed, closed->reopened->active. Everything else fails closed and
 * no structure row is ever deleted.
 */
final class OrganizationLifecycle
{
    public const STATE_DRAFT = 'draft';

    public const STATE_ACTIVE = 'active';

    public const STATE_SUSPENDED = 'suspended';

    public const STATE_CLOSED = 'closed';

    public const STATE_REOPENED = 'reopened';

    private const TRANSITIONS = [
        self::STATE_DRAFT => [self::STATE_ACTIVE],
        self::STATE_ACTIVE => [self::STATE_SUSPENDED, self::STATE_CLOSED],
        self::STATE_SUSPENDED => [self::STATE_ACTIVE],
        self::STATE_CLOSED => [self::STATE_REOPENED],
        self::STATE_REOPENED => [self::STATE_ACTIVE],
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
            throw BusinessRejection::forCode('organization.lifecycle_unknown_state', sprintf('unknown lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('organization.lifecycle_transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
