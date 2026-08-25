<?php

declare(strict_types=1);

namespace Tests\Unit\Support;

use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Errors\ConcurrencyConflict;
use App\Support\Errors\UnknownIntegrationOutcome;
use App\Support\Errors\ValidationError;
use PHPUnit\Framework\TestCase;

final class ErrorTaxonomyTest extends TestCase
{
    public function test_categories_are_stable(): void
    {
        $this->assertSame('validation', ValidationError::forCode('x.y', 'message')->category());
        $this->assertSame('authorization', AuthorizationDenied::forCode('x.y', 'message')->category());
        $this->assertSame('business_rejection', BusinessRejection::forCode('x.y', 'message')->category());
        $this->assertSame('concurrency_conflict', ConcurrencyConflict::forCode('x.y', 'retry me')->category());
        $this->assertSame('integration_failure_unknown_outcome', UnknownIntegrationOutcome::forCode('x.y', 'message')->category());
    }

    public function test_codes_and_messages_survive_the_boundary(): void
    {
        $error = BusinessRejection::forCode('identity.duplicate_verified_person', 'identity key already belongs to a verified person');

        $this->assertSame('identity.duplicate_verified_person', $error->errorCode());
        $this->assertSame('identity key already belongs to a verified person', $error->getMessage());
    }

    public function test_every_error_carries_a_correlation_identifier(): void
    {
        $first = ValidationError::forCode('effective_period.inverted', 'x');
        $second = ValidationError::forCode('effective_period.inverted', 'x');

        $this->assertNotSame('', $first->correlationId());
        $this->assertNotSame($first->correlationId(), $second->correlationId());
    }

    public function test_only_concurrency_conflicts_are_retryable_by_default(): void
    {
        $this->assertTrue(ConcurrencyConflict::forCode('a.b', 'c')->retryable());
        $this->assertFalse(BusinessRejection::forCode('a.b', 'c')->retryable());
        $this->assertFalse(AuthorizationDenied::forCode('a.b', 'c')->retryable());
        $this->assertFalse(ValidationError::forCode('a.b', 'c')->retryable());
    }
}
