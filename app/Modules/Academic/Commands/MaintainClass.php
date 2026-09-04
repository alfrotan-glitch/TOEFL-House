<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\ClassLifecycle;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Models\Skill;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Academic\Models\TeacherAssignmentSkill;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\Person;
use App\Support\Authorization\AccessDecision;
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
        private readonly AccessDecision $access,
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
                    $this->requireCapability($actor);
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
                    $this->requireCapability($actor);

                    /** @var ClassModel $locked */
                    $locked = ClassModel::query()->whereKey($class->id)->lockForUpdate()->firstOrFail();
                    $from = $locked->lifecycle_state;
                    ClassLifecycle::requireTransition($from, $toState);
                    if ($toState === ClassLifecycle::STATE_ACTIVE && TeacherAssignment::query()->where('class_id', $locked->id)->whereNull('effective_to')->doesntExist()) {
                        throw BusinessRejection::forCode('academic.class_needs_teacher', 'a class needs at least one open teacher assignment to activate');
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
    public function scheduleSession(Actor $actor, ClassModel $class, CarbonImmutable $scheduledOn, string $startsAt, string $endsAt, string $idempotencyKey, ?string $skillId = null): array
    {
        $payload = hash('sha256', implode('|', ['academic.session.schedule', $class->id, $scheduledOn->toDateString(), $startsAt, $endsAt, $skillId ?? '', $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.session.schedule', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $class, $scheduledOn, $startsAt, $endsAt, $skillId): array {
                    $this->requireCapability($actor);
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

                    $session = ClassSession::query()->create([
                        'id' => RandomIdentifier::new(),
                        'class_id' => $class->id,
                        'skill_id' => $skillId,
                        'scheduled_on' => $scheduledOn->startOfDay()->toDateString(),
                        'starts_at' => $startsAt,
                        'ends_at' => $endsAt,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.session.schedule', 'class_session', $session->id, null, [
                        'class_id' => $class->id, 'scheduled_on' => $session->scheduled_on, 'skill_id' => $skillId,
                    ]);

                    return ['session_id' => $session->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.session.schedule', 'class_session', $class->id);
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
                    $this->requireCapability($actor);

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
                    $this->requireCapability($actor);
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

    private function requireCapability(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('academic.schedule_denied', $outcome->reason);
        }
    }
}
