<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Offering;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Models\FinancialGateException;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Finance-owned, approved gate exception. An approved exception carries an
 * explicit reason and effectiveness window and is scoped to a student (and,
 * when given, an offering/class). It is never a frontend bypass.
 */
final class MaintainFinancialGateException
{
    public const CAPABILITY_PROPOSE = 'finance.gate_exception';

    public const CAPABILITY_APPROVE = 'finance.gate_exception_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly AllocatePayment $allocations,
    ) {}

    /** @return array{exception_id: string, correlation_id: string} */
    public function propose(Actor $proposer, string $studentId, ?string $offeringId, ?string $classId, string $amount, string $reason, string $effectiveFrom, ?string $effectiveTo, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.gate_exception.propose', $studentId, (string) $offeringId, (string) $classId, $amount, $reason, $effectiveFrom, (string) $effectiveTo, $proposer->actorId]));

        try {
            return $this->idempotency->execute('finance.gate_exception.propose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($proposer, $studentId, $offeringId, $classId, $amount, $reason, $effectiveFrom, $effectiveTo): array {
                    $this->require($proposer, self::CAPABILITY_PROPOSE);
                    $this->validate($studentId, $offeringId, $classId, $amount, $reason, $effectiveFrom, $effectiveTo);

                    $exception = FinancialGateException::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $studentId,
                        'offering_id' => $offeringId !== null && $offeringId !== '' ? $offeringId : null,
                        'class_id' => $classId !== null && $classId !== '' ? $classId : null,
                        'amount' => $amount,
                        'reason' => $reason,
                        'effective_from' => $effectiveFrom,
                        'effective_to' => $effectiveTo !== null && $effectiveTo !== '' ? $effectiveTo : null,
                        'lifecycle_state' => FinancialGateException::STATE_PROPOSED,
                        'requested_by' => $proposer->actorId,
                    ]);
                    $event = $this->audit->record($proposer->actorId, 'finance.gate_exception.propose', 'financial_gate_exception', $exception->id, null, [
                        'student_id' => $studentId, 'amount' => $amount, 'reason' => $reason,
                    ]);

                    return ['exception_id' => $exception->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $proposer, 'finance.gate_exception.propose', 'financial_gate_exception', $reason);
        }
    }

    /** @return array{exception_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, FinancialGateException $exception, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.gate_exception.approve', $exception->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('finance.gate_exception.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $exception): array {
                    $this->require($approver, self::CAPABILITY_APPROVE);

                    /** @var FinancialGateException $locked */
                    $locked = FinancialGateException::query()->whereKey($exception->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== FinancialGateException::STATE_PROPOSED) {
                        throw BusinessRejection::forCode('finance.gate_exception_not_proposed', 'only a proposed gate exception can be approved');
                    }
                    if (trim((string) $locked->requested_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('finance.gate_exception_not_independent', 'the approver must differ from the proposer');
                    }
                    $uncovered = $this->allocations->studentUncovered($locked->student_id);
                    if (bccomp((string) $locked->amount, $uncovered, 2) === 1) {
                        throw BusinessRejection::forCode('finance.gate_exception_exceeds_uncovered', sprintf('the gate exception exceeds the current uncovered obligation remainder %s', $uncovered));
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => FinancialGateException::STATE_APPROVED, 'approved_by' => $approver->actorId, 'approved_at' => now()]);
                    $locked->save();
                    $event = $this->audit->record($approver->actorId, 'finance.gate_exception.approve', 'financial_gate_exception', $locked->id, $before, ['lifecycle_state' => FinancialGateException::STATE_APPROVED]);

                    return ['exception_id' => $locked->id, 'lifecycle_state' => FinancialGateException::STATE_APPROVED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'finance.gate_exception.approve', 'financial_gate_exception', $exception->id);
        }
    }

    private function validate(string $studentId, ?string $offeringId, ?string $classId, string $amount, string $reason, string $effectiveFrom, ?string $effectiveTo): void
    {
        if ($reason === '') {
            throw BusinessRejection::forCode('finance.gate_exception_reason', 'a gate exception requires its explicit reason');
        }
        if (! is_numeric($amount) || (float) $amount <= 0) {
            throw BusinessRejection::forCode('finance.gate_exception_amount', 'the gate exception amount must be a positive number');
        }
        if ($effectiveTo !== null && $effectiveTo !== '' && $effectiveTo < $effectiveFrom) {
            throw BusinessRejection::forCode('finance.gate_exception_window', 'the gate exception effective window is inverted');
        }
        if (Student::query()->whereKey($studentId)->doesntExist()) {
            throw BusinessRejection::forCode('finance.gate_exception_student_unknown', 'a gate exception requires a known student');
        }
        if ($offeringId !== null && $offeringId !== '' && Offering::query()->whereKey($offeringId)->doesntExist()) {
            throw BusinessRejection::forCode('finance.gate_exception_offering_unknown', 'a gate exception offering must exist');
        }
        if ($classId !== null && $classId !== '' && ClassModel::query()->whereKey($classId)->doesntExist()) {
            throw BusinessRejection::forCode('finance.gate_exception_class_unknown', 'a gate exception class must exist');
        }
    }

    private function require(Actor $actor, string $capability): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.gate_exception_denied', $outcome->reason);
        }
    }
}
