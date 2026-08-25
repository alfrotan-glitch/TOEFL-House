<?php

declare(strict_types=1);

namespace App\Modules\Access\Commands;

use App\Modules\Access\Domain\AccessLifecycle;
use App\Modules\Access\Models\Delegation;
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

                    if ($creator->actorId !== $delegatorPersonId) {
                        $outcome = $this->access->decide($creator, self::CAPABILITY, null);
                        if (! $outcome->allowed) {
                            throw AuthorizationDenied::forCode('access.delegate_denied', $outcome->reason);
                        }
                    } else {
                        $scopedOutcome = $this->access->decide($creator, $permission ?? '', null);
                        if ($permission !== null && ! $scopedOutcome->allowed) {
                            throw AuthorizationDenied::forCode('access.delegate_beyond_authority', 'a delegator may not delegate authority they do not hold');
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
}
