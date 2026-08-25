<?php

declare(strict_types=1);

namespace Tests\Feature\Organization;

use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureDecision;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Identifiers\RandomIdentifier;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\OperatesStructure;
use Tests\TestCase;

final class StructureAuthorizationFeatureTest extends TestCase
{
    use BuildsActors;
    use OperatesStructure;

    public function test_decision_without_owner_approvals_is_denied(): void
    {
        $organization = $this->establishActiveOrganization();
        $decision = new StructureDecision(
            $this->generalManager(),
            $this->structureManager('*'),
            [$this->structureOwner('*', 'owner-1')],
        );

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('two owner approvals required');
        $this->transitionCommand()->close($organization, $decision, RandomIdentifier::new());
    }

    public function test_single_actor_holding_every_role_is_denied(): void
    {
        $organization = $this->establishActiveOrganization();
        $oneActor = new Actor('solo-1', 'Single Actor', ['*' => [
            'organization.structure.initiate', 'organization.structure.review', 'organization.structure.approve',
        ]]);
        $decision = new StructureDecision($oneActor, $oneActor, [$oneActor, $this->structureOwner('*', 'owner-2')]);

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('reviewer must differ from initiator');
        $this->transitionCommand()->close($organization, $decision, RandomIdentifier::new());
    }

    public function test_owner_acting_as_approver_and_initiator_is_denied(): void
    {
        $organization = $this->establishActiveOrganization();
        $initiatorWhoIsAlsoOwner = new Actor('solo-2', 'Initiating Owner', ['*' => [
            'organization.structure.initiate', 'organization.structure.approve',
        ]]);
        $decision = new StructureDecision(
            $initiatorWhoIsAlsoOwner,
            $this->structureManager('*'),
            [$initiatorWhoIsAlsoOwner, $this->structureOwner('*', 'owner-9')],
        );

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('owner approval must come from distinct actors');
        $this->transitionCommand()->close($organization, $decision, RandomIdentifier::new());
    }

    public function test_initiator_without_general_manager_capability_is_denied(): void
    {
        $organization = $this->establishActiveOrganization();
        $decision = new StructureDecision(
            $this->actorWithoutAnyCapability('fake-gm'),
            $this->structureManager('*'),
            [$this->structureOwner('*', 'owner-1'), $this->structureOwner('*', 'owner-2')],
        );

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('capability organization.structure.initiate not granted in scope');
        $this->transitionCommand()->close($organization, $decision, RandomIdentifier::new());
    }

    public function test_out_of_scope_owner_approval_is_denied(): void
    {
        $organization = $this->establishActiveOrganization();
        $foreignOwner = $this->structureOwner('organization:another-organization', 'owner-foreign');
        $decision = new StructureDecision(
            $this->generalManager(),
            $this->structureManager('*'),
            [$foreignOwner, $this->structureOwner('*', 'owner-2')],
        );

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('capability organization.structure.approve not granted in scope');
        $this->transitionCommand()->close($organization, $decision, RandomIdentifier::new());
    }

    public function test_material_denial_is_committed_as_audit_evidence(): void
    {
        $organization = $this->establishActiveOrganization();
        $decision = new StructureDecision(
            $this->actorWithoutAnyCapability('denied-gm'),
            $this->structureManager('*'),
            [$this->structureOwner('*', 'owner-1'), $this->structureOwner('*', 'owner-2')],
        );

        try {
            $this->transitionCommand()->close($organization, $decision, RandomIdentifier::new());
            $this->fail('close must be denied for an unauthorized initiator');
        } catch (AuthorizationDenied) {
        }

        $this->assertDatabaseHas('audit_events', [
            'operation' => 'organization.structure.close.denied',
            'target_type' => 'organization',
            'target_id' => $organization->id,
            'actor_id' => 'denied-gm',
        ]);
        $this->assertDatabaseHas('organizations', ['id' => $organization->id, 'lifecycle_state' => 'active']);
    }

    public function test_denied_creation_leaves_no_structure_fact(): void
    {
        $decision = new StructureDecision(
            $this->generalManager('denied-create-gm'),
            $this->actorWithoutAnyCapability('denied-create-mgr'),
            [$this->structureOwner('*', 'owner-1'), $this->structureOwner('*', 'owner-2')],
        );

        try {
            $this->createCommand()->createOrganization($decision, 'Unborn Organization', RandomIdentifier::new());
            $this->fail('creation must be denied without a reviewer');
        } catch (AuthorizationDenied) {
        }

        $this->assertDatabaseMissing('organizations', ['name' => 'Unborn Organization']);
        $this->assertDatabaseHas('audit_events', [
            'operation' => 'organization.structure.create.denied',
            'target_type' => 'organization',
            'actor_id' => 'denied-create-gm',
        ]);
    }
}
