<?php

declare(strict_types=1);

namespace Tests\Unit\Finance;

use App\Modules\Finance\Domain\FinanceLifecycle;
use App\Support\Errors\BusinessRejection;
use PHPUnit\Framework\TestCase;

final class FinanceLifecycleTest extends TestCase
{
    public function test_financial_periods_never_reopen(): void
    {
        $this->assertTrue(FinanceLifecycle::allowsPeriodTransition('open', 'closed'));
        $this->assertFalse(FinanceLifecycle::allowsPeriodTransition('closed', 'open'), 'closed financial periods never reopen');
        $this->assertFalse(FinanceLifecycle::allowsPeriodTransition('closed', 'closed'));
    }

    public function test_reconciliations_lock_on_approval(): void
    {
        $this->assertTrue(FinanceLifecycle::allowsReconciliationTransition('draft', 'approved'));
        $this->assertFalse(FinanceLifecycle::allowsReconciliationTransition('approved', 'draft'), 'an approved reconciliation is locked evidence');

        $this->expectException(BusinessRejection::class);
        FinanceLifecycle::requirePeriodTransition('closed', 'open');
    }
}
