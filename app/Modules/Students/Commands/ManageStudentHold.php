<?php

declare(strict_types=1);

namespace App\Modules\Students\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Models\StudentHoldEvent;
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
 * Student-level freeze/resume hold. The hold is append-only evidence; staff
 * workflow can observe an open freeze and the student lifecycle query can
 * surface it alongside the authoritative Academic enrollment states. This
 * command never mutates Academic enrollment rows.
 */
final class ManageStudentHold
{
    public const CAPABILITY = 'students.hold';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{student_id: string, action: string, hold_event_id: string, correlation_id: string} */
    public function freeze(Actor $actor, Student $student, string $reason, string $idempotencyKey): array
    {
        return $this->appendAction($actor, $student, 'freeze', $reason, $idempotencyKey);
    }

    /** @return array{student_id: string, action: string, hold_event_id: string, correlation_id: string} */
    public function resume(Actor $actor, Student $student, string $reason, string $idempotencyKey): array
    {
        return $this->appendAction($actor, $student, 'resume', $reason, $idempotencyKey);
    }

    /** @return array{student_id: string, action: string, hold_event_id: string, correlation_id: string} */
    private function appendAction(Actor $actor, Student $student, string $action, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['students.hold.'.$action, $student->id, $reason, $actor->actorId]));

        try {
            return $this->idempotency->execute('students.hold.'.$action, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $student, $action, $reason): array {
                    $outcome = $this->access->decide($actor, self::CAPABILITY, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('students.hold_denied', $outcome->reason);
                    }
                    if ($reason === '') {
                        throw BusinessRejection::forCode('students.hold_reason', 'a student hold transition requires a reason');
                    }

                    /** @var Student $locked */
                    $locked = Student::query()->whereKey($student->id)->lockForUpdate()->firstOrFail();
                    /** @var StudentStatus|null $status */
                    $status = StudentStatus::query()->where('student_id', $locked->id)->lockForUpdate()->orderByDesc('seq')->first();
                    if ($status === null || $status->status !== 'active') {
                        throw BusinessRejection::forCode('students.hold_requires_active', 'a student hold may be opened or resumed only while the student is active');
                    }

                    /** @var StudentHoldEvent|null $latest */
                    $latest = StudentHoldEvent::query()->where('student_id', $locked->id)->lockForUpdate()->orderByDesc('seq')->first();
                    $currentAction = $latest?->action;
                    if ($action === 'freeze' && $currentAction === 'freeze') {
                        throw BusinessRejection::forCode('students.hold_already_frozen', 'this student already has an open freeze');
                    }
                    if ($action === 'resume' && $currentAction !== 'freeze') {
                        throw BusinessRejection::forCode('students.hold_not_frozen', 'only a frozen student can be resumed');
                    }

                    $event = StudentHoldEvent::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $locked->id,
                        'action' => $action,
                        'effective_from' => (new CarbonImmutable)->startOfDay()->toDateString(),
                        'reason' => $reason,
                        'actor_id' => $actor->actorId,
                    ]);

                    $audit = $this->audit->record($actor->actorId, 'students.hold.'.$action, 'student_hold_event', $event->id, [
                        'action' => $latest?->action,
                    ], ['action' => $action, 'reason' => $reason]);

                    return [
                        'student_id' => $locked->id,
                        'action' => $action,
                        'hold_event_id' => $event->id,
                        'correlation_id' => $audit->correlation_id,
                    ];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'students.hold.'.$action, 'student_hold_event', $student->id);
        }
    }
}
