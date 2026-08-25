<?php

declare(strict_types=1);

namespace Tests\Unit\Students;

use App\Modules\Students\Domain\StudentStatusRegistry;
use App\Support\Errors\BusinessRejection;
use PHPUnit\Framework\TestCase;

final class StudentStatusRegistryTest extends TestCase
{
    public function test_verified_transitions(): void
    {
        $this->assertTrue(StudentStatusRegistry::allowsTransition('active', 'suspended'));
        $this->assertTrue(StudentStatusRegistry::allowsTransition('active', 'withdrawn'));
        $this->assertTrue(StudentStatusRegistry::allowsTransition('active', 'completed'));
        $this->assertTrue(StudentStatusRegistry::allowsTransition('suspended', 'active'));
        $this->assertTrue(StudentStatusRegistry::allowsTransition('withdrawn', 'active'));
        $this->assertTrue(StudentStatusRegistry::allowsTransition('completed', 'alumni'));
    }

    public function test_reactivation_targets_are_suspended_and_withdrawn_only(): void
    {
        $this->assertSame(['suspended', 'withdrawn'], StudentStatusRegistry::reactivationTargets());
        $this->assertFalse(StudentStatusRegistry::allowsTransition('completed', 'active'));
        $this->assertFalse(StudentStatusRegistry::allowsTransition('alumni', 'active'));
    }

    public function test_forbidden_paths(): void
    {
        $this->assertFalse(StudentStatusRegistry::allowsTransition('suspended', 'completed'));
        $this->assertFalse(StudentStatusRegistry::allowsTransition('withdrawn', 'alumni'));
        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('transition alumni -> active is not allowed');
        StudentStatusRegistry::requireTransition('alumni', 'active');
    }
}
