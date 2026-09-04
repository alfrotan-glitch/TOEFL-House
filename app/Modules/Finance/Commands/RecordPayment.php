<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Domain\CrmInteractionTraceRecorder;
use App\Modules\Finance\Domain\FinanceLifecycle;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Payment;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Payments: money received from an external source is recorded once (the
 * external receipt reference is unique — a payment posts only once), only
 * into an open financial period, and is immutable from then on.
 */
final class RecordPayment
{
    public const CAPABILITY = 'finance.payment';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly CrmInteractionTraceRecorder $crmTrace,
    ) {}

    /** @return array{payment_id: string, correlation_id: string} */
    public function record(Actor $actor, FinancialPeriod $period, string $studentId, string $amount, string $method, string $payerRef, string $receivedOn, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.payment.record', $period->id, $studentId, $amount, $method, $payerRef, $receivedOn, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.payment.record', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $period, $studentId, $amount, $method, $payerRef, $receivedOn): array {
                    $this->require($actor);
                    if ($payerRef === '') {
                        throw BusinessRejection::forCode('finance.payment_payer_ref', 'a payment requires its external receipt reference');
                    }
                    if (! is_numeric($amount) || (float) $amount <= 0) {
                        throw BusinessRejection::forCode('finance.payment_amount', 'the payment amount must be a positive number');
                    }

                    /** @var FinancialPeriod $lockedPeriod */
                    $lockedPeriod = FinancialPeriod::query()->whereKey($period->id)->lockForUpdate()->firstOrFail();
                    if ($lockedPeriod->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN) {
                        throw BusinessRejection::forCode('finance.period_not_open', 'payments record only into an open financial period');
                    }
                    if (Payment::query()->where('payer_ref', $payerRef)->exists()) {
                        throw BusinessRejection::forCode('finance.payment_duplicate', 'this external receipt reference has already been posted');
                    }

                    $payment = Payment::query()->create([
                        'id' => RandomIdentifier::new(),
                        'period_id' => $lockedPeriod->id,
                        'student_id' => $studentId,
                        'amount' => $amount,
                        'method' => $method,
                        'payer_ref' => $payerRef,
                        'received_on' => $receivedOn,
                        'recorded_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'finance.payment.record', 'payment', $payment->id, null, [
                        'student_id' => $studentId, 'amount' => $amount, 'payer_ref' => $payerRef,
                    ]);
                    $this->traceVisitor($actor, $studentId, $payment->id, $payerRef, $receivedOn);

                    return ['payment_id' => $payment->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.payment.record', 'payment', $payerRef);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.payment_denied', $outcome->reason);
        }
    }

    private function traceVisitor(Actor $actor, string $studentId, string $paymentId, string $payerRef, string $receivedOn): void
    {
        $visitorId = $this->crmTrace->visitorIdForStudent($studentId);
        if ($visitorId === null) {
            return;
        }
        $this->crmTrace->record(
            $actor,
            $visitorId,
            'outbound',
            'payment',
            'positive',
            sprintf('Payment %s received for the student linked to this lead.', $payerRef),
            CarbonImmutable::parse($receivedOn),
            paymentId: $paymentId,
        );
    }
}
