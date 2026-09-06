<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\AcademicAccess;
use App\Modules\Academic\Domain\ClassLifecycle;
use App\Modules\Academic\Domain\ClassSectionLifecycle;
use App\Modules\Academic\Domain\EnrollmentLifecycle;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AcademicRoom;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSection;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Models\Skill;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Academic\Models\TeacherAssignmentSkill;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\Person;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Class and session control: a class delivers a published program version
 * in a published period with fixed capacity; sessions are scheduled on
 * active classes; teachers are assigned effective-dated, one open
 * assignment per teacher per class; cancellation preserves the record.
 */
final class MaintainClass
{
    public const CAPABILITY = 'academic.schedule';

    public function __construct(
        private readonly AcademicAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{class_id: string, correlation_id: string} */
    public function defineClass(Actor $actor, string $programVersionId, string $periodId, int $capacity, string $idempotencyKey, ?string $programVersionLevelId = null): array
    {
        $payload = hash('sha256', implode('|', ['academic.class.define', $programVersionId, $periodId, $capacity, $programVersionLevelId ?? '', $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.class.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $programVersionId, $periodId, $capacity, $programVersionLevelId): array {
                    $this->requireCapability($actor, null);
                    if (ProgramVersion::query()->whereKey($programVersionId)->doesntExist()) {
                        throw BusinessRejection::forCode('academic.class_version_unknown', 'a class requires a published program version');
                    }
                    /** @var AcademicPeriod|null $period */
                    $period = AcademicPeriod::query()->find($periodId);
                    if ($period === null || $period->lifecycle_state !== 'published') {
                        throw BusinessRejection::forCode('academic.class_period_unavailable', 'a class requires a published academic period');
                    }
                    if ($capacity <= 0) {
                        throw BusinessRejection::forCode('academic.class_capacity_invalid', 'class capacity must be positive');
                    }
                    if ($programVersionLevelId !== null && $programVersionLevelId !== '') {
                        $this->assertLevelBelongsToVersion($programVersionLevelId, $programVersionId);
                    }

                    $class = ClassModel::query()->create([
                        'id' => RandomIdentifier::new(),
                        'program_version_id' => $programVersionId,
                        'period_id' => $periodId,
                        'program_version_level_id' => $programVersionLevelId !== null && $programVersionLevelId !== '' ? $programVersionLevelId : null,
                        'capacity' => $capacity,
                        'lifecycle_state' => ClassLifecycle::STATE_PLANNED,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.class.define', 'class', $class->id, null, [
                        'program_version_id' => $programVersionId, 'period_id' => $periodId, 'program_version_level_id' => $class->program_version_level_id, 'capacity' => $capacity,
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

    /** @return array{class_id: string, lifecycle_state: string, correlation_id: string} */
    public function transition(Actor $actor, ClassModel $class, string $toState, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.class.transition', $class->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.class.transition', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $class, $toState): array {
                    $this->requireCapability($actor, null);

                    /** @var ClassModel $locked */
                    $locked = ClassModel::query()->whereKey($class->id)->lockForUpdate()->firstOrFail();
                    $from = $locked->lifecycle_state;
                    ClassLifecycle::requireTransition($from, $toState);
                    if ($toState === ClassLifecycle::STATE_ACTIVE && TeacherAssignment::query()->where('class_id', $locked->id)->whereNull('effective_to')->doesntExist()) {
                        throw BusinessRejection::forCode('academic.class_needs_teacher', 'a class needs at least one open teacher assignment to activate');
                    }
                    if (in_array($toState, [ClassLifecycle::STATE_CANCELLED, ClassLifecycle::STATE_COMPLETED], true)) {
                        $this->assertNoOpenSeats($locked->id, $toState);
                    }

                    $locked->forceFill(['lifecycle_state' => $toState]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.class.transition', 'class', $locked->id, ['lifecycle_state' => $from], ['lifecycle_state' => $toState]);

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
                    $this->requireCapability($actor, $this->roomBranch($roomId));
                    if ($class->lifecycle_state !== ClassLifecycle::STATE_ACTIVE) {
                        throw BusinessRejection::forCode('academic.session_class_not_active', 'sessions are scheduled only on active classes');
                    }
                    if ($endsAt <= $startsAt) {
                        throw BusinessRejection::forCode('academic.session_window', 'a session must end after it starts');
                    }
                    if ($skillId !== null) {
                        /** @var Skill|null $skill */
                        $skill = Skill::query()->find($skillId);
                        if ($skill === null || $skill->lifecycle_state !== Skill::STATE_ACTIVE) {
                            throw BusinessRejection::forCode('academic.session_skill_unknown', 'a session may deliver only an active skill');
                        }
                    }
                    if ($sectionId !== null) {
                        $this->assertSectionOpen($sectionId, $class->id);
                    }
                    if ($roomId !== null) {
                        $this->assertRoomAvailable($roomId);
                    }

                    $session = ClassSession::query()->create([
                        'id' => RandomIdentifier::new(),
                        'class_id' => $class->id,
                        'skill_id' => $skillId,
                        'room_id' => $roomId,
                        'section_id' => $sectionId,
                        'scheduled_on' => $scheduledOn->startOfDay()->toDateString(),
                        'starts_at' => $startsAt,
                        'ends_at' => $endsAt,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.session.schedule', 'class_session', $session->id, null, [
                        'class_id' => $class->id, 'scheduled_on' => $session->scheduled_on, 'skill_id' => $skillId, 'room_id' => $roomId, 'section_id' => $sectionId,
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
                    $this->requireCapability($actor, null);
                    if ($name === '') {
                        throw BusinessRejection::forCode('academic.section_name_required', 'a section requires a name');
                    }
                    if ($capacity < 1) {
                        throw BusinessRejection::forCode('academic.section_capacity_positive', 'a section requires a positive capacity');
                    }
                    if (ClassSection::query()->where('class_id', $class->id)->where('name', $name)->exists()) {
                        throw BusinessRejection::forCode('academic.section_name_exists', 'a section name must be unique within its class');
                    }

                    $section = ClassSection::query()->create([
                        'id' => RandomIdentifier::new(),
                        'class_id' => $class->id,
                        'name' => $name,
                        'capacity' => $capacity,
                        'lifecycle_state' => ClassSectionLifecycle::STATE_PLANNED,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.section.define', 'class_section', $section->id, null, [
                        'class_id' => $class->id, 'name' => $name, 'capacity' => $capacity,
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
                    $this->requireCapability($actor, null);

                    /** @var ClassSection $locked */
                    $locked = ClassSection::query()->whereKey($section->id)->lockForUpdate()->firstOrFail();
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
                    $event = $this->audit->record($actor->actorId, 'academic.section.transition.'.$toState, 'class_section', $locked->id, ['lifecycle_state' => $from], ['lifecycle_state' => $toState]);

                    return ['section_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.section.transition', 'class_section', $section->id);
        }
    }

    private function assertSectionOpen(string $sectionId, string $classId): void
    {
        /** @var ClassSection $section */
        $section = ClassSection::query()->whereKey($sectionId)->firstOrFail();
        if ($classId !== $section->class_id) {
            throw BusinessRejection::forCode('academic.session_section_class_mismatch', 'a session section must belong to the session class');
        }
        if ($section->lifecycle_state !== ClassSectionLifecycle::STATE_OPEN) {
            throw BusinessRejection::forCode('academic.session_section_not_open', 'a session may be scheduled only in an open section');
        }
    }

    private function assertRoomAvailable(string $roomId): void
    {
        /** @var AcademicRoom $room */
        $room = AcademicRoom::query()->whereKey($roomId)->firstOrFail();
        if ($room->lifecycle_state !== 'available') {
            throw BusinessRejection::forCode('academic.session_room_not_available', 'a session may be scheduled only in an available room');
        }
    }

    /**
     * Skill dimension of a teaching assignment: which skill the teacher
     * delivers in this class. Rows are append-only evidence; a change is a
     * new effective-dated assignment.
     *
     * @return array{assignment_skill_id: string, correlation_id: string}
     */
    public function assignSkill(Actor $actor, TeacherAssignment $assignment, string $skillId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.teacher.assign_skill', $assignment->id, $skillId, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.teacher.assign_skill', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $assignment, $skillId): array {
                    $this->requireCapability($actor, null);

                    /** @var TeacherAssignment $locked */
                    $locked = TeacherAssignment::query()->where('id', $assignment->id)->lockForUpdate()->firstOrFail();
                    /** @var Skill|null $skill */
                    $skill = Skill::query()->find($skillId);
                    if ($skill === null || $skill->lifecycle_state !== Skill::STATE_ACTIVE) {
                        throw BusinessRejection::forCode('academic.assignment_skill_unknown', 'an assignment skill must be an active catalog skill');
                    }
                    if (TeacherAssignmentSkill::query()->where('teacher_assignment_id', $locked->id)->where('skill_id', $skillId)->exists()) {
                        throw BusinessRejection::forCode('academic.assignment_skill_duplicate', 'this assignment already carries this skill');
                    }

                    $row = TeacherAssignmentSkill::query()->create([
                        'id' => RandomIdentifier::new(),
                        'teacher_assignment_id' => $locked->id,
                        'skill_id' => $skillId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.assign_skill', 'teacher_assignment_skill', $row->id, null, [
                        'teacher_assignment_id' => $locked->id, 'skill_id' => $skillId,
                    ]);

                    return ['assignment_skill_id' => $row->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.assign_skill', 'teacher_assignment_skill', $assignment->id);
        }
    }

    /** @return array{assignment_id: string, correlation_id: string} */
    public function assignTeacher(Actor $actor, ClassModel $class, string $teacherPersonId, CarbonImmutable $effectiveFrom, ?CarbonImmutable $effectiveTo, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.teacher.assign', $class->id, $teacherPersonId, $effectiveFrom->toDateString(), $effectiveTo?->toDateString() ?? '', $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.teacher.assign', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $class, $teacherPersonId, $effectiveFrom, $effectiveTo): array {
                    $this->requireCapability($actor, null);
                    if (! Person::query()->whereKey($teacherPersonId)->exists()) {
                        throw BusinessRejection::forCode('academic.teacher_unknown', 'a teacher assignment requires a known person');
                    }
                    if ($effectiveTo !== null && $effectiveTo->startOfDay()->lessThanOrEqualTo($effectiveFrom->startOfDay())) {
                        throw BusinessRejection::forCode('academic.teacher_period', 'a teacher assignment must end after it starts');
                    }
                    if (TeacherAssignment::query()->where('class_id', $class->id)->where('teacher_person_id', $teacherPersonId)->whereNull('effective_to')->exists()) {
                        throw BusinessRejection::forCode('academic.teacher_duplicate', 'this teacher already has an open assignment on the class');
                    }

                    $assignment = TeacherAssignment::query()->create([
                        'id' => RandomIdentifier::new(),
                        'class_id' => $class->id,
                        'teacher_person_id' => $teacherPersonId,
                        'effective_from' => $effectiveFrom->startOfDay()->toDateString(),
                        'effective_to' => $effectiveTo?->startOfDay()->toDateString(),
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.assign', 'teacher_assignment', $assignment->id, null, [
                        'class_id' => $class->id, 'teacher_person_id' => $teacherPersonId,
                    ]);

                    return ['assignment_id' => $assignment->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.assign', 'teacher_assignment', $class->id);
        }
    }

    private function requireCapability(Actor $actor, ?string $branchId): void
    {
        $this->access->require($actor, self::CAPABILITY, $branchId, 'academic.schedule_denied');
    }

    /**
     * Booking a room consumes a branch-owned resource, so a roomed session
     * is checked in the room's branch scope. Room-less scheduling stays a
     * governance act (explicit null).
     */
    private function roomBranch(?string $roomId): ?string
    {
        if ($roomId === null || trim($roomId) === '') {
            return null;
        }

        return trim((string) (AcademicRoom::query()->whereKey($roomId)->value('branch_id') ?? ''));
    }

    /**
     * End an open assignment on an explicit date with a mandatory
     * reason. History is retained: the row is dated, never deleted.
     * Ending the last open assignment of an active class is allowed;
     * continuance is an Academic Management decision (D-F-062), not an
     * automatic transition.
     *
     * @return array{assignment_id: string, effective_to: string, correlation_id: string}
     */
    public function endAssignment(Actor $actor, TeacherAssignment $assignment, CarbonImmutable $effectiveTo, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.teacher.end', $assignment->id, $effectiveTo->toDateString(), $reason, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.teacher.end', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $assignment, $effectiveTo, $reason): array {
                    $this->requireCapability($actor, null);
                    if ($reason === '') {
                        throw BusinessRejection::forCode('academic.assignment_reason', 'ending an assignment requires a reason');
                    }

                    /** @var TeacherAssignment $locked */
                    $locked = TeacherAssignment::query()->whereKey($assignment->id)->lockForUpdate()->firstOrFail();
                    if ($locked->effective_to !== null) {
                        throw BusinessRejection::forCode('academic.assignment_not_open', 'only an open assignment can be ended');
                    }
                    if ($effectiveTo->startOfDay()->lessThanOrEqualTo(CarbonImmutable::parse($locked->effective_from)->startOfDay())) {
                        throw BusinessRejection::forCode('academic.assignment_period', 'an assignment must end after it starts');
                    }

                    $locked->forceFill(['effective_to' => $effectiveTo->startOfDay()->toDateString()]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.end', 'teacher_assignment', $locked->id, ['effective_to' => null], [
                        'effective_to' => $locked->effective_to, 'reason' => $reason,
                    ]);

                    return ['assignment_id' => $locked->id, 'effective_to' => (string) $locked->effective_to, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.end', 'teacher_assignment', $assignment->id);
        }
    }

    /**
     * Move the end date of a dated assignment later, with a mandatory
     * reason (D-F-065). Open-ended assignments are not extended; they
     * have no end date to move.
     *
     * @return array{assignment_id: string, effective_to: string, correlation_id: string}
     */
    public function extendAssignment(Actor $actor, TeacherAssignment $assignment, CarbonImmutable $newEffectiveTo, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.teacher.extend', $assignment->id, $newEffectiveTo->toDateString(), $reason, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.teacher.extend', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $assignment, $newEffectiveTo, $reason): array {
                    $this->requireCapability($actor, null);
                    if ($reason === '') {
                        throw BusinessRejection::forCode('academic.assignment_reason', 'extending an assignment requires a reason');
                    }

                    /** @var TeacherAssignment $locked */
                    $locked = TeacherAssignment::query()->whereKey($assignment->id)->lockForUpdate()->firstOrFail();
                    if ($locked->effective_to === null) {
                        throw BusinessRejection::forCode('academic.assignment_not_dated', 'only a dated assignment can be extended');
                    }
                    if ($newEffectiveTo->startOfDay()->lessThanOrEqualTo(CarbonImmutable::parse($locked->effective_to)->startOfDay())) {
                        throw BusinessRejection::forCode('academic.assignment_period', 'an extension must move the end date later');
                    }

                    $before = ['effective_to' => $locked->effective_to];
                    $locked->forceFill(['effective_to' => $newEffectiveTo->startOfDay()->toDateString()]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.extend', 'teacher_assignment', $locked->id, $before, [
                        'effective_to' => $locked->effective_to, 'reason' => $reason,
                    ]);

                    return ['assignment_id' => $locked->id, 'effective_to' => (string) $locked->effective_to, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.extend', 'teacher_assignment', $assignment->id);
        }
    }

    /**
     * Hand over one open assignment to a successor in a single
     * transaction (D-F-061): the outgoing row ends on the handover
     * date and the successor row opens from that date. Substitution
     * stays a separate assignment row; the audit links both.
     *
     * @return array{outgoing_assignment_id: string, incoming_assignment_id: string, correlation_id: string}
     */
    public function handoverAssignment(Actor $actor, TeacherAssignment $assignment, string $successorTeacherPersonId, CarbonImmutable $handoverOn, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.teacher.handover', $assignment->id, $successorTeacherPersonId, $handoverOn->toDateString(), $reason, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.teacher.handover', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $assignment, $successorTeacherPersonId, $handoverOn, $reason): array {
                    $this->requireCapability($actor, null);
                    if ($reason === '') {
                        throw BusinessRejection::forCode('academic.assignment_reason', 'handing over an assignment requires a reason');
                    }
                    if (! Person::query()->whereKey($successorTeacherPersonId)->exists()) {
                        throw BusinessRejection::forCode('academic.teacher_unknown', 'a handover requires a known successor person');
                    }

                    /** @var TeacherAssignment $locked */
                    $locked = TeacherAssignment::query()->whereKey($assignment->id)->lockForUpdate()->firstOrFail();
                    if ($locked->effective_to !== null) {
                        throw BusinessRejection::forCode('academic.assignment_not_open', 'only an open assignment can be handed over');
                    }
                    if ($handoverOn->startOfDay()->lessThanOrEqualTo(CarbonImmutable::parse($locked->effective_from)->startOfDay())) {
                        throw BusinessRejection::forCode('academic.assignment_period', 'a handover must take effect after the assignment starts');
                    }
                    if (TeacherAssignment::query()->where('class_id', $locked->class_id)->where('teacher_person_id', $successorTeacherPersonId)->whereNull('effective_to')->exists()) {
                        throw BusinessRejection::forCode('academic.teacher_duplicate', 'the successor already has an open assignment on the class');
                    }

                    $day = $handoverOn->startOfDay()->toDateString();
                    $locked->forceFill(['effective_to' => $day]);
                    $locked->save();

                    $incoming = TeacherAssignment::query()->create([
                        'id' => RandomIdentifier::new(),
                        'class_id' => $locked->class_id,
                        'teacher_person_id' => $successorTeacherPersonId,
                        'effective_from' => $day,
                        'effective_to' => null,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.handover', 'teacher_assignment', $incoming->id, ['outgoing_assignment_id' => $locked->id], [
                        'outgoing_assignment_id' => $locked->id,
                        'successor_teacher_person_id' => $successorTeacherPersonId,
                        'handover_on' => $day,
                        'reason' => $reason,
                    ]);

                    return ['outgoing_assignment_id' => $locked->id, 'incoming_assignment_id' => $incoming->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.handover', 'teacher_assignment', $assignment->id);
        }
    }
}
