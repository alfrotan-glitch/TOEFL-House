<?php

declare(strict_types=1);

namespace App\Modules\Hr\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Domain\ContractLifecycle;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\Contract;
use App\Modules\Hr\Models\Employment;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Contract chain header: draft terms, sign them into force (terms fixed
 * from then on), close the chain when terms change. Compensation itself
 * lives exclusively on the immutable contract versions prepared by the
 * Finance Manager and approved by the General Manager (CompensationRule
 * is the single authoritative compensation model).
 */
final class MaintainContract
{
    public const CAPABILITY = 'hr.contract';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{contract_id: string, correlation_id: string} */
    public function draft(Actor $actor, Employment $employment, string $termsSummary, string $effectiveFrom, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.contract.draft', $employment->id, $termsSummary, $effectiveFrom, $actor->actorId]));

        try {
            return $this->idempotency->execute('hr.contract.draft', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $employment, $termsSummary, $effectiveFrom): array {
                    $this->require($actor, self::CAPABILITY);
                    if ($termsSummary === '') {
                        throw BusinessRejection::forCode('hr.contract_terms', 'a contract requires its terms summary');
                    }

                    /** @var Employment $locked */
                    $locked = Employment::query()->whereKey($employment->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state === EmploymentLifecycle::STATE_TERMINATED) {
                        throw BusinessRejection::forCode('hr.contract_employment_terminated', 'a terminated employment cannot receive contracts');
                    }
                    if (Contract::query()->where('employment_id', $locked->id)->whereIn('lifecycle_state', ['draft', 'active'])->exists()) {
                        throw BusinessRejection::forCode('hr.contract_open_exists', 'this employment already has an open contract');
                    }

                    $contract = Contract::query()->create([
                        'id' => RandomIdentifier::new(),
                        'employment_id' => $locked->id,
                        'terms_summary' => $termsSummary,
                        'lifecycle_state' => ContractLifecycle::STATE_DRAFT,
                        'effective_from' => $effectiveFrom,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'hr.contract.draft', 'contract', $contract->id, null, ['employment_id' => $locked->id, 'effective_from' => $effectiveFrom]);

                    return ['contract_id' => $contract->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'hr.contract.draft', 'contract', $employment->id);
        }
    }

    /** @return array{contract_id: string, lifecycle_state: string, correlation_id: string} */
    public function sign(Actor $actor, Contract $contract, string $signedRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.contract.sign', $contract->id, $signedRef, $actor->actorId]));

        try {
            return $this->idempotency->execute('hr.contract.sign', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $contract, $signedRef): array {
                    $this->require($actor, self::CAPABILITY);
                    if ($signedRef === '') {
                        throw BusinessRejection::forCode('hr.contract_signature', 'signing requires the signed-document evidence reference');
                    }

                    /** @var Contract $locked */
                    $locked = Contract::query()->whereKey($contract->id)->lockForUpdate()->firstOrFail();
                    ContractLifecycle::requireTransition($locked->lifecycle_state, ContractLifecycle::STATE_ACTIVE);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => ContractLifecycle::STATE_ACTIVE, 'signed_ref' => $signedRef, 'signed_by' => $actor->actorId]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'hr.contract.sign', 'contract', $locked->id, $before, ['lifecycle_state' => ContractLifecycle::STATE_ACTIVE, 'signed_ref' => $signedRef]);

                    return ['contract_id' => $locked->id, 'lifecycle_state' => ContractLifecycle::STATE_ACTIVE, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'hr.contract.sign', 'contract', $contract->id);
        }
    }

    /** @return array{contract_id: string, lifecycle_state: string, correlation_id: string} */
    public function close(Actor $actor, Contract $contract, string $effectiveTo, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.contract.close', $contract->id, $effectiveTo, $actor->actorId]));

        try {
            return $this->idempotency->execute('hr.contract.close', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $contract, $effectiveTo): array {
                    $this->require($actor, self::CAPABILITY);

                    /** @var Contract $locked */
                    $locked = Contract::query()->whereKey($contract->id)->lockForUpdate()->firstOrFail();
                    ContractLifecycle::requireTransition($locked->lifecycle_state, ContractLifecycle::STATE_CLOSED);
                    if ($effectiveTo <= $locked->effective_from) {
                        throw BusinessRejection::forCode('hr.contract_period', 'the closure date must be after the effective start');
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => ContractLifecycle::STATE_CLOSED, 'effective_to' => $effectiveTo]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'hr.contract.close', 'contract', $locked->id, $before, ['lifecycle_state' => ContractLifecycle::STATE_CLOSED, 'effective_to' => $effectiveTo]);

                    return ['contract_id' => $locked->id, 'lifecycle_state' => ContractLifecycle::STATE_CLOSED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'hr.contract.close', 'contract', $contract->id);
        }
    }

    private function require(Actor $actor, string $capability): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('hr.contract_denied', $outcome->reason);
        }
    }
}
