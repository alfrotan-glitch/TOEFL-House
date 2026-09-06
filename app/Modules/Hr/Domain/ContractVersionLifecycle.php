<?php

declare(strict_types=1);

namespace App\Modules\Hr\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Contract version lifecycle: the Finance Manager prepares and submits a
 * draft; the General Manager approves it (approval evidence + digest); an
 * approved version is in force for its effective window until superseded
 * by a later approved version or expired. Withdrawal is possible only
 * before approval. Approved history is immutable.
 */
final class ContractVersionLifecycle
{
    public const STATE_DRAFT = 'draft';

    public const STATE_SUBMITTED = 'submitted';

    public const STATE_APPROVED = 'approved';

    public const STATE_ACTIVE = 'active';

    public const STATE_SUPERSEDED = 'superseded';

    public const STATE_EXPIRED = 'expired';

    public const STATE_WITHDRAWN = 'withdrawn';

    public const IN_FORCE_STATES = [self::STATE_APPROVED, self::STATE_ACTIVE];

    public const SETTLED_STATES = [self::STATE_APPROVED, self::STATE_ACTIVE, self::STATE_SUPERSEDED, self::STATE_EXPIRED];

    private const TRANSITIONS = [
        self::STATE_DRAFT => [self::STATE_SUBMITTED, self::STATE_WITHDRAWN],
        self::STATE_SUBMITTED => [self::STATE_APPROVED, self::STATE_ACTIVE, self::STATE_WITHDRAWN],
        self::STATE_APPROVED => [self::STATE_SUPERSEDED, self::STATE_EXPIRED],
        self::STATE_ACTIVE => [self::STATE_SUPERSEDED, self::STATE_EXPIRED],
        self::STATE_SUPERSEDED => [],
        self::STATE_EXPIRED => [],
        self::STATE_WITHDRAWN => [],
    ];

    public static function allowsTransition(string $from, string $to): bool
    {
        return in_array($to, self::TRANSITIONS[$from] ?? [], true);
    }

    public static function requireTransition(string $from, string $to): void
    {
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('hr.contract_version_transition_forbidden', sprintf('contract version cannot move from %s to %s', $from, $to));
        }
    }
}
