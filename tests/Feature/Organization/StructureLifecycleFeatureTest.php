<?php

declare(strict_types=1);

namespace Tests\Feature\Organization;

use App\Modules\Audit\Models\AuditEvent;
use App\Modules\Organization\Models\Organization;
use App\Support\Authorization\StructureDecision;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\OperatesStructure;
use Tests\TestCase;

final class StructureLifecycleFeatureTest extends TestCase
{
    use BuildsActors;
    use OperatesStructure;

    public function test_complete_registry_chain_draft_active_suspended_active_closed_reopened_active(): void
    {
        $organization = $this->establishActiveOrganization('Lifecycle Organization');
        $command = $this->transitionCommand();
        $decision = fn (): StructureDecision => $this->structureDecisionForGlobalActors();

        $command->suspend($organization, $decision(), RandomIdentifier::new());
        $this->assertDatabaseHas('organizations', ['id' => $organization->id, 'lifecycle_state' => 'suspended']);

        $command->activate($organization, $decision(), RandomIdentifier::new());
        $this->assertDatabaseHas('organizations', ['id' => $organization->id, 'lifecycle_state' => 'active']);

        $command->close($organization, $decision(), RandomIdentifier::new());
        $this->assertDatabaseHas('organizations', ['id' => $organization->id, 'lifecycle_state' => 'closed']);

        $outcome = $command->reopen($organization, $decision(), RandomIdentifier::new());
        $this->assertSame('active', $outcome['lifecycle_state']);
        $this->assertDatabaseHas('organizations', ['id' => $organization->id, 'lifecycle_state' => 'active']);

        $reopenTrail = AuditEvent::query()
            ->where('target_id', $organization->id)
            ->where('operation', 'organization.structure.reopen')
            ->orderBy('occurred_at')
            ->pluck('before_state')
            ->all();
        $this->assertSame([['lifecycle_state' => 'closed'], ['lifecycle_state' => 'reopened']], $reopenTrail);

        $suspendTrail = AuditEvent::query()
            ->where('target_id', $organization->id)
            ->where('operation', 'organization.structure.suspend')
            ->pluck('before_state')
            ->all();
        $this->assertSame([['lifecycle_state' => 'active']], $suspendTrail);
    }

    public function test_suspended_unit_cannot_be_closed(): void
    {
        $organization = $this->establishActiveOrganization('Suspended Path');
        $decision = $this->structureDecisionForGlobalActors();
        $this->transitionCommand()->suspend($organization, $decision, RandomIdentifier::new());

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('transition suspended -> closed is not allowed');
        $this->transitionCommand()->close($organization, $this->structureDecisionForGlobalActors(), RandomIdentifier::new());
    }

    public function test_draft_unit_cannot_be_suspended(): void
    {
        $created = $this->createCommand()->createOrganization($this->structureDecisionForGlobalActors(), 'Draft Unit', RandomIdentifier::new());
        /** @var Organization $draft */
        $draft = Organization::query()->findOrFail($created['id']);

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('transition draft -> suspended is not allowed');
        $this->transitionCommand()->suspend($draft, $this->structureDecisionForGlobalActors(), RandomIdentifier::new());
    }

    public function test_closed_unit_cannot_be_closed_twice(): void
    {
        $organization = $this->establishActiveOrganization('Closed Once');
        $decision = $this->structureDecisionForGlobalActors();
        $this->transitionCommand()->close($organization, $decision, RandomIdentifier::new());

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('transition closed -> closed is not allowed');
        $this->transitionCommand()->close($organization, $this->structureDecisionForGlobalActors(), RandomIdentifier::new());
    }

    public function test_failed_transition_leaves_state_and_audit_unchanged(): void
    {
        $organization = $this->establishActiveOrganization('Stable Unit');
        $decision = $this->structureDecisionForGlobalActors();
        $this->transitionCommand()->close($organization, $decision, RandomIdentifier::new());
        $auditCount = AuditEvent::query()->where('target_id', $organization->id)->count();

        try {
            $this->transitionCommand()->suspend($organization, $this->structureDecisionForGlobalActors(), RandomIdentifier::new());
            $this->fail('closed unit suspend must fail closed');
        } catch (BusinessRejection) {
        }

        $this->assertDatabaseHas('organizations', ['id' => $organization->id, 'lifecycle_state' => 'closed']);
        $this->assertSame($auditCount, AuditEvent::query()->where('target_id', $organization->id)->count());
    }
}
