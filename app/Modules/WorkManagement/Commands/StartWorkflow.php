<?php

declare(strict_types=1);

namespace App\Modules\WorkManagement\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\Employment;
use App\Modules\WorkManagement\Domain\WorkQueueCatalog;
use App\Modules\WorkManagement\Domain\WorkflowCatalog;
use App\Modules\WorkManagement\Models\WorkItem;
use App\Modules\WorkManagement\Models\WorkItemHistory;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Organization;
use App\Modules\WorkManagement\Models\WorkflowInstance;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\BranchScopedAccess;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Support\Facades\DB;

/**
 * Starts coordination around an existing domain fact. It never creates or
 * changes that fact; the returned work item only links the employee to the
 * owning domain command/action.
 */
final class StartWorkflow
{
    public const CAPABILITY = 'workflow.start';

    private readonly BranchScopedAccess $scoped;

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {
        $this->scoped = new BranchScopedAccess($access);
    }

    /** @return array{workflow_id: string, work_item_id: string, duplicate: bool, correlation_id: string} */
    public function start(
        Actor $actor,
        string $definitionKey,
        string $sourceType,
        string $sourceId,
        ?string $branchId,
        ?string $assignedTo,
        ?string $queueKey,
        string $idempotencyKey,
        ?int $sourceVersion = null,
        ?string $organizationId = null,
    ): array {
        $definition = WorkflowCatalog::definition($definitionKey);
        $payload = hash('sha256', implode('|', [$definitionKey, $sourceType, $sourceId, $organizationId ?? '', $branchId ?? '', $assignedTo ?? '', $queueKey ?? '', (string) $sourceVersion, $actor->actorId]));

        try {
            return $this->idempotency->execute('workflow.start', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $definitionKey, $definition, $sourceType, $sourceId, $branchId, $assignedTo, $queueKey, $sourceVersion, $organizationId): array {
                    if ($sourceType === '' || $sourceId === '') {
                        throw BusinessRejection::forCode('workflow.source_required', 'a workflow must reference an existing domain fact');
                    }
                    if ($sourceVersion !== null && $sourceVersion < 1) {
                        throw BusinessRejection::forCode('workflow.source_version_invalid', 'a workflow source version must be a positive integer');
                    }
                    WorkflowCatalog::assertSource($definitionKey, $sourceType, $sourceId);
                    if (($assignedTo === null || trim($assignedTo) === '') && ($queueKey === null || trim($queueKey) === '')) {
                        throw BusinessRejection::forCode('workflow.assignment_required', 'a work item requires an actor or governed queue assignment');
                    }
                    $resolvedOrganizationId = $this->resolveOrganizationId($branchId, $organizationId);
                    if ($branchId === null || trim($branchId) === '') {
                        $outcome = $this->access->decide($actor, self::CAPABILITY, StructureScope::organization($resolvedOrganizationId));
                        if (! $outcome->allowed) {
                            throw AuthorizationDenied::forCode('workflow.start_denied', $outcome->reason);
                        }
                    } else {
                        $this->scoped->require($actor, self::CAPABILITY, $branchId, 'workflow.start_denied');
                    }
                    if ($queueKey !== null && trim($queueKey) !== '') {
                        WorkQueueCatalog::assertKnown(trim($queueKey));
                    }
                    if ($assignedTo !== null && trim($assignedTo) !== '') {
                        $assignedTo = trim($assignedTo);
                        $assigneeEmployment = Employment::query()
                            ->where('person_id', $assignedTo)
                            ->orderByDesc('created_at')
                            ->orderByDesc('id')
                            ->first();
                        if ($assigneeEmployment === null || $assigneeEmployment->lifecycle_state !== EmploymentLifecycle::STATE_ACTIVE) {
                            throw BusinessRejection::forCode('workflow.assignee_ineligible', 'a work item requires an active employee assignee');
                        }
                        $assignee = new Actor($assignedTo, 'Workflow assignee');
                        $assigneeScope = $branchId !== null && trim($branchId) !== ''
                            ? Branch::query()->whereKey($branchId)->firstOrFail()->structureScope()
                            : StructureScope::organization($resolvedOrganizationId);
                        if (! $this->access->decide($assignee, 'workflow.work', $assigneeScope)->allowed) {
                            throw BusinessRejection::forCode('workflow.assignee_scope', 'the assigned actor must hold workflow work authority in the item scope');
                        }
                    }

                    $existing = WorkflowInstance::query()
                        ->where('definition_key', $definitionKey)
                        ->where('source_type', $sourceType)
                        ->where('source_id', $sourceId)
                        ->where('lifecycle_state', 'running')
                        ->lockForUpdate()
                        ->first();
                    if ($existing !== null) {
                        if ((string) $existing->organization_id !== $resolvedOrganizationId
                            || (string) ($existing->branch_id ?? '') !== (string) ($branchId ?? '')) {
                            throw BusinessRejection::forCode('workflow.scope_conflict', 'the existing workflow source is governed in a different organization or branch scope');
                        }
                        $item = $existing->workItems()->whereIn('lifecycle_state', ['open', 'claimed', 'in_progress'])->first();
                        if ($item === null) {
                            throw BusinessRejection::forCode('workflow.running_without_work', 'the running workflow has no actionable work item');
                        }

                        return ['workflow_id' => $existing->id, 'work_item_id' => $item->id, 'duplicate' => true, 'correlation_id' => (string) $existing->correlation_id];
                    }

                    $workflow = WorkflowInstance::query()->create([
                        'id' => RandomIdentifier::new(),
                        'definition_key' => $definitionKey,
                        'definition_version' => $definition['version'],
                        'source_type' => $sourceType,
                        'source_id' => $sourceId,
                        'correlation_id' => RandomIdentifier::new(),
                        'organization_id' => $resolvedOrganizationId,
                        'branch_id' => $branchId,
                        'lifecycle_state' => 'running',
                        'started_by' => $actor->actorId,
                        'started_at' => now(),
                        'context' => ['source_version' => $sourceVersion],
                    ]);
                    $item = WorkItem::query()->create([
                        'id' => RandomIdentifier::new(),
                        'workflow_instance_id' => $workflow->id,
                        'kind' => $definition['work_kind'],
                        'title' => $definition['name'],
                        'source_type' => $sourceType,
                        'source_id' => $sourceId,
                        'action_key' => $definition['action_key'],
                        'source_version' => $sourceVersion,
                        'organization_id' => $resolvedOrganizationId,
                        'branch_id' => $branchId,
                        'assigned_to' => $assignedTo,
                        'queue_key' => $queueKey,
                        'priority' => 100,
                        'lifecycle_state' => 'open',
                        'created_by' => $actor->actorId,
                    ]);
                    WorkItemHistory::query()->create([
                        'id' => RandomIdentifier::new(),
                        'workflow_instance_id' => $workflow->id,
                        'work_item_id' => $item->id,
                        'event_type' => 'workflow.started',
                        'actor_id' => $actor->actorId,
                        'to_state' => 'open',
                        'metadata' => ['definition_key' => $definitionKey, 'action_key' => $definition['action_key']],
                        'occurred_at' => now(),
                    ]);
                    $event = $this->audit->record($actor->actorId, 'workflow.start', 'workflow_instance', $workflow->id, null, ['source_type' => $sourceType, 'source_id' => $sourceId, 'work_item_id' => $item->id, 'organization_id' => $resolvedOrganizationId, 'branch_id' => $branchId]);

                    return ['workflow_id' => $workflow->id, 'work_item_id' => $item->id, 'duplicate' => false, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'workflow.start', 'workflow', $sourceId);
        }
    }

    private function resolveOrganizationId(?string $branchId, ?string $organizationId): string
    {
        $branchId = trim((string) ($branchId ?? ''));
        $organizationId = trim((string) ($organizationId ?? ''));
        if ($branchId !== '') {
            $branch = Branch::query()->whereKey($branchId)->first();
            if ($branch === null || $branch->lifecycle_state !== 'active') {
                throw BusinessRejection::forCode('workflow.branch_unknown', 'a workflow branch must be active');
            }
            try {
                $branchOrganization = trim((string) $branch->structureScope()->organizationId);
            } catch (ModelNotFoundException) {
                throw BusinessRejection::forCode('workflow.branch_unknown', 'a workflow branch requires current active campus provenance');
            }
            if ($branchOrganization === '' || ($organizationId !== '' && $organizationId !== $branchOrganization)) {
                throw BusinessRejection::forCode('workflow.organization_provenance_invalid', 'workflow branch and organization provenance must agree');
            }
            $organizationId = $branchOrganization;
        }
        if ($organizationId === '' || ! Organization::query()->whereKey($organizationId)->where('lifecycle_state', 'active')->exists()) {
            throw BusinessRejection::forCode('workflow.organization_provenance_required', 'a workflow requires an active organization provenance');
        }

        return $organizationId;
    }
}
