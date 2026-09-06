<?php

declare(strict_types=1);

namespace App\Modules\Organization\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Organization\Domain\OrganizationLifecycle;
use App\Modules\Organization\Domain\StructureUnit;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\StructureDecision;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

/**
 * Lifecycle transitions of structure units. Every execution validates the
 * authority chain, revalidates state at commit under a row lock, and commits
 * the fact together with its audit evidence in one owning transaction.
 */
final class TransitionStructureUnit
{
    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{id: string, unit_type: string, lifecycle_state: string, correlation_id: string} */
    public function activate(Model&StructureUnit $unit, StructureDecision $decision, string $idempotencyKey): array
    {
        return $this->transition($unit, OrganizationLifecycle::STATE_ACTIVE, 'activate', $decision, $idempotencyKey);
    }

    /** @return array{id: string, unit_type: string, lifecycle_state: string, correlation_id: string} */
    public function suspend(Model&StructureUnit $unit, StructureDecision $decision, string $idempotencyKey): array
    {
        return $this->transition($unit, OrganizationLifecycle::STATE_SUSPENDED, 'suspend', $decision, $idempotencyKey);
    }

    /** @return array{id: string, unit_type: string, lifecycle_state: string, correlation_id: string} */
    public function close(Model&StructureUnit $unit, StructureDecision $decision, string $idempotencyKey): array
    {
        return $this->transition($unit, OrganizationLifecycle::STATE_CLOSED, 'close', $decision, $idempotencyKey);
    }

    /**
     * Reopening is the registry chain closed -> reopened -> active, committed
     * atomically with one audit record per transition.
     *
     * @return array{id: string, unit_type: string, lifecycle_state: string, correlation_id: string}
     */
    public function reopen(Model&StructureUnit $unit, StructureDecision $decision, string $idempotencyKey): array
    {
        try {
            return $this->idempotency->execute(
                'organization.structure.reopen',
                $idempotencyKey,
                $this->transitionPayload($unit, 'reopen', $decision),
                function () use ($unit, $decision): array {
                    return DB::transaction(function () use ($unit, $decision): array {
                        $decision->authorize($this->access, $unit->structureScope());
                        $locked = $this->lockedUnit($unit);

                        OrganizationLifecycle::requireTransition($locked->lifecycleState(), OrganizationLifecycle::STATE_REOPENED);
                        $outcome = $this->commitTransition($locked, OrganizationLifecycle::STATE_REOPENED, 'reopen', $decision);
                        OrganizationLifecycle::requireTransition($locked->lifecycleState(), OrganizationLifecycle::STATE_ACTIVE);

                        return $this->commitTransition($locked, OrganizationLifecycle::STATE_ACTIVE, 'reopen', $decision, $outcome['correlation_id']);
                    });
                },
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $decision->initiator, 'organization.structure.reopen', $unit->unitType(), $unit->unitId());
        }
    }

    /** @return array{id: string, unit_type: string, lifecycle_state: string, correlation_id: string} */
    private function transition(Model&StructureUnit $unit, string $toState, string $verb, StructureDecision $decision, string $idempotencyKey): array
    {
        $operation = 'organization.structure.'.$verb;
        try {
            return $this->idempotency->execute(
                $operation,
                $idempotencyKey,
                $this->transitionPayload($unit, $verb, $decision),
                function () use ($unit, $toState, $verb, $decision): array {
                    return DB::transaction(function () use ($unit, $toState, $verb, $decision): array {
                        $decision->authorize($this->access, $unit->structureScope());
                        $locked = $this->lockedUnit($unit);
                        OrganizationLifecycle::requireTransition($locked->lifecycleState(), $toState);

                        return $this->commitTransition($locked, $toState, $verb, $decision);
                    });
                },
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $decision->initiator, $operation, $unit->unitType(), $unit->unitId());
        }
    }

    /**
     * @return array{id: string, unit_type: string, lifecycle_state: string, correlation_id: string}
     */
    private function commitTransition(Model&StructureUnit $locked, string $toState, string $verb, StructureDecision $decision, ?string $correlationId = null): array
    {
        $before = ['lifecycle_state' => $locked->lifecycleState()];
        $locked->forceFill(['lifecycle_state' => $toState]);
        $locked->save();
        $after = ['lifecycle_state' => $toState];

        $event = $this->audit->record(
            $decision->initiator->actorId,
            'organization.structure.'.$verb,
            $locked->unitType(),
            $locked->unitId(),
            $before,
            $after,
            $correlationId,
        );

        return [
            'id' => $locked->unitId(),
            'unit_type' => $locked->unitType(),
            'lifecycle_state' => $toState,
            'correlation_id' => $event->correlation_id,
        ];
    }

    private function transitionPayload(StructureUnit $unit, string $verb, StructureDecision $decision): string
    {
        return hash('sha256', implode('|', [
            'organization.structure.'.$verb,
            $unit->unitType(),
            $unit->unitId(),
            implode(',', $decision->participantIds()),
        ]));
    }

    /**
     * Revalidates the row under a lock at commit time; the lifecycle check
     * that passed outside the transaction is repeated on the locked row.
     */
    private function lockedUnit(Model&StructureUnit $unit): Model&StructureUnit
    {
        /** @var Model&StructureUnit $locked */
        $locked = $unit::query()->whereKey($unit->unitId())->lockForUpdate()->firstOrFail();

        return $locked;
    }
}
