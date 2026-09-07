<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\FinanceLifecycle;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Payment;
use App\Modules\Finance\Queries\FinancialBalanceQuery;
use App\Modules\Finance\Models\Refund;
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
 * Refunds (BR-FIN-002), staged like discounts and contract versions:
 *
 *   - a REQUESTER (finance.refund) proposes a refund against an open
 *     period within the refundable remainder — the refund is born
 *     'proposed';
 *   - a distinct APPROVER (finance.refund_approve) records it in their
 *     own session — the only path by which money actually moves back.
 *     The approval re-checks the remainder under the payment lock.
 *
 * Each signature is captured from an authenticated session's actor; a
 * transport may never supply another person's identity.
 */
final class RefundPayment
{
    public const CAPABILITY_REQUEST = 'finance.refund';

    public const CAPABILITY_APPROVE = 'finance.refund_approve';

    public const STATE_PROPOSED = 'proposed';

    public const STATE_RECORDED = 'recorded';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly FinancialBalanceQuery $balances,
        private readonly LedgerPoster $ledger,
    ) {}

    /** @return array{refund_id: string, correlation_id: string} */
    public function propose(Actor $requester, Payment $payment, FinancialPeriod $period, string $amount, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.refund.propose', $payment->id, $period->id, $amount, $reason, $requester->actorId]));

        try {
            return $this->idempotency->execute('finance.refund.propose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($requester, $payment, $period, $amount, $reason): array {
                    if ($reason === '') {
                        throw BusinessRejection::forCode('finance.refund_reason', 'a refund requires its documented conditions');
                    }
                    if (! MoneyAmount::positive($amount)) {
                        throw BusinessRejection::forCode('finance.refund_amount', 'the refund amount must be a positive number');
                    }

                    /** @var FinancialPeriod $lockedPeriod */
                    $lockedPeriod = FinancialPeriod::query()->whereKey($period->id)->lockForUpdate()->firstOrFail();
                    if ($lockedPeriod->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN) {
                        throw BusinessRejection::forCode('finance.period_not_open', 'refunds record only into an open financial period');
                    }

                    /** @var Payment $lockedPayment */
                    $lockedPayment = Payment::query()->whereKey($payment->id)->lockForUpdate()->firstOrFail();
                    if (trim((string) $lockedPayment->period_id) !== trim((string) $lockedPeriod->id)) {
                        throw BusinessRejection::forCode('finance.refund_period_mismatch', 'a refund must remain in the payment financial period');
                    }
                    $branchId = trim((string) ($lockedPayment->current_home_branch_id ?? $lockedPayment->originating_branch_id ?? ''));
                    $branch = $branchId === '' ? null : Branch::query()->whereKey($branchId)->first();
                    if ($branch === null) {
                        throw BusinessRejection::forCode('finance.refund_provenance_required', 'a refund requires known payment branch provenance');
                    }
                    $this->require($requester, self::CAPABILITY_REQUEST, $branch->structureScope());
                    $this->assertWithinRefundableRemainder($lockedPayment, $amount);

                    $refund = Refund::query()->create([
                        'id' => RandomIdentifier::new(),
                        'payment_id' => $lockedPayment->id,
                        'period_id' => $lockedPeriod->id,
                        'amount' => $amount,
                        'reason' => $reason,
                        'requested_by' => $requester->actorId,
                        'lifecycle_state' => self::STATE_PROPOSED,
                        'originating_branch_id' => $lockedPayment->originating_branch_id,
                        'current_home_branch_id' => $lockedPayment->current_home_branch_id,
                    ]);
                    $event = $this->audit->record($requester->actorId, 'finance.refund.propose', 'refund', $refund->id, null, [
                        'payment_id' => $lockedPayment->id, 'branch_id' => $branch->id, 'organization_id' => $branch->structureScope()->organizationId, 'amount' => $amount,
                    ]);

                    return ['refund_id' => $refund->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $requester, 'finance.refund.propose', 'refund', $payment->id);
        }
    }

    /** @return array{refund_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, Refund $refund, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.refund.approve', $refund->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('finance.refund.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $refund): array {
                    /** @var Refund $locked */
                    $locked = Refund::query()->whereKey($refund->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== self::STATE_PROPOSED) {
                        throw BusinessRejection::forCode('finance.refund_not_proposed', sprintf('only a proposed refund can be approved (state: %s)', $locked->lifecycle_state));
                    }
                    // char(N) columns come back space-padded — compare trimmed.
                    if (trim((string) $locked->requested_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('finance.refund_not_independent', 'the refund requester and approver must differ');
                    }

                    /** @var FinancialPeriod $lockedPeriod */
                    $lockedPeriod = FinancialPeriod::query()->whereKey($locked->period_id)->lockForUpdate()->firstOrFail();
                    if ($lockedPeriod->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN) {
                        throw BusinessRejection::forCode('finance.period_not_open', 'refunds record only into an open financial period');
                    }

                    /** @var Payment $lockedPayment */
                    $lockedPayment = Payment::query()->whereKey($locked->payment_id)->lockForUpdate()->firstOrFail();
                    if (trim((string) $lockedPayment->period_id) !== trim((string) $lockedPeriod->id)) {
                        throw BusinessRejection::forCode('finance.refund_period_mismatch', 'a refund must remain in the payment financial period');
                    }
                    $branchId = trim((string) ($lockedPayment->current_home_branch_id ?? $lockedPayment->originating_branch_id ?? ''));
                    $branch = $branchId === '' ? null : Branch::query()->whereKey($branchId)->first();
                    if ($branch === null) {
                        throw BusinessRejection::forCode('finance.refund_provenance_required', 'a refund requires known payment branch provenance');
                    }
                    $this->require($approver, self::CAPABILITY_APPROVE, $branch->structureScope());
                    $this->assertWithinRefundableRemainder($lockedPayment, (string) $locked->amount);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => self::STATE_RECORDED, 'approved_by' => $approver->actorId]);
                    $locked->save();
                    $event = $this->audit->record($approver->actorId, 'finance.refund.approve', 'refund', $locked->id, $before, [
                        'lifecycle_state' => self::STATE_RECORDED,
                        'branch_id' => $branch->id,
                        'organization_id' => $branch->structureScope()->organizationId,
                    ]);
                    $ledger = $this->ledger->post($approver, 'refund', $locked->id);

                    return ['refund_id' => $locked->id, 'lifecycle_state' => self::STATE_RECORDED, 'correlation_id' => $event->correlation_id, 'journal_id' => $ledger['journal_id'], 'debit_account_id' => $ledger['debit_account_id'], 'credit_account_id' => $ledger['credit_account_id']];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'finance.refund.approve', 'refund', $refund->id);
        }
    }

    private function assertWithinRefundableRemainder(Payment $payment, string $amount): void
    {
        $refundable = $this->balances->paymentRemaining($payment);
        if (bccomp(MoneyAmount::decimal($amount), $refundable, 2) === 1) {
            throw BusinessRejection::forCode('finance.refund_exceeds_source', sprintf('the refund exceeds the refundable remainder %s', $refundable));
        }
    }

    private function require(Actor $actor, string $capability, \App\Support\Authorization\StructureScope $scope): void
    {
        $outcome = $this->access->decide($actor, $capability, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.refund_denied', $outcome->reason);
        }
    }
}
