<?php

declare(strict_types=1);

namespace App\Modules\Hr\Commands;

use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\Employment;
use App\Modules\Hr\Models\WorkBasis;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Work/teaching basis evidence: academic teaching evidence enters as a
 * controlled input — when it disagrees with employment status it is HELD
 * (preserved for review), never dropped; manual declarations require an
 * open employment up front. Evidence rows are append-only history.
 */
final class RecordWorkBasis
{
    public const CAPABILITY = 'hr.workbasis';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{work_basis_id: string, lifecycle_state: string, correlation_id: string} */
    public function recordFromAcademic(Actor $recorder, Employment $employment, string $teacherAssignmentId, string $periodFrom, string $periodTo, string $quantity, string $evidenceRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.workbasis.academic', $employment->id, $teacherAssignmentId, $periodFrom, $periodTo, $quantity, $recorder->actorId]));

        try {
            return $this->idempotency->execute('hr.workbasis.academic', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($recorder, $employment, $teacherAssignmentId, $periodFrom, $periodTo, $quantity, $evidenceRef): array {
                    $this->require($recorder);

                    /** @var TeacherAssignment|null $assignment */
                    $assignment = TeacherAssignment::query()->find($teacherAssignmentId);
                    if ($assignment === null) {
                        throw BusinessRejection::forCode('hr.workbasis_assignment_unknown', 'the referenced teaching assignment does not exist');
                    }

                    /** @var Employment $locked */
                    $locked = Employment::query()->whereKey($employment->id)->lockForUpdate()->firstOrFail();
                    if (trim((string) $locked->person_id) !== trim((string) $assignment->teacher_person_id)) {
                        throw BusinessRejection::forCode('hr.workbasis_person_mismatch', 'the teaching assignment belongs to a different teacher');
                    }
                    $openDuringPeriod = $locked->lifecycle_state === EmploymentLifecycle::STATE_ACTIVE
                        || $locked->lifecycle_state === EmploymentLifecycle::STATE_ON_LEAVE;

                    $basis = WorkBasis::query()->create([
                        'id' => RandomIdentifier::new(),
                        'employment_id' => $locked->id,
                        'source' => 'academic',
                        'teacher_assignment_id' => $assignment->id,
                        'period_from' => $periodFrom,
                        'period_to' => $periodTo,
                        'quantity' => $quantity,
                        'unit' => 'hours',
                        'evidence_ref' => $evidenceRef,
                        'note' => $openDuringPeriod ? null : 'held: employment state '.$locked->lifecycle_state.' disagrees with the teaching evidence',
                        'lifecycle_state' => $openDuringPeriod ? 'recorded' : 'held',
                        'recorded_by' => $recorder->actorId,
                    ]);
                    $event = $this->audit->record($recorder->actorId, 'hr.workbasis.academic', 'work_basis', $basis->id, null, [
                        'employment_id' => $locked->id, 'teacher_assignment_id' => $assignment->id, 'lifecycle_state' => $basis->lifecycle_state,
                    ]);

                    return ['work_basis_id' => $basis->id, 'lifecycle_state' => $basis->lifecycle_state, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $recorder, 'hr.workbasis.academic', 'work_basis', $employment->id);
        }
    }

    /** @return array{work_basis_id: string, lifecycle_state: string, correlation_id: string} */
    public function recordManual(Actor $recorder, Employment $employment, string $periodFrom, string $periodTo, string $quantity, string $unit, string $evidenceRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['hr.workbasis.manual', $employment->id, $periodFrom, $periodTo, $quantity, $unit, $recorder->actorId]));

        try {
            return $this->idempotency->execute('hr.workbasis.manual', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($recorder, $employment, $periodFrom, $periodTo, $quantity, $unit, $evidenceRef): array {
                    $this->require($recorder);
                    if ($evidenceRef === '') {
                        throw BusinessRejection::forCode('hr.workbasis_evidence', 'work evidence requires a reference');
                    }

                    /** @var Employment $locked */
                    $locked = Employment::query()->whereKey($employment->id)->lockForUpdate()->firstOrFail();
                    if (! in_array($locked->lifecycle_state, [EmploymentLifecycle::STATE_ACTIVE, EmploymentLifecycle::STATE_ON_LEAVE], true)) {
                        throw BusinessRejection::forCode('hr.workbasis_employment_not_open', 'manual work evidence requires an open employment');
                    }

                    $basis = WorkBasis::query()->create([
                        'id' => RandomIdentifier::new(),
                        'employment_id' => $locked->id,
                        'source' => 'manual',
                        'period_from' => $periodFrom,
                        'period_to' => $periodTo,
                        'quantity' => $quantity,
                        'unit' => $unit,
                        'evidence_ref' => $evidenceRef,
                        'lifecycle_state' => 'recorded',
                        'recorded_by' => $recorder->actorId,
                    ]);
                    $event = $this->audit->record($recorder->actorId, 'hr.workbasis.manual', 'work_basis', $basis->id, null, [
                        'employment_id' => $locked->id, 'quantity' => $quantity, 'unit' => $unit,
                    ]);

                    return ['work_basis_id' => $basis->id, 'lifecycle_state' => 'recorded', 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $recorder, 'hr.workbasis.manual', 'work_basis', $employment->id);
        }
    }

    private function require(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('hr.workbasis_denied', $outcome->reason);
        }
    }
}
