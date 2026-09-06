<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\AcademicAccess;
use App\Modules\Academic\Domain\TeacherAuthority;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Skill;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Academic\Models\TeacherAssignmentSkill;
use App\Modules\Academic\Models\TeacherProfile;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Models\Employment;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Teacher-owned assignment authority. Academic class commands expose only a
 * compatibility façade; assignment lifecycle, capability checks, provenance,
 * handover, and attribution are owned here.
 */
final class MaintainTeacherAssignment
{
    public const CAPABILITY = 'academic.schedule';

    public function __construct(
        private readonly AcademicAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly TeacherAuthority $teacherAuthority,
    ) {}

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
                    /** @var TeacherAssignment $assignmentClass */
                    $assignmentClass = ClassModel::query()->whereKey($assignment->class_id)->firstOrFail();
                    $this->requireCapability($actor, $assignmentClass->branch_id);

                    /** @var TeacherAssignment $locked */
                    $locked = TeacherAssignment::query()->where('id', $assignment->id)->lockForUpdate()->firstOrFail();
                    if (in_array($locked->lifecycle_state, ['ended', 'cancelled'], true)) {
                        throw BusinessRejection::forCode('academic.assignment_closed', 'a closed assignment cannot receive skill attribution');
                    }
                    /** @var Skill|null $skill */
                    $skill = Skill::query()->find($skillId);
                    if ($skill === null || $skill->lifecycle_state !== Skill::STATE_ACTIVE) {
                        throw BusinessRejection::forCode('academic.assignment_skill_unknown', 'an assignment skill must be an active catalog skill');
                    }
                    /** @var TeacherProfile|null $profile */
                    $profile = $locked->teacher_profile_id === null ? null : TeacherProfile::query()->find($locked->teacher_profile_id);
                    if ($profile === null || (string) $locked->teacher_person_id !== (string) $profile->person_id) {
                        throw BusinessRejection::forCode('academic.teacher_profile_required', 'subject attribution requires a person-consistent canonical teacher assignment');
                    }
                    $assignmentStart = CarbonImmutable::parse((string) $locked->effective_from);
                    $this->teacherAuthority->assertSkillAuthorityForWindow(
                        $profile,
                        $skillId,
                        'teach',
                        $assignmentStart,
                        $locked->effective_to !== null ? CarbonImmutable::parse((string) $locked->effective_to) : null,
                        (string) $assignmentClass->branch_id,
                    );
                    if (TeacherAssignmentSkill::query()->where('teacher_assignment_id', $locked->id)->where('skill_id', $skillId)->exists()) {
                        throw BusinessRejection::forCode('academic.assignment_skill_duplicate', 'this assignment already carries this skill');
                    }

                    $row = TeacherAssignmentSkill::query()->create([
                        'id' => RandomIdentifier::new(),
                        'teacher_assignment_id' => $locked->id,
                        'skill_id' => $skillId,
                    ]);
                    $provenance = $this->classProvenance($locked->class_id);
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.assign_skill', 'teacher_assignment_skill', $row->id, null, [
                        'teacher_assignment_id' => $locked->id, 'skill_id' => $skillId,
                        ...$provenance,
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
                    /** @var ClassModel $lockedClass */
                    $lockedClass = ClassModel::query()->whereKey($class->id)->lockForUpdate()->firstOrFail();
                    $this->requireCapability($actor, $lockedClass->branch_id);
                    if ($effectiveTo !== null && $effectiveTo->startOfDay()->lessThanOrEqualTo($effectiveFrom->startOfDay())) {
                        throw BusinessRejection::forCode('academic.teacher_period', 'a teacher assignment must end after it starts');
                    }
                    $profile = $this->teacherAuthority->assertAssignable($actor, $lockedClass, $teacherPersonId, $effectiveFrom, $effectiveTo);
                    if (TeacherAssignment::query()->where('class_id', $lockedClass->id)->where('teacher_person_id', $teacherPersonId)->where(fn ($state) => $state->whereNull('lifecycle_state')->orWhereIn('lifecycle_state', ['planned', 'active']))->whereNull('effective_to')->exists()) {
                        throw BusinessRejection::forCode('academic.teacher_duplicate', 'this teacher already has an open assignment on the class');
                    }
                    $provenance = $this->classProvenance($lockedClass->id);

                    $assignment = TeacherAssignment::query()->create([
                        'id' => RandomIdentifier::new(),
                        'class_id' => $lockedClass->id,
                        'branch_id' => $provenance['branch_id'],
                        'campus_id' => $provenance['campus_id'],
                        'organization_id' => $provenance['organization_id'],
                        'teacher_person_id' => $teacherPersonId,
                        'teacher_profile_id' => $profile->id,
                        'lifecycle_state' => $this->lifecycleForStart($effectiveFrom),
                        'effective_from' => $effectiveFrom->startOfDay()->toDateString(),
                        'effective_to' => $effectiveTo?->startOfDay()->toDateString(),
                        'assigned_by' => $actor->actorId,
                        'assignment_reason' => 'canonical teacher assignment',
                    ]);
                    $provenance = $this->classProvenance($lockedClass->id);
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.assign', 'teacher_assignment', $assignment->id, null, [
                        'class_id' => $lockedClass->id, 'teacher_person_id' => $teacherPersonId, 'teacher_profile_id' => $profile->id,
                        ...$provenance,
                    ]);

                    return ['assignment_id' => $assignment->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.assign', 'teacher_assignment', $class->id);
        }
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

    /**
     * Closure is historical evidence: it must retain the assignment's
     * captured scope even when the branch or campus has since been retired.
     * Canonical assignments always carry the three snapshots; the fallback
     * exists only for pre-convergence remediation rows.
     *
     * @return array{branch_id: string, campus_id: string, organization_id: string}
     */
    private function historicalAssignmentProvenance(TeacherAssignment $assignment): array
    {
        if ($assignment->branch_id !== null && $assignment->campus_id !== null && $assignment->organization_id !== null) {
            return [
                'branch_id' => (string) $assignment->branch_id,
                'campus_id' => (string) $assignment->campus_id,
                'organization_id' => (string) $assignment->organization_id,
            ];
        }

        return $this->classProvenance($assignment->class_id);
    }

    /**
     * HR termination orchestration: Teacher remains the sole assignment
     * writer, while HR remains the sole employment writer. Current delivery
     * assignments close at the employment effective date; future rows are
     * explicitly cancelled and cannot deliver against inactive employment.
     */
    public function closeForEmployment(Actor $actor, Employment $employment, CarbonImmutable $effectiveTo, string $reason): void
    {
        $close = function () use ($actor, $employment, $effectiveTo, $reason): void {
            $profile = TeacherProfile::query()->where('employment_id', $employment->id)->first();
            if ($profile === null) {
                return;
            }
            $branch = Branch::query()->whereKey($profile->current_home_branch_id)->first();
            if ($branch === null || $branch->lifecycle_state !== 'active') {
                throw BusinessRejection::forCode('hr.teacher_assignment_provenance_required', 'teacher assignment closure requires active branch provenance');
            }
            $this->access->require($actor, 'hr.terminate', (string) $branch->id, 'hr.teacher_assignment_close_denied');
            $assignments = TeacherAssignment::query()->where('teacher_profile_id', $profile->id)->where(fn ($state) => $state->whereNull('lifecycle_state')->orWhere('lifecycle_state', '!=', 'cancelled'))->where(function ($query) use ($effectiveTo): void {
                $query->whereNull('effective_to')->orWhere('effective_to', '>', $effectiveTo->toDateString());
            })->lockForUpdate()->get();
            foreach ($assignments as $assignment) {
                $before = ['effective_to' => $assignment->effective_to, 'lifecycle_state' => $assignment->lifecycle_state];
                $isFuture = CarbonImmutable::parse((string) $assignment->effective_from)->startOfDay()->greaterThanOrEqualTo($effectiveTo->startOfDay());
                $assignment->forceFill($isFuture
                    ? ['lifecycle_state' => 'cancelled']
                    : ['effective_to' => $effectiveTo->toDateString(), 'lifecycle_state' => 'ended']
                )->save();
                $provenance = $this->historicalAssignmentProvenance($assignment);
                    $this->audit->record($actor->actorId, 'academic.teacher.assignment.close_for_employment', 'teacher_assignment', $assignment->id, $before, [
                    'effective_to' => $assignment->effective_to, 'lifecycle_state' => $assignment->lifecycle_state,
                    'employment_id' => $employment->id, 'reason' => $reason, ...$provenance,
                ]);
            }
        };

        if (DB::transactionLevel() > 0) {
            $close();

            return;
        }
        DB::transaction($close);
    }

    private function lifecycleForStart(CarbonImmutable $effectiveFrom): string
    {
        return $effectiveFrom->startOfDay()->isFuture() ? 'planned' : 'active';
    }

    private function requireCapability(Actor $actor, ?string $branchId): void
    {
        $this->access->require($actor, self::CAPABILITY, $branchId, 'academic.schedule_denied');
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
                    $assignmentClass = ClassModel::query()->whereKey($assignment->class_id)->firstOrFail();
                    $this->requireCapability($actor, $assignmentClass->branch_id);
                    if ($reason === '') {
                        throw BusinessRejection::forCode('academic.assignment_reason', 'ending an assignment requires a reason');
                    }

                    /** @var TeacherAssignment $locked */
                    $locked = TeacherAssignment::query()->whereKey($assignment->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state === 'cancelled') {
                        throw BusinessRejection::forCode('academic.assignment_cancelled', 'a cancelled assignment cannot be ended');
                    }
                    if ($locked->effective_to !== null) {
                        throw BusinessRejection::forCode('academic.assignment_not_open', 'only an open assignment can be ended');
                    }
                    if ($effectiveTo->startOfDay()->lessThanOrEqualTo(CarbonImmutable::parse($locked->effective_from)->startOfDay())) {
                        throw BusinessRejection::forCode('academic.assignment_period', 'an assignment must end after it starts');
                    }

                    $locked->forceFill(['effective_to' => $effectiveTo->startOfDay()->toDateString(), 'lifecycle_state' => 'ended']);
                    $locked->save();
                    $provenance = $this->historicalAssignmentProvenance($locked);
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.end', 'teacher_assignment', $locked->id, ['effective_to' => null], [
                        'effective_to' => $locked->effective_to, 'reason' => $reason,
                        ...$provenance,
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
                    $assignmentClass = ClassModel::query()->whereKey($assignment->class_id)->firstOrFail();
                    $this->requireCapability($actor, $assignmentClass->branch_id);
                    if ($reason === '') {
                        throw BusinessRejection::forCode('academic.assignment_reason', 'extending an assignment requires a reason');
                    }

                    /** @var TeacherAssignment $locked */
                    $locked = TeacherAssignment::query()->whereKey($assignment->id)->lockForUpdate()->firstOrFail();
                    if (in_array($locked->lifecycle_state, ['ended', 'cancelled'], true)) {
                        throw BusinessRejection::forCode('academic.assignment_not_extendable', 'ended or cancelled assignments cannot be extended');
                    }
                    if ($locked->effective_to === null) {
                        throw BusinessRejection::forCode('academic.assignment_not_dated', 'only a dated assignment can be extended');
                    }
                    if ($newEffectiveTo->startOfDay()->lessThanOrEqualTo(CarbonImmutable::parse($locked->effective_to)->startOfDay())) {
                        throw BusinessRejection::forCode('academic.assignment_period', 'an extension must move the end date later');
                    }
                    $this->teacherAuthority->assertAssignable($actor, $assignmentClass, (string) $locked->teacher_person_id, CarbonImmutable::parse((string) $locked->effective_from), $newEffectiveTo);

                    $before = ['effective_to' => $locked->effective_to];
                    $locked->forceFill(['effective_to' => $newEffectiveTo->startOfDay()->toDateString()]);
                    $locked->save();
                    $provenance = $this->classProvenance($locked->class_id);
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.extend', 'teacher_assignment', $locked->id, $before, [
                        'effective_to' => $locked->effective_to, 'reason' => $reason,
                        ...$provenance,
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
                    $assignmentClass = ClassModel::query()->whereKey($assignment->class_id)->firstOrFail();
                    $this->requireCapability($actor, $assignmentClass->branch_id);
                    if ($reason === '') {
                        throw BusinessRejection::forCode('academic.assignment_reason', 'handing over an assignment requires a reason');
                    }
                    /** @var TeacherAssignment $locked */
                    $locked = TeacherAssignment::query()->whereKey($assignment->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state === 'cancelled') {
                        throw BusinessRejection::forCode('academic.assignment_cancelled', 'a cancelled assignment cannot be handed over');
                    }
                    if ($locked->effective_to !== null) {
                        throw BusinessRejection::forCode('academic.assignment_not_open', 'only an open assignment can be handed over');
                    }
                    if ($handoverOn->startOfDay()->lessThanOrEqualTo(CarbonImmutable::parse($locked->effective_from)->startOfDay())) {
                        throw BusinessRejection::forCode('academic.assignment_period', 'a handover must take effect after the assignment starts');
                    }
                    if (TeacherAssignment::query()->where('class_id', $locked->class_id)->where('teacher_person_id', $successorTeacherPersonId)->where(fn ($state) => $state->whereNull('lifecycle_state')->orWhereIn('lifecycle_state', ['planned', 'active']))->whereNull('effective_to')->exists()) {
                        throw BusinessRejection::forCode('academic.teacher_duplicate', 'the successor already has an open assignment on the class');
                    }

                    $day = $handoverOn->startOfDay()->toDateString();
                    $this->teacherAuthority->assertAssignable($actor, $assignmentClass, (string) $locked->teacher_person_id, CarbonImmutable::parse((string) $locked->effective_from), $handoverOn);
                    $successor = $this->teacherAuthority->assertAssignable($actor, $assignmentClass, $successorTeacherPersonId, $handoverOn, null);
                    $locked->forceFill(['effective_to' => $day, 'lifecycle_state' => 'ended']);
                    $locked->save();
                    $provenance = $this->classProvenance($locked->class_id);

                    $incoming = TeacherAssignment::query()->create([
                        'id' => RandomIdentifier::new(),
                        'class_id' => $locked->class_id,
                        'branch_id' => $provenance['branch_id'],
                        'campus_id' => $provenance['campus_id'],
                        'organization_id' => $provenance['organization_id'],
                        'teacher_person_id' => $successorTeacherPersonId,
                        'teacher_profile_id' => $successor->id,
                        'lifecycle_state' => $this->lifecycleForStart($handoverOn),
                        'effective_from' => $day,
                        'effective_to' => null,
                        'assigned_by' => $actor->actorId,
                        'assignment_reason' => $reason,
                    ]);
                    $provenance = $this->classProvenance($incoming->class_id);
                    $event = $this->audit->record($actor->actorId, 'academic.teacher.handover', 'teacher_assignment', $incoming->id, ['outgoing_assignment_id' => $locked->id], [
                        'outgoing_assignment_id' => $locked->id,
                        'successor_teacher_person_id' => $successorTeacherPersonId,
                        'successor_teacher_profile_id' => $successor->id,
                        'handover_on' => $day,
                        'reason' => $reason,
                        ...$provenance,
                    ]);

                    return ['outgoing_assignment_id' => $locked->id, 'incoming_assignment_id' => $incoming->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.teacher.handover', 'teacher_assignment', $assignment->id);
        }
    }
}
