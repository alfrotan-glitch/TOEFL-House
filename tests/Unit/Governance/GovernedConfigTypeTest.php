<?php

declare(strict_types=1);

namespace Tests\Unit\Governance;

use App\Modules\Governance\Domain\GovernedConfigType;
use App\Support\Errors\ValidationError;
use PHPUnit\Framework\TestCase;

/**
 * WP-2 S1: pure, typed value/type model. Type = shape/constraint of the
 * scalar; semantics live in the ratified config key. Validation is exercised
 * directly (no database) to prove invalid typed values and constraint
 * violations are rejected before they could ever reach storage.
 */
final class GovernedConfigTypeTest extends TestCase
{
    public function test_known_types_accept_their_typed_scalars(): void
    {
        GovernedConfigType::assertValue(GovernedConfigType::POSITIVE_MONEY, 10000);
        GovernedConfigType::assertValue(GovernedConfigType::NONNEGATIVE_MONEY, 0);
        GovernedConfigType::assertValue(GovernedConfigType::POSITIVE_INTEGER, 1);
        GovernedConfigType::assertValue(GovernedConfigType::NONNEGATIVE_INTEGER, 0);
        GovernedConfigType::assertValue(GovernedConfigType::PERCENT, 100);
        GovernedConfigType::assertValue(GovernedConfigType::APPROVER_REFERENCE, '00000000-0000-4000-8000-00000000b005');

        $this->assertTrue(GovernedConfigType::isKnown(GovernedConfigType::PERCENT));
        $this->assertFalse(GovernedConfigType::isKnown('freeform'));
    }

    public function test_invalid_typed_values_are_rejected(): void
    {
        $this->expectValueRejected(GovernedConfigType::POSITIVE_INTEGER, 'not-an-int');
        $this->expectValueRejected(GovernedConfigType::PERCENT, 1.5);
        $this->expectValueRejected(GovernedConfigType::APPROVER_REFERENCE, 123);
        $this->expectValueRejected(GovernedConfigType::APPROVER_REFERENCE, '   ');
    }

    public function test_constraint_violations_are_rejected(): void
    {
        // Non-negative integer must be >= 0; percent must be 0..100; positive
        // values must be >= 1.
        $this->expectValueRejected(GovernedConfigType::NONNEGATIVE_INTEGER, -1);
        $this->expectValueRejected(GovernedConfigType::POSITIVE_INTEGER, 0);
        $this->expectValueRejected(GovernedConfigType::POSITIVE_MONEY, 0);
        $this->expectValueRejected(GovernedConfigType::PERCENT, -1);
        $this->expectValueRejected(GovernedConfigType::PERCENT, 101);
    }

    public function test_unknown_config_type_is_rejected(): void
    {
        $this->expectException(ValidationError::class);
        $this->expectExceptionCode(0);
        GovernedConfigType::assertValue('freeform_blob', 5);
    }

    private function expectValueRejected(string $type, mixed $value): void
    {
        try {
            GovernedConfigType::assertValue($type, $value);
            $this->fail(sprintf('value of type %s should have been rejected', $type));
        } catch (ValidationError $e) {
            $this->assertSame('governance.invalid_value', $e->errorCode());
        }
    }
}
