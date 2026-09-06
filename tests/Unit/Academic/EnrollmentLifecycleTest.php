<?php

declare(strict_types=1);

namespace Tests\Unit\Academic;

use App\Modules\Academic\Domain\EnrollmentLifecycle;
use App\Support\Errors\BusinessRejection;
use PHPUnit\Framework\TestCase;

final class EnrollmentLifecycleTest extends TestCase
{
    public function test_registry_chain(): void
    {
        $this->assertTrue(EnrollmentLifecycle::allowsTransition('requested', 'active'));
        $this->assertTrue(EnrollmentLifecycle::allowsTransition('requested', 'withdrawn'));
        $this->assertTrue(EnrollmentLifecycle::allowsTransition('active', 'frozen'));
        $this->assertTrue(EnrollmentLifecycle::allowsTransition('active', 'transferred'));
        $this->assertTrue(EnrollmentLifecycle::allowsTransition('active', 'withdrawn'));
        $this->assertTrue(EnrollmentLifecycle::allowsTransition('active', 'completed'));
        $this->assertTrue(EnrollmentLifecycle::allowsTransition('frozen', 'active'));
        $this->assertTrue(EnrollmentLifecycle::allowsTransition('frozen', 'withdrawn'));
    }

    public function test_terminal_seats_never_continue(): void
    {
        foreach (['transferred', 'withdrawn', 'completed'] as $terminal) {
            foreach (EnrollmentLifecycle::states() as $to) {
                $this->assertFalse(EnrollmentLifecycle::allowsTransition($terminal, $to));
            }
        }
    }

    public function test_unknown_throws(): void
    {
        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('unknown enrollment lifecycle state');
        EnrollmentLifecycle::requireTransition(' auditing', 'active');
    }
}
