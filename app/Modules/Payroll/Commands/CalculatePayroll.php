<?php

declare(strict_types=1);

namespace App\Modules\Payroll\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Domain\ContractVersionLifecycle;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\CompensationRule;
use App\Modules\Hr\Models\Contract;
use App\Modules\Hr\Models\ContractVersion;
use App\Modules\Hr\Models\Employment;
use App\Modules\Hr\Models\EmploymentStatus;
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
 * Payroll calculation — the single authoritative compensation path.
 *
 * Resolves the in-force contract version of the employment for the exact
 * payroll period and applies its frozen compensation rules: per-unit
 * rates resolve by the deterministic precedence ladder (exact skill x
 * scale > skill-only > scale-only > generic), and fixed monthly plus
 * allowance lines are prorated by calendar-day overlap of the version
 * window and the period (full-period coverage pays in full; exact cent
 * arithmetic, round half up).
 *
 * Teaching volume derives from authoritative academic delivery evidence:
 * a session is payable only when at least one enrolled student has a
 * final attendance fact with status present or late — the final fact is
 * the uncorrected tip of the authoritative corrects_id chain, never
 * timestamp ordering. Absent and excused never qualify; cancelled and
 * never-held sessions carry no qualifying attendance and are not
 * payable. Each qualifying session is claimed exactly once by a
 * teaching delivery fact (unique per session at the database level), so
 * double payment is impossible.
 *
 * No in-force version, rule-missing, unattributed or conflicting
 * evidence cases are HELD for HR/Finance review — there is no legacy
 * fallback, no silent zero, and no invented charge. A recalculation
 * supersedes the prior calculation; history is retained, and the
 * complete immutable snapshot (version, scale, rules and rates, skill
 * breakdown, volume, evidence references, proration, final amount)
 * reproduces the approved payroll regardless of later contract, scale,
 * skill, attendance correction, or rate changes.
 */
final class CalculatePayroll
{
    public const CAPABILITY = 'payroll.calculate';

    /** Final attendance statuses that qualify a delivered session for payment. */
    public const QUALIFYING_ATTENDANCE_STATUSES = ['present', 'late'];

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
     * @return array{0: string, 1: array<string, mixed>, 2: string|null, 3: list<array{session_id: string, skill_id: string, scheduled_on: string, hours: string, fact_id: string}>}
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

        return ['0.00', ['contract_version_id' => null], 'contract-silent: no approved contract version covers this period', []];
    }

    /**
     * @param  list<array{session_id: string, skill_id: string, scheduled_on: string, hours: string, fact_id: string}>  $claims
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
     * @return array{0: string, 1: array<string, mixed>, 2: string|null, 3: list<array{session_id: string, skill_id: string, scheduled_on: string, hours: string, fact_id: string}>}
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
            return ['0.00', $this->versionSnapshotContext($contract, $version, $rules, $period), 'payroll.skill_attribution_missing: a delivered session has no skill attribution', []];
        }

        $bySkill = [];
        $claims = [];
        foreach ($delivered as $session) {
            $bySkill[$session->skill_id][] = $session;
            $claims[] = [
                'session_id' => $session->session_id,
                'skill_id' => $session->skill_id,
                'scheduled_on' => $session->scheduled_on,
                'hours' => $session->hours,
                'fact_id' => $session->fact_id,
            ];
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
            return ['0.00', $this->versionSnapshotContext($contract, $version, $rules, $period), $heldReason, []];
        }

        $additiveRows = [];
        foreach ($rules as $rule) {
            if ($rule->method === CompensationRule::METHOD_FIXED || $rule->method === CompensationRule::METHOD_ALLOWANCE) {
                $prorated = $this->proratedLineAmount((string) $rule->rate, $version, $period);
                $amount = bcadd($amount, $prorated['payable'], 2);
                $additiveRows[] = [
                    'rule_id' => $rule->id, 'method' => $rule->method, 'label' => $rule->label,
                    'contract_amount' => (string) $rule->rate,
                    'active_days' => $prorated['active_days'], 'period_days' => $prorated['period_days'],
                    'amount' => $prorated['payable'],
                ];
            }
        }

        $snapshot = array_merge($this->versionSnapshotContext($contract, $version, $rules, $period), [
            'formula' => 'skill-scale-v1',
            'per_skill' => $perSkillRows,
            'delivery' => $claims,
            'additive' => $additiveRows,
        ]);

        return [$amount, $snapshot, null, $claims];
    }

    /**
     * Calendar-day overlap of the version window and the payroll period,
     * both inclusive. The in-force resolution guarantees a non-empty
     * overlap, so active_days is at least 1.
     *
     * @return array{period_days: int, active_days: int}
     */
    private function prorationWindow(ContractVersion $version, PayrollPeriod $period): array
    {
        $periodFrom = new CarbonImmutable($period->date_from);
        $periodTo = new CarbonImmutable($period->date_to);
        $periodDays = (int) $periodFrom->diffInDays($periodTo) + 1;
        $from = $periodFrom > new CarbonImmutable($version->effective_from) ? $periodFrom : new CarbonImmutable($version->effective_from);
        $to = $version->effective_to === null || $periodTo < new CarbonImmutable($version->effective_to)
            ? $periodTo
            : new CarbonImmutable($version->effective_to);
        $activeDays = (int) $from->diffInDays($to) + 1;

        return ['period_days' => $periodDays, 'active_days' => min($activeDays, $periodDays)];
    }

    /**
     * Prorate an additive line (fixed monthly / allowance) by calendar
     * days: payable = contract_amount x active_days / period_days. Full
     * coverage pays the full amount. Exact cent arithmetic with round
     * half up, so monetary precision never depends on float order.
     *
     * @return array{payable: string, active_days: int, period_days: int}
     */
    private function proratedLineAmount(string $contractAmount, ContractVersion $version, PayrollPeriod $period): array
    {
        $window = $this->prorationWindow($version, $period);
        if ($window['active_days'] >= $window['period_days']) {
            return ['payable' => $contractAmount, 'active_days' => $window['period_days'], 'period_days' => $window['period_days']];
        }
        $numerator = bcmul(bcmul($contractAmount, '100', 0), (string) $window['active_days'], 0);
        $quotient = (int) bcdiv($numerator, (string) $window['period_days'], 0);
        $remainder = (int) bcmod($numerator, (string) $window['period_days'], 0);
        if ($remainder * 2 >= $window['period_days']) {
            $quotient++;
        }

        return ['payable' => bcdiv((string) $quotient, '100', 2), 'active_days' => $window['active_days'], 'period_days' => $window['period_days']];
    }

    /**
     * @param  list<CompensationRule>  $rules
     * @return array<string, mixed>
     */
    private function versionSnapshotContext(Contract $contract, ContractVersion $version, array $rules, PayrollPeriod $period): array
    {
        $proration = $this->prorationWindow($version, $period);

        return [
            'contract_id' => $contract->id,
            'contract_version_id' => $version->id,
            'version_no' => $version->version_no,
            'scale_id' => $version->scale_id,
            'rules' => array_map(static fn (CompensationRule $rule): array => [
                'id' => $rule->id, 'method' => $rule->method, 'skill_id' => $rule->skill_id,
                'scale_id' => $rule->scale_id, 'label' => $rule->label, 'rate' => (string) $rule->rate,
            ], $rules),
            'proration' => [
                'period_from' => $period->date_from,
                'period_to' => $period->date_to,
                'period_days' => $proration['period_days'],
                'version_effective_from' => $version->effective_from,
                'version_effective_to' => $version->effective_to,
                'active_days' => $proration['active_days'],
            ],
        ];
    }

    /**
     * Delivered skill sessions of the period: scheduled with a skill,
     * inside the teacher's effective assignment window for that class and
     * skill, and qualified by final attendance — at least one attendance
     * fact whose status is present or late and which is the uncorrected
     * tip of its corrects_id chain (a correction that flips the status
     * retires the prior fact from qualification). The earliest qualifying
     * tip is carried as the evidence reference.
     *
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
            ->whereExists($this->qualifyingAttendanceExists())
            ->distinct()
            ->orderBy('class_sessions.scheduled_on')
            ->orderBy('class_sessions.id')
            ->get([
                'class_sessions.id as session_id',
                'class_sessions.skill_id as skill_id',
                'class_sessions.scheduled_on as scheduled_on',
                'class_sessions.starts_at as starts_at',
                'class_sessions.ends_at as ends_at',
                DB::raw("(SELECT afq.id FROM attendance_facts afq WHERE afq.session_id = class_sessions.id AND afq.status IN ('present','late') AND NOT EXISTS (SELECT 1 FROM attendance_facts afq2 WHERE afq2.corrects_id = afq.id) ORDER BY afq.created_at, afq.id LIMIT 1) as fact_id"),
            ])
            ->map(static function (\stdClass $row): \stdClass {
                $start = CarbonImmutable::parse('2000-01-01 '.$row->starts_at);
                $end = CarbonImmutable::parse('2000-01-01 '.$row->ends_at);
                $row->hours = bcdiv((string) $start->diffInMinutes($end), '60', 2);

                return $row;
            })
            ->all();
    }

    /**
     * Delivered sessions without skill attribution: qualifying final
     * attendance on a session whose skill is unset cannot be paid under
     * the single resolution space and holds the calculation.
     */
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
            ->whereExists($this->qualifyingAttendanceExists())
            ->exists();
    }

    /**
     * A session is delivery-qualified only when at least one of its
     * attendance facts has a final status of present or late. "Final" is
     * resolved through the authoritative corrects_id chain: a fact is
     * final when no other fact corrects it (the uncorrected chain tip),
     * so correction history — not timestamps — decides qualification.
     */
    private function qualifyingAttendanceExists(): \Closure
    {
        return function ($query): void {
            $query->selectRaw('1')
                ->from('attendance_facts as af')
                ->whereColumn('af.session_id', 'class_sessions.id')
                ->whereIn('af.status', self::QUALIFYING_ATTENDANCE_STATUSES)
                ->whereNotExists(function ($inner): void {
                    $inner->selectRaw('1')->from('attendance_facts as af2')->whereColumn('af2.corrects_id', 'af.id');
                });
        };
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

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('payroll.calculate_denied', $outcome->reason);
        }
    }
}
