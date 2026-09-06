<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Models\Skill;
use App\Modules\Academic\Models\TeacherAvailability;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Academic\Models\TeacherProfile;
use App\Modules\Academic\Models\TeacherProfileBranch;
use App\Modules\Academic\Models\TeacherProfileStatus;
use App\Modules\Academic\Models\TeacherQualification;
use App\Modules\Academic\Models\TeacherSkillAuthority;
use App\Modules\Academic\Models\TeacherWorkloadLimit;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Models\Employment;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Teacher/Faculty capability lifecycle. This command is the only writer for
 * profile, qualification, branch provenance, subject authority, and declared
 * availability facts; HR remains the writer for employment and leave.
 */
final class MaintainTeacherProfile
{
    public const CAPABILITY = 'academic.teacher_manage';
    public const CAPABILITY_APPROVE = 'academic.teacher_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{teacher_profile_id: string, correlation_id: string} */
    public function register(Actor $actor, Employment $employment, string $professionalTitle, ?string $summary, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.teacher.register', $employment->id, $professionalTitle, $summary ?? '', $actor->actorId]));
        try {
            return $this->idempotency->execute('academic.teacher.register', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $employment, $professionalTitle, $summary): array {
                    /** @var Employment $locked */
                    $locked = Employment::query()->whereKey($employment->id)->lockForUpdate()->firstOrFail();
                    $person = Person::query()->find($locked->person_id);
                    if ($person === null || ! $person->isVerified()) {
                        throw BusinessRejection::forCode('academic.teacher_identity_not_verified', 'a teacher profile requires verified person identity');
                    }
                    $branch = Branch::query()->whereKey($person->home_branch_id)->first();
                    $this->require($actor, self::CAPABILITY, $branch);
                    if ($locked->lifecycle_state !== 'active') {
                        throw BusinessRejection::forCode('academic.teacher_employment_inactive', 'a teacher profile requires active employment');
                    }
                    if (TeacherProfile::query()->where('person_id', $person->id)->exists()) {
                        throw BusinessRejection::forCode('academic.teacher_profile_exists', 'the person already has a canonical teacher profile');
                    }
                    if (trim($professionalTitle) === '') {
                        throw BusinessRejection::forCode('academic.teacher_title_required', 'a teacher profile requires a professional title');
                    }
                    if ($branch === null || $branch->lifecycle_state !== 'active') {
                        throw BusinessRejection::forCode('academic.teacher_branch_required', 'teacher profile requires active branch provenance');
                    }
                    $profile = TeacherProfile::query()->create([
                        'id' => RandomIdentifier::new(),
                        'person_id' => $person->id,
                        'employment_id' => $locked->id,
                        'originating_branch_id' => $branch->id,
                        'current_home_branch_id' => $branch->id,
                        'lifecycle_state' => TeacherProfile::STATE_PENDING,
                        'professional_title' => $professionalTitle,
                        'profile_summary' => $summary,
                    ]);
                    TeacherProfileStatus::query()->create([
                        'id' => RandomIdentifier::new(), 'teacher_profile_id' => $profile->id,
                        'status' => TeacherProfile::STATE_PENDING, 'effective_from' => CarbonImmutable::today()->toDateString(),
                        'reason' => 'teacher profile registered', 'actor_id' => $actor->actorId,
                    ]);
                    TeacherProfileBranch::query()->create([
                        'id' => RandomIdentifier::new(),
                        'teacher_profile_id' => $profile->id,
                        'branch_id' => $branch->id,
                        'effective_from' => CarbonImmutable::today()->toDateString(),
                        'effective_to' => null,
                        'lifecycle_state' => 'active',
                        'provenance_reason' => 'originating verified person branch',
                        'approved_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.register', 'teacher_profile', $profile->id, null, [
                        'person_id' => $person->id, 'employment_id' => $locked->id, 'branch_id' => $branch->id,
                        'lifecycle_state' => TeacherProfile::STATE_PENDING,
                    ]);
                    return ['teacher_profile_id' => $profile->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.register', 'teacher_profile', $employment->id);
        }
    }

    /** @return array{qualification_id: string, correlation_id: string} */
    public function addQualification(Actor $actor, TeacherProfile $profile, string $type, string $title, string $issuer, string $evidenceRef, ?string $validFrom, ?string $validTo, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.teacher.qualification.add', $profile->id, $type, $title, $issuer, $evidenceRef, $actor->actorId]));
        try {
            return $this->idempotency->execute('academic.teacher.qualification.add', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $profile, $type, $title, $issuer, $evidenceRef, $validFrom, $validTo): array {
                    $locked = TeacherProfile::query()->whereKey($profile->id)->lockForUpdate()->firstOrFail();
                    $this->require($actor, self::CAPABILITY, Branch::query()->whereKey($locked->current_home_branch_id)->first());
                    foreach ([$type, $title, $issuer, $evidenceRef] as $value) {
                        if (trim($value) === '') {
                            throw BusinessRejection::forCode('academic.teacher_qualification_incomplete', 'qualification type, title, issuer, and evidence are required');
                        }
                    }
                    if ($validFrom !== null && $validTo !== null && $validTo < $validFrom) {
                        throw BusinessRejection::forCode('academic.teacher_qualification_period', 'qualification validity must end on or after its start');
                    }
                    $qualification = TeacherQualification::query()->create([
                        'id' => RandomIdentifier::new(), 'teacher_profile_id' => $locked->id,
                        'qualification_type' => $type, 'title' => $title, 'issuer' => $issuer,
                        'evidence_ref' => $evidenceRef, 'submitted_by' => $actor->actorId, 'valid_from' => $validFrom, 'valid_to' => $validTo,
                        'lifecycle_state' => 'pending',
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.qualification.add', 'teacher_qualification', $qualification->id, null, ['teacher_profile_id' => $locked->id, 'evidence_ref' => $evidenceRef]);
                    return ['qualification_id' => $qualification->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.qualification.add', 'teacher_profile', $profile->id);
        }
    }

    /** @return array{qualification_id: string, correlation_id: string} */
    public function verifyQualification(Actor $actor, TeacherQualification $qualification, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.teacher.qualification.verify', $qualification->id, $actor->actorId]));
        try {
            return $this->idempotency->execute('academic.teacher.qualification.verify', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $qualification): array {
                    $locked = TeacherQualification::query()->whereKey($qualification->id)->lockForUpdate()->firstOrFail();
                    $profile = TeacherProfile::query()->whereKey($locked->teacher_profile_id)->lockForUpdate()->firstOrFail();
                    $this->require($actor, self::CAPABILITY_APPROVE, Branch::query()->whereKey($profile->current_home_branch_id)->first());
                    if ($locked->lifecycle_state !== 'pending') {
                        throw BusinessRejection::forCode('academic.teacher_qualification_state', 'only a pending qualification can be verified');
                    }
                    if ($locked->submitted_by === $actor->actorId) {
                        throw AuthorizationDenied::forCode('academic.teacher_qualification_independent', 'qualification verification requires a distinct verifier');
                    }
                    $locked->forceFill(['lifecycle_state' => 'verified', 'verified_by' => $actor->actorId, 'verified_at' => now()])->save();
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.qualification.verify', 'teacher_qualification', $locked->id, ['lifecycle_state' => 'pending'], ['lifecycle_state' => 'verified', 'teacher_profile_id' => $profile->id]);
                    return ['qualification_id' => $locked->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.qualification.verify', 'teacher_qualification', $qualification->id);
        }
    }

    /** @return array{teacher_profile_id: string, lifecycle_state: string, correlation_id: string} */
    public function transition(Actor $actor, TeacherProfile $profile, string $toState, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.teacher.profile.transition', $profile->id, $toState, $reason, $actor->actorId]));
        try {
            return $this->idempotency->execute('academic.teacher.profile.transition', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $profile, $toState, $reason): array {
                    $locked = TeacherProfile::query()->whereKey($profile->id)->lockForUpdate()->firstOrFail();
                    $this->require($actor, self::CAPABILITY_APPROVE, Branch::query()->whereKey($locked->current_home_branch_id)->first());
                    if (! in_array($toState, [TeacherProfile::STATE_ACTIVE, TeacherProfile::STATE_SUSPENDED, TeacherProfile::STATE_RETIRED], true)) {
                        throw BusinessRejection::forCode('academic.teacher_state_unknown', 'unsupported teacher profile state');
                    }
                    $allowed = TeacherProfile::allowedTransitions((string) $locked->lifecycle_state);
                    if (! in_array($toState, $allowed, true)) {
                        throw BusinessRejection::forCode('academic.teacher_transition_forbidden', 'teacher profile lifecycle transition is not allowed');
                    }
                    if (trim($reason) === '') {
                        throw BusinessRejection::forCode('academic.teacher_state_reason', 'teacher profile transitions require a reason');
                    }
                    if ($toState === TeacherProfile::STATE_ACTIVE) {
                        $this->assertActivationFacts($locked);
                    }
                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState, 'approved_by' => $actor->actorId, 'approved_at' => now()])->save();
                    TeacherProfileStatus::query()->create([
                        'id' => RandomIdentifier::new(), 'teacher_profile_id' => $locked->id,
                        'status' => $toState, 'effective_from' => CarbonImmutable::today()->toDateString(),
                        'reason' => $reason, 'actor_id' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.profile.transition', 'teacher_profile', $locked->id, $before, ['lifecycle_state' => $toState, 'reason' => $reason]);
                    return ['teacher_profile_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.profile.transition', 'teacher_profile', $profile->id);
        }
    }

    /** @return array{teacher_profile_id: string, branch_id: string, correlation_id: string} */
    public function transferBranch(Actor $actor, TeacherProfile $profile, string $branchId, string $effectiveFrom, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.teacher.branch.transfer', $profile->id, $branchId, $effectiveFrom, $actor->actorId]));
        try {
            return $this->idempotency->execute('academic.teacher.branch.transfer', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $profile, $branchId, $effectiveFrom, $reason): array {
                    $locked = TeacherProfile::query()->whereKey($profile->id)->lockForUpdate()->firstOrFail();
                    $branch = Branch::query()->whereKey($branchId)->first();
                    $this->require($actor, self::CAPABILITY_APPROVE, $branch);
                    if ($branch === null || $branch->lifecycle_state !== 'active' || $locked->lifecycle_state !== TeacherProfile::STATE_ACTIVE || trim($reason) === '') {
                        throw BusinessRejection::forCode('academic.teacher_transfer_invalid', 'teacher transfer requires an active profile, active destination branch, and reason');
                    }
                    if (CarbonImmutable::parse($effectiveFrom)->startOfDay()->isFuture()) {
                        throw BusinessRejection::forCode('academic.teacher_transfer_future', 'a current-home branch transfer must take effect today or earlier');
                    }
                    if ((string) $locked->current_home_branch_id === $branchId) {
                        throw BusinessRejection::forCode('academic.teacher_transfer_same_branch', 'teacher transfer requires a different destination branch');
                    }
                    $previousAuthorization = TeacherProfileBranch::query()->where('teacher_profile_id', $locked->id)->where('branch_id', $locked->current_home_branch_id)->where('lifecycle_state', 'active')->whereNull('effective_to')->orderByDesc('effective_from')->first();
                    if ($previousAuthorization === null || $effectiveFrom <= (string) $previousAuthorization->effective_from) {
                        throw BusinessRejection::forCode('academic.teacher_transfer_period', 'teacher transfer must follow the current branch authorization start');
                    }
                    $activeAssignment = TeacherAssignment::query()->where('teacher_profile_id', $locked->id)->where('branch_id', '!=', $branchId)->where(fn ($state) => $state->whereNull('lifecycle_state')->orWhere('lifecycle_state', '!=', 'cancelled'))->where(function ($query) use ($effectiveFrom): void {
                        $query->whereNull('effective_to')->orWhere('effective_to', '>', $effectiveFrom);
                    })->where('effective_from', '<=', $effectiveFrom)->exists();
                    if ($activeAssignment) {
                        throw BusinessRejection::forCode('academic.teacher_transfer_assignments_open', 'teacher transfer requires handover or closure of assignments in the prior branch');
                    }
                    TeacherProfileBranch::query()->where('teacher_profile_id', $locked->id)->where('branch_id', $locked->current_home_branch_id)->where('lifecycle_state', 'active')->whereNull('effective_to')->update(['effective_to' => $effectiveFrom, 'lifecycle_state' => 'ended']);
                    $authorization = TeacherProfileBranch::query()->create([
                        'id' => RandomIdentifier::new(), 'teacher_profile_id' => $locked->id, 'branch_id' => $branch->id,
                        'effective_from' => $effectiveFrom, 'effective_to' => null, 'lifecycle_state' => 'active',
                        'provenance_reason' => $reason, 'approved_by' => $actor->actorId,
                    ]);
                    $locked->forceFill(['current_home_branch_id' => $branch->id])->save();
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.branch.transfer', 'teacher_profile', $locked->id, ['current_home_branch_id' => $profile->current_home_branch_id], ['current_home_branch_id' => $branch->id, 'branch_authorization_id' => $authorization->id, 'effective_from' => $effectiveFrom, 'reason' => $reason]);
                    return ['teacher_profile_id' => $locked->id, 'branch_id' => $branch->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.branch.transfer', 'teacher_profile', $profile->id);
        }
    }

    /** @return array{branch_authorization_id: string, correlation_id: string} */
    public function authorizeBranch(Actor $actor, TeacherProfile $profile, string $branchId, string $effectiveFrom, ?string $effectiveTo, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.teacher.branch.authorize', $profile->id, $branchId, $effectiveFrom, $effectiveTo ?? '', $actor->actorId]));
        try {
            return $this->idempotency->execute('academic.teacher.branch.authorize', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $profile, $branchId, $effectiveFrom, $effectiveTo, $reason): array {
                    $locked = TeacherProfile::query()->whereKey($profile->id)->lockForUpdate()->firstOrFail();
                    $branch = Branch::query()->whereKey($branchId)->first();
                    $this->require($actor, self::CAPABILITY_APPROVE, $branch);
                    if ($branch === null || $branch->lifecycle_state !== 'active' || trim($reason) === '') {
                        throw BusinessRejection::forCode('academic.teacher_branch_invalid', 'teacher branch authorization requires an active branch and reason');
                    }
                    if ($effectiveTo !== null && $effectiveTo <= $effectiveFrom) {
                        throw BusinessRejection::forCode('academic.teacher_branch_period', 'teacher branch authorization must end after it starts');
                    }
                    if (TeacherProfileBranch::query()->where('teacher_profile_id', $locked->id)->where('branch_id', $branchId)->where('lifecycle_state', 'active')->where('effective_from', '<', $effectiveTo ?? '9999-12-31')->where(function ($query) use ($effectiveFrom): void {
                        $query->whereNull('effective_to')->orWhere('effective_to', '>', $effectiveFrom);
                    })->exists()) {
                        throw BusinessRejection::forCode('academic.teacher_branch_overlap', 'teacher branch authorizations may not overlap');
                    }
                    $row = TeacherProfileBranch::query()->create([
                        'id' => RandomIdentifier::new(), 'teacher_profile_id' => $locked->id, 'branch_id' => $branch->id,
                        'effective_from' => $effectiveFrom, 'effective_to' => $effectiveTo, 'lifecycle_state' => 'active',
                        'provenance_reason' => $reason, 'approved_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.branch.authorize', 'teacher_profile_branch', $row->id, null, ['teacher_profile_id' => $locked->id, 'branch_id' => $branch->id, 'effective_from' => $effectiveFrom, 'effective_to' => $effectiveTo]);
                    return ['branch_authorization_id' => $row->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.branch.authorize', 'teacher_profile', $profile->id);
        }
    }

    /** @return array{skill_authority_id: string, correlation_id: string} */
    public function authorizeSkill(Actor $actor, TeacherProfile $profile, string $skillId, string $branchId, string $kind, string $effectiveFrom, ?string $effectiveTo, string $evidenceRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.teacher.skill.authorize', $profile->id, $skillId, $branchId, $kind, $effectiveFrom, $actor->actorId]));
        try {
            return $this->idempotency->execute('academic.teacher.skill.authorize', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $profile, $skillId, $branchId, $kind, $effectiveFrom, $effectiveTo, $evidenceRef): array {
                    $locked = TeacherProfile::query()->whereKey($profile->id)->lockForUpdate()->firstOrFail();
                    $branch = Branch::query()->whereKey($branchId)->first();
                    $this->require($actor, self::CAPABILITY_APPROVE, $branch);
                    if ($effectiveTo !== null && $effectiveTo <= $effectiveFrom) {
                        throw BusinessRejection::forCode('academic.teacher_skill_period', 'subject authority must end after it starts');
                    }
                    if ($branch === null || ! $locked->branchAuthorizations()->where('branch_id', $branchId)->where('lifecycle_state', 'active')->where('effective_from', '<=', $effectiveFrom)->where(function ($query) use ($effectiveFrom, $effectiveTo): void {
                        $query->whereNull('effective_to')->orWhere('effective_to', '>', $effectiveFrom)->when($effectiveTo !== null, fn ($valid) => $valid->where(function ($end) use ($effectiveTo): void {
                            $end->whereNull('effective_to')->orWhere('effective_to', '>=', $effectiveTo);
                        }));
                    })->exists()) {
                        throw BusinessRejection::forCode('academic.teacher_skill_branch_invalid', 'subject authority requires effective teacher branch authorization for its full window');
                    }
                    $skill = Skill::query()->whereKey($skillId)->first();
                    if ($skill === null || $skill->lifecycle_state !== Skill::STATE_ACTIVE || ! in_array($kind, ['teach', 'assess', 'moderate'], true) || trim($evidenceRef) === '') {
                        throw BusinessRejection::forCode('academic.teacher_skill_invalid', 'subject authority requires active skill, supported kind, and evidence');
                    }
                    if (TeacherSkillAuthority::query()->where('teacher_profile_id', $locked->id)->where('skill_id', $skill->id)->where('branch_id', $branchId)->where('authority_kind', $kind)->where('lifecycle_state', 'active')->where('effective_from', '<', $effectiveTo ?? '9999-12-31')->where(function ($query) use ($effectiveFrom): void {
                        $query->whereNull('effective_to')->orWhere('effective_to', '>', $effectiveFrom);
                    })->exists()) {
                        throw BusinessRejection::forCode('academic.teacher_skill_overlap', 'teacher subject authorities may not overlap');
                    }
                    $row = TeacherSkillAuthority::query()->create([
                        'id' => RandomIdentifier::new(), 'teacher_profile_id' => $locked->id, 'skill_id' => $skill->id,
                        'branch_id' => $branch->id,
                        'authority_kind' => $kind, 'effective_from' => $effectiveFrom, 'effective_to' => $effectiveTo,
                        'lifecycle_state' => 'active', 'approved_by' => $actor->actorId, 'evidence_ref' => $evidenceRef,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.skill.authorize', 'teacher_skill_authority', $row->id, null, ['teacher_profile_id' => $locked->id, 'skill_id' => $skill->id, 'authority_kind' => $kind]);
                    return ['skill_authority_id' => $row->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.skill.authorize', 'teacher_profile', $profile->id);
        }
    }

    /** @return array{availability_id: string, correlation_id: string} */
    public function declareAvailability(Actor $actor, TeacherProfile $profile, string $branchId, int $weekday, string $startsAt, string $endsAt, string $effectiveFrom, ?string $effectiveTo, string $kind, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.teacher.availability.declare', $profile->id, $branchId, $weekday, $startsAt, $endsAt, $effectiveFrom, $actor->actorId]));
        try {
            return $this->idempotency->execute('academic.teacher.availability.declare', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $profile, $branchId, $weekday, $startsAt, $endsAt, $effectiveFrom, $effectiveTo, $kind): array {
                    $locked = TeacherProfile::query()->whereKey($profile->id)->lockForUpdate()->firstOrFail();
                    $branch = Branch::query()->whereKey($branchId)->first();
                    $this->require($actor, self::CAPABILITY, $branch);
                    if ($branch === null || $locked->lifecycle_state !== TeacherProfile::STATE_ACTIVE || $weekday < 1 || $weekday > 7 || $kind !== 'available') {
                        throw BusinessRejection::forCode('academic.teacher_availability_invalid', 'availability requires an active profile, active branch, valid weekday, and available kind');
                    }
                    if ($endsAt <= $startsAt || ($effectiveTo !== null && $effectiveTo <= $effectiveFrom)) {
                        throw BusinessRejection::forCode('academic.teacher_availability_period', 'availability requires a positive time window and a valid effective period');
                    }
                    if (! $locked->branchAuthorizations()->where('branch_id', $branch->id)->where('lifecycle_state', 'active')->where('effective_from', '<=', $effectiveFrom)->where(function ($query) use ($effectiveFrom, $effectiveTo): void {
                        $query->whereNull('effective_to')->orWhere('effective_to', '>', $effectiveFrom)->when($effectiveTo !== null, fn ($valid) => $valid->where(function ($end) use ($effectiveTo): void {
                            $end->whereNull('effective_to')->orWhere('effective_to', '>=', $effectiveTo);
                        }));
                    })->exists()) {
                        throw BusinessRejection::forCode('academic.teacher_availability_branch_invalid', 'availability requires effective teacher branch authorization for its full window');
                    }
                    if (TeacherAvailability::query()->where('teacher_profile_id', $locked->id)->where('branch_id', $branch->id)->where('weekday', $weekday)->where('lifecycle_state', 'active')->where('starts_at', '<', $endsAt)->where('ends_at', '>', $startsAt)->where('effective_from', '<=', $effectiveFrom)->where(function ($query) use ($effectiveTo): void {
                        $query->whereNull('effective_to')->orWhere('effective_to', '>', $effectiveTo ?? $effectiveFrom);
                    })->exists()) {
                        throw BusinessRejection::forCode('academic.teacher_availability_overlap', 'teacher availability windows may not overlap');
                    }
                    $row = TeacherAvailability::query()->create([
                        'id' => RandomIdentifier::new(), 'teacher_profile_id' => $locked->id, 'weekday' => $weekday,
                        'starts_at' => $startsAt, 'ends_at' => $endsAt, 'effective_from' => $effectiveFrom,
                        'effective_to' => $effectiveTo, 'lifecycle_state' => 'active', 'availability_kind' => $kind, 'branch_id' => $branch->id,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.availability.declare', 'teacher_availability', $row->id, null, ['teacher_profile_id' => $locked->id, 'branch_id' => $branch->id, 'weekday' => $weekday]);
                    return ['availability_id' => $row->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.availability.declare', 'teacher_profile', $profile->id);
        }
    }

    /** @return array{workload_limit_id: string, correlation_id: string} */
    public function setWorkloadLimit(Actor $actor, TeacherProfile $profile, string $branchId, string $maxHoursPerWeek, string $effectiveFrom, ?string $effectiveTo, string $evidenceRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.teacher.workload.set', $profile->id, $branchId, $maxHoursPerWeek, $effectiveFrom, $actor->actorId]));
        try {
            return $this->idempotency->execute('academic.teacher.workload.set', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $profile, $branchId, $maxHoursPerWeek, $effectiveFrom, $effectiveTo, $evidenceRef): array {
                    $locked = TeacherProfile::query()->whereKey($profile->id)->lockForUpdate()->firstOrFail();
                    $branch = Branch::query()->whereKey($branchId)->first();
                    $this->require($actor, self::CAPABILITY_APPROVE, $branch);
                    if ($branch === null || trim($evidenceRef) === '' || preg_match('/^(?:0|[1-9]\\d{0,2})(?:\\.\\d{1,2})?$/', $maxHoursPerWeek) !== 1 || (float) $maxHoursPerWeek <= 0) {
                        throw BusinessRejection::forCode('academic.teacher_workload_invalid', 'workload requires an active branch, positive weekly hours, and evidence');
                    }
                    if ($effectiveTo !== null && $effectiveTo <= $effectiveFrom) {
                        throw BusinessRejection::forCode('academic.teacher_workload_period', 'workload limit must end after it starts');
                    }
                    if (! $locked->branchAuthorizations()->where('branch_id', $branchId)->where('lifecycle_state', 'active')->where('effective_from', '<=', $effectiveFrom)->where(function ($query) use ($effectiveFrom, $effectiveTo): void {
                        $query->whereNull('effective_to')->orWhere('effective_to', '>', $effectiveFrom)->when($effectiveTo !== null, fn ($valid) => $valid->where(function ($end) use ($effectiveTo): void {
                            $end->whereNull('effective_to')->orWhere('effective_to', '>=', $effectiveTo);
                        }));
                    })->exists()) {
                        throw BusinessRejection::forCode('academic.teacher_workload_branch_invalid', 'workload requires effective teacher branch authorization for its full window');
                    }
                    if (TeacherWorkloadLimit::query()->where('teacher_profile_id', $locked->id)->where('branch_id', $branchId)->where('lifecycle_state', 'active')->where('effective_from', '<', $effectiveTo ?? '9999-12-31')->where(function ($query) use ($effectiveFrom): void {
                        $query->whereNull('effective_to')->orWhere('effective_to', '>', $effectiveFrom);
                    })->exists()) {
                        throw BusinessRejection::forCode('academic.teacher_workload_overlap', 'teacher workload limits may not overlap');
                    }
                    $row = TeacherWorkloadLimit::query()->create([
                        'id' => RandomIdentifier::new(), 'teacher_profile_id' => $locked->id, 'branch_id' => $branch->id,
                        'max_hours_per_week' => $maxHoursPerWeek, 'effective_from' => $effectiveFrom, 'effective_to' => $effectiveTo,
                        'lifecycle_state' => 'active', 'approved_by' => $actor->actorId, 'evidence_ref' => $evidenceRef,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.workload.set', 'teacher_workload_limit', $row->id, null, ['teacher_profile_id' => $locked->id, 'branch_id' => $branch->id, 'max_hours_per_week' => $maxHoursPerWeek]);
                    return ['workload_limit_id' => $row->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.workload.set', 'teacher_profile', $profile->id);
        }
    }

    private function assertActivationFacts(TeacherProfile $profile): void
    {
        if (! Person::query()->whereKey($profile->person_id)->where('verification_state', 'verified')->exists()) {
            throw BusinessRejection::forCode('academic.teacher_identity_not_verified', 'teacher activation requires verified identity');
        }
        if (! Employment::query()->whereKey($profile->employment_id)->where('person_id', $profile->person_id)->where('lifecycle_state', 'active')->exists()) {
            throw BusinessRejection::forCode('academic.teacher_employment_inactive', 'teacher activation requires active employment');
        }
        if (! TeacherQualification::query()->where('teacher_profile_id', $profile->id)->where('lifecycle_state', 'verified')->where(function ($query): void {
            $query->whereNull('valid_from')->orWhere('valid_from', '<=', CarbonImmutable::today()->toDateString());
        })->where(function ($query): void {
            $query->whereNull('valid_to')->orWhere('valid_to', '>=', CarbonImmutable::today()->toDateString());
        })->exists()) {
            throw BusinessRejection::forCode('academic.teacher_qualification_missing', 'teacher activation requires a current verified qualification');
        }
        $today = CarbonImmutable::today()->toDateString();
        if (! TeacherProfileBranch::query()->where('teacher_profile_id', $profile->id)->where('branch_id', $profile->current_home_branch_id)->where('lifecycle_state', 'active')->where('effective_from', '<=', $today)->where(function ($query) use ($today): void {
            $query->whereNull('effective_to')->orWhere('effective_to', '>', $today);
        })->exists()) {
            throw BusinessRejection::forCode('academic.teacher_branch_required', 'teacher activation requires effective current-home branch authorization');
        }
    }

    private function require(Actor $actor, string $capability, ?Branch $branch): void
    {
        $decision = $this->access->decide($actor, $capability, $branch?->structureScope());
        if (! $decision->allowed) {
            throw AuthorizationDenied::forCode('academic.teacher_manage_denied', $decision->reason);
        }
    }
}
