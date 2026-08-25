<?php

declare(strict_types=1);

namespace Tests\Unit\Documents;

use App\Modules\Documents\Domain\DocumentLifecycle;
use App\Support\Errors\BusinessRejection;
use PHPUnit\Framework\TestCase;

final class DocumentLifecycleTest extends TestCase
{
    public function test_registry_chain_and_resubmission(): void
    {
        $this->assertTrue(DocumentLifecycle::allowsTransition('draft', 'submitted'));
        $this->assertTrue(DocumentLifecycle::allowsTransition('submitted', 'verified'));
        $this->assertTrue(DocumentLifecycle::allowsTransition('submitted', 'rejected'));
        $this->assertTrue(DocumentLifecycle::allowsTransition('rejected', 'submitted'));
        $this->assertTrue(DocumentLifecycle::allowsTransition('verified', 'active'));
        $this->assertTrue(DocumentLifecycle::allowsTransition('active', 'expired'));
        $this->assertTrue(DocumentLifecycle::allowsTransition('active', 'archived'));
        $this->assertTrue(DocumentLifecycle::allowsTransition('expired', 'archived'));
    }

    public function test_forbidden_paths_fail_closed(): void
    {
        $this->assertFalse(DocumentLifecycle::allowsTransition('draft', 'verified'));
        $this->assertFalse(DocumentLifecycle::allowsTransition('rejected', 'active'));
        $this->assertFalse(DocumentLifecycle::allowsTransition('archived', 'submitted'));
        $this->assertFalse(DocumentLifecycle::allowsTransition('active', 'submitted'));
    }

    public function test_unknown_state_throws(): void
    {
        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('unknown document lifecycle state');
        DocumentLifecycle::requireTransition('lost', 'archived');
    }
}
