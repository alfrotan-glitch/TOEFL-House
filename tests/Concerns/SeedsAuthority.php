<?php

declare(strict_types=1);

namespace Tests\Concerns;

use App\Modules\Access\Domain\AccessLifecycle;
use App\Modules\Access\Models\AccessPolicy;
use App\Modules\Access\Models\Position;
use App\Modules\Access\Models\PositionAssignment;
use App\Modules\Access\Models\Role;
use App\Modules\Access\Models\ScopeGrant;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Organization;
use App\Support\Identifiers\RandomIdentifier;

/**
 * Authority fixtures seed the canonical access model exactly as the
 * governed bootstrap would: a bootstrap organization, one role per
 * capability set, positions bound to roles, active assignments, and direct
 * named-scope grants.
 */
trait SeedsAuthority
{
    private string $bootstrapOrganizationId = '00000000-0000-4000-8000-00000000b005';

    private array $seededRoleSets = [];

    private array $seededAssignments = [];

    private array $seededScopeGrants = [];

    /** @var array<string, list<string>> */
    private array $authorityCapabilities = [];

    private array $authorityPeople = [];

    private function ensureBootstrapAuthority(): void
    {
        if (Organization::query()->whereKey($this->bootstrapOrganizationId)->exists()) {
            return;
        }

        Organization::query()->create([
            'id' => $this->bootstrapOrganizationId,
            'name' => 'Authority Bootstrap',
            'lifecycle_state' => 'active',
        ]);
    }

    /**
     * Person with role-derived authority for the given capabilities inside
     * the bootstrap organization.
     */
    private function personWithAuthority(string $personId, array $capabilities): Person
    {
        $this->ensureBootstrapAuthority();
        if (! isset($this->authorityPeople[$personId])) {
            $this->authorityPeople[$personId] = Person::query()->create([
                'id' => $personId,
                'legal_name' => 'Authority Fixture '.$personId,
                'date_of_birth' => '1980-01-01',
                'verification_state' => Person::VERIFICATION_VERIFIED,
            ]);
        }
        $person = $this->authorityPeople[$personId];
        $this->authorityCapabilities[$personId] = array_values(array_unique(array_merge(
            $this->authorityCapabilities[$personId] ?? [],
            $capabilities,
        )));
        if ($capabilities === []) {
            return $person;
        }

        sort($capabilities);
        $setKey = implode(',', $capabilities);
        if (isset($this->seededAssignments[$personId.':'.$setKey])) {
            return $person;
        }
        $this->seededAssignments[$personId.':'.$setKey] = true;
        $roleId = $this->seededRoleSets[$setKey] ?? null;
        if ($roleId === null) {
            /** @var Role $role */
            $role = Role::query()->create(['id' => RandomIdentifier::new(), 'name' => 'Fixture Role '.substr(md5($setKey), 0, 8)]);
            $roleId = $role->id;
            $this->seededRoleSets[$setKey] = $roleId;
            foreach ($capabilities as $capability) {
                AccessPolicy::query()->create([
                    'id' => RandomIdentifier::new(),
                    'binding_type' => 'role',
                    'binding_id' => $roleId,
                    'grants_type' => AccessPolicy::GRANTS_PERMISSION,
                    'grants_id' => null,
                    'permission' => $capability,
                    'effective_from' => '2026-01-01',
                    'effective_to' => null,
                    'published_by' => $person->id,
                ]);
            }
        }

        /** @var Position $position */
        $position = Position::query()->create([
            'id' => RandomIdentifier::new(),
            'organization_id' => $this->bootstrapOrganizationId,
            'name' => 'Fixture Position '.$personId.'-'.substr(md5($setKey), 0, 8),
        ]);
        AccessPolicy::query()->create([
            'id' => RandomIdentifier::new(),
            'binding_type' => 'position',
            'binding_id' => $position->id,
            'grants_type' => AccessPolicy::GRANTS_ROLE,
            'grants_id' => $roleId,
            'permission' => '',
            'effective_from' => '2026-01-01',
            'effective_to' => null,
            'published_by' => $person->id,
        ]);
        PositionAssignment::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'position_id' => $position->id,
            'lifecycle_state' => AccessLifecycle::STATE_ACTIVE,
            'effective_from' => '2026-01-01',
            'effective_to' => null,
            'assigned_by' => $person->id,
        ]);

        return $person;
    }

    /**
     * Direct named-scope grant of capabilities to a person.
     */
    private function grantScopeAuthority(string $personId, array $capabilities, string $scopeType, string $scopeId, ?string $effectiveTo = null): void
    {
        $this->ensureBootstrapAuthority();
        if (! isset($this->authorityPeople[$personId])) {
            $this->authorityPeople[$personId] = Person::query()->create([
                'id' => $personId,
                'legal_name' => 'Authority Fixture '.$personId,
                'date_of_birth' => '1980-01-01',
                'verification_state' => Person::VERIFICATION_VERIFIED,
            ]);
        }

        $this->authorityCapabilities[$personId] = array_values(array_unique(array_merge(
            $this->authorityCapabilities[$personId] ?? [],
            $capabilities,
        )));
        foreach ($capabilities as $capability) {
            $grantKey = $personId.':'.$capability.':'.$scopeType.':'.$scopeId;
            if (isset($this->seededScopeGrants[$grantKey])) {
                continue;
            }
            $this->seededScopeGrants[$grantKey] = true;
            ScopeGrant::query()->create([
                'id' => RandomIdentifier::new(),
                'person_id' => $personId,
                'permission' => $capability,
                'scope_type' => $scopeType,
                'scope_id' => $scopeId,
                'lifecycle_state' => AccessLifecycle::STATE_ACTIVE,
                'effective_from' => '2026-01-01',
                'effective_to' => $effectiveTo,
                'is_emergency' => false,
                'review_required' => false,
                'granted_by' => '00000000-0000-4000-8000-00000000b005',
            ]);
        }
    }

    /**
     * Grants every materialized fixture person their accumulated
     * capabilities on a newly created scope, keeping wildcard fixture
     * actors authoritative inside every organization the test creates.
     */
    private function grantKnownAuthorityOn(string $scopeType, string $scopeId): void
    {
        foreach ($this->authorityCapabilities as $personId => $capabilities) {
            $this->grantScopeAuthority($personId, $capabilities, $scopeType, $scopeId);
        }
    }
}
