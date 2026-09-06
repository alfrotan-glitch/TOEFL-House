<?php

declare(strict_types=1);

namespace Tests\Feature\Access;

use App\Modules\Access\AccessResolution;
use App\Modules\Access\Models\AccessPolicy;
use App\Modules\Access\Models\Delegation;
use App\Modules\Access\Models\PositionAssignment;
use App\Modules\Access\Models\ScopeGrant;
use App\Modules\Organization\Models\Organization;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class AccessResolutionFeatureTest extends TestCase
{
    use BuildsActors;

    private AccessResolution $resolution;

    protected function setUp(): void
    {
        parent::setUp();
        $this->resolution = new AccessResolution;
    }

    public function test_role_derived_authority_resolves_through_the_whole_chain(): void
    {
        $actor = $this->accessAdministrator('chain-1');
        $organization = $this->establishActiveOrganizationFor('chain-1');

        $decision = $this->resolution->decide($actor, 'access.grant', new StructureScope($organization));

        $this->assertTrue($decision->allowed);
    }

    public function test_authority_denied_without_any_authority(): void
    {
        $nobody = $this->actorWithoutAnyCapability('nobody-chain');
        $organization = $this->establishActiveOrganizationFor('nobody-chain');

        $decision = $this->resolution->decide($nobody, 'access.grant', new StructureScope($organization));

        $this->assertFalse($decision->allowed);
    }

    public function test_scope_grant_does_not_leak_across_organizations(): void
    {
        $inScope = $this->establishActiveOrganizationFor('scoped-1');
        $outOfScope = $this->establishActiveOrganizationFor('scoped-2');
        $this->personWithAuthority('scoped-1', []);
        $this->grantScopeAuthority('scoped-1', ['access.grant'], 'organization', $inScope);
        $actor = new Actor('scoped-1', 'Scoped Holder');

        $allowed = $this->resolution->decide($actor, 'access.grant', new StructureScope($inScope));
        $denied = $this->resolution->decide($actor, 'access.grant', new StructureScope($outOfScope));

        $this->assertTrue($allowed->allowed);
        $this->assertFalse($denied->allowed);
    }

    public function test_expired_grant_stops_authority_without_any_rewrite(): void
    {
        $organization = $this->establishActiveOrganizationFor('exp-1');
        $this->grantScopeAuthority('exp-1', ['access.grant'], 'organization', $organization, '2026-08-01');
        $actor = new Actor('exp-1', 'Time Limited Holder');

        $asOfBefore = new AccessResolution(new CarbonImmutable('2026-06-15'));
        $asOfAfter = new AccessResolution(new CarbonImmutable('2026-09-15'));
        $scope = new StructureScope($organization);

        $this->assertTrue($asOfBefore->decide($actor, 'access.grant', $scope)->allowed);
        $this->assertFalse($asOfAfter->decide($actor, 'access.grant', $scope)->allowed);
    }

    public function test_future_grant_is_not_yet_effective(): void
    {
        $organization = $this->establishActiveOrganizationFor('fut-1');
        $this->personWithAuthority('fut-1', []);
        ScopeGrant::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => 'fut-1',
            'permission' => 'access.grant',
            'scope_type' => 'organization',
            'scope_id' => $organization,
            'lifecycle_state' => 'active',
            'effective_from' => '2027-01-01',
            'effective_to' => null,
            'is_emergency' => false,
            'review_required' => false,
            'granted_by' => $this->bootstrapOrganizationId,
        ]);
        $actor = new Actor('fut-1', 'Future Holder');

        $decision = $this->resolution->decide($actor, 'access.grant', new StructureScope($organization));

        $this->assertFalse($decision->allowed);
    }

    public function test_revoked_assignment_stops_role_derived_authority(): void
    {
        $actor = $this->accessAdministrator('rev-1');
        PositionAssignment::query()
            ->where('person_id', 'rev-1')
            ->update(['lifecycle_state' => 'revoked']);

        $decision = $this->resolution->decide($actor, 'access.grant', new StructureScope($this->bootstrapOrganizationId));

        $this->assertFalse($decision->allowed);
    }

    public function test_closed_policy_version_stops_role_permissions(): void
    {
        $actor = $this->accessAdministrator('pol-1');
        AccessPolicy::query()
            ->where('binding_type', 'role')
            ->where('grants_type', 'permission')
            ->where('permission', 'access.grant')
            ->update(['effective_to' => '2026-01-15']);

        $decision = $this->resolution->decide($actor, 'access.grant', new StructureScope($this->bootstrapOrganizationId));

        $this->assertFalse($decision->allowed);
    }

    public function test_delegation_grants_authority_within_the_delegators_own_reach(): void
    {
        $delegator = $this->actorWithStructureCapabilities('del-1', ['access.grant']);
        $organization = $this->establishActiveOrganizationFor('del-1');
        $this->createActiveDelegation('del-1', 'del-2', null, null, null);
        $delegate = new Actor('del-2', 'Delegate');

        $decision = $this->resolution->decide($delegate, 'access.grant', new StructureScope($organization));

        $this->assertTrue($decision->allowed);
    }

    public function test_delegate_never_exceeds_the_delegators_authority(): void
    {
        $organization = $this->establishActiveOrganizationFor('del-3');
        $this->actorWithStructureCapabilities('del-3', ['access.grant']);
        $this->createActiveDelegation('del-3', 'del-4', null, null, null);
        $delegate = new Actor('del-4', 'Delegate Without Reach');

        $beyond = $this->resolution->decide($delegate, 'access.revoke', new StructureScope($organization));

        $this->assertFalse($beyond->allowed);
    }

    public function test_expired_delegation_stops_authority(): void
    {
        $organization = $this->establishActiveOrganizationFor('del-5');
        $this->actorWithStructureCapabilities('del-5', ['access.grant']);
        $this->createDelegation('del-5', 'del-6', null, null, null, '2026-01-01', '2026-02-01');
        $delegate = new Actor('del-6', 'Expired Delegate');

        $decision = $this->resolution->decide($delegate, 'access.grant', new StructureScope($organization));

        $this->assertFalse($decision->allowed);
    }

    public function test_revoked_delegation_stops_authority_immediately(): void
    {
        $organization = $this->establishActiveOrganizationFor('del-7');
        $this->actorWithStructureCapabilities('del-7', ['access.grant']);
        $this->createDelegation('del-7', 'del-8', null, null, null, '2026-01-01', '2027-01-01', 'revoked');
        $delegate = new Actor('del-8', 'Revoked Delegate');

        $decision = $this->resolution->decide($delegate, 'access.grant', new StructureScope($organization));

        $this->assertFalse($decision->allowed);
    }

    public function test_scoped_delegation_narrows_to_the_delegated_scope(): void
    {
        $this->actorWithStructureCapabilities('del-9', ['access.grant']);
        $inScope = $this->establishActiveOrganizationFor('del-9');
        $outOfScope = $this->establishActiveOrganizationFor('del-10');
        $this->createActiveDelegation('del-9', 'del-11', null, 'organization', $inScope);
        $delegate = new Actor('del-11', 'Scoped Delegate');

        $within = $this->resolution->decide($delegate, 'access.grant', new StructureScope($inScope));
        $outside = $this->resolution->decide($delegate, 'access.grant', new StructureScope($outOfScope));

        $this->assertTrue($within->allowed);
        $this->assertFalse($outside->allowed);
    }

    public function test_missing_actor_identity_is_denied(): void
    {
        $decision = $this->resolution->decide(new Actor('', 'No Identity'), 'access.grant', null);

        $this->assertFalse($decision->allowed);
    }

    private function establishActiveOrganizationFor(string $fixturePersonId): string
    {
        $organization = Organization::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'Resolution Organization '.$fixturePersonId,
            'lifecycle_state' => 'active',
        ]);
        $this->grantKnownAuthorityOn('organization', $organization->id);

        return $organization->id;
    }

    private function createActiveDelegation(string $delegatorId, string $delegateId, ?string $permission, ?string $scopeType, ?string $scopeId): void
    {
        $this->createDelegation($delegatorId, $delegateId, $permission, $scopeType, $scopeId, '2026-01-01', '2027-01-01');
    }

    private function createDelegation(string $delegatorId, string $delegateId, ?string $permission, ?string $scopeType, ?string $scopeId, string $from, string $to, string $state = 'active'): void
    {
        foreach ([$delegatorId, $delegateId] as $personId) {
            $this->personWithAuthority($personId, []);
        }
        Delegation::query()->create([
            'id' => RandomIdentifier::new(),
            'delegator_person_id' => $delegatorId,
            'delegate_person_id' => $delegateId,
            'permission' => $permission,
            'scope_type' => $scopeType,
            'scope_id' => $scopeId,
            'lifecycle_state' => $state,
            'effective_from' => $from,
            'effective_to' => $to,
            'reason' => 'fixture delegation',
            'created_by' => $delegatorId,
        ]);
    }
}
