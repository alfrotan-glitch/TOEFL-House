<?php

declare(strict_types=1);

namespace App\Modules\Access\Commands;

use App\Modules\Access\Domain\AccessLifecycle;
use App\Modules\Access\Models\PositionAssignment;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;

/**
 * Explicit lifecycle transitions of a position assignment; expired access
 * can never continue and revoked assignments stay in history.
 */
final class TransitionPositionAssignment
{
    public const CAPABILITY = 'access.assign_position';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{assignment_id: string, lifecycle_state: string, correlation_id: string} */
    public function activate(Actor $actor, PositionAssignment $assignment, string $idempotencyKey): array
    {
        return $this->transition($actor, $assignment, AccessLifecycle::STATE_ACTIVE, 'activate', $idempotencyKey);
    }

    /** @return array{assignment_id: string, lifecycle_state: string, correlation_id: string} */
    public function revoke(Actor $actor, PositionAssignment $assignment, string $idempotencyKey): array
    {
        return $this->transition($actor, $assignment, AccessLifecycle::STATE_REVOKED, 'revoke', $idempotencyKey);
    }

    /** @return array{assignment_id: string, lifecycle_state: string, correlation_id: string} */
    private function transition(Actor $actor, PositionAssignment $assignment, string $toState, string $verb, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['access.position.'.$verb, $assignment->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('access.position.'.$verb, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $assignment, $toState, $verb): array {
                    $outcome = $this->access->decide($actor, self::CAPABILITY, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('access.position_transition_denied', $outcome->reason);
                    }

                    /** @var PositionAssignment $locked */
                    $locked = PositionAssignment::query()->whereKey($assignment->id)->lockForUpdate()->firstOrFail();
                    AccessLifecycle::requireTransition($locked->lifecycle_state, $toState);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState]);
                    $locked->save();

                    $event = $this->audit->record($actor->actorId, 'access.position.'.$verb, 'position_assignment', $locked->id, $before, ['lifecycle_state' => $toState]);

                    return ['assignment_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'access.position.'.$verb, 'position_assignment', $assignment->id);
        }
    }
}
