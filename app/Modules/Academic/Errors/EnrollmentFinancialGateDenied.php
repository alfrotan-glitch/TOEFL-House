<?php

declare(strict_types=1);

namespace App\Modules\Academic\Errors;

use App\Support\Errors\DomainError;

/**
 * Finance gate denial for an enrollment activation. Carries the signed
 * assessment so a rejected attempt can be frozen on the requested enrollment
 * and audited after the owning transaction rolls back.
 */
final class EnrollmentFinancialGateDenied extends DomainError
{
    /**
     * @param  array<string, mixed>  $evidence
     * @param  array<string, mixed>  $assessment
     */
    public function __construct(
        string $message,
        string $errorCode,
        private readonly array $evidence,
        private readonly array $assessment,
    ) {
        parent::__construct($message, $errorCode, self::CATEGORY_BUSINESS_REJECTION, false);
    }

    public static function forCode(string $errorCode, string $message, bool $retryable = false): static
    {
        return new self($message, $errorCode, [], []);
    }

    /**
     * @param  array<string, mixed>  $evidence
     * @param  array<string, mixed>  $assessment
     */
    public static function withAssessment(string $errorCode, string $message, array $evidence, array $assessment): self
    {
        return new self($message, $errorCode, $evidence, $assessment);
    }

    /** @return array<string, mixed> */
    public function evidence(): array
    {
        return $this->evidence;
    }

    /** @return array<string, mixed> */
    public function assessment(): array
    {
        return $this->assessment;
    }
}
