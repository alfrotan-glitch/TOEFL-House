<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\WaitlistLifecycle;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassWaitlistEntry;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Offering;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Models\StudentStatus;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Class waitlist: students queue only when the delivery/offering capacity is
 * exhausted, staff offer a freed seat to the next open entry, and an offered
 * entry is promoted into a normal requested enrollment (never a silent
 * active seat). Withdraw/expire are terminal state changes on the entry.
 */
final class ManageClassWaitlist
{
    public const CAPABILITY_REQUEST = 'academic.enroll';

    public const CAPABILITY_APPROVE = 'academic.enroll_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{entry_id: string, position: int, correlation_id: string} */
    public function join(Actor $requester, string $studentId, string $classId, ?string $offeringId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.waitlist.join', $studentId, $classId, $offeringId ?? '', $requester->actorId]));

        try {
            return $this->idempotency->execute('academic.waitlist.join', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($requester, $studentId, $classId, $offeringId): array {
                    $outcome = $this->access->decide($requester, self::CAPABILITY_REQUEST, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('academic.waitlist_denied', $outcome->reason);
                    }
                    $this->assertStudentActive($studentId);

                    /** @var ClassModel $class */
                    $class = ClassModel::query()->whereKey($classId)->lockForUpdate()->firstOrFail();
                    if ($class->lifecycle_state !== 'active') {
                        throw BusinessRejection::forCode('academic.class_not_active', 'a waitlist requires an active class');
                    }
                    if (ClassWaitlistEntry::query()->where('class_id', $classId)->where('student_id', $studentId)->whereIn('lifecycle_state', ['waiting', 'offered'])->exists()) {
                        throw BusinessRejection::forCode('academic.waitlist_entry_exists', 'this student already has an open waitlist entry for the class');
                    }
                    if (Enrollment::query()->where('class_id', $classId)->where('student_id', $studentId)->whereIn('lifecycle_state', ['requested', 'active', 'frozen'])->exists()) {
                        throw BusinessRejection::forCode('academic.enrollment_seat_exists', 'this student already holds a seat in the class');
                    }

                    if ($offeringId !== null && $offeringId !== '') {
                        $this->assertOfferingMatchesClass($offeringId, $classId);
                    }
                    $classFull = $this->classFull($class);
                    $offeringFull = $offeringId !== null && $offeringId !== '' && $this->offeringFull($offeringId);
                    if (! $classFull && ! $offeringFull) {
                        throw BusinessRejection::forCode('academic.waitlist_not_full', 'a waitlist is available only when the class or offering capacity is exhausted');
                    }

                    $position = (int) ClassWaitlistEntry::query()->where('class_id', $classId)->whereIn('lifecycle_state', ['waiting', 'offered'])->max('position') + 1;
                    $entry = ClassWaitlistEntry::query()->create([
                        'id' => RandomIdentifier::new(),
                        'class_id' => $classId,
                        'student_id' => $studentId,
                        'offering_id' => $offeringId !== null && $offeringId !== '' ? $offeringId : null,
                        'position' => $position,
                        'lifecycle_state' => WaitlistLifecycle::STATE_WAITING,
                        'joined_by' => $requester->actorId,
                    ]);
                    $event = $this->audit->record($requester->actorId, 'academic.waitlist.join', 'class_waitlist_entry', $entry->id, null, [
                        'class_id' => $classId, 'student_id' => $studentId, 'offering_id' => $entry->offering_id, 'position' => $position,
                    ]);

                    return ['entry_id' => $entry->id, 'position' => $position, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $requester, 'academic.waitlist.join', 'class_waitlist_entry', $classId);
        }
    }

    /** @return array{entry_id: string, lifecycle_state: string, correlation_id: string} */
    public function offer(Actor $actor, ClassWaitlistEntry $entry, string $idempotencyKey): array
    {
        return $this->transition($actor, $entry, WaitlistLifecycle::STATE_OFFERED, self::CAPABILITY_APPROVE, $idempotencyKey);
    }

    /** @return array{entry_id: string, enrollment_id: string, correlation_id: string} */
    public function promote(Actor $actor, ClassWaitlistEntry $entry, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.waitlist.promote', $entry->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.waitlist.promote', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $entry, $idempotencyKey): array {
                    $outcome = $this->access->decide($actor, self::CAPABILITY_APPROVE, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('academic.waitlist_denied', $outcome->reason);
                    }

                    /** @var ClassWaitlistEntry $locked */
                    $locked = ClassWaitlistEntry::query()->whereKey($entry->id)->lockForUpdate()->firstOrFail();
                    WaitlistLifecycle::requireTransition($locked->lifecycle_state, WaitlistLifecycle::STATE_ENROLLED);
                    $this->assertCapacityAvailable($locked);

                    $requested = app(MaintainEnrollment::class)->request(
                        $actor,
                        $locked->student_id,
                        $locked->class_id,
                        $idempotencyKey.'.enrollment',
                        $locked->offering_id,
                    );

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => WaitlistLifecycle::STATE_ENROLLED])->save();
                    $event = $this->audit->record($actor->actorId, 'academic.waitlist.promote', 'class_waitlist_entry', $locked->id, $before, [
                        'lifecycle_state' => WaitlistLifecycle::STATE_ENROLLED,
                        'enrollment_id' => $requested['enrollment_id'],
                    ]);

                    return [
                        'entry_id' => $locked->id,
                        'enrollment_id' => $requested['enrollment_id'],
                        'correlation_id' => $event->correlation_id,
                    ];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.waitlist.promote', 'class_waitlist_entry', $entry->id);
        }
    }

    /** @return array{entry_id: string, lifecycle_state: string, correlation_id: string} */
    public function withdraw(Actor $actor, ClassWaitlistEntry $entry, string $idempotencyKey): array
    {
        return $this->transition($actor, $entry, WaitlistLifecycle::STATE_WITHDRAWN, self::CAPABILITY_REQUEST, $idempotencyKey);
    }

    /** @return array{entry_id: string, lifecycle_state: string, correlation_id: string} */
    public function expire(Actor $actor, ClassWaitlistEntry $entry, string $idempotencyKey): array
    {
        return $this->transition($actor, $entry, WaitlistLifecycle::STATE_EXPIRED, self::CAPABILITY_APPROVE, $idempotencyKey);
    }

    /** @return array{entry_id: string, lifecycle_state: string, correlation_id: string} */
    private function transition(Actor $actor, ClassWaitlistEntry $entry, string $toState, string $capability, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.waitlist.transition', $entry->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.waitlist.transition.'.$toState, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $entry, $toState, $capability): array {
                    $outcome = $this->access->decide($actor, $capability, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('academic.waitlist_denied', $outcome->reason);
                    }

                    /** @var ClassWaitlistEntry $locked */
                    $locked = ClassWaitlistEntry::query()->whereKey($entry->id)->lockForUpdate()->firstOrFail();
                    WaitlistLifecycle::requireTransition($locked->lifecycle_state, $toState);
                    if ($toState === WaitlistLifecycle::STATE_OFFERED) {
                        $this->assertCapacityAvailable($locked);
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState])->save();
                    $event = $this->audit->record($actor->actorId, 'academic.waitlist.transition.'.$toState, 'class_waitlist_entry', $locked->id, $before, ['lifecycle_state' => $toState]);

                    return ['entry_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.waitlist.transition', 'class_waitlist_entry', $entry->id);
        }
    }

    private function assertStudentActive(string $studentId): void
    {
        /** @var Student|null $student */
        $student = Student::query()->find($studentId);
        if ($student === null) {
            throw BusinessRejection::forCode('academic.student_unknown', 'a waitlist requires a known student');
        }
        $status = StudentStatus::query()->where('student_id', $studentId)->orderByDesc('seq')->first();
        if ($status === null || $status->status !== 'active') {
            throw BusinessRejection::forCode('academic.student_not_active', 'a waitlist requires a currently active student');
        }
    }

    private function assertOfferingMatchesClass(string $offeringId, string $classId): void
    {
        /** @var Offering $offering */
        $offering = Offering::query()->whereKey($offeringId)->firstOrFail();
        if ($offering->lifecycle_state !== Offering::STATE_OPEN) {
            throw BusinessRejection::forCode('academic.offering_not_open', 'a waitlist may target only an open offering');
        }
        /** @var ClassModel $class */
        $class = ClassModel::query()->whereKey($classId)->firstOrFail();
        if ($offering->academic_period_id !== $class->period_id || $offering->program_version_level_id !== $class->program_version_level_id) {
            throw BusinessRejection::forCode('academic.waitlist_offering_mismatch', 'the waitlist offering must match the class period and level');
        }
    }

    private function classFull(ClassModel $class): bool
    {
        $activeSeats = Enrollment::query()->where('class_id', $class->id)->where('lifecycle_state', 'active')->count();

        return $activeSeats >= $class->capacity;
    }

    private function offeringFull(string $offeringId): bool
    {
        /** @var Offering $offering */
        $offering = Offering::query()->whereKey($offeringId)->firstOrFail();
        $activeSeats = Enrollment::query()->where('offering_id', $offeringId)->where('lifecycle_state', 'active')->count();

        return $activeSeats >= $offering->capacity;
    }

    private function assertCapacityAvailable(ClassWaitlistEntry $entry): void
    {
        /** @var ClassModel $class */
        $class = ClassModel::query()->whereKey($entry->class_id)->firstOrFail();
        if ($class->lifecycle_state !== 'active') {
            throw BusinessRejection::forCode('academic.class_not_active', 'the waitlist class is not active');
        }
        if ($this->classFull($class)) {
            throw BusinessRejection::forCode('academic.waitlist_class_full', 'the class still has no capacity for the waitlist offer');
        }
        if ($entry->offering_id !== null && $this->offeringFull($entry->offering_id)) {
            throw BusinessRejection::forCode('academic.waitlist_offering_full', 'the offering still has no capacity for the waitlist offer');
        }
    }
}
