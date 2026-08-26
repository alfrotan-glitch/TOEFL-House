<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Models\Discount;
use App\Modules\Finance\Models\FundAllocation;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\ObligationLine;
use App\Modules\Finance\Models\Payment;
use App\Modules\Finance\Models\PaymentAllocation;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
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
    ) {}

    /** @return array{allocation_id: string, correlation_id: string} */
    public function allocate(Actor $actor, Payment $payment, Obligation $obligation, string $amount, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.payment.allocate', $payment->id, $obligation->id, $amount, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.payment.allocate', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $payment, $obligation, $amount): array {
                    $this->require($actor);
                    if (! is_numeric($amount) || (float) $amount <= 0) {
                        throw BusinessRejection::forCode('finance.allocation_amount', 'the allocation amount must be a positive number');
                    }
                    if (trim((string) $payment->student_id) !== trim((string) $obligation->student_id)) {
                        throw BusinessRejection::forCode('finance.allocation_payer_mismatch', 'the payment and the obligation belong to different students');
                    }

                    /** @var Payment $lockedPayment */
                    $lockedPayment = Payment::query()->whereKey($payment->id)->lockForUpdate()->firstOrFail();
                    /** @var Obligation $lockedObligation */
                    $lockedObligation = Obligation::query()->whereKey($obligation->id)->lockForUpdate()->firstOrFail();

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
                        'payment_id' => $lockedPayment->id, 'obligation_id' => $lockedObligation->id, 'amount' => $amount,
                    ]);

                    return ['allocation_id' => $allocation->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.payment.allocate', 'payment_allocation', $payment->id);
        }
    }

    public function paymentRemaining(Payment $payment): string
    {
        $allocated = PaymentAllocation::query()->where('payment_id', $payment->id)->sum('amount');

        return bcsub((string) $payment->amount, (string) $allocated, 2);
    }

    public function obligationRemaining(Obligation $obligation): string
    {
        $lineIds = ObligationLine::query()->where('obligation_id', $obligation->id)->pluck('id');
        $funded = FundAllocation::query()->whereIn('obligation_line_id', $lineIds)->sum('amount');
        $allocated = PaymentAllocation::query()->where('obligation_id', $obligation->id)->sum('amount');
        $discounted = Discount::query()->where('obligation_id', $obligation->id)->where('lifecycle_state', 'approved')->sum('amount');

        return bcsub(bcsub(bcsub((string) $obligation->original_amount, (string) $funded, 2), (string) $allocated, 2), (string) $discounted, 2);
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.payment_denied', $outcome->reason);
        }
    }
}
