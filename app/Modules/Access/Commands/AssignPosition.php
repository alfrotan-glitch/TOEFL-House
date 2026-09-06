<?php

declare(strict_types=1);

namespace App\Modules\Access\Commands;

use App\Modules\Access\Domain\AccessLifecycle;
use App\Modules\Access\Models\Position;
use App\Modules\Access\Models\PositionAssignment;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\PersonBranchScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Assigns a person to a position as a proposed assignment; activation is a
 * separate explicit transition. A repeated assignment closes the prior open
 * assignment for the same person and position, retaining history.
 */
final class AssignPosition
{
    public const CAPABILITY = 'access.assign_position';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{assignment_id: string, correlation_id: string} */
    public function assign(Actor $assigner, string $personId, string $positionId, CarbonImmutable $effectiveFrom, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['access.position.assign', $personId, $positionId, $effectiveFrom->toDateString(), $assigner->actorId]));

        try {
            return $this->idempotency->execute('access.position.assign', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($assigner, $personId, $positionId, $effectiveFrom): array {
                    $scope = PersonBranchScope::resolve($personId);
                    $position = Position::query()->whereKey($positionId)->first();
                    if ($position === null || trim((string) $position->organization_id) !== trim($scope->organizationId)) {
                        throw BusinessRejection::forCode('access.position_scope_mismatch', 'a position assignment must remain inside the person home organization');
                    }
                    $this->requireAssigner($assigner, $scope);

                    $prior = PositionAssignment::query()
                        ->where('person_id', $personId)
                        ->where('position_id', $positionId)
                        ->where('lifecycle_state', AccessLifecycle::STATE_ACTIVE)
                        ->whereNull('effective_to')
                        ->lockForUpdate()
                        ->get();
                    foreach ($prior as $priorRow) {
                        $priorRow->effective_to = $effectiveFrom->startOfDay()->toDateString();
                        $priorRow->save();
                    }

                    $assignment = PositionAssignment::query()->create([
                        'id' => RandomIdentifier::new(),
                        'person_id' => $personId,
                        'position_id' => $positionId,
                        'lifecycle_state' => AccessLifecycle::STATE_PROPOSED,
                        'effective_from' => $effectiveFrom->startOfDay()->toDateString(),
                        'effective_to' => null,
                        'assigned_by' => $assigner->actorId,
                    ]);

                    $event = $this->audit->record($assigner->actorId, 'access.position.assign', 'position_assignment', $assignment->id, null, [
                        'person_id' => $personId,
                        'position_id' => $positionId,
                        'lifecycle_state' => AccessLifecycle::STATE_PROPOSED,
                        'effective_from' => $assignment->effective_from,
                        'branch_id' => $scope->branchId, 'organization_id' => $scope->organizationId,
                    ]);

                    return ['assignment_id' => $assignment->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $assigner, 'access.position.assign', 'position_assignment', $personId);
        }
    }

    private function requireAssigner(Actor $assigner, \App\Support\Authorization\StructureScope $scope): void
    {
        $outcome = $this->access->decide($assigner, self::CAPABILITY, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('access.assign_position_denied', $outcome->reason);
        }
    }
}
