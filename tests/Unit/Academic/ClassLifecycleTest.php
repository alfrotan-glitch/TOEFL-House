<?php

declare(strict_types=1);

namespace Tests\Unit\Academic;

use App\Modules\Academic\Domain\ClassLifecycle;
use App\Support\Errors\BusinessRejection;
use PHPUnit\Framework\TestCase;

final class ClassLifecycleTest extends TestCase
{
    public function test_registry_chain(): void
    {
        $this->assertTrue(ClassLifecycle::allowsTransition('planned', 'published'));
        $this->assertTrue(ClassLifecycle::allowsTransition('published', 'active'));
        $this->assertTrue(ClassLifecycle::allowsTransition('active', 'completed'));
        $this->assertTrue(ClassLifecycle::allowsTransition('completed', 'archived'));
        foreach (['planned', 'published', 'active'] as $cancellable) {
            $this->assertTrue(ClassLifecycle::allowsTransition($cancellable, 'cancelled'), $cancellable);
        }
        $this->assertTrue(ClassLifecycle::allowsTransition('cancelled', 'archived'));
    }

    public function test_forbidden_paths_fail_closed(): void
    {
        $this->assertFalse(ClassLifecycle::allowsTransition('planned', 'active'));
        $this->assertFalse(ClassLifecycle::allowsTransition('cancelled', 'active'));
        $this->assertFalse(ClassLifecycle::allowsTransition('archived', 'active'));
        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('transition archived -> active is not allowed');
        ClassLifecycle::requireTransition('archived', 'active');
    }
}
