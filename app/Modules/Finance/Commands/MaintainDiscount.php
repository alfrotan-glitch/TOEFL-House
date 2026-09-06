<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\FinanceLifecycle;
use App\Modules\Finance\Domain\FinancialCoverageLock;
use App\Modules\Finance\Domain\PaymentLifecycle;
use App\Modules\Finance\Models\Discount;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use App\Support\MoneyAmount;
use Illuminate\Support\Facades\DB;

/**
 * Discounts (BR-FIN-003): proposed with published or separately approved
 * eligibility and effective dates, approved by a distinct actor, recorded
 * with audit; the original charge is never rewritten and an approved
 * discount is immutable history.
 */
final class MaintainDiscount
{
    public const CAPABILITY_PROPOSE = 'finance.discount';

    public const CAPABILITY_APPROVE = 'finance.discount_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly AllocatePayment $allocations,
    ) {}

    /** @return array{discount_id: string, correlation_id: string} */
    public function propose(Actor $proposer, Obligation $obligation, FinancialPeriod $period, string $amount, string $eligibility, string $effectiveFrom, ?string $effectiveTo, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.discount.propose', $obligation->id, $period->id, $amount, $eligibility, $effectiveFrom, (string) $effectiveTo, $reason, $proposer->actorId]));

        try {
            return $this->idempotency->execute('finance.discount.propose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($proposer, $obligation, $period, $amount, $eligibility, $effectiveFrom, $effectiveTo, $reason): array {
                    $this->validate($amount, $eligibility, $effectiveFrom, $effectiveTo, $reason);

                    /** @var Obligation $lockedObligation */
                    $lockedObligation = Obligation::query()->whereKey($obligation->id)->lockForUpdate()->firstOrFail();

                    $branch = $this->branchForObligation($lockedObligation);
                    if ($branch === null) {
                        throw BusinessRejection::forCode('finance.discount_provenance_required', 'a discount requires known obligation branch provenance');
                    }
                    $this->require($proposer, self::CAPABILITY_PROPOSE, $branch->structureScope());

                    /** @var FinancialPeriod $lockedPeriod */
                    $lockedPeriod = FinancialPeriod::query()->whereKey($period->id)->lockForUpdate()->firstOrFail();
                    if ($lockedPeriod->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN) {
                        throw BusinessRejection::forCode('finance.period_not_open', 'discounts attach only to an open financial period');
                    }
                    if (trim((string) $lockedObligation->period_id) !== trim((string) $lockedPeriod->id)) {
                        throw BusinessRejection::forCode('finance.discount_period_mismatch', 'a discount must be recorded in the obligation financial period');
                    }

                    $discount = Discount::query()->create([
                        'id' => RandomIdentifier::new(),
                        'obligation_id' => $lockedObligation->id,
                        'period_id' => $lockedPeriod->id,
                        'amount' => $amount,
                        'eligibility' => $eligibility,
                        'effective_from' => $effectiveFrom,
                        'effective_to' => $effectiveTo,
                        'reason' => $reason,
                        'lifecycle_state' => PaymentLifecycle::DISCOUNT_PROPOSED,
                        'proposed_by' => $proposer->actorId,
                    ]);
                    $event = $this->audit->record($proposer->actorId, 'finance.discount.propose', 'discount', $discount->id, null, [
                        'obligation_id' => $lockedObligation->id, 'branch_id' => $branch->id, 'organization_id' => $branch->structureScope()->organizationId, 'amount' => $amount, 'eligibility' => $eligibility,
                    ]);

                    return ['discount_id' => $discount->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $proposer, 'finance.discount.propose', 'discount', $obligation->id);
        }
    }

    /** @return array{discount_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, Discount $discount, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.discount.approve', $discount->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('finance.discount.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $discount): array {
                    $studentId = (string) Obligation::query()->whereKey($discount->obligation_id)->value('student_id');
                    FinancialCoverageLock::acquire($studentId);

                    /** @var Discount $locked */
                    $locked = Discount::query()->whereKey($discount->id)->lockForUpdate()->firstOrFail();
                    PaymentLifecycle::requireDiscountTransition($locked->lifecycle_state, PaymentLifecycle::DISCOUNT_APPROVED);
                    if (trim((string) $locked->proposed_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('finance.discount_not_independent', 'the approver must differ from the proposer');
                    }

                    /** @var Obligation $obligation */
                    $obligation = Obligation::query()->whereKey($locked->obligation_id)->lockForUpdate()->firstOrFail();
                    if (trim((string) $obligation->student_id) !== trim($studentId)) {
                        throw BusinessRejection::forCode('finance.discount_student_mismatch', 'the discount obligation student changed while the coverage lock was acquired');
                    }
                    $period = FinancialPeriod::query()->whereKey($locked->period_id)->lockForUpdate()->firstOrFail();
                    if ($period->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN || trim((string) $period->id) !== trim((string) $obligation->period_id)) {
                        throw BusinessRejection::forCode('finance.discount_period_mismatch', 'a discount can be approved only in its open obligation financial period');
                    }
                    $branch = $this->branchForObligation($obligation);
                    if ($branch === null) {
                        throw BusinessRejection::forCode('finance.discount_provenance_required', 'a discount requires known obligation branch provenance');
                    }
                    $this->require($approver, self::CAPABILITY_APPROVE, $branch->structureScope());
                    $remaining = $this->allocations->obligationRemaining($obligation);
                    if (bccomp($locked->amount, $remaining, 2) === 1) {
                        throw BusinessRejection::forCode('finance.discount_exceeds_obligation', sprintf('the discount exceeds the uncovered obligation remainder %s', $remaining));
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => PaymentLifecycle::DISCOUNT_APPROVED, 'approved_by' => $approver->actorId]);
                    $locked->save();
                    $event = $this->audit->record($approver->actorId, 'finance.discount.approve', 'discount', $locked->id, $before, ['lifecycle_state' => PaymentLifecycle::DISCOUNT_APPROVED, 'branch_id' => $branch->id, 'organization_id' => $branch->structureScope()->organizationId]);

                    return ['discount_id' => $locked->id, 'lifecycle_state' => PaymentLifecycle::DISCOUNT_APPROVED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'finance.discount.approve', 'discount', $discount->id);
        }
    }

    private function validate(string $amount, string $eligibility, string $effectiveFrom, ?string $effectiveTo, string $reason): void
    {
        if ($eligibility === '' || $reason === '') {
            throw BusinessRejection::forCode('finance.discount_terms', 'a discount requires its eligibility basis and reason');
        }
        if (! MoneyAmount::positive($amount)) {
            throw BusinessRejection::forCode('finance.discount_amount', 'the discount amount must be a positive number');
        }
        if ($effectiveTo !== null && $effectiveTo < $effectiveFrom) {
            throw BusinessRejection::forCode('finance.discount_window', 'the discount effective window is inverted');
        }
    }

    private function branchForObligation(Obligation $obligation): ?Branch
    {
        $branchId = trim((string) ($obligation->current_home_branch_id ?? $obligation->originating_branch_id ?? ''));

        return $branchId === '' ? null : Branch::query()->whereKey($branchId)->first();
    }

    private function require(Actor $actor, string $capability, \App\Support\Authorization\StructureScope $scope): void
    {
        $outcome = $this->access->decide($actor, $capability, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.discount_denied', $outcome->reason);
        }
    }
}
