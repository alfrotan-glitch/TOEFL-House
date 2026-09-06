<?php

declare(strict_types=1);

namespace App\Modules\Resources\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Resources\Domain\ResourceLifecycle;
use App\Modules\Resources\Domain\ResourceScope;
use App\Modules\Resources\Models\WorkOrder;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Facilities work: request -> approval (distinct approver) -> in progress
 * -> completed with mandatory work evidence, or cancelled.
 */
final class MaintainWorkOrder
{
    public const CAPABILITY_REQUEST = 'facilities.work';

    public const CAPABILITY_APPROVE = 'facilities.work_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{work_order_id: string, correlation_id: string} */
    public function request(Actor $requester, string $facilityNote, string $description, string $branchId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['resources.work.request', $facilityNote, $description, $branchId, $requester->actorId]));

        try {
            return $this->idempotency->execute('resources.work.request', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($requester, $facilityNote, $description, $branchId): array {
                    $scope = ResourceScope::fromBranch($branchId);
                    $this->require($requester, self::CAPABILITY_REQUEST, $scope);
                    if ($facilityNote === '' || $description === '') {
                        throw BusinessRejection::forCode('resources.work_terms', 'a work order requires its facility and description');
                    }

                    $order = WorkOrder::query()->create([
                        'id' => RandomIdentifier::new(),
                        'organization_id' => $scope->organizationId,
                        'originating_branch_id' => $scope->branchId,
                        'facility_note' => $facilityNote,
                        'description' => $description,
                        'lifecycle_state' => ResourceLifecycle::WORK_REQUESTED,
                        'requested_by' => $requester->actorId,
                    ]);
                    $event = $this->audit->record($requester->actorId, 'resources.work.request', 'work_order', $order->id, null, [
                        'facility' => $facilityNote, 'branch_id' => $scope->branchId, 'organization_id' => $scope->organizationId,
                    ]);

                    return ['work_order_id' => $order->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $requester, 'resources.work.request', 'work_order', $facilityNote);
        }
    }

    /** @return array{work_order_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, WorkOrder $order, string $idempotencyKey): array
    {
        return $this->transition($approver, $order, ResourceLifecycle::WORK_APPROVED, 'approve', self::CAPABILITY_APPROVE, null, $idempotencyKey);
    }

    /** @return array{work_order_id: string, lifecycle_state: string, correlation_id: string} */
    public function start(Actor $actor, WorkOrder $order, string $idempotencyKey): array
    {
        return $this->transition($actor, $order, ResourceLifecycle::WORK_IN_PROGRESS, 'start', self::CAPABILITY_REQUEST, null, $idempotencyKey);
    }

    /** @return array{work_order_id: string, lifecycle_state: string, correlation_id: string} */
    public function complete(Actor $actor, WorkOrder $order, string $evidenceRef, string $idempotencyKey): array
    {
        if ($evidenceRef === '') {
            throw BusinessRejection::forCode('resources.work_evidence', 'completion requires work evidence');
        }

        return $this->transition($actor, $order, ResourceLifecycle::WORK_COMPLETED, 'complete', self::CAPABILITY_REQUEST, $evidenceRef, $idempotencyKey);
    }

    /** @return array{work_order_id: string, lifecycle_state: string, correlation_id: string} */
    public function cancel(Actor $actor, WorkOrder $order, string $idempotencyKey): array
    {
        return $this->transition($actor, $order, ResourceLifecycle::WORK_CANCELLED, 'cancel', self::CAPABILITY_APPROVE, null, $idempotencyKey);
    }

    /** @return array{work_order_id: string, lifecycle_state: string, correlation_id: string} */
    private function transition(Actor $actor, WorkOrder $order, string $toState, string $verb, string $capability, ?string $evidenceRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['resources.work.'.$verb, $order->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('resources.work.'.$verb, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $order, $toState, $verb, $capability, $evidenceRef): array {
                    /** @var WorkOrder $locked */
                    $locked = WorkOrder::query()->whereKey($order->id)->lockForUpdate()->firstOrFail();
                    $scope = ResourceScope::fromStored($locked->originating_branch_id, $locked->organization_id);
                    $this->require($actor, $capability, $scope);
                    ResourceLifecycle::requireWorkTransition($locked->lifecycle_state, $toState);
                    if ($toState === ResourceLifecycle::WORK_APPROVED && trim((string) $locked->requested_by) === $actor->actorId) {
                        throw AuthorizationDenied::forCode('resources.work_not_independent', 'the approver must differ from the requester');
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState]);
                    if ($toState === ResourceLifecycle::WORK_APPROVED) {
                        $locked->approved_by = $actor->actorId;
                    }
                    if ($toState === ResourceLifecycle::WORK_COMPLETED) {
                        $locked->evidence_ref = $evidenceRef;
                    }
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'resources.work.'.$verb, 'work_order', $locked->id, $before, [
                        'lifecycle_state' => $toState,
                        'branch_id' => $scope->branchId, 'organization_id' => $scope->organizationId,
                    ]);

                    return ['work_order_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'resources.work.'.$verb, 'work_order', $order->id);
        }
    }

    private function require(Actor $actor, string $capability, StructureScope $scope): void
    {
        $outcome = $this->access->decide($actor, $capability, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('resources.work_denied', $outcome->reason);
        }
    }
}
