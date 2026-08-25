<?php

declare(strict_types=1);

namespace App\Modules\Documents\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Transition table of the document lifecycle registry: draft -> submitted
 * -> verified or rejected, a rejection is resubmitted as a new version,
 * verified -> active, then expired or archived. History is never rewritten.
 */
final class DocumentLifecycle
{
    public const STATE_DRAFT = 'draft';

    public const STATE_SUBMITTED = 'submitted';

    public const STATE_VERIFIED = 'verified';

    public const STATE_REJECTED = 'rejected';

    public const STATE_ACTIVE = 'active';

    public const STATE_EXPIRED = 'expired';

    public const STATE_ARCHIVED = 'archived';

    private const TRANSITIONS = [
        self::STATE_DRAFT => [self::STATE_SUBMITTED],
        self::STATE_SUBMITTED => [self::STATE_VERIFIED, self::STATE_REJECTED],
        self::STATE_REJECTED => [self::STATE_SUBMITTED],
        self::STATE_VERIFIED => [self::STATE_ACTIVE],
        self::STATE_ACTIVE => [self::STATE_EXPIRED, self::STATE_ARCHIVED],
        self::STATE_EXPIRED => [self::STATE_ARCHIVED],
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
            throw BusinessRejection::forCode('documents.unknown_state', sprintf('unknown document lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('documents.transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
