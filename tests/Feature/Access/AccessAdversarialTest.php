<?php

declare(strict_types=1);

namespace Tests\Feature\Access;

use App\Modules\Access\AccessResolution;
use App\Modules\Access\Commands\GrantScopePermission;
use App\Modules\Access\Models\Delegation;
use App\Modules\Access\Models\Position;
use App\Modules\Access\Models\PositionAssignment;
use App\Modules\Access\Models\Role;
use App\Modules\Access\Models\ScopeGrant;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\OperatesStructure;
use Tests\TestCase;

/**
 * Adversarial vectors against the authority registry: unknown capabilities,
 * delegation chains, cross-organization positions, unresolvable scopes, and
 * tampering attempts all fail closed.
 */
final class AccessAdversarialTest extends TestCase
{
    use BuildsActors;
    use OperatesStructure;

    public function test_fabricated_capabilities_are_denied(): void
    {
        $actor = $this->accessAdministrator('adv-1');
        $organization = $this->establishActiveOrganization();

        foreach (['*.*', 'identity.*', 'access', ''] as $fabricated) {
            $decision = (new AccessResolution)->decide($actor, $fabricated, new StructureScope($organization->id));
            $this->assertFalse($decision->allowed, sprintf('capability %s must not resolve', $fabricated));
        }
    }

    public function test_delegation_chains_resolve_one_level_only(): void
    {
        $root = $this->actorWithStructureCapabilities('adv-root', ['identity.verify']);
        $organization = $this->establishActiveOrganization();
        $this->createFixtureDelegation('adv-root', 'adv-middle', null, null, null);
        $this->createFixtureDelegation('adv-middle', 'adv-leaf', null, null, null);
        $leaf = new Actor('adv-leaf', 'Leaf');
        $middle = new Actor('adv-middle', 'Middle');

        $resolution = new AccessResolution;
        $this->assertTrue($resolution->decide($middle, 'identity.verify', new StructureScope($organization->id))->allowed);
        $this->assertFalse($resolution->decide($leaf, 'identity.verify', new StructureScope($organization->id))->allowed);
    }

    public function test_position_in_one_organization_does_not_leak_into_another(): void
    {
        $home = $this->establishActiveOrganization('Home Organization');
        $away = $this->establishActiveOrganization('Away Organization');
        $this->personWithAuthority('adv-holder', []);
        /** @var Role $role */
        $role = Role::query()->create(['id' => RandomIdentifier::new(), 'name' => 'Away Director']);
        /** @var Position $position */
        $position = Position::query()->create(['id' => RandomIdentifier::new(), 'organization_id' => $away->id, 'name' => 'Away Position']);
        $this->grantScopeAuthority('adv-holder', ['identity.verify'], 'organization', $home->id);
        // assignment hangs under the away organization's position
        PositionAssignment::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => 'adv-holder',
            'position_id' => $position->id,
            'lifecycle_state' => 'active',
            'effective_from' => '2026-01-01',
            'effective_to' => null,
            'assigned_by' => 'adv-holder',
        ]);

        $holder = new Actor('adv-holder', 'Holder');
        $resolution = new AccessResolution;
        $this->assertFalse($resolution->decide($holder, 'identity.verify', new StructureScope($away->id))->allowed, 'a position assignment without a permission-granting role must not authorize');
        $this->assertTrue($resolution->decide($holder, 'identity.verify', new StructureScope($home->id))->allowed);
    }

    public function test_unresolvable_scope_grant_is_rejected(): void
    {
        $grantor = $this->accessAdministrator('adv-grantor');
        $organization = $this->establishActiveOrganization();
        $this->personWithAuthority('adv-target', []);

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('campus scope does not resolve');
        app(GrantScopePermission::class)->grant(
            $grantor, 'adv-target', 'identity.verify', 'campus', '00000000-0000-4000-8000-00000000dea1',
            new CarbonImmutable('2026-08-25'), null, false, 'adv-grant-1',
        );

        $this->assertDatabaseMissing('scope_grants', ['person_id' => 'adv-target']);
    }

    public function test_tampered_grant_rows_without_command_protection_still_resolve_fail_closed(): void
    {
        $organization = $this->establishActiveOrganization();
        $this->personWithAuthority('adv-tamper', []);
        // raw row with a lifecycle the CHECK constraint forbids cannot exist;
        // instead simulate date tampering: start after end is rejected by the schema
        $this->expectException(QueryException::class);
        ScopeGrant::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => 'adv-tamper',
            'permission' => 'identity.verify',
            'scope_type' => 'organization',
            'scope_id' => $organization->id,
            'lifecycle_state' => 'active',
            'effective_from' => '2026-10-01',
            'effective_to' => '2026-01-01',
            'is_emergency' => false,
            'review_required' => false,
            'granted_by' => 'adv-tamper',
        ]);
    }

    private function createFixtureDelegation(string $delegatorId, string $delegateId, ?string $permission, ?string $scopeType, ?string $scopeId): void
    {
        $this->personWithAuthority($delegatorId, []);
        $this->personWithAuthority($delegateId, []);
        Delegation::query()->create([
            'id' => RandomIdentifier::new(),
            'delegator_person_id' => $delegatorId,
            'delegate_person_id' => $delegateId,
            'permission' => $permission,
            'scope_type' => $scopeType,
            'scope_id' => $scopeId,
            'lifecycle_state' => 'active',
            'effective_from' => '2026-01-01',
            'effective_to' => '2027-01-01',
            'reason' => 'adversarial fixture',
            'created_by' => $delegatorId,
        ]);
    }
}
