<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\CompensationComponent;
use App\Modules\Hr\Models\Contract;
use App\Modules\Hr\Models\Employment;
use App\Modules\Hr\Models\EmploymentStatus;
use App\Modules\Hr\Models\WorkBasis;
use App\Modules\Payroll\Domain\PayrollLifecycle;
use App\Modules\Payroll\Models\PayrollCalculation;
use App\Modules\Payroll\Models\PayrollPeriod;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Payroll calculation: snapshots the effective contract configuration and
 * the recorded work evidence of the period. A contract-silent case (work
 * evidence with no covering active component, or no active contract) is
 * HELD for HR/Finance review — no charge or payment is invented. A
 * recalculation supersedes the prior calculation; history is retained.
 */
final class CalculatePayroll
{
    public const CAPABILITY = 'payroll.calculate';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{calculation_id: string, lifecycle_state: string, correlation_id: string} */
    public function prepare(Actor $preparer, PayrollPeriod $period, Employment $employment, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['payroll.calculation.prepare', $period->id, $employment->id, $preparer->actorId]));

        try {
            return $this->idempotency->execute('payroll.calculation.prepare', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($preparer, $period, $employment): array {
                    $this->require($preparer);

                    /** @var PayrollPeriod $lockedPeriod */
                    $lockedPeriod = PayrollPeriod::query()->whereKey($period->id)->lockForUpdate()->firstOrFail();
                    if (! in_array($lockedPeriod->lifecycle_state, [PayrollLifecycle::PERIOD_OPEN, PayrollLifecycle::PERIOD_CALCULATING], true)) {
                        throw BusinessRejection::forCode('payroll.period_not_open', 'calculations attach only to an open payroll period');
                    }

                    /** @var Employment $lockedEmployment */
                    $lockedEmployment = Employment::query()->whereKey($employment->id)->lockForUpdate()->firstOrFail();
                    $terminatedOn = EmploymentStatus::query()
                        ->where('employment_id', $lockedEmployment->id)
                        ->where('status', EmploymentLifecycle::STATE_TERMINATED)
                        ->max('effective_from');
                    if ($terminatedOn !== null && (string) $terminatedOn < $lockedPeriod->date_from) {
                        throw BusinessRejection::forCode('payroll.employment_before_period', 'the employment ended before this period began');
                    }

                    PayrollCalculation::query()->where('period_id', $lockedPeriod->id)->where('employment_id', $lockedEmployment->id)
                        ->whereIn('lifecycle_state', [PayrollLifecycle::CALC_PREPARED, PayrollLifecycle::CALC_HELD])
                        ->update(['lifecycle_state' => PayrollLifecycle::CALC_SUPERSEDED]);

                    [$amount, $snapshot, $heldReason] = $this->compute($lockedPeriod, $lockedEmployment);

                    $calculation = PayrollCalculation::query()->create([
                        'id' => RandomIdentifier::new(),
                        'period_id' => $lockedPeriod->id,
                        'employment_id' => $lockedEmployment->id,
                        'base_amount' => $amount,
                        'snapshot' => $snapshot,
                        'lifecycle_state' => $heldReason === null ? PayrollLifecycle::CALC_PREPARED : PayrollLifecycle::CALC_HELD,
                        'held_reason' => $heldReason,
                        'prepared_by' => $preparer->actorId,
                    ]);
                    $event = $this->audit->record($preparer->actorId, 'payroll.calculation.prepare', 'payroll_calculation', $calculation->id, null, [
                        'period_id' => $lockedPeriod->id, 'employment_id' => $lockedEmployment->id, 'base_amount' => $amount,
                        'lifecycle_state' => $calculation->lifecycle_state,
                    ]);

                    return ['calculation_id' => $calculation->id, 'lifecycle_state' => $calculation->lifecycle_state, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $preparer, 'payroll.calculation.prepare', 'payroll_calculation', $employment->id);
        }
    }

    /** @return array{0: string, 1: array<string, mixed>, 2: string|null} */
    private function compute(PayrollPeriod $period, Employment $employment): array
    {
        /** @var Contract|null $contract */
        $contract = Contract::query()
            ->where('employment_id', $employment->id)
            ->where('lifecycle_state', 'active')
            ->where('effective_from', '<=', $period->date_to)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>=', $period->date_from))
            ->first();

        if ($contract === null) {
            return ['0.00', ['contract_id' => null, 'components' => [], 'work_bases' => []], 'contract-silent: no active contract covers this period'];
        }

        /** @var list<CompensationComponent> $components */
        $components = CompensationComponent::query()
            ->where('contract_id', $contract->id)
            ->where('lifecycle_state', 'active')
            ->where('effective_from', '<=', $period->date_to)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>=', $period->date_from))
            ->get()->all();

        $rates = [];
        foreach ($components as $component) {
            $rates[$component->kind] = $component->amount;
        }

        /** @var list<WorkBasis> $bases */
        $bases = WorkBasis::query()
            ->where('employment_id', $employment->id)
            ->where('lifecycle_state', 'recorded')
            ->where('period_from', '<=', $period->date_to)
            ->where('period_to', '>=', $period->date_from)
            ->get()->all();

        $heldReason = null;
        $quantities = ['hours' => '0', 'classes' => '0'];
        foreach ($bases as $basis) {
            $quantities[$basis->unit] = bcadd((string) $quantities[$basis->unit], (string) $basis->quantity, 2);
            $kind = $basis->unit === 'hours' ? 'hourly' : 'class_based';
            if (! isset($rates[$kind])) {
                $heldReason = 'contract-silent: work evidence of unit '.$basis->unit.' has no active covering compensation component';
            }
        }

        $amount = '0.00';
        $componentRows = [];
        foreach ($components as $component) {
            if (in_array($component->kind, ['fixed', 'allowance'], true)) {
                $amount = bcadd($amount, (string) $component->amount, 2);
                $componentRows[] = ['id' => $component->id, 'kind' => $component->kind, 'amount' => (string) $component->amount];
            } else {
                $unit = $component->kind === 'hourly' ? 'hours' : 'classes';
                $lineAmount = bcmul((string) $component->amount, $quantities[$unit], 2);
                $amount = bcadd($amount, $lineAmount, 2);
                $componentRows[] = ['id' => $component->id, 'kind' => $component->kind, 'rate' => (string) $component->amount, 'unit' => $unit, 'quantity' => $quantities[$unit], 'amount' => $lineAmount];
            }
        }

        $snapshot = [
            'contract_id' => $contract->id,
            'components' => $componentRows,
            'work_bases' => array_map(static fn (WorkBasis $basis): array => [
                'id' => $basis->id, 'unit' => $basis->unit, 'quantity' => (string) $basis->quantity, 'source' => $basis->source,
            ], $bases),
        ];

        return [$amount, $snapshot, $heldReason];
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('payroll.calculate_denied', $outcome->reason);
        }
    }
}
