<?php

declare(strict_types=1);

namespace Tests\Unit\Payroll;

use App\Modules\Payroll\Domain\PayrollLifecycle;
use App\Support\Errors\BusinessRejection;
use PHPUnit\Framework\TestCase;

final class PayrollLifecycleTest extends TestCase
{
    public function test_period_closes_once_and_never_reopens(): void
    {
        $this->assertTrue(PayrollLifecycle::allowsPeriodTransition('open', 'calculating'));
        $this->assertTrue(PayrollLifecycle::allowsPeriodTransition('open', 'closed'));
        $this->assertTrue(PayrollLifecycle::allowsPeriodTransition('calculating', 'closed'));
        $this->assertFalse(PayrollLifecycle::allowsPeriodTransition('closed', 'open'), 'closed periods never reopen');
        $this->assertFalse(PayrollLifecycle::allowsPeriodTransition('closed', 'calculating'));
    }

    public function test_calculation_history_is_retained(): void
    {
        $this->assertTrue(PayrollLifecycle::allowsCalculationTransition('prepared', 'resulted'));
        $this->assertTrue(PayrollLifecycle::allowsCalculationTransition('prepared', 'superseded'));
        $this->assertTrue(PayrollLifecycle::allowsCalculationTransition('held', 'superseded'));
        $this->assertFalse(PayrollLifecycle::allowsCalculationTransition('resulted', 'superseded'), 'a consumed calculation is fixed history');
        $this->assertFalse(PayrollLifecycle::allowsCalculationTransition('held', 'resulted'), 'a held case must be recalculated, never approved silently');
        $this->assertFalse(PayrollLifecycle::allowsCalculationTransition('superseded', 'resulted'));

        $this->expectException(BusinessRejection::class);
        PayrollLifecycle::requirePeriodTransition('closed', 'open');
    }
}
