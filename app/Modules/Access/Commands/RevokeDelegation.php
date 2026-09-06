<?php

declare(strict_types=1);

namespace App\Modules\Access\Commands;

use App\Modules\Access\Domain\AccessLifecycle;
use App\Modules\Access\Models\Delegation;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Campus;
use App\Modules\Organization\Models\Department;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;

/**
 * Revocation terminates a delegation; the record and its history remain.
 */
final class RevokeDelegation
{
    public const CAPABILITY = 'access.delegate';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{delegation_id: string, lifecycle_state: string, correlation_id: string} */
    public function revoke(Actor $actor, Delegation $delegation, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['access.delegate.revoke', $delegation->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('access.delegate.revoke', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $delegation): array {
                    /** @var Delegation $locked */
                    $locked = Delegation::query()->whereKey($delegation->id)->lockForUpdate()->firstOrFail();
                    if (trim((string) $locked->delegator_person_id) !== $actor->actorId) {
                        $scope = $this->scopeForDelegation($locked->scope_type, $locked->scope_id);
                        $outcome = $this->access->decide($actor, self::CAPABILITY, $scope?->withInactiveLifecycleAccess());
                        if (! $outcome->allowed) {
                            throw AuthorizationDenied::forCode('access.delegate_revoke_denied', $outcome->reason);
                        }
                    }

                    AccessLifecycle::requireTransition($locked->lifecycle_state, AccessLifecycle::STATE_REVOKED);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => AccessLifecycle::STATE_REVOKED]);
                    $locked->save();

                    $event = $this->audit->record($actor->actorId, 'access.delegate.revoke', 'delegation', $locked->id, $before, ['lifecycle_state' => AccessLifecycle::STATE_REVOKED]);

                    return ['delegation_id' => $locked->id, 'lifecycle_state' => AccessLifecycle::STATE_REVOKED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'access.delegate.revoke', 'delegation', $delegation->id);
        }
    }

    private function scopeForDelegation(?string $scopeType, ?string $scopeId): ?\App\Support\Authorization\StructureScope
    {
        if ($scopeType === null || trim((string) $scopeId) === '') {
            return null;
        }

        return match ($scopeType) {
            'organization' => new \App\Support\Authorization\StructureScope((string) $scopeId),
            'campus' => new \App\Support\Authorization\StructureScope((string) (Campus::query()->whereKey($scopeId)->value('organization_id')
                ?? throw \App\Support\Errors\BusinessRejection::forCode('access.scope_unavailable', 'delegation campus scope does not resolve')), (string) $scopeId),
            'branch' => Branch::query()->whereKey($scopeId)->firstOrFail()->structureScope(),
            'department' => Department::query()->whereKey($scopeId)->firstOrFail()->structureScope(),
            default => throw \App\Support\Errors\BusinessRejection::forCode('access.scope_type_unknown', 'delegation scope type is unknown'),
        };
    }
}
