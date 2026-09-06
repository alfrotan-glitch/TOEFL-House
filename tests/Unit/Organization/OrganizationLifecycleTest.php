<?php

declare(strict_types=1);

namespace Tests\Unit\Organization;

use App\Modules\Organization\Domain\OrganizationLifecycle;
use App\Support\Errors\BusinessRejection;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class OrganizationLifecycleTest extends TestCase
{
    public static function allowedTransitions(): array
    {
        return [
            'draft to active' => ['draft', 'active'],
            'active to suspended' => ['active', 'suspended'],
            'suspended to active' => ['suspended', 'active'],
            'active to closed' => ['active', 'closed'],
            'closed to reopened' => ['closed', 'reopened'],
            'reopened to active' => ['reopened', 'active'],
        ];
    }

    #[DataProvider('allowedTransitions')]
    public function test_allowed_transition(string $from, string $to): void
    {
        $this->assertTrue(OrganizationLifecycle::allowsTransition($from, $to));
        OrganizationLifecycle::requireTransition($from, $to);
        $this->addToAssertionCount(1);
    }

    public static function forbiddenTransitions(): array
    {
        return [
            'draft to suspended' => ['draft', 'suspended'],
            'draft to closed' => ['draft', 'closed'],
            'active to draft' => ['active', 'draft'],
            'suspended to closed' => ['suspended', 'closed'],
            'suspended to reopened' => ['suspended', 'reopened'],
            'closed to active directly' => ['closed', 'active'],
            'reopened to closed' => ['reopened', 'closed'],
            'reopened to suspended' => ['reopened', 'suspended'],
            'draft to reopened' => ['draft', 'reopened'],
        ];
    }

    #[DataProvider('forbiddenTransitions')]
    public function test_forbidden_transition_fails_closed(string $from, string $to): void
    {
        $this->assertFalse(OrganizationLifecycle::allowsTransition($from, $to));

        $this->expectException(BusinessRejection::class);
        OrganizationLifecycle::requireTransition($from, $to);
    }

    public function test_unknown_state_fails_closed(): void
    {
        $this->expectException(BusinessRejection::class);
        OrganizationLifecycle::requireTransition('archived', 'active');
    }

    public function test_registry_states_are_exactly_the_lifecycle_states(): void
    {
        $this->assertSame(
            ['draft', 'active', 'suspended', 'closed', 'reopened'],
            OrganizationLifecycle::states(),
        );
    }
}
