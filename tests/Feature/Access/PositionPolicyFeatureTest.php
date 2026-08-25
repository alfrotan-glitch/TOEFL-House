<?php

declare(strict_types=1);

namespace Tests\Feature\Access;

use App\Modules\Access\AccessResolution;
use App\Modules\Access\Commands\AssignPosition;
use App\Modules\Access\Commands\DefineAccessPolicy;
use App\Modules\Access\Commands\TransitionPositionAssignment;
use App\Modules\Access\Models\AccessPolicy;
use App\Modules\Access\Models\Position;
use App\Modules\Access\Models\PositionAssignment;
use App\Modules\Access\Models\Role;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\OperatesStructure;
use Tests\TestCase;

final class PositionPolicyFeatureTest extends TestCase
{
    use BuildsActors;
    use OperatesStructure;

    public function test_assignment_lifecycle_proposes_then_activates_and_revokes(): void
    {
        $publisher = $this->accessAdministrator('pol-admin-1');
        $organization = $this->establishActiveOrganization();
        $this->personWithAuthority('pol-holder-1', []);
        /** @var Role $role */
        $role = Role::query()->create(['id' => RandomIdentifier::new(), 'name' => 'Campus Director']);
        /** @var Position $position */
        $position = Position::query()->create(['id' => RandomIdentifier::new(), 'organization_id' => $organization->id, 'name' => 'Director Position']);
        app(DefineAccessPolicy::class)->bindPositionRole($publisher, $position->id, $role->id, new CarbonImmutable('2026-08-25'), 'policy-key-1');
        app(DefineAccessPolicy::class)->grantRolePermission($publisher, $role->id, 'identity.verify', new CarbonImmutable('2026-08-25'), 'policy-key-2');

        $created = app(AssignPosition::class)->assign($publisher, 'pol-holder-1', $position->id, new CarbonImmutable('2026-08-25'), 'assign-key-1');
        $this->assertDatabaseHas('position_assignments', ['id' => $created['assignment_id'], 'lifecycle_state' => 'proposed']);
        $holder = new Actor('pol-holder-1', 'Holder');
        $resolution = new AccessResolution;
        $this->assertFalse($resolution->decide($holder, 'identity.verify', new StructureScope($organization->id))->allowed);

        app(TransitionPositionAssignment::class)->activate($publisher, PositionAssignment::query()->findOrFail($created['assignment_id']), 'assign-key-2');
        $this->assertDatabaseHas('position_assignments', ['id' => $created['assignment_id'], 'lifecycle_state' => 'active']);
        $this->assertTrue($resolution->decide($holder, 'identity.verify', new StructureScope($organization->id))->allowed);

        app(TransitionPositionAssignment::class)->revoke($publisher, PositionAssignment::query()->findOrFail($created['assignment_id']), 'assign-key-3');
        $this->assertFalse($resolution->decide($holder, 'identity.verify', new StructureScope($organization->id))->allowed);
        $this->assertDatabaseHas('audit_events', ['operation' => 'access.position.activate', 'target_type' => 'position_assignment', 'target_id' => $created['assignment_id']]);
        $this->assertDatabaseHas('audit_events', ['operation' => 'access.position.revoke', 'target_type' => 'position_assignment', 'target_id' => $created['assignment_id']]);
    }

    public function test_forbidden_assignment_transitions_are_rejected(): void
    {
        $publisher = $this->accessAdministrator('pol-admin-2');
        $organization = $this->establishActiveOrganization();
        $this->personWithAuthority('pol-holder-2', []);
        /** @var Position $position */
        $position = Position::query()->create(['id' => RandomIdentifier::new(), 'organization_id' => $organization->id, 'name' => 'Forbidden Position']);
        $created = app(AssignPosition::class)->assign($publisher, 'pol-holder-2', $position->id, new CarbonImmutable('2026-08-25'), 'assign-key-4');
        /** @var PositionAssignment $assignment */
        $assignment = PositionAssignment::query()->findOrFail($created['assignment_id']);

        try {
            app(TransitionPositionAssignment::class)->revoke($publisher, $assignment, 'assign-key-5');
            $this->fail('proposed -> revoked must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('access.lifecycle_transition_forbidden', $rejection->errorCode());
        }

        app(TransitionPositionAssignment::class)->activate($publisher, $assignment, 'assign-key-6');
        try {
            app(TransitionPositionAssignment::class)->activate($publisher, $assignment, 'assign-key-7');
            $this->fail('active -> active must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('access.lifecycle_transition_forbidden', $rejection->errorCode());
        }
    }

    public function test_repeated_assignment_closes_the_prior_open_assignment(): void
    {
        $publisher = $this->accessAdministrator('pol-admin-3');
        $organization = $this->establishActiveOrganization();
        $this->personWithAuthority('pol-holder-3', []);
        /** @var Position $position */
        $position = Position::query()->create(['id' => RandomIdentifier::new(), 'organization_id' => $organization->id, 'name' => 'Repeat Position']);

        $first = app(AssignPosition::class)->assign($publisher, 'pol-holder-3', $position->id, new CarbonImmutable('2026-08-25'), 'assign-key-8');
        app(TransitionPositionAssignment::class)->activate($publisher, PositionAssignment::query()->findOrFail($first['assignment_id']), 'assign-key-9');
        $second = app(AssignPosition::class)->assign($publisher, 'pol-holder-3', $position->id, new CarbonImmutable('2026-09-01'), 'assign-key-10');

        $this->assertDatabaseHas('position_assignments', ['id' => $first['assignment_id'], 'effective_to' => '2026-09-01']);
        $this->assertDatabaseHas('position_assignments', ['id' => $second['assignment_id'], 'lifecycle_state' => 'proposed', 'effective_to' => null]);
    }

    public function test_publishing_a_new_policy_version_closes_the_prior_open_row(): void
    {
        $publisher = $this->accessAdministrator('pol-admin-4');
        $organization = $this->establishActiveOrganization();
        /** @var Role $firstRole */
        $firstRole = Role::query()->create(['id' => RandomIdentifier::new(), 'name' => 'First Version Role']);
        /** @var Role $secondRole */
        $secondRole = Role::query()->create(['id' => RandomIdentifier::new(), 'name' => 'Second Version Role']);
        /** @var Position $position */
        $position = Position::query()->create(['id' => RandomIdentifier::new(), 'organization_id' => $organization->id, 'name' => 'Versioned Position']);

        $first = app(DefineAccessPolicy::class)->bindPositionRole($publisher, $position->id, $firstRole->id, new CarbonImmutable('2026-08-25'), 'policy-key-3');
        $second = app(DefineAccessPolicy::class)->bindPositionRole($publisher, $position->id, $secondRole->id, new CarbonImmutable('2026-09-01'), 'policy-key-4');

        $this->assertDatabaseHas('access_policies', ['id' => $first['policy_id'], 'effective_to' => '2026-09-01']);
        $this->assertDatabaseHas('access_policies', ['id' => $second['policy_id'], 'effective_to' => null]);
        $openVersions = AccessPolicy::query()->where('binding_type', 'position')->where('binding_id', $position->id)->where('grants_type', 'role')->whereNull('effective_to')->count();
        $this->assertSame(1, $openVersions);
    }

    public function test_unprivileged_publisher_is_denied_and_audited(): void
    {
        $organization = $this->establishActiveOrganization();
        $unprivileged = $this->actorWithoutAnyCapability('unpriv-publisher');
        /** @var Role $role */
        $role = Role::query()->create(['id' => RandomIdentifier::new(), 'name' => 'Denied Role']);

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('no active authority grants access.define_policy');
        app(DefineAccessPolicy::class)->grantRolePermission($unprivileged, $role->id, 'identity.verify', new CarbonImmutable('2026-08-25'), 'policy-key-5');

        $this->assertDatabaseHas('audit_events', ['operation' => 'access.policy.publish.denied', 'actor_id' => 'unpriv-publisher']);
        $this->assertDatabaseMissing('access_policies', ['binding_type' => 'role', 'binding_id' => $role->id]);
    }

    public function test_unprivileged_assigner_is_denied_and_audited(): void
    {
        $organization = $this->establishActiveOrganization();
        $unprivileged = $this->actorWithoutAnyCapability('unpriv-assigner');
        $this->personWithAuthority('pol-holder-4', []);
        /** @var Position $position */
        $position = Position::query()->create(['id' => RandomIdentifier::new(), 'organization_id' => $organization->id, 'name' => 'Denied Position']);

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('no active authority grants access.assign_position');
        app(AssignPosition::class)->assign($unprivileged, 'pol-holder-4', $position->id, new CarbonImmutable('2026-08-25'), 'assign-key-11');

        $this->assertDatabaseHas('audit_events', ['operation' => 'access.position.assign.denied', 'actor_id' => 'unpriv-assigner']);
        $this->assertDatabaseMissing('position_assignments', ['person_id' => 'pol-holder-4']);
    }
}
