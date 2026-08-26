<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Models\Employment;
use App\Modules\Payroll\Domain\PayrollLifecycle;
use App\Modules\Payroll\Models\PayrollAdjustment;
use App\Modules\Payroll\Models\PayrollCalculation;
use App\Modules\Payroll\Models\PayrollPeriod;
use App\Modules\Payroll\Models\PayrollResult;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Approved payable results and their corrections: approval is segregated
 * from preparation and from the beneficiary; corrections and reversals
 * append adjustments to the immutable result and are impossible once the
 * period is closed.
 */
final class ApprovePayrollResult
{
    public const CAPABILITY_APPROVE = 'payroll.approve';

    public const CAPABILITY_ADJUST = 'payroll.adjust';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{result_id: string, correlation_id: string} */
    public function approve(Actor $approver, PayrollCalculation $calculation, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['payroll.result.approve', $calculation->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('payroll.result.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $calculation): array {
                    $this->require($approver, self::CAPABILITY_APPROVE);

                    /** @var PayrollCalculation $locked */
                    $locked = PayrollCalculation::query()->whereKey($calculation->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== PayrollLifecycle::CALC_PREPARED) {
                        throw BusinessRejection::forCode('payroll.calculation_not_prepared', 'only a prepared calculation can be approved');
                    }
                    if (trim((string) $locked->prepared_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('payroll.approval_not_independent', 'the approver must differ from the preparer');
                    }
                    /** @var Employment $employment */
                    $employment = Employment::query()->findOrFail($locked->employment_id);
                    if (trim((string) $employment->person_id) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('payroll.beneficiary', 'the beneficiary may never approve their own payroll');
                    }

                    $result = PayrollResult::query()->create([
                        'id' => RandomIdentifier::new(),
                        'calculation_id' => $locked->id,
                        'period_id' => $locked->period_id,
                        'employment_id' => $locked->employment_id,
                        'amount' => $locked->base_amount,
                        'lifecycle_state' => 'approved',
                        'approved_by' => $approver->actorId,
                    ]);
                    $locked->forceFill(['lifecycle_state' => PayrollLifecycle::CALC_RESULTED]);
                    $locked->save();
                    $event = $this->audit->record($approver->actorId, 'payroll.result.approve', 'payroll_result', $result->id, null, [
                        'calculation_id' => $locked->id, 'amount' => $result->amount,
                    ]);

                    return ['result_id' => $result->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'payroll.result.approve', 'payroll_result', $calculation->id);
        }
    }

    /** @return array{adjustment_id: string, correlation_id: string} */
    public function adjust(Actor $approver, PayrollResult $result, string $kind, string $amount, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['payroll.result.adjust', $result->id, $kind, $amount, $reason, $approver->actorId]));

        try {
            return $this->idempotency->execute('payroll.result.adjust', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $result, $kind, $amount, $reason): array {
                    $this->require($approver, self::CAPABILITY_ADJUST);
                    if ($reason === '') {
                        throw BusinessRejection::forCode('payroll.adjustment_reason', 'an adjustment requires a reason');
                    }
                    if (! in_array($kind, ['adjustment', 'reversal'], true)) {
                        throw BusinessRejection::forCode('payroll.adjustment_kind', sprintf('unknown adjustment kind %s', $kind));
                    }
                    if (! is_numeric($amount)) {
                        throw BusinessRejection::forCode('payroll.adjustment_amount', 'the adjustment amount must be numeric');
                    }

                    /** @var PayrollResult $lockedResult */
                    $lockedResult = PayrollResult::query()->whereKey($result->id)->lockForUpdate()->firstOrFail();

                    /** @var PayrollPeriod $period */
                    $period = PayrollPeriod::query()->whereKey($lockedResult->period_id)->lockForUpdate()->firstOrFail();
                    if ($period->lifecycle_state === PayrollLifecycle::PERIOD_CLOSED) {
                        throw BusinessRejection::forCode('payroll.period_closed', 'a closed payroll period rejects mutation');
                    }
                    if ($kind === 'reversal' && PayrollAdjustment::query()->where('result_id', $lockedResult->id)->where('kind', 'reversal')->exists()) {
                        throw BusinessRejection::forCode('payroll.reversal_exists', 'this result is already reversed');
                    }

                    $adjustment = PayrollAdjustment::query()->create([
                        'id' => RandomIdentifier::new(),
                        'result_id' => $lockedResult->id,
                        'kind' => $kind,
                        'amount' => $kind === 'reversal' ? bcmul($amount, '-1', 2) : $amount,
                        'reason' => $reason,
                        'approved_by' => $approver->actorId,
                    ]);
                    $event = $this->audit->record($approver->actorId, 'payroll.result.adjust', 'payroll_adjustment', $adjustment->id, null, [
                        'result_id' => $lockedResult->id, 'kind' => $kind, 'amount' => $adjustment->amount,
                    ]);

                    return ['adjustment_id' => $adjustment->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'payroll.result.adjust', 'payroll_adjustment', $result->id);
        }
    }

    private function require(Actor $actor, string $capability): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('payroll.approve_denied', $outcome->reason);
        }
    }
}
