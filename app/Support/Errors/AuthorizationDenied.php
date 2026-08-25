<?php

declare(strict_types=1);

namespace App\Support\Errors;

final class AuthorizationDenied extends DomainError
{
    public static function forCode(string $errorCode, string $message, bool $retryable = false): static
    {
        return new self($message, $errorCode, self::CATEGORY_AUTHORIZATION, $retryable);
    }
}
