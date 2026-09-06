<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Models\Employment;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Modules\Payroll\Domain\PayrollLifecycle;
use App\Modules\Payroll\Models\PayrollCalculation;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;

/**
 * Explicitly closes a held Payroll exception after a replacement calculation
 * exists. Recalculation never silently resolves a held predecessor: the
 * reviewer supplies durable evidence and the replacement identity, and the
 * immutable history records who made that decision.
 */
final class ResolveHeldPayrollCalculation
{
    public const CAPABILITY = 'payroll.resolve_held';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{calculation_id: string, replacement_calculation_id: string, lifecycle_state: string, correlation_id: string} */
    public function resolve(
        Actor $resolver,
        PayrollCalculation $heldCalculation,
        PayrollCalculation $replacementCalculation,
        string $resolutionRef,
        string $idempotencyKey,
    ): array {
        $resolutionRef = trim($resolutionRef);
        $payload = hash('sha256', implode('|', [
            'payroll.calculation.resolve_held',
            $heldCalculation->id,
            $replacementCalculation->id,
            $resolutionRef,
            $resolver->actorId,
        ]));

        try {
            return $this->idempotency->execute('payroll.calculation.resolve_held', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($resolver, $heldCalculation, $replacementCalculation, $resolutionRef): array {
                    if ($resolutionRef === '') {
                        throw BusinessRejection::forCode('payroll.resolution_reference', 'held Payroll resolution requires an evidence reference');
                    }

                    /** @var PayrollCalculation $lockedHeld */
                    $lockedHeld = PayrollCalculation::query()->whereKey($heldCalculation->id)->lockForUpdate()->firstOrFail();
                    if ($lockedHeld->lifecycle_state !== PayrollLifecycle::CALC_HELD) {
                        throw BusinessRejection::forCode('payroll.calculation_not_held', 'only a held Payroll calculation can be explicitly resolved');
                    }

                    /** @var PayrollCalculation $lockedReplacement */
                    $lockedReplacement = PayrollCalculation::query()->whereKey($replacementCalculation->id)->lockForUpdate()->firstOrFail();
                    if (! in_array($lockedReplacement->lifecycle_state, [PayrollLifecycle::CALC_PREPARED, PayrollLifecycle::CALC_RESULTED], true)) {
                        throw BusinessRejection::forCode('payroll.replacement_not_ready', 'a held Payroll calculation requires a prepared or resulted replacement');
                    }
                    if ($lockedReplacement->id === $lockedHeld->id
                        || $lockedReplacement->period_id !== $lockedHeld->period_id
                        || $lockedReplacement->employment_id !== $lockedHeld->employment_id) {
                        throw BusinessRejection::forCode('payroll.replacement_mismatch', 'the replacement must belong to the same period and employment and differ from the held calculation');
                    }

                    /** @var Employment $employment */
                    $employment = Employment::query()->whereKey($lockedHeld->employment_id)->firstOrFail();
                    if (trim((string) $employment->person_id) === $resolver->actorId) {
                        throw AuthorizationDenied::forCode('payroll.resolution_beneficiary', 'the beneficiary may never resolve their own held Payroll exception');
                    }
                    if (trim((string) $lockedReplacement->prepared_by) === $resolver->actorId) {
                        throw AuthorizationDenied::forCode('payroll.resolution_not_independent', 'the replacement preparer must differ from the held-exception resolver');
                    }
                    $scope = $this->employmentScope($employment);
                    $this->require($resolver, $scope);
                    PayrollLifecycle::requireCalculationTransition($lockedHeld->lifecycle_state, PayrollLifecycle::CALC_SUPERSEDED);

                    $before = [
                        'lifecycle_state' => $lockedHeld->lifecycle_state,
                        'held_reason' => $lockedHeld->held_reason,
                    ];
                    $lockedHeld->forceFill([
                        'lifecycle_state' => PayrollLifecycle::CALC_SUPERSEDED,
                        'resolution_ref' => $resolutionRef,
                        'resolved_by' => $resolver->actorId,
                        'replacement_calculation_id' => $lockedReplacement->id,
                    ]);
                    $lockedHeld->save();
                    $event = $this->audit->record($resolver->actorId, 'payroll.calculation.resolve_held', 'payroll_calculation', $lockedHeld->id, $before, [
                        'lifecycle_state' => $lockedHeld->lifecycle_state,
                        'held_reason' => $lockedHeld->held_reason,
                        'resolution_ref' => $resolutionRef,
                        'replacement_calculation_id' => $lockedReplacement->id,
                        'branch_id' => $scope->branchId,
                        'organization_id' => $scope->organizationId,
                    ]);

                    return [
                        'calculation_id' => $lockedHeld->id,
                        'replacement_calculation_id' => $lockedReplacement->id,
                        'lifecycle_state' => $lockedHeld->lifecycle_state,
                        'correlation_id' => $event->correlation_id,
                    ];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $resolver, 'payroll.calculation.resolve_held', 'payroll_calculation', $heldCalculation->id);
        }
    }

    private function employmentScope(Employment $employment): StructureScope
    {
        /** @var Person|null $person */
        $person = Person::query()->whereKey($employment->person_id)->first();
        $branchId = $person !== null ? trim((string) ($person->home_branch_id ?? '')) : '';
        $branch = $branchId === '' ? null : Branch::query()->whereKey($branchId)->first();
        if ($branch === null || $branch->lifecycle_state !== 'active' || $branch->structureScope()->organizationId === '') {
            throw BusinessRejection::forCode('payroll.branch_provenance_missing', 'held Payroll resolution requires an active employee home branch with organization provenance');
        }

        return $branch->structureScope();
    }

    private function require(Actor $actor, StructureScope $scope): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('payroll.resolve_held_denied', $outcome->reason);
        }
    }
}
