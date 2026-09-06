<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\AcademicAccess;
use App\Modules\Academic\Domain\ClassLifecycle;
use App\Modules\Academic\Domain\ClassSectionLifecycle;
use App\Modules\Academic\Domain\EnrollmentLifecycle;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSection;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Organization\Models\Branch;
use App\Modules\Scheduling\Domain\SchedulingConstraints;
use App\Modules\Audit\AuditRecorder;
use App\Support\Authorization\Actor;
use App\Support\Authorization\ActorBranches;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Class and session control: a class delivers a published program version
 * in a published period with fixed capacity; sessions are scheduled on
 * active classes; Teacher assignment lifecycle is delegated to the
 * canonical MaintainTeacherAssignment command; cancellation preserves the
 * academic record.
 */
final class MaintainClass
{
    public const CAPABILITY = 'academic.schedule';

    public function __construct(
        private readonly AcademicAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly SchedulingConstraints $scheduling,
        private readonly MaintainTeacherAssignment $teacherAssignments,
        private readonly ActorBranches $branches,
    ) {}

    /** @return array{class_id: string, correlation_id: string} */
    public function defineClass(Actor $actor, string $programVersionId, string $periodId, int $capacity, string $idempotencyKey, ?string $programVersionLevelId = null, ?string $branchId = null, ?string $offeringId = null): array
    {
        $payload = hash('sha256', implode('|', ['academic.class.define', $programVersionId, $periodId, $capacity, $programVersionLevelId ?? '', $branchId ?? '', $offeringId ?? '', $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.class.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $programVersionId, $periodId, $capacity, $programVersionLevelId, $branchId, $offeringId): array {
                    $resolvedBranchId = $this->resolveClassBranch($actor, $branchId);
                    $this->requireCapability($actor, $resolvedBranchId);
                    if (! ProgramVersion::query()->whereKey($programVersionId)->whereHas('program', static fn ($query) => $query->where('lifecycle_state', 'published'))->exists()) {
                        throw BusinessRejection::forCode('academic.class_version_unknown', 'a class requires a published program version');
                    }
                    /** @var AcademicPeriod|null $period */
                    $period = AcademicPeriod::query()->whereKey($periodId)->lockForUpdate()->first();
                    if ($period === null || $period->lifecycle_state !== 'published') {
                        throw BusinessRejection::forCode('academic.class_period_unavailable', 'a class requires a published academic period');
                    }
                    if ($capacity <= 0) {
                        throw BusinessRejection::forCode('academic.class_capacity_invalid', 'class capacity must be positive');
                    }

                    $offeringQuery = Offering::query()->where('branch_id', $resolvedBranchId)
                        ->where('academic_period_id', $periodId)
                        ->where('lifecycle_state', Offering::STATE_OPEN);
                    if ($offeringId !== null && $offeringId !== '') {
                        $offeringQuery->whereKey($offeringId);
                    }
                    if ($programVersionLevelId !== null && $programVersionLevelId !== '') {
                        $offeringQuery->where('program_version_level_id', $programVersionLevelId);
                    } else {
                        $offeringQuery->whereHas('level', static fn ($query) => $query->where('program_version_id', $programVersionId));
                    }
                    /** @var Offering|null $offering */
                    $offering = $offeringQuery->lockForUpdate()->first();
                    if ($offering === null) {
                        throw BusinessRejection::forCode('academic.class_offering_required', 'a new class must reference an open offering for its branch, level, and period');
                    }
                    if ($offering->capacity < $capacity) {
                        throw BusinessRejection::forCode('academic.class_capacity_exceeds_offering', 'class capacity cannot exceed its offering capacity');
                    }
                    $levelId = (string) $offering->program_version_level_id;
                    $this->assertLevelBelongsToVersion($levelId, $programVersionId);

                    $class = ClassModel::query()->create([
                        'id' => RandomIdentifier::new(),
                        'program_version_id' => $programVersionId,
                        'period_id' => $periodId,
                        'branch_id' => $resolvedBranchId,
                        'program_version_level_id' => $levelId,
                        'offering_id' => $offering->id,
                        'capacity' => $capacity,
                        'lifecycle_state' => ClassLifecycle::STATE_PLANNED,
                    ]);
                    $provenance = $this->classProvenance($class->id);
                    $event = $this->audit->record($actor->actorId, 'academic.class.define', 'class', $class->id, null, [
                        'program_version_id' => $programVersionId, 'period_id' => $periodId, 'branch_id' => $resolvedBranchId, 'program_version_level_id' => $class->program_version_level_id, 'offering_id' => $class->offering_id, 'capacity' => $capacity,
                        ...$provenance,
                    ]);

                    return ['class_id' => $class->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.class.define', 'class', $programVersionId);
        }
    }

    /**
     * Terminal class transitions are fail-closed: a class moves to
     * cancelled or completed only once every seat it carries has reached
     * its own terminal state (withdrawn, transferred, completed).
     * Requested, active, and frozen seats are live delivery obligations —
     * the same live set the duplicate-seat, transfer, and waitlist guards
     * use — and stranding them on a dead class would orphan attendance,
     * assessment, and progression evidence. The live rows are locked so a
     * concurrent seat mutation serializes against the guard. Mirrors the
     * offering guard (academic.offering_open_seats).
     */
    private function assertNoOpenSeats(string $classId, string $toState): void
    {
        $openSeats = Enrollment::query()->where('class_id', $classId)
            ->whereIn('lifecycle_state', [EnrollmentLifecycle::STATE_REQUESTED, EnrollmentLifecycle::STATE_ACTIVE, EnrollmentLifecycle::STATE_FROZEN])
            ->lockForUpdate()
            ->pluck('id');
        if ($openSeats->isNotEmpty()) {
            throw BusinessRejection::forCode('academic.class_open_seats', sprintf('class cannot move to %s while %d open enrollment seat(s) reference it', $toState, $openSeats->count()));
        }
    }

    private function assertLevelBelongsToVersion(string $programVersionLevelId, string $programVersionId): void
    {
        /** @var ProgramVersionLevel $level */
        $level = ProgramVersionLevel::query()->whereKey($programVersionLevelId)->firstOrFail();
        if ($programVersionId !== $level->program_version_id) {
            throw BusinessRejection::forCode('academic.class_level_version_mismatch', 'a class level must belong to the class program version');
        }
    }

    /**
     * Class delivery is branch-homed: the capability is checked against the
     * class's own branch id. Legacy rows without branch provenance fail
     * closed through BranchScopedAccess (empty id is never a grant).
     */
    private function requireCapability(Actor $actor, ?string $branchId): void
    {
        $this->access->require($actor, self::CAPABILITY, $branchId, 'academic.schedule_denied');
    }

    /**
     * Resolves the target branch for a new class. Explicit callers (the HTTP
     * boundary) always supply one; programmatic callers may omit it, in which
     * case a single unambiguous visible branch is used and every other case is
     * rejected rather than guessed.
     */
    private function resolveClassBranch(Actor $actor, ?string $branchId): string
    {
        if ($branchId !== null && trim($branchId) !== '') {
            return trim($branchId);
        }
        $visible = $this->branches->visibleBranchIds($actor);
        if (count($visible) !== 1) {
            throw BusinessRejection::forCode('academic.class_branch_ambiguous', 'a new class requires an explicit branch unless the actor has exactly one visible branch');
        }

        return $visible[0];
    }

    /** @return array{branch_id: string, campus_id: string, organization_id: string} */
    private function classProvenance(string $classId): array
    {
        $class = ClassModel::query()->whereKey($classId)->first();
        $branchId = $class !== null ? trim((string) ($class->branch_id ?? '')) : '';
        $branch = $branchId === '' ? null : Branch::query()->whereKey($branchId)->first();
        if ($branch === null || $branch->lifecycle_state !== 'active') {
            throw BusinessRejection::forCode('academic.class_provenance_required', 'a class-linked event requires active branch provenance');
        }
        $scope = $branch->structureScope();
        if ($scope->organizationId === '' || $scope->campusId === null) {
            throw BusinessRejection::forCode('academic.class_provenance_required', 'a class-linked event requires active campus organization provenance');
        }

        return ['branch_id' => (string) $branch->id, 'campus_id' => (string) $scope->campusId, 'organization_id' => $scope->organizationId];
    }

    /** @return array{class_id: string, lifecycle_state: string, correlation_id: string} */
    public function transition(Actor $actor, ClassModel $class, string $toState, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.class.transition', $class->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.class.transition', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $class, $toState): array {
                    /** @var ClassModel $locked */
                    $locked = ClassModel::query()->whereKey($class->id)->lockForUpdate()->firstOrFail();
                    $this->requireCapability($actor, $locked->branch_id);
                    $from = $locked->lifecycle_state;
                    ClassLifecycle::requireTransition($from, $toState);
                    if ($toState === ClassLifecycle::STATE_ACTIVE && TeacherAssignment::query()
                        ->where('class_id', $locked->id)
                        ->where('branch_id', $locked->branch_id)
                        ->whereNotNull('teacher_profile_id')
                        ->where(fn ($state) => $state->whereNull('lifecycle_state')->orWhereIn('lifecycle_state', ['planned', 'active']))
                        ->where('effective_from', '<=', CarbonImmutable::today()->toDateString())
                        ->where(fn ($window) => $window->whereNull('effective_to')->orWhere('effective_to', '>', CarbonImmutable::today()->toDateString()))
                        ->whereHas('teacherProfile', static fn ($profile) => $profile->whereColumn('teacher_profiles.person_id', 'teacher_assignments.teacher_person_id')->where('teacher_profiles.lifecycle_state', 'active'))
                        ->doesntExist()) {
                        throw BusinessRejection::forCode('academic.class_needs_teacher', 'a class needs at least one current canonical teacher assignment to activate');
                    }
                    if (in_array($toState, [ClassLifecycle::STATE_CANCELLED, ClassLifecycle::STATE_COMPLETED], true)) {
                        $this->assertNoOpenSeats($locked->id, $toState);
                        $futureSessions = ClassSession::query()->where('class_id', $locked->id)
                            ->where('scheduled_on', '>=', CarbonImmutable::today()->toDateString())
                            ->count();
                        if ($futureSessions > 0) {
                            throw BusinessRejection::forCode('academic.class_future_sessions', "class cannot move to {$toState} while {$futureSessions} future session(s) remain");
                        }
                    }

                    $locked->forceFill(['lifecycle_state' => $toState]);
                    $locked->save();
                    $provenance = $this->classProvenance($locked->id);
                    $event = $this->audit->record($actor->actorId, 'academic.class.transition', 'class', $locked->id, ['lifecycle_state' => $from], [
                        'lifecycle_state' => $toState,
                        ...$provenance,
                    ]);

                    return ['class_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.class.transition', 'class', $class->id);
        }
    }

    /** @return array{session_id: string, correlation_id: string} */
    public function scheduleSession(Actor $actor, ClassModel $class, CarbonImmutable $scheduledOn, string $startsAt, string $endsAt, string $idempotencyKey, ?string $skillId = null, ?string $roomId = null, ?string $sectionId = null): array
    {
        $payload = hash('sha256', implode('|', ['academic.session.schedule', $class->id, $scheduledOn->toDateString(), $startsAt, $endsAt, $skillId ?? '', $roomId ?? '', $sectionId ?? '', $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.session.schedule', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $class, $scheduledOn, $startsAt, $endsAt, $skillId, $roomId, $sectionId): array {
                    /** @var ClassModel $lockedClass */
                    $lockedClass = ClassModel::query()->whereKey($class->id)->lockForUpdate()->firstOrFail();
                    $classBranchId = trim((string) ($lockedClass->branch_id ?? ''));
                    $this->requireCapability($actor, $classBranchId);
                    $this->scheduling->assertSessionCanBeScheduled($lockedClass, $scheduledOn, $startsAt, $endsAt, $skillId, $roomId, $sectionId);

                    $session = ClassSession::query()->create([
                        'id' => RandomIdentifier::new(),
                        'class_id' => $lockedClass->id,
                        'skill_id' => $skillId,
                        'room_id' => $roomId,
                        'section_id' => $sectionId,
                        'scheduled_on' => $scheduledOn->startOfDay()->toDateString(),
                        'starts_at' => $startsAt,
                        'ends_at' => $endsAt,
                    ]);
                    $provenance = $this->classProvenance($lockedClass->id);
                    $event = $this->audit->record($actor->actorId, 'academic.session.schedule', 'class_session', $session->id, null, [
                        'class_id' => $lockedClass->id, 'offering_id' => $lockedClass->offering_id, 'scheduled_on' => $session->scheduled_on, 'skill_id' => $skillId, 'room_id' => $roomId, 'section_id' => $sectionId,
                        ...$provenance,
                    ]);

                    return ['session_id' => $session->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.session.schedule', 'class_session', $class->id);
        }
    }

    /** @return array{section_id: string, correlation_id: string} */
    public function defineSection(Actor $actor, ClassModel $class, string $name, int $capacity, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.section.define', $class->id, $name, (string) $capacity, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.section.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $class, $name, $capacity): array {
                    /** @var ClassModel $lockedClass */
                    $lockedClass = ClassModel::query()->whereKey($class->id)->lockForUpdate()->firstOrFail();
                    $this->requireCapability($actor, $lockedClass->branch_id);
                    if ($name === '') {
                        throw BusinessRejection::forCode('academic.section_name_required', 'a section requires a name');
                    }
                    if ($capacity < 1) {
                        throw BusinessRejection::forCode('academic.section_capacity_positive', 'a section requires a positive capacity');
                    }
                    if (ClassSection::query()->where('class_id', $lockedClass->id)->where('name', $name)->exists()) {
                        throw BusinessRejection::forCode('academic.section_name_exists', 'a section name must be unique within its class');
                    }

                    $section = ClassSection::query()->create([
                        'id' => RandomIdentifier::new(),
                        'class_id' => $lockedClass->id,
                        'name' => $name,
                        'capacity' => $capacity,
                        'lifecycle_state' => ClassSectionLifecycle::STATE_PLANNED,
                    ]);
                    $provenance = $this->classProvenance($lockedClass->id);
                    $event = $this->audit->record($actor->actorId, 'academic.section.define', 'class_section', $section->id, null, [
                        'class_id' => $lockedClass->id, 'name' => $name, 'capacity' => $capacity,
                        ...$provenance,
                    ]);

                    return ['section_id' => $section->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.section.define', 'class_section', $class->id);
        }
    }

    /** @return array{section_id: string, lifecycle_state: string, correlation_id: string} */
    public function transitionSection(Actor $actor, ClassSection $section, string $toState, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.section.transition', $section->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.section.transition.'.$toState, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $section, $toState): array {
                    /** @var ClassModel $sectionClass */
                    $sectionClass = ClassModel::query()->whereKey($section->class_id)->lockForUpdate()->firstOrFail();
                    $this->requireCapability($actor, $sectionClass->branch_id);

                    /** @var ClassSection $locked */
                    $locked = ClassSection::query()->whereKey($section->id)->lockForUpdate()->firstOrFail();
                    if ($locked->class_id !== $sectionClass->id) {
                        throw BusinessRejection::forCode('academic.section_class_changed', 'the section class changed while the transition was being authorized');
                    }
                    $from = $locked->lifecycle_state;
                    ClassSectionLifecycle::requireTransition($from, $toState);
                    if ($toState === ClassSectionLifecycle::STATE_OPEN) {
                        $class = ClassModel::query()->whereKey($locked->class_id)->firstOrFail();
                        if ($class->lifecycle_state !== ClassLifecycle::STATE_ACTIVE) {
                            throw BusinessRejection::forCode('academic.section_class_not_active', 'a section opens only on an active class');
                        }
                    }
                    if (in_array($toState, [ClassSectionLifecycle::STATE_CLOSED, ClassSectionLifecycle::STATE_CANCELLED, ClassSectionLifecycle::STATE_ARCHIVED], true)) {
                        $future = ClassSession::query()->where('section_id', $locked->id)->where('scheduled_on', '>=', CarbonImmutable::today()->toDateString())->count();
                        if ($future > 0) {
                            throw BusinessRejection::forCode('academic.section_has_future_sessions', 'a section cannot close or archive while future sessions reference it');
                        }
                    }

                    $locked->forceFill(['lifecycle_state' => $toState])->save();
                    $provenance = $this->classProvenance($locked->class_id);
                    $event = $this->audit->record($actor->actorId, 'academic.section.transition.'.$toState, 'class_section', $locked->id, ['lifecycle_state' => $from], [
                        'lifecycle_state' => $toState,
                        ...$provenance,
                    ]);

                    return ['section_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.section.transition', 'class_section', $section->id);
        }
    }

    /** Compatibility façade; Teacher assignment authority owns this write.

     * @return array{assignment_skill_id: string, correlation_id: string}
     */
    public function assignSkill(Actor $actor, TeacherAssignment $assignment, string $skillId, string $idempotencyKey): array
    {
        return $this->teacherAssignments->assignSkill($actor, $assignment, $skillId, $idempotencyKey);
    }

    /** Compatibility façade; Teacher assignment authority owns this write.

     * @return array{assignment_id: string, correlation_id: string}
     */
    public function assignTeacher(Actor $actor, ClassModel $class, string $teacherPersonId, CarbonImmutable $effectiveFrom, ?CarbonImmutable $effectiveTo, string $idempotencyKey): array
    {
        return $this->teacherAssignments->assignTeacher($actor, $class, $teacherPersonId, $effectiveFrom, $effectiveTo, $idempotencyKey);
    }

    /** Compatibility façade; Teacher assignment authority owns this write.

     * @return array{assignment_id: string, effective_to: string, correlation_id: string}
     */
    public function endAssignment(Actor $actor, TeacherAssignment $assignment, CarbonImmutable $effectiveTo, string $reason, string $idempotencyKey): array
    {
        return $this->teacherAssignments->endAssignment($actor, $assignment, $effectiveTo, $reason, $idempotencyKey);
    }

    /** Compatibility façade; Teacher assignment authority owns this write.

     * @return array{assignment_id: string, effective_to: string, correlation_id: string}
     */
    public function extendAssignment(Actor $actor, TeacherAssignment $assignment, CarbonImmutable $newEffectiveTo, string $reason, string $idempotencyKey): array
    {
        return $this->teacherAssignments->extendAssignment($actor, $assignment, $newEffectiveTo, $reason, $idempotencyKey);
    }

    /** Compatibility façade; Teacher assignment authority owns this write.

     * @return array{outgoing_assignment_id: string, incoming_assignment_id: string, correlation_id: string}
     */
    public function handoverAssignment(Actor $actor, TeacherAssignment $assignment, string $successorTeacherPersonId, CarbonImmutable $handoverOn, string $reason, string $idempotencyKey): array
    {
        return $this->teacherAssignments->handoverAssignment($actor, $assignment, $successorTeacherPersonId, $handoverOn, $reason, $idempotencyKey);
    }

}
