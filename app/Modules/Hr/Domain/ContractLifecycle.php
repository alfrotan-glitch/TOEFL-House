<?php

declare(strict_types=1);

namespace App\Modules\Hr\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Contract lifecycle (foundation 22/31): effective contract per employee;
 * signing fixes the terms (immutable once used) and a later contract closes
 * the prior one.
 */
final class ContractLifecycle
{
    public const STATE_DRAFT = 'draft';

    public const STATE_ACTIVE = 'active';

    public const STATE_CLOSED = 'closed';

    private const TRANSITIONS = [
        self::STATE_DRAFT => [self::STATE_ACTIVE, self::STATE_CLOSED],
        self::STATE_ACTIVE => [self::STATE_CLOSED],
        self::STATE_CLOSED => [],
    ];

    public static function allowsTransition(string $from, string $to): bool
    {
        return in_array($to, self::TRANSITIONS[$from] ?? [], true);
    }

    public static function requireTransition(string $from, string $to): void
    {
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('hr.contract_transition_forbidden', sprintf('contract cannot move from %s to %s', $from, $to));
        }
    }
}
