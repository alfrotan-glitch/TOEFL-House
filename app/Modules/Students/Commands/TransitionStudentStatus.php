<?php

declare(strict_types=1);

namespace App\Modules\Students\Commands;

use App\Modules\Academic\Queries\GraduationCertificationQuery;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Students\Domain\StudentStatusRegistry;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Models\StudentStatus;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Status transitions append a new status row and close the previous one in
 * the same transaction — status is history, never an overwrite.
 * Suspension and withdrawal need the manage capability; reactivation needs
 * the separate approval capability and is never silent. Alumni is gated on
 * the governed Academic chain: an approved eligible graduation decision and
 * its issued certificate (Academic owns that truth; Students owns the
 * transition).
 */
final class TransitionStudentStatus
{
    public const CAPABILITY_MANAGE = 'students.manage';

    public const CAPABILITY_REACTIVATE = 'students.reactivate';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly GraduationCertificationQuery $certification,
    ) {}

    /** @return array{student_id: string, status: string, correlation_id: string} */
    public function suspend(Actor $actor, Student $student, string $reason, string $idempotencyKey): array
    {
        return $this->transition($actor, $student, StudentStatusRegistry::STATUS_SUSPENDED, self::CAPABILITY_MANAGE, $reason, $idempotencyKey);
    }

    /** @return array{student_id: string, status: string, correlation_id: string} */
    public function withdraw(Actor $actor, Student $student, string $reason, string $idempotencyKey): array
    {
        return $this->transition($actor, $student, StudentStatusRegistry::STATUS_WITHDRAWN, self::CAPABILITY_MANAGE, $reason, $idempotencyKey);
    }

    /** @return array{student_id: string, status: string, correlation_id: string} */
    public function reactivate(Actor $actor, Student $student, string $reason, string $idempotencyKey): array
    {
        return $this->transition($actor, $student, StudentStatusRegistry::STATUS_ACTIVE, self::CAPABILITY_REACTIVATE, $reason, $idempotencyKey);
    }

    /** @return array{student_id: string, status: string, correlation_id: string} */
    public function complete(Actor $actor, Student $student, string $reason, string $idempotencyKey): array
    {
        return $this->transition($actor, $student, StudentStatusRegistry::STATUS_COMPLETED, self::CAPABILITY_MANAGE, $reason, $idempotencyKey);
    }

    /** @return array{student_id: string, status: string, correlation_id: string} */
    public function graduate(Actor $actor, Student $student, string $reason, string $idempotencyKey): array
    {
        return $this->transition($actor, $student, StudentStatusRegistry::STATUS_ALUMNI, self::CAPABILITY_MANAGE, $reason, $idempotencyKey);
    }

    /** @return array{student_id: string, status: string, correlation_id: string} */
    private function transition(Actor $actor, Student $student, string $toStatus, string $capability, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['students.status', $student->id, $toStatus, $reason, $actor->actorId]));

        try {
            return $this->idempotency->execute('students.status.'.$toStatus, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $student, $toStatus, $capability, $reason): array {
                    $outcome = $this->access->decide($actor, $capability, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('students.status_denied', $outcome->reason);
                    }
                    if ($reason === '') {
                        throw BusinessRejection::forCode('students.status_reason', 'a status transition requires a reason');
                    }
                    if ($toStatus === StudentStatusRegistry::STATUS_ALUMNI) {
                        $this->assertGraduationCertified($student->id);
                    }

                    /** @var StudentStatus|null $latest */
                    $latest = StudentStatus::query()->where('student_id', $student->id)->orderByDesc('seq')->lockForUpdate()->first();
                    $from = $latest?->status;
                    if ($from === null) {
                        throw BusinessRejection::forCode('students.no_status_history', 'the student has no status history');
                    }
                    StudentStatusRegistry::requireTransition($from, $toStatus);

                    $today = (new CarbonImmutable)->startOfDay()->toDateString();
                    $status = StudentStatus::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $student->id,
                        'status' => $toStatus,
                        'effective_from' => $today,
                        'reason' => $reason,
                        'actor_id' => $actor->actorId,
                    ]);

                    $event = $this->audit->record($actor->actorId, 'students.status.'.$toStatus, 'student_status', $status->id, ['status' => $from], [
                        'status' => $toStatus, 'reason' => $reason,
                    ]);

                    return ['student_id' => $student->id, 'status' => $toStatus, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'students.status', 'student', $student->id);
        }
    }

    /**
     * Alumni is the governed Academic chain made visible on the student
     * record: an approved eligible graduation decision plus its issued
     * certificate. A free-text reason alone can never mint a graduate.
     */
    private function assertGraduationCertified(string $studentId): void
    {
        $certification = $this->certification->certificationForStudent($studentId);
        if ($certification === null) {
            throw BusinessRejection::forCode('students.graduation_decision_required', 'alumni status requires an approved eligible graduation decision for the student');
        }
        if ($certification['certificate_id'] === null) {
            throw BusinessRejection::forCode('students.graduation_certificate_required', 'alumni status requires the issued graduation certificate');
        }
    }
}
