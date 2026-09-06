<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\AcademicAccess;
use App\Modules\Academic\Domain\RecordBranch;
use App\Modules\Academic\Models\AttendanceFact;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Attendance control: facts are append-only evidence tied to an active
 * enrollment of the session's class; corrections append a linked row with
 * a mandatory reason and never rewrite the original.
 */
final class RecordAttendance
{
    public const CAPABILITY = 'academic.attendance';

    public function __construct(
        private readonly AcademicAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{fact_id: string, correlation_id: string} */
    public function record(Actor $recorder, ClassSession $session, Enrollment $enrollment, string $status, string $idempotencyKey): array
    {
        return $this->append($recorder, $session, $enrollment, $status, null, null, 'academic.attendance.record', $idempotencyKey);
    }

    /** @return array{fact_id: string, corrects_id: string, correlation_id: string} */
    public function correct(Actor $recorder, AttendanceFact $original, string $status, string $reason, string $idempotencyKey): array
    {
        /** @var ClassSession $session */
        $session = ClassSession::query()->findOrFail($original->session_id);
        /** @var Enrollment $enrollment */
        $enrollment = Enrollment::query()->findOrFail($original->enrollment_id);

        return $this->append($recorder, $session, $enrollment, $status, $original->id, $reason, 'academic.attendance.correct', $idempotencyKey);
    }

    /** @return array{fact_id: string, correlation_id: string}|array{fact_id: string, corrects_id: string, correlation_id: string} */
    private function append(Actor $recorder, ClassSession $session, Enrollment $enrollment, string $status, ?string $correctsId, ?string $reason, string $operation, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [$operation, $session->id, $enrollment->id, $status, $correctsId ?? '', $reason ?? '', $recorder->actorId]));

        try {
            return $this->idempotency->execute($operation, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($recorder, $session, $enrollment, $status, $correctsId, $reason, $operation): array {
                    /** @var Enrollment $lockedEnrollment */
                    $lockedEnrollment = Enrollment::query()->whereKey($enrollment->id)->lockForUpdate()->firstOrFail();
                    // Seat-level grain: each seat is checked in its own
                    // branch, so mixed-branch classes stay correct.
                    $this->access->require($recorder, self::CAPABILITY, RecordBranch::enrollmentBranch($lockedEnrollment), 'academic.attendance_denied');
                    if (! in_array($status, ['present', 'absent', 'late', 'excused'], true)) {
                        throw BusinessRejection::forCode('academic.attendance_status_unknown', sprintf('unknown attendance status %s', $status));
                    }
                    /** @var ClassModel|null $class */
                    $class = ClassModel::query()->find($session->class_id);
                    if ($class === null || $class->lifecycle_state !== 'active') {
                        throw BusinessRejection::forCode('academic.attendance_class_not_active', 'attendance is taken only on sessions of an active class');
                    }
                    if ($lockedEnrollment->class_id !== $session->class_id) {
                        throw BusinessRejection::forCode('academic.attendance_wrong_class', 'the enrollment does not belong to the session class');
                    }
                    if ($lockedEnrollment->lifecycle_state !== 'active') {
                        throw BusinessRejection::forCode('academic.attendance_enrollment_not_active', 'attendance attaches only to an active enrollment');
                    }
                    if ($correctsId !== null) {
                        if ($reason === null || $reason === '') {
                            throw BusinessRejection::forCode('academic.attendance_correction_reason', 'a correction requires a reason');
                        }
                        /** @var AttendanceFact|null $original */
                        $original = AttendanceFact::query()->find($correctsId);
                        if ($original === null || $original->enrollment_id !== $lockedEnrollment->id) {
                            throw BusinessRejection::forCode('academic.attendance_correction_target', 'a correction must target a fact of the same enrollment');
                        }
                    }

                    $fact = AttendanceFact::query()->create([
                        'id' => RandomIdentifier::new(),
                        'session_id' => $session->id,
                        'enrollment_id' => $lockedEnrollment->id,
                        'status' => $status,
                        'corrects_id' => $correctsId,
                        'reason' => $reason,
                        'recorded_by' => $recorder->actorId,
                    ]);
                    $event = $this->audit->record($recorder->actorId, $operation, 'attendance_fact', $fact->id, null, [
                        'session_id' => $session->id,
                        'enrollment_id' => $lockedEnrollment->id,
                        'status' => $status,
                        'corrects_id' => $correctsId,
                        'reason' => $reason,
                    ]);

                    return $correctsId !== null
                        ? ['fact_id' => $fact->id, 'corrects_id' => $correctsId, 'correlation_id' => $event->correlation_id]
                        : ['fact_id' => $fact->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $recorder, $operation, 'attendance_fact', $session->id);
        }
    }
}
