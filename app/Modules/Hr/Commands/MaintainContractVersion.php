<?php

declare(strict_types=1);

namespace App\Modules\Hr\Commands;

use App\Modules\Academic\Models\Skill;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Domain\ContractLifecycle;
use App\Modules\Hr\Domain\ContractVersionLifecycle;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\CompensationRule;
use App\Modules\Hr\Models\Contract;
use App\Modules\Hr\Models\ContractVersion;
use App\Modules\Hr\Models\Employment;
use App\Modules\Hr\Models\Scale;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Versioned teacher contracts: the Finance Manager prepares a draft
 * version with its compensation rules and submits it; the General Manager
 * approves it. The approver is never the preparer and never the
 * beneficiary, enforced in the command and in the schema. Approval
 * freezes the version and its rules with evidence and a digest; any later
 * change is a new effective version that supersedes the prior one.
 */
final class MaintainContractVersion
{
    public const CAPABILITY_PREPARE = 'hr.contract.prepare';

    public const CAPABILITY_APPROVE = 'hr.contract.approve';

    public const METHODS = [
        CompensationRule::METHOD_FIXED,
        CompensationRule::METHOD_ALLOWANCE,
        CompensationRule::METHOD_SESSION,
        CompensationRule::METHOD_HOURLY,
    ];

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /**
     * @return array{version_id: string, contract_id: string, version_no: int, correlation_id: string}
     */
    public function prepare(Actor $preparer, Employment $employment, string $termsRef, ?string $scaleId, string $effectiveFrom, ?string $effectiveTo, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.contract_version.prepare', $employment->id, $termsRef, $scaleId ?? '', $effectiveFrom, $effectiveTo ?? '', $preparer->actorId]));

        try {
            return $this->idempotency->execute('hr.contract_version.prepare', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($preparer, $employment, $termsRef, $scaleId, $effectiveFrom, $effectiveTo): array {
                    $this->require($preparer, self::CAPABILITY_PREPARE);
                    if ($termsRef === '') {
                        throw BusinessRejection::forCode('hr.contract_version_terms', 'a contract version requires its terms evidence reference');
                    }
                    if ($effectiveTo !== null && $effectiveTo <= $effectiveFrom) {
                        throw BusinessRejection::forCode('hr.contract_version_period', 'the effective window must end after it starts');
                    }

                    /** @var Employment $lockedEmployment */
                    $lockedEmployment = Employment::query()->where('id', $employment->id)->lockForUpdate()->firstOrFail();
                    if ($lockedEmployment->lifecycle_state === EmploymentLifecycle::STATE_TERMINATED) {
                        throw BusinessRejection::forCode('hr.contract_version_employment_terminated', 'a terminated employment cannot receive contract versions');
                    }
                    if ($scaleId !== null) {
                        /** @var Scale|null $scale */
                        $scale = Scale::query()->find($scaleId);
                        if ($scale === null || $scale->lifecycle_state !== Scale::STATE_ACTIVE) {
                            throw BusinessRejection::forCode('hr.contract_version_scale_unknown', 'a version may pin only an active scale');
                        }
                    }

                    /** @var Contract|null $contract */
                    $contract = Contract::query()
                        ->where('employment_id', $lockedEmployment->id)
                        ->whereIn('lifecycle_state', [ContractLifecycle::STATE_DRAFT, ContractLifecycle::STATE_ACTIVE])
                        ->lockForUpdate()
                        ->first();
                    if ($contract === null) {
                        $contract = Contract::query()->create([
                            'id' => RandomIdentifier::new(),
                            'employment_id' => $lockedEmployment->id,
                            'terms_summary' => $termsRef,
                            'lifecycle_state' => ContractLifecycle::STATE_DRAFT,
                            'effective_from' => $effectiveFrom,
                        ]);
                    }
                    if ($effectiveFrom < $contract->effective_from) {
                        throw BusinessRejection::forCode('hr.contract_version_before_contract', 'a version cannot start before its contract');
                    }

                    $versionNo = ((int) ContractVersion::query()->where('contract_id', $contract->id)->max('version_no')) + 1;
                    $version = ContractVersion::query()->create([
                        'id' => RandomIdentifier::new(),
                        'contract_id' => $contract->id,
                        'version_no' => $versionNo,
                        'lifecycle_state' => ContractVersionLifecycle::STATE_DRAFT,
                        'terms_ref' => $termsRef,
                        'scale_id' => $scaleId,
                        'effective_from' => $effectiveFrom,
                        'effective_to' => $effectiveTo,
                        'prepared_by' => $preparer->actorId,
                    ]);
                    $event = $this->audit->record($preparer->actorId, 'hr.contract_version.prepare', 'contract_version', $version->id, null, [
                        'contract_id' => $contract->id, 'version_no' => $versionNo, 'effective_from' => $effectiveFrom, 'scale_id' => $scaleId,
                    ]);

                    return ['version_id' => $version->id, 'contract_id' => $contract->id, 'version_no' => $versionNo, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $preparer, 'hr.contract_version.prepare', 'contract_version', $employment->id);
        }
    }

    /**
     * @return array{rule_id: string, correlation_id: string}
     */
    public function addRule(Actor $preparer, ContractVersion $version, string $method, string $rate, ?string $skillId, ?string $scaleId, ?string $label, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.compensation_rule.add', $version->id, $method, $rate, $skillId ?? '', $scaleId ?? '', $label ?? '', $preparer->actorId]));

        try {
            return $this->idempotency->execute('hr.compensation_rule.add', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($preparer, $version, $method, $rate, $skillId, $scaleId, $label): array {
                    $this->require($preparer, self::CAPABILITY_PREPARE);
                    if (! in_array($method, self::METHODS, true)) {
                        throw BusinessRejection::forCode('hr.compensation_rule_method', sprintf('unknown compensation method %s', $method));
                    }
                    if (! is_numeric($rate) || (float) $rate <= 0) {
                        throw BusinessRejection::forCode('hr.compensation_rule_rate', 'a compensation rate must be a positive number');
                    }

                    /** @var ContractVersion $locked */
                    $locked = ContractVersion::query()->where('id', $version->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== ContractVersionLifecycle::STATE_DRAFT) {
                        throw BusinessRejection::forCode('hr.compensation_rule_version_frozen', 'compensation rules attach only to a draft version');
                    }
                    if ($method === CompensationRule::METHOD_FIXED || $method === CompensationRule::METHOD_ALLOWANCE) {
                        if ($skillId !== null || $scaleId !== null) {
                            throw BusinessRejection::forCode('hr.compensation_rule_dimension', 'fixed and allowance lines carry no skill or scale dimension');
                        }
                        if ($method === CompensationRule::METHOD_ALLOWANCE && ($label === null || $label === '')) {
                            throw BusinessRejection::forCode('hr.compensation_rule_label', 'an allowance requires its label');
                        }
                        if ($method === CompensationRule::METHOD_FIXED) {
                            $label = null;
                            if (CompensationRule::query()->where('contract_version_id', $locked->id)->where('method', CompensationRule::METHOD_FIXED)->exists()) {
                                throw BusinessRejection::forCode('hr.compensation_rule_fixed_exists', 'this version already carries a fixed monthly salary');
                            }
                        }
                        if ($method === CompensationRule::METHOD_ALLOWANCE && CompensationRule::query()->where('contract_version_id', $locked->id)->where('method', CompensationRule::METHOD_ALLOWANCE)->where('label', $label)->exists()) {
                            throw BusinessRejection::forCode('hr.compensation_rule_allowance_exists', 'this version already carries an allowance with this label');
                        }
                    } else {
                        $label = null;
                        if ($skillId !== null) {
                            /** @var Skill|null $skill */
                            $skill = Skill::query()->find($skillId);
                            if ($skill === null || $skill->lifecycle_state !== Skill::STATE_ACTIVE) {
                                throw BusinessRejection::forCode('hr.compensation_rule_skill_unknown', 'a rate may reference only an active skill');
                            }
                        }
                        if ($scaleId !== null) {
                            /** @var Scale|null $scale */
                            $scale = Scale::query()->find($scaleId);
                            if ($scale === null || $scale->lifecycle_state !== Scale::STATE_ACTIVE) {
                                throw BusinessRejection::forCode('hr.compensation_rule_scale_unknown', 'a rate may reference only an active scale');
                            }
                            if ($scaleId !== $locked->scale_id) {
                                throw BusinessRejection::forCode('hr.compensation_rule_scale_mismatch', 'a scale-keyed rate must match the scale pinned by its version');
                            }
                        }
                        $overlap = CompensationRule::query()
                            ->where('contract_version_id', $locked->id)
                            ->whereIn('method', [CompensationRule::METHOD_SESSION, CompensationRule::METHOD_HOURLY])
                            ->where(fn ($query) => $skillId === null ? $query->whereNull('skill_id') : $query->where('skill_id', $skillId))
                            ->where(fn ($query) => $scaleId === null ? $query->whereNull('scale_id') : $query->where('scale_id', $scaleId))
                            ->exists();
                        if ($overlap) {
                            throw BusinessRejection::forCode('hr.compensation_rule_overlap', 'this version already has a per-unit rate covering that skill and scale combination');
                        }
                    }

                    $rule = CompensationRule::query()->create([
                        'id' => RandomIdentifier::new(),
                        'contract_version_id' => $locked->id,
                        'method' => $method,
                        'skill_id' => $skillId,
                        'scale_id' => $scaleId,
                        'label' => $label,
                        'rate' => $rate,
                    ]);
                    $event = $this->audit->record($preparer->actorId, 'hr.compensation_rule.add', 'compensation_rule', $rule->id, null, [
                        'contract_version_id' => $locked->id, 'method' => $method, 'skill_id' => $skillId, 'scale_id' => $scaleId, 'rate' => $rate,
                    ]);

                    return ['rule_id' => $rule->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $preparer, 'hr.compensation_rule.add', 'compensation_rule', $version->id);
        }
    }

    /**
     * @return array{correlation_id: string}
     */
    public function discardRule(Actor $preparer, CompensationRule $rule, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.compensation_rule.discard', $rule->id, $preparer->actorId]));

        try {
            return $this->idempotency->execute('hr.compensation_rule.discard', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($preparer, $rule): array {
                    $this->require($preparer, self::CAPABILITY_PREPARE);

                    /** @var CompensationRule $locked */
                    $locked = CompensationRule::query()->where('id', $rule->id)->lockForUpdate()->firstOrFail();
                    /** @var ContractVersion $version */
                    $version = ContractVersion::query()->where('id', $locked->contract_version_id)->lockForUpdate()->firstOrFail();
                    if ($version->lifecycle_state !== ContractVersionLifecycle::STATE_DRAFT) {
                        throw BusinessRejection::forCode('hr.compensation_rule_version_frozen', 'compensation rules attach only to a draft version');
                    }

                    $locked->delete();
                    $event = $this->audit->record($preparer->actorId, 'hr.compensation_rule.discard', 'compensation_rule', $locked->id, ['method' => $locked->method, 'rate' => $locked->rate], null);

                    return ['correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $preparer, 'hr.compensation_rule.discard', 'compensation_rule', $rule->id);
        }
    }

    /**
     * @return array{version_id: string, lifecycle_state: string, correlation_id: string}
     */
    public function submit(Actor $preparer, ContractVersion $version, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.contract_version.submit', $version->id, $preparer->actorId]));

        try {
            return $this->idempotency->execute('hr.contract_version.submit', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($preparer, $version): array {
                    $this->require($preparer, self::CAPABILITY_PREPARE);

                    /** @var ContractVersion $locked */
                    $locked = ContractVersion::query()->where('id', $version->id)->lockForUpdate()->firstOrFail();
                    ContractVersionLifecycle::requireTransition($locked->lifecycle_state, ContractVersionLifecycle::STATE_SUBMITTED);
                    $this->requireRules($locked);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => ContractVersionLifecycle::STATE_SUBMITTED, 'submitted_at' => now()]);
                    $locked->save();
                    $event = $this->audit->record($preparer->actorId, 'hr.contract_version.submit', 'contract_version', $locked->id, $before, ['lifecycle_state' => ContractVersionLifecycle::STATE_SUBMITTED]);

                    return ['version_id' => $locked->id, 'lifecycle_state' => ContractVersionLifecycle::STATE_SUBMITTED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $preparer, 'hr.contract_version.submit', 'contract_version', $version->id);
        }
    }

    /**
     * @return array{version_id: string, lifecycle_state: string, correlation_id: string}
     */
    public function withdraw(Actor $preparer, ContractVersion $version, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.contract_version.withdraw', $version->id, $preparer->actorId]));

        try {
            return $this->idempotency->execute('hr.contract_version.withdraw', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($preparer, $version): array {
                    $this->require($preparer, self::CAPABILITY_PREPARE);

                    /** @var ContractVersion $locked */
                    $locked = ContractVersion::query()->where('id', $version->id)->lockForUpdate()->firstOrFail();
                    ContractVersionLifecycle::requireTransition($locked->lifecycle_state, ContractVersionLifecycle::STATE_WITHDRAWN);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => ContractVersionLifecycle::STATE_WITHDRAWN]);
                    $locked->save();
                    $event = $this->audit->record($preparer->actorId, 'hr.contract_version.withdraw', 'contract_version', $locked->id, $before, ['lifecycle_state' => ContractVersionLifecycle::STATE_WITHDRAWN]);

                    return ['version_id' => $locked->id, 'lifecycle_state' => ContractVersionLifecycle::STATE_WITHDRAWN, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $preparer, 'hr.contract_version.withdraw', 'contract_version', $version->id);
        }
    }

    /**
     * @return array{version_id: string, lifecycle_state: string, approval_digest: string, correlation_id: string}
     */
    public function approve(Actor $approver, ContractVersion $version, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.contract_version.approve', $version->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('hr.contract_version.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $version): array {
                    $this->require($approver, self::CAPABILITY_APPROVE);

                    /** @var ContractVersion $locked */
                    $locked = ContractVersion::query()->where('id', $version->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== ContractVersionLifecycle::STATE_SUBMITTED) {
                        throw BusinessRejection::forCode('hr.contract_version_not_submitted', 'only a submitted version can be approved');
                    }
                    if (trim((string) $locked->prepared_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('hr.contract_version_not_independent', 'the approver must differ from the preparer');
                    }
                    /** @var Contract $contract */
                    $contract = Contract::query()->where('id', $locked->contract_id)->lockForUpdate()->firstOrFail();
                    /** @var Employment $employment */
                    $employment = Employment::query()->where('id', $contract->employment_id)->firstOrFail();
                    if (trim((string) $employment->person_id) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('hr.contract_version_beneficiary', 'the beneficiary may never approve their own contract');
                    }
                    $this->requireRules($locked);

                    /** @var list<CompensationRule> $rules */
                    $rules = CompensationRule::query()->where('contract_version_id', $locked->id)->orderBy('id')->get()->all();
                    foreach ($rules as $rule) {
                        if ($rule->scale_id !== null && $rule->scale_id !== $locked->scale_id) {
                            throw BusinessRejection::forCode('hr.compensation_rule_scale_mismatch', 'a scale-keyed rate must match the scale pinned by its version');
                        }
                    }

                    $cutoff = (new CarbonImmutable($locked->effective_from))->subDay()->toDateString();
                    /** @var list<ContractVersion> $inForce */
                    $inForce = ContractVersion::query()
                        ->where('contract_id', $contract->id)
                        ->where('id', '<>', $locked->id)
                        ->whereIn('lifecycle_state', ContractVersionLifecycle::IN_FORCE_STATES)
                        ->where('effective_from', '<', $locked->effective_from)
                        ->lockForUpdate()
                        ->get()->all();
                    $overlapping = ContractVersion::query()
                        ->where('contract_id', $contract->id)
                        ->where('id', '<>', $locked->id)
                        ->whereIn('lifecycle_state', ContractVersionLifecycle::IN_FORCE_STATES)
                        ->where('effective_from', '>=', $locked->effective_from)
                        ->exists();
                    if ($overlapping) {
                        throw BusinessRejection::forCode('hr.contract_version_backdated', 'a version cannot take effect before an already in-force version of this contract');
                    }

                    $digest = hash('sha256', json_encode([
                        'contract_version_id' => $locked->id,
                        'contract_id' => $contract->id,
                        'version_no' => $locked->version_no,
                        'terms_ref' => $locked->terms_ref,
                        'scale_id' => $locked->scale_id,
                        'effective_from' => $locked->effective_from,
                        'effective_to' => $locked->effective_to,
                        'prepared_by' => $locked->prepared_by,
                        'rules' => array_map(static fn (CompensationRule $rule): array => [
                            'method' => $rule->method, 'skill_id' => $rule->skill_id, 'scale_id' => $rule->scale_id, 'label' => $rule->label, 'rate' => $rule->rate,
                        ], $rules),
                    ], JSON_THROW_ON_ERROR));

                    $finalState = $locked->effective_from <= now()->toDateString()
                        ? ContractVersionLifecycle::STATE_ACTIVE
                        : ContractVersionLifecycle::STATE_APPROVED;
                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill([
                        'lifecycle_state' => $finalState,
                        'approved_by' => $approver->actorId,
                        'approved_at' => now(),
                        'approval_digest' => $digest,
                    ]);
                    $locked->save();

                    foreach ($inForce as $prior) {
                        if ($prior->effective_to === null || $prior->effective_to > $cutoff) {
                            $prior->forceFill(['lifecycle_state' => ContractVersionLifecycle::STATE_SUPERSEDED, 'effective_to' => $cutoff]);
                            $prior->save();
                            $this->audit->record($approver->actorId, 'hr.contract_version.supersede', 'contract_version', $prior->id, ['lifecycle_state' => ContractVersionLifecycle::STATE_ACTIVE], ['lifecycle_state' => ContractVersionLifecycle::STATE_SUPERSEDED, 'effective_to' => $cutoff]);
                        }
                    }

                    if ($contract->lifecycle_state === ContractLifecycle::STATE_DRAFT) {
                        $contract->forceFill([
                            'lifecycle_state' => ContractLifecycle::STATE_ACTIVE,
                            'signed_ref' => 'contract-version/'.$locked->id,
                            'signed_by' => $approver->actorId,
                        ]);
                        $contract->save();
                    }

                    $event = $this->audit->record($approver->actorId, 'hr.contract_version.approve', 'contract_version', $locked->id, $before, [
                        'lifecycle_state' => $finalState, 'approved_by' => $approver->actorId, 'approval_digest' => $digest,
                    ]);

                    return ['version_id' => $locked->id, 'lifecycle_state' => $finalState, 'approval_digest' => $digest, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'hr.contract_version.approve', 'contract_version', $version->id);
        }
    }

    private function requireRules(ContractVersion $version): void
    {
        if (CompensationRule::query()->where('contract_version_id', $version->id)->doesntExist()) {
            throw BusinessRejection::forCode('hr.contract_version_no_rules', 'a contract version requires at least one compensation rule before it can advance');
        }
    }

    private function require(Actor $actor, string $capability): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('hr.contract_version_denied', $outcome->reason);
        }
    }
}
