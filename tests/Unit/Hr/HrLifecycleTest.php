<?php

declare(strict_types=1);

namespace Tests\Unit\Hr;

use App\Modules\Hr\Domain\ContractLifecycle;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Domain\LeaveLifecycle;
use App\Support\Errors\BusinessRejection;
use PHPUnit\Framework\TestCase;

final class HrLifecycleTest extends TestCase
{
    public function test_employment_chain_and_terminal_states(): void
    {
        $this->assertTrue(EmploymentLifecycle::allowsTransition('candidate', 'active'));
        $this->assertTrue(EmploymentLifecycle::allowsTransition('candidate', 'terminated'));
        $this->assertTrue(EmploymentLifecycle::allowsTransition('active', 'on_leave'));
        $this->assertTrue(EmploymentLifecycle::allowsTransition('on_leave', 'active'));
        $this->assertTrue(EmploymentLifecycle::allowsTransition('active', 'suspended'));
        $this->assertTrue(EmploymentLifecycle::allowsTransition('suspended', 'active'));
        $this->assertTrue(EmploymentLifecycle::allowsTransition('suspended', 'terminated'));
        $this->assertFalse(EmploymentLifecycle::allowsTransition('candidate', 'on_leave'), 'leave requires active employment');
        $this->assertFalse(EmploymentLifecycle::allowsTransition('terminated', 'active'), 'termination is final');
    }

    public function test_contract_signing_fixes_terms_and_closing_is_final(): void
    {
        $this->assertTrue(ContractLifecycle::allowsTransition('draft', 'active'));
        $this->assertTrue(ContractLifecycle::allowsTransition('draft', 'closed'));
        $this->assertTrue(ContractLifecycle::allowsTransition('active', 'closed'));
        $this->assertFalse(ContractLifecycle::allowsTransition('closed', 'active'), 'a closed contract never reopens; terms change is a new contract');
    }

    public function test_leave_decisions_and_terminal_states(): void
    {
        $this->assertTrue(LeaveLifecycle::allowsTransition('requested', 'approved'));
        $this->assertTrue(LeaveLifecycle::allowsTransition('requested', 'rejected'));
        $this->assertTrue(LeaveLifecycle::allowsTransition('approved', 'cancelled'));
        $this->assertFalse(LeaveLifecycle::allowsTransition('rejected', 'approved'), 'a rejected request is history; re-request instead');
        $this->assertFalse(LeaveLifecycle::allowsTransition('cancelled', 'approved'));

        $this->expectException(BusinessRejection::class);
        EmploymentLifecycle::requireTransition('terminated', 'active');
    }
}
