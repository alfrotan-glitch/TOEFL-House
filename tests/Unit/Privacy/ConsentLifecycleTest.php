<?php

declare(strict_types=1);

namespace Tests\Unit\Privacy;

use App\Modules\Privacy\Domain\ConsentLifecycle;
use App\Support\Errors\BusinessRejection;
use PHPUnit\Framework\TestCase;

final class ConsentLifecycleTest extends TestCase
{
    public function test_registry_chain_moves_forward_only(): void
    {
        $this->assertTrue(ConsentLifecycle::allowsTransition('draft', 'submitted'));
        $this->assertTrue(ConsentLifecycle::allowsTransition('submitted', 'verified'));
        $this->assertTrue(ConsentLifecycle::allowsTransition('verified', 'active'));
        $this->assertTrue(ConsentLifecycle::allowsTransition('active', 'revoked'));
        $this->assertTrue(ConsentLifecycle::allowsTransition('active', 'expired'));
        $this->assertTrue(ConsentLifecycle::allowsTransition('revoked', 'archived'));
    }

    public function test_backward_and_skip_transitions_are_forbidden(): void
    {
        $this->assertFalse(ConsentLifecycle::allowsTransition('draft', 'active'));
        $this->assertFalse(ConsentLifecycle::allowsTransition('active', 'draft'));
        $this->assertFalse(ConsentLifecycle::allowsTransition('submitted', 'revoked'));
        $this->assertFalse(ConsentLifecycle::allowsTransition('archived', 'active'));
    }

    public function test_revocation_is_not_the_end_of_history_but_never_reactivates(): void
    {
        $this->assertFalse(ConsentLifecycle::allowsTransition('revoked', 'active'));
        $this->assertFalse(ConsentLifecycle::allowsTransition('expired', 'active'));
    }

    public function test_unknown_and_forbidden_transitions_throw(): void
    {
        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('transition draft -> revoked is not allowed');
        ConsentLifecycle::requireTransition('draft', 'revoked');
    }
}
