<?php

declare(strict_types=1);

namespace Tests\Unit\Access;

use App\Modules\Access\Domain\AccessLifecycle;
use App\Support\Errors\BusinessRejection;
use PHPUnit\Framework\TestCase;

final class AccessLifecycleTest extends TestCase
{
    public function test_proposed_may_only_become_active(): void
    {
        $this->assertTrue(AccessLifecycle::allowsTransition('proposed', 'active'));
        $this->assertFalse(AccessLifecycle::allowsTransition('proposed', 'revoked'));
        $this->assertFalse(AccessLifecycle::allowsTransition('proposed', 'expired'));
    }

    public function test_active_may_expire_or_be_revoked(): void
    {
        $this->assertTrue(AccessLifecycle::allowsTransition('active', 'expired'));
        $this->assertTrue(AccessLifecycle::allowsTransition('active', 'revoked'));
        $this->assertFalse(AccessLifecycle::allowsTransition('active', 'proposed'));
    }

    public function test_terminal_states_never_continue(): void
    {
        foreach (['expired', 'revoked'] as $terminal) {
            foreach (AccessLifecycle::states() as $to) {
                $this->assertFalse(AccessLifecycle::allowsTransition($terminal, $to));
            }
        }
    }

    public function test_unknown_state_is_rejected(): void
    {
        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('unknown lifecycle state');
        AccessLifecycle::requireTransition('frozen', 'active');
    }

    public function test_forbidden_transition_is_rejected(): void
    {
        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('transition proposed -> revoked is not allowed');
        AccessLifecycle::requireTransition('proposed', 'revoked');
    }
}
