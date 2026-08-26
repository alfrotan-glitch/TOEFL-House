<?php

declare(strict_types=1);

namespace Tests\Unit\Finance;

use App\Modules\Finance\Domain\PaymentLifecycle;
use App\Support\Errors\BusinessRejection;
use PHPUnit\Framework\TestCase;

final class PaymentLifecycleTest extends TestCase
{
    public function test_discounts_move_from_proposed_to_approved_only(): void
    {
        $this->assertTrue(PaymentLifecycle::allowsDiscountTransition('proposed', 'approved'));
        $this->assertFalse(PaymentLifecycle::allowsDiscountTransition('approved', 'proposed'), 'an approved discount is immutable history');
        $this->assertFalse(PaymentLifecycle::allowsDiscountTransition('approved', 'approved'));

        $this->expectException(BusinessRejection::class);
        PaymentLifecycle::requireDiscountTransition('approved', 'proposed');
    }
}
