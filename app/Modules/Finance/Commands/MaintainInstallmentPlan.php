<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Academic\Models\Offering;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Models\EnrollmentInstallmentPlan;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Finance-approved alternative settlement: an installment plan for the
 * student's remaining obligation. Approved by a distinct Finance actor and
 * immutable afterwards; it is an explicitly authorized settlement, never
 * frontend state.
 */
final class MaintainInstallmentPlan
{
    public const CAPABILITY_PROPOSE = 'finance.installment';

    public const CAPABILITY_APPROVE = 'finance.installment_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly AllocatePayment $allocations,
    ) {}

    /** @return array{plan_id: string, correlation_id: string} */
    public function propose(Actor $proposer, string $studentId, ?string $offeringId, string $amount, int $installmentsCount, string $firstDueOn, string $scheduleRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.installment.propose', $studentId, (string) $offeringId, $amount, (string) $installmentsCount, $firstDueOn, $scheduleRef, $proposer->actorId]));

        try {
            return $this->idempotency->execute('finance.installment.propose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($proposer, $studentId, $offeringId, $amount, $installmentsCount, $firstDueOn, $scheduleRef): array {
                    $this->require($proposer, self::CAPABILITY_PROPOSE);
                    $this->validate($studentId, $offeringId, $amount, $installmentsCount, $firstDueOn, $scheduleRef);
                    if (EnrollmentInstallmentPlan::query()->where('schedule_ref', $scheduleRef)->exists()) {
                        throw BusinessRejection::forCode('finance.installment_schedule_exists', 'this installment schedule reference already exists');
                    }

                    $plan = EnrollmentInstallmentPlan::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $studentId,
                        'offering_id' => $offeringId !== null && $offeringId !== '' ? $offeringId : null,
                        'amount' => $amount,
                        'installments_count' => $installmentsCount,
                        'first_due_on' => $firstDueOn,
                        'schedule_ref' => $scheduleRef,
                        'lifecycle_state' => EnrollmentInstallmentPlan::STATE_PROPOSED,
                        'requested_by' => $proposer->actorId,
                    ]);
                    $event = $this->audit->record($proposer->actorId, 'finance.installment.propose', 'enrollment_installment_plan', $plan->id, null, [
                        'student_id' => $studentId, 'amount' => $amount, 'schedule_ref' => $scheduleRef,
                    ]);

                    return ['plan_id' => $plan->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $proposer, 'finance.installment.propose', 'enrollment_installment_plan', $scheduleRef);
        }
    }

    /** @return array{plan_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, EnrollmentInstallmentPlan $plan, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.installment.approve', $plan->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('finance.installment.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $plan): array {
                    $this->require($approver, self::CAPABILITY_APPROVE);

                    /** @var EnrollmentInstallmentPlan $locked */
                    $locked = EnrollmentInstallmentPlan::query()->whereKey($plan->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== EnrollmentInstallmentPlan::STATE_PROPOSED) {
                        throw BusinessRejection::forCode('finance.installment_not_proposed', 'only a proposed installment plan can be approved');
                    }
                    if (trim((string) $locked->requested_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('finance.installment_not_independent', 'the approver must differ from the proposer');
                    }
                    $uncovered = $this->allocations->studentUncovered($locked->student_id);
                    if (bccomp((string) $locked->amount, $uncovered, 2) === 1) {
                        throw BusinessRejection::forCode('finance.installment_exceeds_uncovered', sprintf('the installment plan exceeds the current uncovered obligation remainder %s', $uncovered));
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => EnrollmentInstallmentPlan::STATE_APPROVED, 'approved_by' => $approver->actorId, 'approved_at' => now()]);
                    $locked->save();
                    $event = $this->audit->record($approver->actorId, 'finance.installment.approve', 'enrollment_installment_plan', $locked->id, $before, ['lifecycle_state' => EnrollmentInstallmentPlan::STATE_APPROVED]);

                    return ['plan_id' => $locked->id, 'lifecycle_state' => EnrollmentInstallmentPlan::STATE_APPROVED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'finance.installment.approve', 'enrollment_installment_plan', $plan->id);
        }
    }

    private function validate(string $studentId, ?string $offeringId, string $amount, int $installmentsCount, string $firstDueOn, string $scheduleRef): void
    {
        if ($scheduleRef === '') {
            throw BusinessRejection::forCode('finance.installment_schedule_ref', 'an installment plan requires its schedule reference');
        }
        if (! is_numeric($amount) || (float) $amount <= 0) {
            throw BusinessRejection::forCode('finance.installment_amount', 'the installment plan amount must be a positive number');
        }
        if ($installmentsCount <= 0) {
            throw BusinessRejection::forCode('finance.installment_count', 'an installment plan requires at least one installment');
        }
        if (Student::query()->whereKey($studentId)->doesntExist()) {
            throw BusinessRejection::forCode('finance.installment_student_unknown', 'an installment plan requires a known student');
        }
        if ($offeringId !== null && $offeringId !== '' && Offering::query()->whereKey($offeringId)->doesntExist()) {
            throw BusinessRejection::forCode('finance.installment_offering_unknown', 'an installment plan offering must exist');
        }
    }

    private function require(Actor $actor, string $capability): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.installment_denied', $outcome->reason);
        }
    }
}
