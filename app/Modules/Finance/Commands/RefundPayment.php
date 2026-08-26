<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\FinanceLifecycle;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Payment;
use App\Modules\Finance\Models\PaymentAllocation;
use App\Modules\Finance\Models\Refund;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Refunds (BR-FIN-002): documented conditions (mandatory reason), the
 * immutable source payment, a requester and a distinct approver, Finance
 * recording — and never more than the refundable remainder (unallocated
 * and unrefunded) of the source payment.
 */
final class RefundPayment
{
    public const CAPABILITY_REQUEST = 'finance.refund';

    public const CAPABILITY_APPROVE = 'finance.refund_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{refund_id: string, correlation_id: string} */
    public function refund(Actor $requester, Actor $approver, Payment $payment, FinancialPeriod $period, string $amount, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.refund', $payment->id, $period->id, $amount, $reason, $requester->actorId, $approver->actorId]));

        try {
            return $this->idempotency->execute('finance.refund', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($requester, $approver, $payment, $period, $amount, $reason): array {
                    $this->require($requester, self::CAPABILITY_REQUEST);
                    $this->require($approver, self::CAPABILITY_APPROVE);
                    if ($reason === '') {
                        throw BusinessRejection::forCode('finance.refund_reason', 'a refund requires its documented conditions');
                    }
                    if ($requester->actorId === $approver->actorId) {
                        throw AuthorizationDenied::forCode('finance.refund_not_independent', 'the refund requester and approver must differ');
                    }
                    if (! is_numeric($amount) || (float) $amount <= 0) {
                        throw BusinessRejection::forCode('finance.refund_amount', 'the refund amount must be a positive number');
                    }

                    /** @var FinancialPeriod $lockedPeriod */
                    $lockedPeriod = FinancialPeriod::query()->whereKey($period->id)->lockForUpdate()->firstOrFail();
                    if ($lockedPeriod->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN) {
                        throw BusinessRejection::forCode('finance.period_not_open', 'refunds record only into an open financial period');
                    }

                    /** @var Payment $lockedPayment */
                    $lockedPayment = Payment::query()->whereKey($payment->id)->lockForUpdate()->firstOrFail();
                    $allocated = PaymentAllocation::query()->where('payment_id', $lockedPayment->id)->sum('amount');
                    $refunded = Refund::query()->where('payment_id', $lockedPayment->id)->sum('amount');
                    $refundable = bcsub(bcsub((string) $lockedPayment->amount, (string) $allocated, 2), (string) $refunded, 2);
                    if (bccomp($amount, $refundable, 2) === 1) {
                        throw BusinessRejection::forCode('finance.refund_exceeds_source', sprintf('the refund exceeds the refundable remainder %s', $refundable));
                    }

                    $refund = Refund::query()->create([
                        'id' => RandomIdentifier::new(),
                        'payment_id' => $lockedPayment->id,
                        'period_id' => $lockedPeriod->id,
                        'amount' => $amount,
                        'reason' => $reason,
                        'requested_by' => $requester->actorId,
                        'approved_by' => $approver->actorId,
                    ]);
                    $event = $this->audit->record($approver->actorId, 'finance.refund', 'refund', $refund->id, null, [
                        'payment_id' => $lockedPayment->id, 'amount' => $amount,
                    ]);

                    return ['refund_id' => $refund->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $requester, 'finance.refund', 'refund', $payment->id);
        }
    }

    private function require(Actor $actor, string $capability): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.refund_denied', $outcome->reason);
        }
    }
}
