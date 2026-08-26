<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\ClassLifecycle;
use App\Modules\Academic\Domain\EnrollmentLifecycle;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
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
 * Enrollment control: request (student must be currently active, class
 * active, seat free), activation under the enrollment-approval capability
 * with the capacity invariant, freeze/withdraw/complete, and transfer that
 * closes the old enrollment and opens a new one in the target class under
 * the same capacity rule. There is never a duplicate active seat.
 */
final class MaintainEnrollment
{
    public const CAPABILITY_REQUEST = 'academic.enroll';

    public const CAPABILITY_APPROVE = 'academic.enroll_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{enrollment_id: string, correlation_id: string} */
    public function request(Actor $requester, string $studentId, string $classId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.enrollment.request', $studentId, $classId, $requester->actorId]));

        try {
            return $this->idempotency->execute('academic.enrollment.request', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($requester, $studentId, $classId): array {
                    $outcome = $this->access->decide($requester, self::CAPABILITY_REQUEST, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('academic.enrollment_denied', $outcome->reason);
                    }
                    $this->assertStudentActive($studentId);
                    $this->assertClassActive($classId);
                    if (Enrollment::query()->where('student_id', $studentId)->where('class_id', $classId)->whereIn('lifecycle_state', ['requested', 'active', 'frozen'])->exists()) {
                        throw BusinessRejection::forCode('academic.enrollment_seat_exists', 'this student already holds a seat in this class');
                    }

                    $enrollment = Enrollment::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $studentId,
                        'class_id' => $classId,
                        'lifecycle_state' => EnrollmentLifecycle::STATE_REQUESTED,
                    ]);
                    $event = $this->audit->record($requester->actorId, 'academic.enrollment.request', 'enrollment', $enrollment->id, null, [
                        'student_id' => $studentId, 'class_id' => $classId,
                    ]);

                    return ['enrollment_id' => $enrollment->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $requester, 'academic.enrollment.request', 'enrollment', $studentId);
        }
    }

    /** @return array{enrollment_id: string, lifecycle_state: string, correlation_id: string} */
    public function activate(Actor $approver, Enrollment $enrollment, string $idempotencyKey): array
    {
        return $this->transition($approver, $enrollment, EnrollmentLifecycle::STATE_ACTIVE, self::CAPABILITY_APPROVE, $idempotencyKey);
    }

    /** @return array{enrollment_id: string, lifecycle_state: string, correlation_id: string} */
    public function freeze(Actor $actor, Enrollment $enrollment, string $idempotencyKey): array
    {
        return $this->transition($actor, $enrollment, EnrollmentLifecycle::STATE_FROZEN, self::CAPABILITY_APPROVE, $idempotencyKey);
    }

    /** @return array{enrollment_id: string, lifecycle_state: string, correlation_id: string} */
    public function withdraw(Actor $actor, Enrollment $enrollment, string $idempotencyKey): array
    {
        return $this->transition($actor, $enrollment, EnrollmentLifecycle::STATE_WITHDRAWN, self::CAPABILITY_REQUEST, $idempotencyKey);
    }

    /** @return array{enrollment_id: string, lifecycle_state: string, correlation_id: string} */
    public function complete(Actor $actor, Enrollment $enrollment, string $idempotencyKey): array
    {
        return $this->transition($actor, $enrollment, EnrollmentLifecycle::STATE_COMPLETED, self::CAPABILITY_APPROVE, $idempotencyKey);
    }

    /**
     * Transfer closes the old enrollment as transferred and opens a new
     * requested enrollment in the target class under the same invariants.
     *
     * @return array{enrollment_id: string, previous_enrollment_id: string, correlation_id: string}
     */
    public function transfer(Actor $actor, Enrollment $enrollment, string $targetClassId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.enrollment.transfer', $enrollment->id, $targetClassId, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.enrollment.transfer', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $enrollment, $targetClassId): array {
                    $outcome = $this->access->decide($actor, self::CAPABILITY_APPROVE, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('academic.enrollment_denied', $outcome->reason);
                    }

                    /** @var Enrollment $locked */
                    $locked = Enrollment::query()->whereKey($enrollment->id)->lockForUpdate()->firstOrFail();
                    EnrollmentLifecycle::requireTransition($locked->lifecycle_state, EnrollmentLifecycle::STATE_TRANSFERRED);
                    if ($targetClassId === $locked->class_id) {
                        throw BusinessRejection::forCode('academic.transfer_same_class', 'a transfer requires a different target class');
                    }
                    $this->assertClassActive($targetClassId);
                    $this->assertStudentActive($locked->student_id);
                    $this->assertCapacity($targetClassId);
                    if (Enrollment::query()->where('student_id', $locked->student_id)->where('class_id', $targetClassId)->whereIn('lifecycle_state', ['requested', 'active', 'frozen'])->exists()) {
                        throw BusinessRejection::forCode('academic.enrollment_seat_exists', 'this student already holds a seat in the target class');
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => EnrollmentLifecycle::STATE_TRANSFERRED]);
                    $locked->save();

                    $next = Enrollment::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $locked->student_id,
                        'class_id' => $targetClassId,
                        'lifecycle_state' => EnrollmentLifecycle::STATE_REQUESTED,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.enrollment.transfer', 'enrollment', $next->id, $before, [
                        'previous_enrollment_id' => $locked->id,
                        'student_id' => $locked->student_id,
                        'from_class' => $locked->class_id,
                        'to_class' => $targetClassId,
                        'lifecycle_state' => EnrollmentLifecycle::STATE_REQUESTED,
                    ]);

                    return ['enrollment_id' => $next->id, 'previous_enrollment_id' => $locked->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.enrollment.transfer', 'enrollment', $enrollment->id);
        }
    }

    /** @return array{enrollment_id: string, lifecycle_state: string, correlation_id: string} */
    private function transition(Actor $actor, Enrollment $enrollment, string $toState, string $capability, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.enrollment.transition', $enrollment->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.enrollment.transition.'.$toState, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $enrollment, $toState, $capability): array {
                    $outcome = $this->access->decide($actor, $capability, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('academic.enrollment_denied', $outcome->reason);
                    }

                    /** @var Enrollment $locked */
                    $locked = Enrollment::query()->whereKey($enrollment->id)->lockForUpdate()->firstOrFail();
                    EnrollmentLifecycle::requireTransition($locked->lifecycle_state, $toState);
                    if ($toState === EnrollmentLifecycle::STATE_ACTIVE) {
                        $this->assertClassActive($locked->class_id);
                        $this->assertCapacity($locked->class_id);
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.enrollment.'.$toState, 'enrollment', $locked->id, $before, ['lifecycle_state' => $toState]);

                    return ['enrollment_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.enrollment.'.$toState, 'enrollment', $enrollment->id);
        }
    }

    private function assertStudentActive(string $studentId): void
    {
        /** @var Student|null $student */
        $student = Student::query()->find($studentId);
        if ($student === null) {
            throw BusinessRejection::forCode('academic.student_unknown', 'enrollment requires a known student');
        }
        /** @var StudentStatus|null $status */
        $status = StudentStatus::query()->where('student_id', $studentId)->orderByDesc('seq')->first();
        if ($status === null || $status->status !== 'active') {
            throw BusinessRejection::forCode('academic.student_not_active', 'enrollment requires a currently active student');
        }
    }

    private function assertClassActive(string $classId): void
    {
        /** @var ClassModel|null $class */
        $class = ClassModel::query()->find($classId);
        if ($class === null || $class->lifecycle_state !== ClassLifecycle::STATE_ACTIVE) {
            throw BusinessRejection::forCode('academic.class_not_active', 'the class is not active');
        }
    }

    private function assertCapacity(string $classId): void
    {
        /** @var ClassModel $class */
        $class = ClassModel::query()->whereKey($classId)->lockForUpdate()->firstOrFail();
        $activeSeats = Enrollment::query()->where('class_id', $classId)->where('lifecycle_state', 'active')->count();
        if ($activeSeats >= $class->capacity) {
            throw BusinessRejection::forCode('academic.class_full', sprintf('class capacity of %d is exhausted', $class->capacity));
        }
    }
}
