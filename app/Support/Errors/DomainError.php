<?php

declare(strict_types=1);

namespace App\Support\Errors;

use RuntimeException;

/**
 * Stable error taxonomy of the implementation error contract. A domain
 * rejection is a business outcome, not an exceptional control flow: callers
 * receive category, stable code, correlation id, and retry guidance.
 */
abstract class DomainError extends RuntimeException
{
    public const CATEGORY_VALIDATION = 'validation';

    public const CATEGORY_AUTHORIZATION = 'authorization';

    public const CATEGORY_BUSINESS_REJECTION = 'business_rejection';

    public const CATEGORY_CONCURRENCY_CONFLICT = 'concurrency_conflict';

    public const CATEGORY_INTEGRATION_UNKNOWN = 'integration_failure_unknown_outcome';

    public const CATEGORY_SYSTEM_FAILURE = 'system_failure';

    public const CATEGORY_EMERGENCY_EXCEPTION = 'emergency_exception';

    private string $correlationId;

    public function __construct(
        string $message,
        private readonly string $errorCode,
        private readonly string $category,
        private readonly bool $retryable,
        string $correlationId = '',
    ) {
        parent::__construct($message);
        $this->correlationId = $correlationId !== '' ? $correlationId : self::newCorrelationId();
    }

    abstract public static function forCode(string $errorCode, string $message, bool $retryable = false): static;

    public function category(): string
    {
        return $this->category;
    }

    public function errorCode(): string
    {
        return $this->errorCode;
    }

    public function retryable(): bool
    {
        return $this->retryable;
    }

    public function correlationId(): string
    {
        return $this->correlationId;
    }

    public static function newCorrelationId(): string
    {
        /** @var non-empty-string $hex */
        $hex = bin2hex(random_bytes(8));

        return $hex;
    }
}
