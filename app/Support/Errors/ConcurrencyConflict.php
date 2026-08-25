<?php

declare(strict_types=1);

namespace App\Support\Errors;

final class ConcurrencyConflict extends DomainError
{
    public static function forCode(string $errorCode, string $message, bool $retryable = true): static
    {
        return new self($message, $errorCode, self::CATEGORY_CONCURRENCY_CONFLICT, $retryable);
    }
}
