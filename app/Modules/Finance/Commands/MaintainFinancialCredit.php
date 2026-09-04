<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Models\FinancialCredit;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Finance-owned student credit/advance. A credit is proposed with an
 * explicit source reference, approved by a distinct Finance actor against the
 * current uncovered obligation truth, and immutable once approved.
 */
final class MaintainFinancialCredit
{
    public const CAPABILITY_PROPOSE = 'finance.credit';

    public const CAPABILITY_APPROVE = 'finance.credit_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly AllocatePayment $allocations,
    ) {}

    /** @return array{credit_id: string, correlation_id: string} */
    public function propose(Actor $proposer, string $studentId, string $amount, string $reason, string $sourceRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.credit.propose', $studentId, $amount, $reason, $sourceRef, $proposer->actorId]));

        try {
            return $this->idempotency->execute('finance.credit.propose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($proposer, $studentId, $amount, $reason, $sourceRef): array {
                    $this->require($proposer, self::CAPABILITY_PROPOSE);
                    $this->validate($amount, $reason, $sourceRef, $studentId);
                    if (FinancialCredit::query()->where('source_ref', $sourceRef)->exists()) {
                        throw BusinessRejection::forCode('finance.credit_source_exists', 'this credit source reference already exists');
                    }

                    $credit = FinancialCredit::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $studentId,
                        'amount' => $amount,
                        'reason' => $reason,
                        'source_ref' => $sourceRef,
                        'lifecycle_state' => FinancialCredit::STATE_PROPOSED,
                        'requested_by' => $proposer->actorId,
                    ]);
                    $event = $this->audit->record($proposer->actorId, 'finance.credit.propose', 'financial_credit', $credit->id, null, [
                        'student_id' => $studentId, 'amount' => $amount, 'source_ref' => $sourceRef,
                    ]);

                    return ['credit_id' => $credit->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $proposer, 'finance.credit.propose', 'financial_credit', $sourceRef);
        }
    }

    /** @return array{credit_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, FinancialCredit $credit, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.credit.approve', $credit->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('finance.credit.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $credit): array {
                    $this->require($approver, self::CAPABILITY_APPROVE);

                    /** @var FinancialCredit $locked */
                    $locked = FinancialCredit::query()->whereKey($credit->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== FinancialCredit::STATE_PROPOSED) {
                        throw BusinessRejection::forCode('finance.credit_not_proposed', 'only a proposed credit can be approved');
                    }
                    if (trim((string) $locked->requested_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('finance.credit_not_independent', 'the approver must differ from the proposer');
                    }
                    $uncovered = $this->allocations->studentUncovered($locked->student_id);
                    if (bccomp((string) $locked->amount, $uncovered, 2) === 1) {
                        throw BusinessRejection::forCode('finance.credit_exceeds_uncovered', sprintf('the credit exceeds the current uncovered obligation remainder %s', $uncovered));
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => FinancialCredit::STATE_APPROVED, 'approved_by' => $approver->actorId, 'approved_at' => now()]);
                    $locked->save();
                    $event = $this->audit->record($approver->actorId, 'finance.credit.approve', 'financial_credit', $locked->id, $before, ['lifecycle_state' => FinancialCredit::STATE_APPROVED]);

                    return ['credit_id' => $locked->id, 'lifecycle_state' => FinancialCredit::STATE_APPROVED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'finance.credit.approve', 'financial_credit', $credit->id);
        }
    }

    private function validate(string $amount, string $reason, string $sourceRef, string $studentId): void
    {
        if ($reason === '' || $sourceRef === '') {
            throw BusinessRejection::forCode('finance.credit_terms', 'a credit requires its reason and source reference');
        }
        if (! is_numeric($amount) || (float) $amount <= 0) {
            throw BusinessRejection::forCode('finance.credit_amount', 'the credit amount must be a positive number');
        }
        if (Student::query()->whereKey($studentId)->doesntExist()) {
            throw BusinessRejection::forCode('finance.credit_student_unknown', 'a credit requires a known student');
        }
    }

    private function require(Actor $actor, string $capability): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.credit_denied', $outcome->reason);
        }
    }
}
