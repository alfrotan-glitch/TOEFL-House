<?php

declare(strict_types=1);

namespace App\Modules\Communication\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Message lifecycle: post-commit delivery — a message is queued after the
 * business commit and moves to sent or failed; delivered messages are
 * retained history.
 */
final class MessageLifecycle
{
    public const STATE_QUEUED = 'queued';

    public const STATE_SENT = 'sent';

    public const STATE_FAILED = 'failed';

    private const TRANSITIONS = [
        self::STATE_QUEUED => [self::STATE_SENT, self::STATE_FAILED],
        self::STATE_SENT => [],
        self::STATE_FAILED => [],
    ];

    public static function allowsTransition(string $from, string $to): bool
    {
        return in_array($to, self::TRANSITIONS[$from] ?? [], true);
    }

    public static function requireTransition(string $from, string $to): void
    {
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('communication.message_transition_forbidden', sprintf('message cannot move from %s to %s', $from, $to));
        }
    }
}
