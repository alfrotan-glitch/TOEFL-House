<?php

declare(strict_types=1);

namespace App\Modules\WorkManagement\Domain;

use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\Employment;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Organization;
use App\Modules\Outbox\Domain\EventConsumer;
use App\Modules\Outbox\Models\DomainEvent;
use App\Modules\WorkManagement\Models\WorkItem;
use App\Modules\WorkManagement\Models\WorkItemHistory;
use App\Modules\WorkManagement\Models\WorkflowInstance;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;

/**
 * Starts coordination only for an explicit workflow intent emitted by a
 * domain command. It never infers an approval from a lifecycle state and
 * never mutates the source aggregate. Replay is safe through the source-event
 * identity; a compatible manual coordination instance is adopted rather than
 * duplicated when the source event later arrives.
 */
final class WorkflowProjectionConsumer implements EventConsumer
{
    public function __construct(private readonly AccessDecision $access) {}

    public function key(): string
    {
        return 'workflow.intent_projection';
    }

    public function supports(DomainEvent $event): bool
    {
        // Presence is the applicability test. Validation belongs in consume:
        // an explicit but malformed workflow intent must be retried and
        // eventually dead-lettered, not silently recorded as non-applicable.
        return is_array($this->intent($event));
    }

    public function consume(DomainEvent $event): void
    {
        /** @var array<string, mixed> $intent */
        $intent = $this->intent($event) ?? [];
        $definitionKey = trim((string) ($intent['definition_key'] ?? ''));
        $definition = WorkflowCatalog::definition($definitionKey);
        $eventSourceType = trim((string) $event->aggregate_type);
        $eventSourceId = trim((string) $event->aggregate_id);
        $intentSourceType = trim((string) ($intent['source_type'] ?? ''));
        $intentSourceId = trim((string) ($intent['source_id'] ?? ''));
        if (($intentSourceType !== '' && $intentSourceType !== $eventSourceType)
            || ($intentSourceId !== '' && $intentSourceId !== $eventSourceId)) {
            throw BusinessRejection::forCode('workflow.source_event_mismatch', 'a workflow intent source must match its domain event aggregate');
        }
        $sourceType = $intentSourceType !== '' ? $intentSourceType : $eventSourceType;
        $sourceId = $intentSourceId !== '' ? $intentSourceId : $eventSourceId;
        WorkflowCatalog::assertSource($definitionKey, $sourceType, $sourceId);
        if (isset($intent['source_version']) && (int) $intent['source_version'] < 1) {
            throw BusinessRejection::forCode('workflow.source_version_invalid', 'a workflow source version must be a positive integer');
        }
        $contextBranch = trim((string) ($event->context['branch_id'] ?? ''));
        $intentBranch = trim((string) ($intent['branch_id'] ?? ''));
        $eventOrganization = trim((string) ($event->context['organization_id'] ?? ''));
        $scopeType = trim((string) ($event->context['scope_type'] ?? 'unknown'));
        $branchId = $contextBranch !== '' ? $contextBranch : ($intentBranch !== '' ? $intentBranch : null);
        if (($intentBranch === '' && $contextBranch === '' && $scopeType !== 'organization')
            || ($intentBranch !== '' && ($contextBranch === '' || $intentBranch !== $contextBranch))
            || ($contextBranch !== '' && $eventOrganization === '')) {
            throw BusinessRejection::forCode('workflow.branch_provenance_invalid', 'a workflow intent branch must match the event envelope provenance');
        }
        if ($branchId !== null && ! Branch::query()->whereKey($branchId)->where('lifecycle_state', 'active')->exists()) {
            throw BusinessRejection::forCode('workflow.branch_unknown', 'a workflow intent requires an existing branch provenance');
        }
        $organizationId = $this->organizationId($branchId ?? '', $eventOrganization, $scopeType);
        if ($organizationId === null) {
            throw BusinessRejection::forCode('workflow.organization_provenance_invalid', 'a workflow intent requires active organization provenance matching its branch scope');
        }
        $assignedTo = isset($intent['assigned_to']) ? trim((string) $intent['assigned_to']) : null;
        $queueKey = isset($intent['queue_key']) ? trim((string) $intent['queue_key']) : null;
        $assignedTo = $assignedTo === '' ? null : $assignedTo;
        $queueKey = $queueKey === '' ? null : $queueKey;
        if ($queueKey !== null) {
            WorkQueueCatalog::assertKnown($queueKey);
        }

        // Receipt state may be rebuilt or lost; the source event itself is
        // the idempotency boundary for this projected workflow instance.
        // This also prevents a replay after a prior instance was completed
        // from creating a second running workflow.
        $projected = WorkflowInstance::query()
            ->where('source_event_id', $event->id)
            ->first();
        if ($projected !== null) {
            return;
        }

        $workflow = WorkflowInstance::query()
            ->where('definition_key', $definitionKey)
            ->where('source_type', $sourceType)
            ->where('source_id', $sourceId)
            ->orderByRaw("CASE WHEN lifecycle_state = 'running' THEN 0 ELSE 1 END")
            ->orderByDesc('created_at')
            ->first();
        if ($workflow !== null) {
            if ((string) $workflow->organization_id !== $organizationId
                || (string) ($workflow->branch_id ?? '') !== (string) ($branchId ?? '')) {
                throw BusinessRejection::forCode('workflow.scope_conflict', 'the existing workflow source is governed in a different organization or branch scope');
            }
            if ($workflow->source_event_id !== null && (string) $workflow->source_event_id !== (string) $event->id) {
                throw BusinessRejection::forCode('workflow.source_event_conflict', 'the source already has a different projected workflow event');
            }
            if ($workflow->source_event_id === null) {
                $workflow->forceFill([
                    'source_event_id' => $event->id,
                    'context' => array_merge(is_array($workflow->context) ? $workflow->context : [], [
                        'source_event_id' => $event->id,
                        'source_version' => $intent['source_version'] ?? null,
                    ]),
                ])->save();
            }
            return;
        }
        if ($assignedTo === null && $queueKey === null) {
            return;
        }
        if ($assignedTo !== null) {
            $assigneeEmployment = Employment::query()
                ->where('person_id', $assignedTo)
                ->orderByDesc('created_at')
                ->orderByDesc('id')
                ->first();
            if ($assigneeEmployment === null || $assigneeEmployment->lifecycle_state !== EmploymentLifecycle::STATE_ACTIVE) {
                throw BusinessRejection::forCode('workflow.assignee_ineligible', 'a workflow intent requires an active employee assignee');
            }
        }
        if ($assignedTo !== null) {
            $assigneeScope = $branchId !== null
                ? Branch::query()->whereKey($branchId)->firstOrFail()->structureScope()
                : StructureScope::organization($organizationId);
            if (! $this->access->decide(new Actor($assignedTo, 'Workflow assignee'), 'workflow.work', $assigneeScope)->allowed) {
                throw BusinessRejection::forCode('workflow.assignee_scope', 'a workflow intent assignee must hold workflow work authority in the item scope');
            }
        }

        $workflow = WorkflowInstance::query()->create([
            'id' => RandomIdentifier::new(),
            'definition_key' => $definitionKey,
            'definition_version' => $definition['version'],
            'source_type' => $sourceType,
            'source_id' => $sourceId,
            'source_event_id' => $event->id,
            'correlation_id' => $event->correlation_id,
            'organization_id' => $organizationId,
            'branch_id' => $branchId,
            'lifecycle_state' => 'running',
            'started_by' => $event->actor_id,
            'started_at' => now(),
            'context' => ['source_event_id' => $event->id, 'source_version' => $intent['source_version'] ?? null],
        ]);
        $item = WorkItem::query()->create([
            'id' => RandomIdentifier::new(),
            'workflow_instance_id' => $workflow->id,
            'kind' => $definition['work_kind'],
            'title' => $definition['name'],
            'source_type' => $sourceType,
            'source_id' => $sourceId,
            'action_key' => $definition['action_key'],
            'source_version' => isset($intent['source_version']) ? (int) $intent['source_version'] : null,
            'organization_id' => $organizationId,
            'branch_id' => $branchId,
            'assigned_to' => $assignedTo,
            'queue_key' => $queueKey,
            'priority' => isset($intent['priority']) ? max(1, min(1000, (int) $intent['priority'])) : 100,
            'due_at' => $intent['due_at'] ?? null,
            'lifecycle_state' => WorkItemLifecycle::OPEN,
            'created_by' => $event->actor_id,
        ]);
        WorkItemHistory::query()->create([
            'id' => RandomIdentifier::new(),
            'workflow_instance_id' => $workflow->id,
            'work_item_id' => $item->id,
            'event_type' => 'workflow.intent_projected',
            'actor_id' => $event->actor_id,
            'to_state' => WorkItemLifecycle::OPEN,
            'metadata' => ['source_event_id' => $event->id, 'definition_key' => $definitionKey],
            'occurred_at' => now(),
        ]);
    }

    private function organizationId(string $branchId, string $eventOrganization, string $scopeType): ?string
    {
        $branchId = trim($branchId);
        $eventOrganization = trim($eventOrganization);
        if ($branchId === '') {
            if ($scopeType !== 'organization' || $eventOrganization === '') {
                return null;
            }

            return Organization::query()
                ->whereKey($eventOrganization)
                ->where('lifecycle_state', 'active')
                ->exists() ? $eventOrganization : null;
        }

        /** @var Branch|null $branch */
        $branch = Branch::query()
            ->whereKey($branchId)
            ->where('lifecycle_state', 'active')
            ->first();
        if ($branch === null) {
            return null;
        }
        $branchOrganization = trim((string) $branch->structureScope()->organizationId);
        if ($branchOrganization === '' || ($eventOrganization !== '' && $eventOrganization !== $branchOrganization)) {
            return null;
        }

        return Organization::query()
            ->whereKey($branchOrganization)
            ->where('lifecycle_state', 'active')
            ->exists() ? $branchOrganization : null;
    }

    /** @return array<string, mixed>|null */
    private function intent(DomainEvent $event): ?array
    {
        $after = $event->payload['after'] ?? null;
        $intent = $event->payload['workflow'] ?? (is_array($after) ? ($after['workflow'] ?? null) : null);

        return is_array($intent) ? $intent : null;
    }
}
