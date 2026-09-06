<?php

declare(strict_types=1);

namespace App\Modules\WorkManagement\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\Employment;
use App\Modules\Organization\Models\Organization;
use App\Modules\WorkManagement\Domain\WorkItemLifecycle;
use App\Modules\WorkManagement\Models\WorkItem;
use App\Modules\WorkManagement\Models\WorkItemHistory;
use App\Modules\WorkManagement\Models\WorkflowInstance;
use App\Modules\WorkManagement\Queries\QueueMembershipQuery;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\BranchScopedAccess;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Coordinates a work item without performing the referenced domain action.
 * Completing an approval item is not approving the domain record; the UI must
 * follow action_key to the owning command, which rechecks current state,
 * scope, separation of duties, and concurrency.
 */
final class MaintainWorkItem
{
    public const CAPABILITY = 'workflow.work';

    private readonly BranchScopedAccess $scoped;

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly QueueMembershipQuery $queueMemberships,
    ) {
        $this->scoped = new BranchScopedAccess($access);
    }

    /** @return array{work_item_id: string, lifecycle_state: string, correlation_id: string} */
    public function transition(Actor $actor, WorkItem $item, string $toState, string $idempotencyKey, ?string $note = null): array
    {
        $payload = hash('sha256', implode('|', ['workflow.work.transition', $item->id, $toState, $note ?? '', $actor->actorId]));

        try {
            return $this->idempotency->execute('workflow.work.transition', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $item, $toState, $note): array {
                    $employment = Employment::query()
                        ->where('person_id', $actor->actorId)
                        ->orderByDesc('created_at')
                        ->orderByDesc('id')
                        ->first();
                    if ($employment === null || $employment->lifecycle_state !== EmploymentLifecycle::STATE_ACTIVE) {
                        throw AuthorizationDenied::forCode('workflow.employment_required', 'work transitions require an active employment for the actor');
                    }
                    /** @var WorkItem $locked */
                    $locked = WorkItem::query()->whereKey($item->id)->lockForUpdate()->firstOrFail();
                    if ($locked->branch_id === null || trim((string) $locked->branch_id) === '') {
                        $organization = Organization::query()->whereKey($locked->organization_id)->first();
                        if ($organization === null || $organization->lifecycle_state !== 'active') {
                            throw AuthorizationDenied::forCode('workflow.organization_provenance_invalid', 'branchless work requires active organization provenance');
                        }
                        $outcome = $this->access->decide($actor, self::CAPABILITY, StructureScope::organization($organization->id));
                        if (! $outcome->allowed) {
                            throw AuthorizationDenied::forCode('workflow.work_denied', $outcome->reason);
                        }
                    } else {
                        $this->scoped->require($actor, self::CAPABILITY, $locked->branch_id, 'workflow.work_denied', (string) $locked->organization_id);
                    }
                    if ($locked->assigned_to !== null && trim((string) $locked->assigned_to) !== $actor->actorId) {
                        throw AuthorizationDenied::forCode('workflow.not_assigned', 'only the assigned actor may transition this work item');
                    }
                    if ($locked->assigned_to === null && ($locked->queue_key === null || ! $this->queueMemberships->canClaim($actor, (string) $locked->queue_key, $locked->branch_id, (string) $locked->organization_id))) {
                        throw AuthorizationDenied::forCode('workflow.queue_membership_denied', 'an unassigned queue item requires active queue membership');
                    }
                    WorkItemLifecycle::assertTransition((string) $locked->lifecycle_state, $toState);

                    $fromState = (string) $locked->lifecycle_state;
                    $changes = ['lifecycle_state' => $toState];
                    if ($locked->assigned_to === null && in_array($toState, [WorkItemLifecycle::CLAIMED, WorkItemLifecycle::IN_PROGRESS], true)) {
                        $changes['assigned_to'] = $actor->actorId;
                    }
                    if ($toState === WorkItemLifecycle::CLAIMED || $toState === WorkItemLifecycle::IN_PROGRESS) {
                        $changes['claimed_at'] = $locked->claimed_at ?? now();
                    }
                    if (in_array($toState, [WorkItemLifecycle::COMPLETED, WorkItemLifecycle::CANCELLED, WorkItemLifecycle::EXPIRED], true)) {
                        $changes['completed_at'] = now();
                        $changes['completed_by'] = $actor->actorId;
                    }
                    $locked->forceFill($changes);
                    $locked->save();
                    WorkItemHistory::query()->create([
                        'id' => RandomIdentifier::new(),
                        'workflow_instance_id' => $locked->workflow_instance_id,
                        'work_item_id' => $locked->id,
                        'event_type' => 'work_item.'.$toState,
                        'actor_id' => $actor->actorId,
                        'from_state' => $fromState,
                        'to_state' => $toState,
                        'metadata' => ['note' => $note, 'action_key' => $locked->action_key],
                        'occurred_at' => now(),
                    ]);
                    if (in_array($toState, [WorkItemLifecycle::COMPLETED, WorkItemLifecycle::CANCELLED, WorkItemLifecycle::EXPIRED], true) && $locked->workflow_instance_id !== null) {
                        $this->closeWorkflowWhenDone((string) $locked->workflow_instance_id, $toState);
                    }
                    $event = $this->audit->record($actor->actorId, 'workflow.work.'.$toState, 'work_item', $locked->id, ['lifecycle_state' => $fromState, 'organization_id' => $locked->organization_id, 'branch_id' => $locked->branch_id], ['lifecycle_state' => $toState, 'action_key' => $locked->action_key, 'organization_id' => $locked->organization_id, 'branch_id' => $locked->branch_id]);

                    return ['work_item_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'workflow.work.transition', 'work_item', $item->id);
        }
    }

    private function closeWorkflowWhenDone(string $workflowId, string $state): void
    {
        // Serialize the terminal check on the workflow row. Checking open
        // items before acquiring this lock allows two concurrent final item
        // transitions to observe each other and leave the workflow running.
        /** @var WorkflowInstance $workflow */
        $workflow = WorkflowInstance::query()->whereKey($workflowId)->lockForUpdate()->firstOrFail();
        if ($workflow->lifecycle_state !== 'running') {
            return;
        }
        $remaining = WorkItem::query()
            ->where('workflow_instance_id', $workflowId)
            ->whereIn('lifecycle_state', ['open', 'claimed', 'in_progress'])
            ->exists();
        if ($remaining) {
            return;
        }

        $workflow->forceFill(['lifecycle_state' => $state === WorkItemLifecycle::COMPLETED ? 'completed' : 'cancelled', 'closed_at' => now()]);
        $workflow->save();
    }
}
