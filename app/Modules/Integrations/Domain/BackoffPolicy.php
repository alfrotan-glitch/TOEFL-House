<?php

declare(strict_types=1);

namespace App\Modules\Integrations\Domain;

/**
 * Bounded exponential backoff: 2^attempt minutes, capped at one hour.
 */
final class BackoffPolicy
{
    public const CAP_MINUTES = 60;

    public static function delayForAttempt(int $attempt): int
    {
        if ($attempt < 1) {
            return 1;
        }

        return min(2 ** $attempt, self::CAP_MINUTES);
    }
}
