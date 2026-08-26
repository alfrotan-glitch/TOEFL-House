<?php

declare(strict_types=1);

namespace App\Modules\Hr\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Domain\ContractLifecycle;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\CompensationComponent;
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
 * Contracts: draft terms, sign them into force (terms fixed from then on),
 * close the prior one when terms change. A compensation change is proposed
 * by HR and activated by a different approver who is never the beneficiary.
 */
final class MaintainContract
{
    public const CAPABILITY = 'hr.contract';

    public const CAPABILITY_COMPENSATION = 'hr.compensation';

    public const CAPABILITY_COMPENSATION_APPROVE = 'hr.compensation_approve';

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

    /** @return array{component_id: string, correlation_id: string} */
    public function proposeCompensation(Actor $proposer, Contract $contract, string $kind, string $amount, string $effectiveFrom, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.compensation.propose', $contract->id, $kind, $amount, $effectiveFrom, $proposer->actorId]));

        try {
            return $this->idempotency->execute('hr.compensation.propose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($proposer, $contract, $kind, $amount, $effectiveFrom): array {
                    $this->require($proposer, self::CAPABILITY_COMPENSATION);
                    if (! is_numeric($amount) || (float) $amount <= 0) {
                        throw BusinessRejection::forCode('hr.compensation_amount', 'a compensation amount must be a positive number');
                    }

                    /** @var Contract $locked */
                    $locked = Contract::query()->whereKey($contract->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== ContractLifecycle::STATE_ACTIVE) {
                        throw BusinessRejection::forCode('hr.compensation_contract_not_active', 'compensation attaches only to an active contract');
                    }
                    if ($effectiveFrom < $locked->effective_from) {
                        throw BusinessRejection::forCode('hr.compensation_outside_contract', 'an entitlement cannot start before its contract');
                    }
                    if ($this->overlaps($locked->id, $kind, $effectiveFrom, null)) {
                        throw BusinessRejection::forCode('hr.compensation_overlap', 'this contract already has an active component of this kind covering that date');
                    }

                    $component = CompensationComponent::query()->create([
                        'id' => RandomIdentifier::new(),
                        'contract_id' => $locked->id,
                        'kind' => $kind,
                        'amount' => $amount,
                        'effective_from' => $effectiveFrom,
                        'lifecycle_state' => 'proposed',
                        'proposed_by' => $proposer->actorId,
                    ]);
                    $event = $this->audit->record($proposer->actorId, 'hr.compensation.propose', 'compensation_component', $component->id, null, ['contract_id' => $locked->id, 'kind' => $kind, 'amount' => $amount]);

                    return ['component_id' => $component->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $proposer, 'hr.compensation.propose', 'compensation_component', $contract->id);
        }
    }

    /** @return array{component_id: string, lifecycle_state: string, correlation_id: string} */
    public function activateCompensation(Actor $approver, CompensationComponent $component, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.compensation.activate', $component->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('hr.compensation.activate', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $component): array {
                    $this->require($approver, self::CAPABILITY_COMPENSATION_APPROVE);

                    /** @var CompensationComponent $locked */
                    $locked = CompensationComponent::query()->whereKey($component->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'proposed') {
                        throw BusinessRejection::forCode('hr.compensation_not_proposed', 'only a proposed component can be activated');
                    }
                    if (trim((string) $locked->proposed_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('hr.compensation_not_independent', 'the approver must differ from the proposer');
                    }
                    /** @var Contract $contract */
                    $contract = Contract::query()->findOrFail($locked->contract_id);
                    /** @var Employment $employment */
                    $employment = Employment::query()->findOrFail($contract->employment_id);
                    if (trim((string) $employment->person_id) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('hr.compensation_beneficiary', 'the beneficiary may never approve their own compensation');
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => 'active', 'approved_by' => $approver->actorId]);
                    $locked->save();
                    $event = $this->audit->record($approver->actorId, 'hr.compensation.activate', 'compensation_component', $locked->id, $before, ['lifecycle_state' => 'active']);

                    return ['component_id' => $locked->id, 'lifecycle_state' => 'active', 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'hr.compensation.activate', 'compensation_component', $component->id);
        }
    }

    private function overlaps(string $contractId, string $kind, string $from, ?string $to): bool
    {
        return CompensationComponent::query()
            ->where('contract_id', $contractId)
            ->where('kind', $kind)
            ->where('lifecycle_state', 'active')
            ->where(fn ($query) => $query
                ->whereNull('effective_to')
                ->orWhere('effective_to', '>', $from))
            ->where(fn ($query) => $to === null ? $query : $query->where('effective_from', '<=', $to))
            ->exists();
    }

    private function require(Actor $actor, string $capability): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('hr.contract_denied', $outcome->reason);
        }
    }
}
