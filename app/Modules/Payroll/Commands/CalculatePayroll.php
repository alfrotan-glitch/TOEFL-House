<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Domain\ContractVersionLifecycle;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\CompensationComponent;
use App\Modules\Hr\Models\CompensationRule;
use App\Modules\Hr\Models\Contract;
use App\Modules\Hr\Models\ContractVersion;
use App\Modules\Hr\Models\Employment;
use App\Modules\Hr\Models\EmploymentStatus;
use App\Modules\Hr\Models\WorkBasis;
use App\Modules\Payroll\Domain\PayrollLifecycle;
use App\Modules\Payroll\Models\PayrollCalculation;
use App\Modules\Payroll\Models\PayrollPeriod;
use App\Modules\Payroll\Models\TeachingDeliveryFact;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\Query\JoinClause;
use Illuminate\Support\Facades\DB;

/**
 * Payroll calculation: snapshots the effective contract configuration and
 * the recorded work evidence of the period. Versioned contracts resolve
 * their in-force contract version and compensation rules (method + skill +
 * scale with a deterministic precedence ladder) and derive teaching volume
 * from authoritative academic delivery evidence, claiming each qualifying
 * session exactly once. Contract-silent, rule-missing, unattributed or
 * conflicting evidence cases are HELD for HR/Finance review — no charge or
 * payment is invented. A recalculation supersedes the prior calculation;
 * history is retained.
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
                    $lockedPeriod = PayrollPeriod::query()->where('id', $period->id)->lockForUpdate()->firstOrFail();
                    if (! in_array($lockedPeriod->lifecycle_state, [PayrollLifecycle::PERIOD_OPEN, PayrollLifecycle::PERIOD_CALCULATING], true)) {
                        throw BusinessRejection::forCode('payroll.period_not_open', 'calculations attach only to an open payroll period');
                    }

                    /** @var Employment $lockedEmployment */
                    $lockedEmployment = Employment::query()->where('id', $employment->id)->lockForUpdate()->firstOrFail();
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

                    [$amount, $snapshot, $heldReason, $claims] = $this->compute($lockedPeriod, $lockedEmployment);

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
                    if ($heldReason === null) {
                        $this->claimDelivery($claims, $calculation->id);
                    }
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

    /**
     * @return array{0: string, 1: array<string, mixed>, 2: string|null, 3: list<array{session_id: string, skill_id: string, scheduled_on: string, hours: string}>}
     */
    private function compute(PayrollPeriod $period, Employment $employment): array
    {
        /** @var list<ContractVersion> $inForce */
        $inForce = ContractVersion::query()
            ->whereIn('contract_id', Contract::query()->where('employment_id', $employment->id)->select('id'))
            ->whereIn('lifecycle_state', ContractVersionLifecycle::IN_FORCE_STATES)
            ->where('effective_from', '<=', $period->date_to)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>=', $period->date_from))
            ->orderByDesc('effective_from')
            ->get()->all();

        if (count($inForce) > 1) {
            $ids = implode(',', array_map(static fn (ContractVersion $version): string => $version->id, $inForce));

            return ['0.00', ['contract_version_ids' => $ids], 'payroll.version_overlap: multiple in-force contract versions cover this period', []];
        }
        if (count($inForce) === 1) {
            return $this->computeByContractVersion($period, $employment, $inForce[0]);
        }

        $versioned = ContractVersion::query()
            ->whereIn('contract_id', Contract::query()->where('employment_id', $employment->id)->select('id'))
            ->whereIn('lifecycle_state', ContractVersionLifecycle::SETTLED_STATES)
            ->exists();
        if ($versioned) {
            return ['0.00', ['contract_version_id' => null], 'contract-silent: no approved contract version covers this period', []];
        }

        return $this->computeLegacy($period, $employment);
    }

    /**
     * @param  list<array{session_id: string, skill_id: string, scheduled_on: string, hours: string}>  $claims
     */
    private function claimDelivery(array $claims, string $calculationId): void
    {
        foreach ($claims as $claim) {
            /** @var TeachingDeliveryFact|null $existing */
            $existing = TeachingDeliveryFact::query()->where('session_id', $claim['session_id'])->lockForUpdate()->first();
            if ($existing !== null) {
                if ($existing->payroll_calculation_id !== $calculationId) {
                    $existing->forceFill(['payroll_calculation_id' => $calculationId]);
                    $existing->save();
                }

                continue;
            }
            TeachingDeliveryFact::query()->create([
                'id' => RandomIdentifier::new(),
                'payroll_calculation_id' => $calculationId,
                'session_id' => $claim['session_id'],
                'skill_id' => $claim['skill_id'],
                'scheduled_on' => $claim['scheduled_on'],
                'hours' => $claim['hours'],
            ]);
        }
    }

    /**
     * @return array{0: string, 1: array<string, mixed>, 2: string|null, 3: list<array{session_id: string, skill_id: string, scheduled_on: string, hours: string}>}
     */
    private function computeByContractVersion(PayrollPeriod $period, Employment $employment, ContractVersion $version): array
    {
        /** @var Contract $contract */
        $contract = Contract::query()->findOrFail($version->contract_id);

        /** @var list<CompensationRule> $rules */
        $rules = CompensationRule::query()->where('contract_version_id', $version->id)->orderBy('id')->get()->all();
        $perUnitRules = array_values(array_filter($rules, static fn (CompensationRule $rule): bool => in_array($rule->method, [CompensationRule::METHOD_SESSION, CompensationRule::METHOD_HOURLY], true)));
        $hasPerUnitRules = $perUnitRules !== [];

        $delivered = $this->deliveredSkillSessions($period, $employment);
        $unattributed = $hasPerUnitRules && $this->deliveredSessionsWithoutSkill($period, $employment);
        if ($unattributed) {
            return ['0.00', $this->versionSnapshotContext($contract, $version, $rules), 'payroll.skill_attribution_missing: a delivered session has no skill attribution', []];
        }

        /** @var list<WorkBasis> $bases */
        $bases = WorkBasis::query()
            ->where('employment_id', $employment->id)
            ->where('lifecycle_state', 'recorded')
            ->whereIn('unit', ['hours', 'classes'])
            ->where('period_from', '<=', $period->date_to)
            ->where('period_to', '>=', $period->date_from)
            ->get()->all();
        if ($bases !== [] && $hasPerUnitRules) {
            return ['0.00', $this->versionSnapshotContext($contract, $version, $rules), 'payroll.volume_conflict: manual work evidence overlaps authoritative session-derived volume for a versioned contract', []];
        }
        if ($bases !== []) {
            return ['0.00', $this->versionSnapshotContext($contract, $version, $rules), 'payroll.volume_unaddressed: manual work evidence exists but the version carries no per-unit rule to pay it', []];
        }

        $bySkill = [];
        $claims = [];
        foreach ($delivered as $session) {
            $bySkill[$session->skill_id][] = $session;
            $claims[] = ['session_id' => $session->session_id, 'skill_id' => $session->skill_id, 'scheduled_on' => $session->scheduled_on, 'hours' => $session->hours];
        }

        $amount = '0.00';
        $perSkillRows = [];
        $heldReason = null;
        foreach ($bySkill as $skillId => $skillSessions) {
            if ($heldReason !== null) {
                continue;
            }
            $rule = $this->resolvePerUnitRule($perUnitRules, (string) $skillId, $version->scale_id !== null ? (string) $version->scale_id : null);
            if ($rule === null) {
                $heldReason = 'payroll.rule_missing: no compensation rule covers skill '.$skillId;

                continue;
            }
            $sessionsCount = (string) count($skillSessions);
            $skillHours = '0.00';
            foreach ($skillSessions as $skillSession) {
                $skillHours = bcadd($skillHours, $skillSession->hours, 2);
            }
            $lineAmount = $rule->method === CompensationRule::METHOD_SESSION
                ? bcmul((string) $rule->rate, $sessionsCount, 2)
                : bcmul((string) $rule->rate, $skillHours, 2);
            $amount = bcadd($amount, $lineAmount, 2);
            $perSkillRows[] = [
                'skill_id' => (string) $skillId, 'sessions' => $sessionsCount, 'hours' => $skillHours,
                'rule_id' => $rule->id, 'method' => $rule->method, 'rate' => (string) $rule->rate, 'amount' => $lineAmount,
            ];
        }
        if ($heldReason !== null) {
            return ['0.00', $this->versionSnapshotContext($contract, $version, $rules), $heldReason, []];
        }

        $additiveRows = [];
        foreach ($rules as $rule) {
            if ($rule->method === CompensationRule::METHOD_FIXED || $rule->method === CompensationRule::METHOD_ALLOWANCE) {
                $amount = bcadd($amount, (string) $rule->rate, 2);
                $additiveRows[] = ['rule_id' => $rule->id, 'method' => $rule->method, 'label' => $rule->label, 'amount' => (string) $rule->rate];
            }
        }

        $snapshot = array_merge($this->versionSnapshotContext($contract, $version, $rules), [
            'formula' => 'skill-scale-v1',
            'per_skill' => $perSkillRows,
            'delivery' => $claims,
            'additive' => $additiveRows,
        ]);

        return [$amount, $snapshot, null, $claims];
    }

    /**
     * @param  list<CompensationRule>  $rules
     * @return array<string, mixed>
     */
    private function versionSnapshotContext(Contract $contract, ContractVersion $version, array $rules): array
    {
        return [
            'contract_id' => $contract->id,
            'contract_version_id' => $version->id,
            'version_no' => $version->version_no,
            'scale_id' => $version->scale_id,
            'rules' => array_map(static fn (CompensationRule $rule): array => [
                'id' => $rule->id, 'method' => $rule->method, 'skill_id' => $rule->skill_id,
                'scale_id' => $rule->scale_id, 'label' => $rule->label, 'rate' => (string) $rule->rate,
            ], $rules),
        ];
    }

    /**
     * @return list<\stdClass>
     */
    private function deliveredSkillSessions(PayrollPeriod $period, Employment $employment): array
    {
        return DB::table('class_sessions')
            ->join('teacher_assignments as ta', function (JoinClause $join) use ($employment): void {
                $join->on('ta.class_id', '=', 'class_sessions.class_id')
                    ->where('ta.teacher_person_id', '=', $employment->person_id)
                    ->where('ta.effective_from', '<=', DB::raw('class_sessions.scheduled_on'))
                    ->where(fn ($query) => $query->whereNull('ta.effective_to')->orWhere('ta.effective_to', '>=', DB::raw('class_sessions.scheduled_on')));
            })
            ->join('teacher_assignment_skills as tas', function (JoinClause $join): void {
                $join->on('tas.teacher_assignment_id', '=', 'ta.id')
                    ->on('tas.skill_id', '=', 'class_sessions.skill_id');
            })
            ->whereBetween('class_sessions.scheduled_on', [$period->date_from, $period->date_to])
            ->whereExists(function ($query): void {
                $query->selectRaw('1')
                    ->from('attendance_facts as af')
                    ->whereColumn('af.session_id', 'class_sessions.id');
            })
            ->distinct()
            ->orderBy('class_sessions.scheduled_on')
            ->orderBy('class_sessions.id')
            ->get(['class_sessions.id as session_id', 'class_sessions.skill_id as skill_id', 'class_sessions.scheduled_on as scheduled_on', 'class_sessions.starts_at as starts_at', 'class_sessions.ends_at as ends_at'])
            ->map(static function (\stdClass $row): \stdClass {
                $start = CarbonImmutable::parse('2000-01-01 '.$row->starts_at);
                $end = CarbonImmutable::parse('2000-01-01 '.$row->ends_at);
                $row->hours = bcdiv((string) $start->diffInMinutes($end), '60', 2);

                return $row;
            })
            ->all();
    }

    private function deliveredSessionsWithoutSkill(PayrollPeriod $period, Employment $employment): bool
    {
        return DB::table('class_sessions')
            ->join('teacher_assignments as ta', function (JoinClause $join) use ($employment): void {
                $join->on('ta.class_id', '=', 'class_sessions.class_id')
                    ->where('ta.teacher_person_id', '=', $employment->person_id)
                    ->where('ta.effective_from', '<=', DB::raw('class_sessions.scheduled_on'))
                    ->where(fn ($query) => $query->whereNull('ta.effective_to')->orWhere('ta.effective_to', '>=', DB::raw('class_sessions.scheduled_on')));
            })
            ->whereBetween('class_sessions.scheduled_on', [$period->date_from, $period->date_to])
            ->whereNull('class_sessions.skill_id')
            ->whereExists(function ($query): void {
                $query->selectRaw('1')
                    ->from('attendance_facts as af')
                    ->whereColumn('af.session_id', 'class_sessions.id');
            })
            ->exists();
    }

    /**
     * @param  list<CompensationRule>  $perUnitRules
     */
    private function resolvePerUnitRule(array $perUnitRules, string $skillId, ?string $scaleId): ?CompensationRule
    {
        $ladder = [
            ['skill' => $skillId, 'scale' => $scaleId],
            ['skill' => $skillId, 'scale' => null],
            ['skill' => null, 'scale' => $scaleId],
            ['skill' => null, 'scale' => null],
        ];
        foreach ($ladder as $step) {
            foreach ($perUnitRules as $rule) {
                if ((string) $rule->skill_id === (string) $step['skill'] && (string) $rule->scale_id === (string) $step['scale']) {
                    return $rule;
                }
            }
        }

        return null;
    }

    /**
     * @return array{0: string, 1: array<string, mixed>, 2: string|null, 3: list<array{session_id: string, skill_id: string, scheduled_on: string, hours: string}>}
     */
    private function computeLegacy(PayrollPeriod $period, Employment $employment): array
    {
        /** @var Contract|null $contract */
        $contract = Contract::query()
            ->where('employment_id', $employment->id)
            ->where('lifecycle_state', 'active')
            ->where('effective_from', '<=', $period->date_to)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>=', $period->date_from))
            ->first();

        if ($contract === null) {
            return ['0.00', ['contract_id' => null, 'components' => [], 'work_bases' => []], 'contract-silent: no active contract covers this period', []];
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

        return [$amount, $snapshot, $heldReason, []];
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('payroll.calculate_denied', $outcome->reason);
        }
    }
}
