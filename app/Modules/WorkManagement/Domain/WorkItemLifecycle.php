<?php

declare(strict_types=1);

namespace App\Modules\WorkManagement\Domain;

use App\Support\Errors\BusinessRejection;

final class WorkItemLifecycle
{
    public const OPEN = 'open';
    public const CLAIMED = 'claimed';
    public const IN_PROGRESS = 'in_progress';
    public const COMPLETED = 'completed';
    public const CANCELLED = 'cancelled';
    public const EXPIRED = 'expired';

    /** @return list<string> */
    public static function transitions(string $from): array
    {
        return match ($from) {
            self::OPEN => [self::CLAIMED, self::IN_PROGRESS, self::CANCELLED, self::EXPIRED],
            self::CLAIMED => [self::IN_PROGRESS, self::COMPLETED, self::CANCELLED, self::EXPIRED],
            self::IN_PROGRESS => [self::COMPLETED, self::CANCELLED, self::EXPIRED],
            default => [],
        };
    }

    public static function assertTransition(string $from, string $to): void
    {
        if (! in_array($to, self::transitions($from), true)) {
            throw BusinessRejection::forCode('workflow.invalid_transition', sprintf('work item cannot transition from %s to %s', $from, $to));
        }
    }

    /** Source completion may close an unclaimed coordination item without impersonating a worker claim. */
    public static function assertSourceCompletionTransition(string $from): void
    {
        if (! in_array($from, [self::OPEN, self::CLAIMED, self::IN_PROGRESS], true)) {
            throw BusinessRejection::forCode('workflow.source_completion_state', sprintf('source completion cannot close a work item from %s', $from));
        }
    }
}
