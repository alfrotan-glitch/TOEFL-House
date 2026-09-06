<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Academic\Models\TeacherAssignmentSkill;
use App\Modules\Academic\Models\TeacherProfile;
use App\Modules\Academic\Models\TeacherSkillAuthority;
use App\Modules\Academic\Models\TeacherAvailability;
use App\Modules\Academic\Models\TeacherWorkloadLimit;
use App\Modules\Hr\Models\Employment;
use App\Modules\Hr\Models\EmploymentStatus;
use App\Modules\Hr\Models\Leave;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Carbon\CarbonImmutable;
use DateTimeImmutable;

/**
 * The single policy seam for teacher capability and delivery authority.
 *
 * Person identity, HR employment, position labels, and React state are not
 * teacher authority. A teacher action needs a verified person, an active
 * canonical TeacherProfile, effective branch authorization, current
 * employment/leave state, and an assignment covering the academic date.
 * Governance actors can use an explicit academic capability, never an
 * inferred identity shortcut.
 */
final class TeacherAuthority
{
    public function __construct(
        private readonly AccessDecision $access,
    ) {}

    public function assertAssignable(
        Actor $actor,
        ClassModel $class,
        string $personId,
        CarbonImmutable $effectiveFrom,
        ?CarbonImmutable $effectiveTo,
    ): TeacherProfile {
        $branchId = trim((string) ($class->branch_id ?? ''));
        if ($branchId === '') {
            throw BusinessRejection::forCode('academic.teacher_branch_required', 'teacher assignment requires class branch provenance');
        }
        $this->requireCapability($actor, 'academic.schedule', $this->branchScope($branchId), 'academic.teacher_assignment_denied');

        /** @var Person|null $person */
        $person = Person::query()->find($personId);
        if ($person === null || ! $person->isVerified()) {
            throw BusinessRejection::forCode('academic.teacher_identity_not_verified', 'teacher authority requires a verified person identity');
        }
        /** @var TeacherProfile|null $profile */
        $profile = TeacherProfile::query()->where('person_id', $person->id)->first();
        if ($profile === null || $profile->lifecycle_state !== TeacherProfile::STATE_ACTIVE) {
            throw BusinessRejection::forCode('academic.teacher_profile_inactive', 'the person has no active canonical teacher profile');
        }
        $this->assertProfileOperational($profile, $effectiveFrom);
        $this->assertBranchAuthorization($profile, $branchId, $effectiveFrom);
        if ($effectiveTo !== null) {
            $lastEffectiveDay = $effectiveTo->subDay();
            $this->assertProfileOperational($profile, $lastEffectiveDay);
            $this->assertBranchAuthorization($profile, $branchId, $lastEffectiveDay);
            if (Leave::query()->where('employment_id', $profile->employment_id)->where('lifecycle_state', 'approved')->where('date_from', '<=', $lastEffectiveDay->toDateString())->where('date_to', '>=', $effectiveFrom->toDateString())->exists()) {
                throw BusinessRejection::forCode('academic.teacher_on_leave', 'teacher assignment cannot span approved leave');
            }
        }
        if (! TeacherProfile::query()->whereKey($profile->id)->whereHas('qualifications', function ($query) use ($effectiveFrom, $effectiveTo): void {
            $query->where('lifecycle_state', 'verified')
                ->where(function ($valid) use ($effectiveFrom): void {
                    $valid->whereNull('valid_from')->orWhere('valid_from', '<=', $effectiveFrom->toDateString());
                })
                ->where(function ($valid) use ($effectiveFrom, $effectiveTo): void {
                    $valid->whereNull('valid_to')->orWhere('valid_to', '>=', ($effectiveTo?->subDay() ?? $effectiveFrom)->toDateString());
                });
        })->exists()) {
            throw BusinessRejection::forCode('academic.teacher_qualification_missing', 'teacher assignment requires a current verified qualification');
        }

        return $profile;
    }

    /**
     * Validate a session has an operational assigned teacher and no timetable
     * conflict. Called before a new session is written; direct SQL is also
     * protected by the assignment/session database guards.
     */
    public function assertClassCanDeliver(
        ClassModel $class,
        CarbonImmutable $scheduledOn,
        string $startsAt,
        string $endsAt,
        ?string $skillId,
    ): void {
        $assignments = TeacherAssignment::query()
            ->where('class_id', $class->id)
            ->where(fn ($state) => $state->whereNull('lifecycle_state')->orWhere('lifecycle_state', '!=', 'cancelled'))
            ->where('effective_from', '<=', $scheduledOn->toDateString())
            ->where(function ($query) use ($scheduledOn): void {
                $query->whereNull('effective_to')->orWhere('effective_to', '>', $scheduledOn->toDateString());
            })
            ->get();
        if ($assignments->isEmpty()) {
            throw BusinessRejection::forCode('academic.teacher_assignment_required', 'a session requires an effective teacher assignment');
        }

        $delivererFound = false;
        foreach ($assignments as $assignment) {
            if ($assignment->teacher_profile_id === null) {
                continue;
            }
            /** @var TeacherProfile|null $profile */
            $profile = TeacherProfile::query()->find($assignment->teacher_profile_id);
            if ($profile === null
                || $assignment->teacher_person_id !== $profile->person_id
                || (string) $assignment->branch_id !== (string) $class->branch_id) {
                continue;
            }
            try {
                $this->assertProfileOperational($profile, $scheduledOn);
                $this->assertQualification($profile, $scheduledOn);
                $this->assertAvailability($profile, (string) $class->branch_id, $scheduledOn, $startsAt, $endsAt);
                if ($skillId !== null && $skillId !== '') {
                    if (! TeacherAssignmentSkill::query()->where('teacher_assignment_id', $assignment->id)->where('skill_id', $skillId)->exists()) {
                        throw BusinessRejection::forCode('academic.teacher_assignment_skill_missing', 'the session skill must be attributed to the effective teacher assignment');
                    }
                    $this->assertSkillAuthority($profile, $skillId, 'teach', $scheduledOn, (string) $class->branch_id);
                }
                $this->assertNoTimetableConflict($assignment, $class, $scheduledOn, $startsAt, $endsAt);
                $this->assertWorkload($profile, (string) $class->branch_id, $scheduledOn, $startsAt, $endsAt);
                $delivererFound = true;
                break;
            } catch (BusinessRejection) {
                continue;
            }
        }
        if (! $delivererFound) {
            throw BusinessRejection::forCode('academic.teacher_delivery_unauthorized', 'no assigned teacher is qualified, available, and operational for this session');
        }
    }

    /**
     * Attendance and teacher assessment actions use the actor's assignment.
     * A non-teacher governance actor must hold an explicit branch capability;
     * no person/position inference is used as a substitute.
     */
    public function requireActorDeliveryAuthority(
        Actor $actor,
        ClassModel $class,
        CarbonImmutable $on,
        ?string $skillId,
        string $capability,
        string $errorCode,
    ): void {
        $branchId = trim((string) ($class->branch_id ?? ''));
        $this->requireCapability($actor, $capability, $this->branchScope($branchId), $errorCode);

        /** @var TeacherProfile|null $profile */
        $profile = TeacherProfile::query()->where('person_id', $actor->actorId)->first();
        if ($profile === null) {
            // The explicit capability is the governance path for assessors,
            // moderators, and academic officers; it is not a teacher shortcut.
            return;
        }
        $assignment = TeacherAssignment::query()
            ->where('class_id', $class->id)
            ->where('teacher_person_id', $actor->actorId)
            ->where(fn ($state) => $state->whereNull('lifecycle_state')->orWhere('lifecycle_state', '!=', 'cancelled'))
            ->where('effective_from', '<=', $on->toDateString())
            ->where(function ($query) use ($on): void {
                $query->whereNull('effective_to')->orWhere('effective_to', '>', $on->toDateString());
            })
            ->first();
        if ($assignment === null || $assignment->teacher_profile_id !== $profile->id) {
            throw AuthorizationDenied::forCode('academic.teacher_assignment_denied', 'teacher actions require an effective assignment to this class');
        }
        $this->assertProfileOperational($profile, $on);
        $this->assertQualification($profile, $on);
        $this->assertBranchAuthorization($profile, $branchId, $on);
        if ($skillId !== null && $skillId !== '') {
            $this->assertSkillAuthority($profile, $skillId, str_contains($capability, 'assess') ? 'assess' : 'teach', $on, $branchId);
        } elseif (str_contains($capability, 'assess')) {
            $hasAssessmentAuthority = TeacherSkillAuthority::query()
                ->where('teacher_profile_id', $profile->id)
                ->where('branch_id', $branchId)
                ->where('authority_kind', 'assess')
                ->where('lifecycle_state', 'active')
                ->where('effective_from', '<=', $on->toDateString())
                ->where(function ($query) use ($on): void {
                    $query->whereNull('effective_to')->orWhere('effective_to', '>', $on->toDateString());
                })
                ->whereIn('skill_id', TeacherAssignmentSkill::query()->where('teacher_assignment_id', $assignment->id)->select('skill_id'))
                ->exists();
            if (! $hasAssessmentAuthority) {
                throw AuthorizationDenied::forCode('academic.teacher_assessment_authority_denied', 'teacher assessment actions require effective assess authority for an assigned skill');
            }
        }
    }

    public function assertQualification(TeacherProfile $profile, CarbonImmutable $on): void
    {
        if (! $profile->qualifications()->where('lifecycle_state', 'verified')->where(function ($query) use ($on): void {
            $query->whereNull('valid_from')->orWhere('valid_from', '<=', $on->toDateString());
        })->where(function ($query) use ($on): void {
            $query->whereNull('valid_to')->orWhere('valid_to', '>=', $on->toDateString());
        })->exists()) {
            throw BusinessRejection::forCode('academic.teacher_qualification_missing', 'teacher delivery requires a current verified qualification');
        }
    }

    public function assertSkillAuthority(TeacherProfile $profile, string $skillId, string $kind, CarbonImmutable $on, ?string $branchId = null): void
    {
        $query = TeacherSkillAuthority::query()
            ->where('teacher_profile_id', $profile->id)
            ->where('skill_id', $skillId);
        if ($branchId !== null && $branchId !== '') {
            $query->where('branch_id', $branchId);
        }
        if (! $query
            ->where('authority_kind', $kind)
            ->where('lifecycle_state', 'active')
            ->where('effective_from', '<=', $on->toDateString())
            ->where(function ($query) use ($on): void {
                $query->whereNull('effective_to')->orWhere('effective_to', '>', $on->toDateString());
            })->exists()) {
            throw BusinessRejection::forCode('academic.teacher_subject_authority_missing', 'the teacher lacks effective authority for this subject or skill');
        }
    }

    public function assertSkillAuthorityForWindow(
        TeacherProfile $profile,
        string $skillId,
        string $kind,
        CarbonImmutable $startsOn,
        ?CarbonImmutable $endsOn,
        ?string $branchId = null,
    ): void {
        $query = TeacherSkillAuthority::query()
            ->where('teacher_profile_id', $profile->id)
            ->where('skill_id', $skillId)
            ->where('authority_kind', $kind)
            ->where('lifecycle_state', 'active')
            ->where('effective_from', '<=', $startsOn->toDateString())
            ->where(function ($valid) use ($endsOn): void {
                if ($endsOn === null) {
                    $valid->whereNull('effective_to');
                    return;
                }
                $valid->whereNull('effective_to')->orWhere('effective_to', '>=', $endsOn->toDateString());
            });
        if ($branchId !== null && $branchId !== '') {
            $query->where('branch_id', $branchId);
        }
        if (! $query->exists()) {
            throw BusinessRejection::forCode('academic.teacher_subject_authority_missing', 'the teacher lacks effective authority for this subject or skill window');
        }
    }

    private function assertProfileOperational(TeacherProfile $profile, CarbonImmutable $on): void
    {
        if ($profile->lifecycle_state !== TeacherProfile::STATE_ACTIVE) {
            throw BusinessRejection::forCode('academic.teacher_profile_inactive', 'teacher profile is not active for this academic action');
        }
        /** @var Employment|null $employment */
        $employment = Employment::query()->whereKey($profile->employment_id)->where('person_id', $profile->person_id)->first();
        if ($employment === null) {
            throw BusinessRejection::forCode('academic.teacher_employment_inactive', 'teacher employment is not active for this academic action');
        }
        $status = EmploymentStatus::query()->where('employment_id', $employment->id)->where('effective_from', '<=', $on->toDateString())->orderByDesc('effective_from')->orderByDesc('created_at')->orderByDesc('id')->first();
        $effectiveEmploymentState = $status !== null ? $status->status : $employment->lifecycle_state;
        if ($effectiveEmploymentState !== 'active') {
            throw BusinessRejection::forCode('academic.teacher_status_inactive', 'teacher employment status is not active on the academic date');
        }
        if (Leave::query()->where('employment_id', $employment->id)->where('lifecycle_state', 'approved')->where('date_from', '<=', $on->toDateString())->where('date_to', '>=', $on->toDateString())->exists()) {
            throw BusinessRejection::forCode('academic.teacher_on_leave', 'teacher is on approved leave for the academic date');
        }
    }

    private function assertBranchAuthorization(TeacherProfile $profile, string $branchId, CarbonImmutable $on): void
    {
        if (! $profile->branchAuthorizations()->where('branch_id', $branchId)->where('lifecycle_state', 'active')->where('effective_from', '<=', $on->toDateString())->where(function ($query) use ($on): void {
            $query->whereNull('effective_to')->orWhere('effective_to', '>', $on->toDateString());
        })->exists()) {
            throw BusinessRejection::forCode('academic.teacher_branch_unauthorized', 'teacher profile is not authorized for this branch on the effective date');
        }
    }

    private function assertAvailability(TeacherProfile $profile, string $branchId, CarbonImmutable $on, string $startsAt, string $endsAt): void
    {
        $start = DateTimeImmutable::createFromFormat('!H:i', $startsAt);
        $end = DateTimeImmutable::createFromFormat('!H:i', $endsAt);
        if ($start === false || $end === false || $end <= $start) {
            throw BusinessRejection::forCode('academic.teacher_time_invalid', 'teacher delivery requires a valid time window');
        }
        $available = TeacherAvailability::query()->where('teacher_profile_id', $profile->id)->where('branch_id', $branchId)->where('weekday', $on->dayOfWeekIso)->where('availability_kind', 'available')->where('lifecycle_state', 'active')->where('effective_from', '<=', $on->toDateString())->where(function ($query) use ($on): void {
            $query->whereNull('effective_to')->orWhere('effective_to', '>', $on->toDateString());
        })->where('starts_at', '<=', $startsAt)->where('ends_at', '>=', $endsAt)->exists();
        if (! $available) {
            throw BusinessRejection::forCode('academic.teacher_unavailable', 'teacher availability does not cover this delivery window');
        }
    }

    private function assertWorkload(TeacherProfile $profile, string $branchId, CarbonImmutable $on, string $startsAt, string $endsAt): void
    {
        /** @var TeacherWorkloadLimit|null $limit */
        $limit = TeacherWorkloadLimit::query()->where('teacher_profile_id', $profile->id)->where('branch_id', $branchId)->where('lifecycle_state', 'active')->where('effective_from', '<=', $on->toDateString())->where(function ($query) use ($on): void {
            $query->whereNull('effective_to')->orWhere('effective_to', '>', $on->toDateString());
        })->orderByDesc('effective_from')->first();
        if ($limit === null) {
            return;
        }
        $proposed = CarbonImmutable::parse($on->toDateString().' '.$endsAt)->diffInMinutes(CarbonImmutable::parse($on->toDateString().' '.$startsAt)) / 60;
        $used = 0.0;
        $sessions = ClassSession::query()->whereBetween('scheduled_on', [$on->startOfWeek()->toDateString(), $on->endOfWeek()->toDateString()])->get();
        foreach ($sessions as $session) {
            if (! TeacherAssignment::query()->where('class_id', $session->class_id)->where('teacher_profile_id', $profile->id)->where('branch_id', $branchId)->where(fn ($state) => $state->whereNull('lifecycle_state')->orWhere('lifecycle_state', '!=', 'cancelled'))->where('effective_from', '<=', $session->scheduled_on)->where(function ($query) use ($session): void {
                $query->whereNull('effective_to')->orWhere('effective_to', '>', $session->scheduled_on);
            })->exists()) {
                continue;
            }
            $used += CarbonImmutable::parse((string) $session->scheduled_on.' '.$session->ends_at)->diffInMinutes(CarbonImmutable::parse((string) $session->scheduled_on.' '.$session->starts_at)) / 60;
        }
        if ($used + $proposed > (float) $limit->max_hours_per_week) {
            throw BusinessRejection::forCode('academic.teacher_workload_exceeded', 'the proposed session would exceed the teacher weekly workload limit');
        }
    }

    private function assertNoTimetableConflict(TeacherAssignment $assignment, ClassModel $class, CarbonImmutable $on, string $startsAt, string $endsAt): void
    {
        $sessions = ClassSession::query()->where('scheduled_on', $on->toDateString())->where('starts_at', '<', $endsAt)->where('ends_at', '>', $startsAt)->get();
        foreach ($sessions as $session) {
            if ($session->id === null) {
                continue;
            }
            $conflict = TeacherAssignment::query()->where('class_id', $session->class_id)->where('teacher_person_id', $assignment->teacher_person_id)->where(fn ($state) => $state->whereNull('lifecycle_state')->orWhere('lifecycle_state', '!=', 'cancelled'))->where('effective_from', '<=', $on->toDateString())->where(function ($query) use ($on): void {
                $query->whereNull('effective_to')->orWhere('effective_to', '>', $on->toDateString());
            })->exists();
            if ($conflict) {
                throw BusinessRejection::forCode('academic.teacher_schedule_conflict', 'teacher delivery windows overlap another assigned class session');
            }
        }
    }

    private function requireCapability(Actor $actor, string $capability, ?\App\Support\Authorization\StructureScope $scope, string $errorCode): void
    {
        $decision = $this->access->decide($actor, $capability, $scope);
        if (! $decision->allowed) {
            throw AuthorizationDenied::forCode($errorCode, $decision->reason);
        }
    }

    private function branchScope(string $branchId): \App\Support\Authorization\StructureScope
    {
        $branch = trim($branchId) === '' ? null : Branch::query()->whereKey($branchId)->first();
        $scope = $branch?->structureScope();
        if ($branch === null || $branch->lifecycle_state !== 'active' || $scope === null || $scope->organizationId === '' || $scope->campusId === null) {
            throw BusinessRejection::forCode('academic.teacher_branch_provenance_required', 'teacher authority requires active branch, campus, and organization provenance');
        }
        return $scope;
    }
}
