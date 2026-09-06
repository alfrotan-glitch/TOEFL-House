<?php

declare(strict_types=1);

namespace Tests\Unit\Resources;

use App\Modules\Communication\Domain\MessageLifecycle;
use App\Modules\Resources\Domain\ResourceLifecycle;
use App\Support\Errors\BusinessRejection;
use PHPUnit\Framework\TestCase;

final class ResourceLifecycleTest extends TestCase
{
    public function test_work_order_chain_and_terminal_states(): void
    {
        $this->assertTrue(ResourceLifecycle::allowsWorkTransition('requested', 'approved'));
        $this->assertTrue(ResourceLifecycle::allowsWorkTransition('requested', 'cancelled'));
        $this->assertTrue(ResourceLifecycle::allowsWorkTransition('approved', 'in_progress'));
        $this->assertTrue(ResourceLifecycle::allowsWorkTransition('in_progress', 'completed'));
        $this->assertFalse(ResourceLifecycle::allowsWorkTransition('requested', 'in_progress'), 'work starts only after approval');
        $this->assertFalse(ResourceLifecycle::allowsWorkTransition('completed', 'in_progress'), 'completed work is history');
    }

    public function test_issuance_chain_and_message_delivery(): void
    {
        $this->assertTrue(ResourceLifecycle::allowsIssuanceTransition('issued', 'returned'));
        $this->assertTrue(ResourceLifecycle::allowsIssuanceTransition('issued', 'lost'));
        $this->assertFalse(ResourceLifecycle::allowsIssuanceTransition('returned', 'issued'), 'issuance history never reopens');
        $this->assertTrue(MessageLifecycle::allowsTransition('queued', 'sent'));
        $this->assertTrue(MessageLifecycle::allowsTransition('queued', 'failed'));
        $this->assertFalse(MessageLifecycle::allowsTransition('sent', 'queued'), 'delivered messages are history');

        $this->expectException(BusinessRejection::class);
        ResourceLifecycle::requireWorkTransition('completed', 'cancelled');
    }
}
