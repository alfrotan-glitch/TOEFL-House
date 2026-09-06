<?php

declare(strict_types=1);

namespace App\Modules\WorkManagement\Domain;

use App\Modules\Outbox\Domain\EventConsumer;
use App\Modules\Outbox\Models\DomainEvent;
use App\Modules\WorkManagement\Models\WorkItem;
use App\Modules\WorkManagement\Models\WorkItemHistory;
use App\Modules\WorkManagement\Models\WorkflowInstance;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Reconciles coordination items from canonical source transitions. The
 * source command remains the only writer of the business decision; this
 * consumer only closes matching work items and their workflow projection.
 * It is idempotent because the relay receipt and source-event metadata are
 * both retained, and it tolerates a source event arriving after a manual
 * work-item claim or transition.
 */
final class WorkflowCompletionConsumer implements EventConsumer
{
    public function key(): string
    {
        return 'workflow.source_completion';
    }

    public function supports(DomainEvent $event): bool
    {
        if (! WorkflowCompletionCatalog::isCandidate($event)) {
            return false;
        }

        // Applicability is determined by the closed source-event catalog, not
        // by whether the projection has arrived yet. Returning false for a
        // missing item would permanently mark the receipt as non-applicable
        // and could lose a completion when the intent consumer is retried.
        return true;
    }

    public function consume(DomainEvent $event): void
    {
        $rule = WorkflowCompletionCatalog::ruleFor($event);
        if ($rule === null) {
            throw BusinessRejection::forCode('workflow.source_completion_unmapped', 'a governed source completion event did not carry its declared terminal state');
        }

        $actorId = trim((string) ($event->actor_id ?? ''));
        if ($actorId === '') {
            throw BusinessRejection::forCode('workflow.source_completion_actor_missing', 'source completion requires a durable source actor');
        }

        // The database guard permits an unclaimed open item to close only
        // inside this projection transaction. The setting is LOCAL to the
        // relay transaction and cannot authorize a normal work-item command.
        DB::statement("SELECT set_config('app.work_item_source_completion', 'on', true)");

        $items = WorkItem::query()
            ->where('source_type', $rule['source_type'])
            ->where('source_id', $event->aggregate_id)
            ->where('action_key', $rule['action_key'])
            ->lockForUpdate()
            ->get();
        if ($items->isEmpty()) {
            throw BusinessRejection::forCode('workflow.source_completion_item_missing', 'the source completion arrived before its projected work item');
        }
        foreach ($items as $item) {
            $fromState = (string) $item->lifecycle_state;
            if (in_array($fromState, [WorkItemLifecycle::COMPLETED, WorkItemLifecycle::CANCELLED, WorkItemLifecycle::EXPIRED], true)) {
                continue;
            }
            WorkItemLifecycle::assertSourceCompletionTransition($fromState);
            $item->forceFill([
                'lifecycle_state' => WorkItemLifecycle::COMPLETED,
                'completed_at' => now(),
                'completed_by' => $actorId,
            ])->save();
            WorkItemHistory::query()->create([
                'id' => RandomIdentifier::new(),
                'workflow_instance_id' => $item->workflow_instance_id,
                'work_item_id' => $item->id,
                'event_type' => 'work_item.source_completed',
                'actor_id' => $actorId,
                'from_state' => $fromState,
                'to_state' => WorkItemLifecycle::COMPLETED,
                'metadata' => [
                    'source_event_id' => $event->id,
                    'source_event_type' => $event->event_type,
                    'source_type' => $rule['source_type'],
                    'source_id' => $event->aggregate_id,
                ],
                'occurred_at' => now(),
            ]);

            if ($item->workflow_instance_id !== null) {
                $this->closeWorkflowWhenDone((string) $item->workflow_instance_id);
            }
        }
    }

    private function closeWorkflowWhenDone(string $workflowId): void
    {
        /** @var WorkflowInstance $workflow */
        $workflow = WorkflowInstance::query()->whereKey($workflowId)->lockForUpdate()->firstOrFail();
        if ($workflow->lifecycle_state !== 'running') {
            return;
        }
        if (WorkItem::query()->where('workflow_instance_id', $workflowId)->whereIn('lifecycle_state', [
            WorkItemLifecycle::OPEN,
            WorkItemLifecycle::CLAIMED,
            WorkItemLifecycle::IN_PROGRESS,
        ])->exists()) {
            return;
        }

        $workflow->forceFill(['lifecycle_state' => 'completed', 'closed_at' => now()])->save();
    }
}
