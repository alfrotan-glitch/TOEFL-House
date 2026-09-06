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
use App\Support\Errors\BusinessRejection;
use App\Support\Errors\ValidationError;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Creates dated, scoped, reasoned temporary authority. Only the delegator
 * (or an access administrator) may delegate; the delegate never exceeds the
 * delegator's own authority because resolution is bounded by it.
 */
final class DelegateAuthority
{
    public const CAPABILITY = 'access.delegate';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /**
     * @return array{delegation_id: string, correlation_id: string}
     */
    public function delegate(
        Actor $creator,
        string $delegatorPersonId,
        string $delegatePersonId,
        ?string $permission,
        ?string $scopeType,
        ?string $scopeId,
        CarbonImmutable $effectiveFrom,
        CarbonImmutable $effectiveTo,
        string $reason,
        string $idempotencyKey,
    ): array {
        $payload = hash('sha256', implode('|', ['access.delegate', $delegatorPersonId, $delegatePersonId, $permission ?? '', $scopeType ?? '', $scopeId ?? '', $effectiveFrom->toDateString(), $effectiveTo->toDateString(), $creator->actorId]));

        try {
            return $this->idempotency->execute('access.delegate', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($creator, $delegatorPersonId, $delegatePersonId, $permission, $scopeType, $scopeId, $effectiveFrom, $effectiveTo, $reason): array {
                    if ($delegatorPersonId === $delegatePersonId) {
                        throw BusinessRejection::forCode('access.delegation_to_self', 'a person cannot delegate to themselves');
                    }
                    if ($effectiveTo->startOfDay()->lessThanOrEqualTo($effectiveFrom->startOfDay())) {
                        throw ValidationError::forCode('access.delegation_period', 'delegation must end after it starts');
                    }
                    if ($reason === '') {
                        throw ValidationError::forCode('access.delegation_reason', 'delegation requires a reason');
                    }
                    if ($permission === null || trim($permission) === '') {
                        throw ValidationError::forCode('access.delegation_permission_required', 'delegation must name one capability');
                    }
                    if ($scopeType === null || trim($scopeType) === '' || $scopeId === null || trim($scopeId) === '') {
                        throw ValidationError::forCode('access.delegation_scope_required', 'delegation must name an explicit organization structure scope');
                    }

                    $scope = $this->scopeForDelegation($scopeType, $scopeId);
                    $delegatorOutcome = $this->access->decide(
                        new Actor($delegatorPersonId, 'Delegation authority holder'),
                        $permission,
                        $scope,
                    );
                    if (! $delegatorOutcome->allowed) {
                        throw AuthorizationDenied::forCode('access.delegate_beyond_authority', 'a delegator may not delegate authority they do not hold');
                    }
                    if ($creator->actorId !== $delegatorPersonId) {
                        $outcome = $this->access->decide($creator, self::CAPABILITY, $scope);
                        if (! $outcome->allowed) {
                            throw AuthorizationDenied::forCode('access.delegate_denied', $outcome->reason);
                        }
                    }

                    $delegation = Delegation::query()->create([
                        'id' => RandomIdentifier::new(),
                        'delegator_person_id' => $delegatorPersonId,
                        'delegate_person_id' => $delegatePersonId,
                        'permission' => $permission,
                        'scope_type' => $scopeType,
                        'scope_id' => $scopeId,
                        'lifecycle_state' => AccessLifecycle::STATE_ACTIVE,
                        'effective_from' => $effectiveFrom->startOfDay()->toDateString(),
                        'effective_to' => $effectiveTo->startOfDay()->toDateString(),
                        'reason' => $reason,
                        'created_by' => $creator->actorId,
                    ]);

                    $event = $this->audit->record($creator->actorId, 'access.delegate', 'delegation', $delegation->id, null, [
                        'delegator_person_id' => $delegatorPersonId,
                        'delegate_person_id' => $delegatePersonId,
                        'permission' => $permission,
                        'scope' => $scopeType !== null ? $scopeType.':'.($scopeId ?? '') : null,
                        'effective_from' => $delegation->effective_from,
                        'effective_to' => $delegation->effective_to,
                        'reason' => $reason,
                    ]);

                    return ['delegation_id' => $delegation->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $creator, 'access.delegate', 'delegation', $delegatePersonId);
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
                ?? throw BusinessRejection::forCode('access.scope_unavailable', 'delegation campus scope does not resolve')), (string) $scopeId),
            'branch' => Branch::query()->whereKey($scopeId)->firstOrFail()->structureScope(),
            'department' => Department::query()->whereKey($scopeId)->firstOrFail()->structureScope(),
            default => throw BusinessRejection::forCode('access.scope_type_unknown', 'delegation scope type is unknown'),
        };
    }
}
