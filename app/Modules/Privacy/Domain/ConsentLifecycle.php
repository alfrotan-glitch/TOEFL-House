<?php

declare(strict_types=1);

namespace App\Modules\Privacy\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Transition table of the consent lifecycle registry: draft -> submitted ->
 * verified -> active, then expired, revoked, or archived. Revocation and
 * expiry stop future use without erasing historical consent evidence.
 */
final class ConsentLifecycle
{
    public const STATE_DRAFT = 'draft';

    public const STATE_SUBMITTED = 'submitted';

    public const STATE_VERIFIED = 'verified';

    public const STATE_ACTIVE = 'active';

    public const STATE_EXPIRED = 'expired';

    public const STATE_REVOKED = 'revoked';

    public const STATE_ARCHIVED = 'archived';

    private const TRANSITIONS = [
        self::STATE_DRAFT => [self::STATE_SUBMITTED],
        self::STATE_SUBMITTED => [self::STATE_VERIFIED],
        self::STATE_VERIFIED => [self::STATE_ACTIVE],
        self::STATE_ACTIVE => [self::STATE_EXPIRED, self::STATE_REVOKED, self::STATE_ARCHIVED],
        self::STATE_EXPIRED => [self::STATE_ARCHIVED],
        self::STATE_REVOKED => [self::STATE_ARCHIVED],
        self::STATE_ARCHIVED => [],
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
            throw BusinessRejection::forCode('privacy.consent_unknown_state', sprintf('unknown consent lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('privacy.consent_transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
