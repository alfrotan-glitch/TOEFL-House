<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Models\Discount;
use App\Modules\Finance\Models\FundAllocation;
use App\Modules\Finance\Models\FinancialCorrection;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\ObligationLine;
use App\Modules\Finance\Models\Payment;
use App\Modules\Finance\Domain\FinancialCoverageLock;
use App\Modules\Finance\Models\PaymentAllocation;
use App\Modules\Finance\Queries\FinancialBalanceQuery;
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
 * Payment allocation: one allocation links exactly one payment to one
 * obligation (unique pair — a payment cannot be allocated twice to the
 * same obligation), can exceed neither the payment's unallocated remainder
 * nor the obligation's uncovered remainder, and commits under row locks on
 * both sources (per-source serialized commit).
 */
final class AllocatePayment
{
    public const CAPABILITY = 'finance.payment';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly ?FinancialBalanceQuery $balances = null,
    ) {}

    /** @return array{allocation_id: string, correlation_id: string} */
    public function allocate(Actor $actor, Payment $payment, Obligation $obligation, string $amount, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.payment.allocate', $payment->id, $obligation->id, $amount, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.payment.allocate', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $payment, $obligation, $amount): array {
                    if (! MoneyAmount::positive($amount)) {
                        throw BusinessRejection::forCode('finance.allocation_amount', 'the allocation amount must be a positive number');
                    }
                    if (trim((string) $payment->student_id) !== trim((string) $obligation->student_id)) {
                        throw BusinessRejection::forCode('finance.allocation_payer_mismatch', 'the payment and the obligation belong to different students');
                    }
                    $studentId = (string) Obligation::query()->whereKey($obligation->id)->value('student_id');
                    FinancialCoverageLock::acquire($studentId);

                    /** @var Payment $lockedPayment */
                    $lockedPayment = Payment::query()->whereKey($payment->id)->lockForUpdate()->firstOrFail();
                    /** @var Obligation $lockedObligation */
                    $lockedObligation = Obligation::query()->whereKey($obligation->id)->lockForUpdate()->firstOrFail();
                    if (trim((string) $lockedPayment->student_id) !== trim((string) $lockedObligation->student_id)
                        || trim((string) $lockedObligation->student_id) !== trim($studentId)) {
                        throw BusinessRejection::forCode('finance.allocation_payer_mismatch', 'the payment and the obligation belong to different students');
                    }

                    $paymentBranchId = trim((string) ($lockedPayment->current_home_branch_id ?? $lockedPayment->originating_branch_id ?? ''));
                    $obligationBranchId = trim((string) ($lockedObligation->current_home_branch_id ?? $lockedObligation->originating_branch_id ?? ''));

                    /** @var array<string, \App\Support\Authorization\StructureScope> $scopes */
                    $scopes = [];
                    foreach (array_values(array_unique([$paymentBranchId, $obligationBranchId])) as $branchId) {
                        $branch = $branchId === '' ? null : Branch::query()->whereKey($branchId)->first();
                        if ($branch === null || $branch->lifecycle_state !== 'active') {
                            throw BusinessRejection::forCode('finance.allocation_provenance_required', 'payment allocation requires known active source branch provenance');
                        }
                        $scopes[$branchId] = $branch->structureScope();
                        $this->require($actor, $scopes[$branchId]);
                    }

                    // A payment must settle an obligation inside the same active
                    // organization. Money received in one organization can never
                    // satisfy debt in another, even for an actor who happens to
                    // govern both — matching the funding-source isolation rule.
                    $organizationIds = [];
                    foreach ($scopes as $scope) {
                        $organizationId = trim((string) $scope->organizationId);
                        if ($organizationId === '') {
                            throw BusinessRejection::forCode('finance.allocation_provenance_required', 'payment allocation requires active organization provenance');
                        }
                        $organizationIds[] = $organizationId;
                    }
                    $organizationIds = array_values(array_unique($organizationIds));
                    if (count($organizationIds) > 1) {
                        throw BusinessRejection::forCode('finance.allocation_organization_mismatch', 'a payment must satisfy an obligation inside the same active organization');
                    }
                    $allocationOrganizationId = $organizationIds[0] ?? '';

                    $allocationProvenance = ['branch_id' => null, 'organization_id' => $allocationOrganizationId];
                    if (count($scopes) === 1) {
                        $allocationProvenance = [
                            'branch_id' => $paymentBranchId !== '' ? $paymentBranchId : $obligationBranchId,
                            'organization_id' => $allocationOrganizationId,
                        ];
                    }

                    if (PaymentAllocation::query()->where('payment_id', $lockedPayment->id)->where('obligation_id', $lockedObligation->id)->exists()) {
                        throw BusinessRejection::forCode('finance.allocation_pair_exists', 'this payment is already allocated to this obligation');
                    }

                    $paymentRemaining = $this->paymentRemaining($lockedPayment);
                    if (bccomp($amount, $paymentRemaining, 2) === 1) {
                        throw BusinessRejection::forCode('finance.allocation_exceeds_payment', sprintf('the allocation exceeds the unallocated payment remainder %s', $paymentRemaining));
                    }

                    $obligationRemaining = $this->obligationRemaining($lockedObligation);
                    if (bccomp($amount, $obligationRemaining, 2) === 1) {
                        throw BusinessRejection::forCode('finance.allocation_exceeds_obligation', sprintf('the allocation exceeds the uncovered obligation remainder %s', $obligationRemaining));
                    }

                    $allocation = PaymentAllocation::query()->create([
                        'id' => RandomIdentifier::new(),
                        'payment_id' => $lockedPayment->id,
                        'obligation_id' => $lockedObligation->id,
                        'amount' => $amount,
                        'allocated_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'finance.payment.allocate', 'payment_allocation', $allocation->id, null, [
                        'payment_id' => $lockedPayment->id, 'obligation_id' => $lockedObligation->id,
                        ...$allocationProvenance,
                        'amount' => $amount,
                    ]);

                    return ['allocation_id' => $allocation->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.payment.allocate', 'payment_allocation', $payment->id);
        }
    }

    /** @return numeric-string */
    public function paymentRemaining(Payment $payment): string
    {
        return ($this->balances ?? new FinancialBalanceQuery())->paymentRemaining($payment);
    }

    /** @return numeric-string */
    public function obligationRemaining(Obligation $obligation): string
    {
        return ($this->balances ?? new FinancialBalanceQuery())->obligationRemaining($obligation);
    }

    /** @return numeric-string */
    public function studentUncovered(string $studentId): string
    {
        return ($this->balances ?? new FinancialBalanceQuery())->studentUncovered($studentId);
    }

    private function require(Actor $actor, \App\Support\Authorization\StructureScope $scope): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.payment_denied', $outcome->reason);
        }
    }
}
