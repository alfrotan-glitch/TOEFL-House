<?php

declare(strict_types=1);

namespace Tests\Unit\Support;

use App\Support\Authorization\Actor;
use App\Support\Authorization\AuthorizationGate;
use App\Support\Authorization\StructureScope;
use PHPUnit\Framework\TestCase;

final class AuthorizationGateTest extends TestCase
{
    public function test_denies_when_no_capability_is_granted(): void
    {
        $gate = new AuthorizationGate;
        $actor = new Actor('a-1', 'Nobody', []);

        $this->assertFalse($gate->decide($actor, 'identity.verify', null)->allowed);
    }

    public function test_denies_when_capability_is_granted_outside_the_scope(): void
    {
        $gate = new AuthorizationGate;
        $actor = new Actor('a-2', 'Other Organization Owner', ['organization:org-a' => ['organization.structure.approve']]);
        $targetScope = new StructureScope('org-b');

        $this->assertFalse($gate->decide($actor, 'organization.structure.approve', $targetScope)->allowed);
    }

    public function test_allows_global_capability_in_any_scope(): void
    {
        $gate = new AuthorizationGate;
        $actor = new Actor('a-3', 'Global', ['*' => ['identity.admin']]);
        $targetScope = new StructureScope('org-b', 'campus-1');

        $this->assertTrue($gate->decide($actor, 'identity.admin', $targetScope)->allowed);
    }

    public function test_ancestor_scope_covers_descendant_scope(): void
    {
        $gate = new AuthorizationGate;
        $actor = new Actor('a-4', 'Organization Owner', ['organization:org-a' => ['organization.structure.approve']]);
        $targetScope = new StructureScope('org-a', 'campus-1', 'branch-1');

        $this->assertTrue($gate->decide($actor, 'organization.structure.approve', $targetScope)->allowed);
    }

    public function test_denial_carries_a_reason(): void
    {
        $gate = new AuthorizationGate;
        $outcome = $gate->decide(new Actor('a-5', 'Nobody', []), 'identity.verify', null);

        $this->assertSame('capability identity.verify not granted in scope', $outcome->reason);
    }

    public function test_empty_actor_identity_fails_closed(): void
    {
        $gate = new AuthorizationGate;
        $outcome = $gate->decide(new Actor('', 'Broken Evidence', ['*' => ['identity.admin']]), 'identity.admin', null);

        $this->assertFalse($outcome->allowed);
        $this->assertSame('actor identity missing', $outcome->reason);
    }
}
