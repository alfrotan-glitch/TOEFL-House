<?php

declare(strict_types=1);

namespace App\Modules\Students\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Models\StudentBranchTransfer;
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
 * Student home-branch transfer. The originating branch is immutable; only
 * current_home_branch_id advances, and every transfer appends a historical
 * fact so branch provenance and history are never rewritten.
 */
final class TransferStudentHomeBranch
{
    public const CAPABILITY = 'students.transfer';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{student_id: string, from_branch_id: string|null, to_branch_id: string, transfer_id: string, correlation_id: string} */
    public function transfer(Actor $actor, Student $student, string $targetBranchId, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['students.transfer', $student->id, $targetBranchId, $reason, $actor->actorId]));

        try {
            return $this->idempotency->execute('students.transfer', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $student, $targetBranchId, $reason): array {
                    $outcome = $this->access->decide($actor, self::CAPABILITY, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('students.transfer_denied', $outcome->reason);
                    }
                    if ($reason === '') {
                        throw BusinessRejection::forCode('students.transfer_reason', 'a branch transfer requires a reason');
                    }
                    /** @var Branch|null $target */
                    $target = Branch::query()->find($targetBranchId);
                    if ($target === null || $target->lifecycle_state !== 'active') {
                        throw BusinessRejection::forCode('students.transfer_branch_inactive', 'the target branch must exist and be active');
                    }

                    /** @var Student $locked */
                    $locked = Student::query()->whereKey($student->id)->lockForUpdate()->firstOrFail();
                    /** @var StudentStatus|null $status */
                    $status = StudentStatus::query()->where('student_id', $locked->id)->lockForUpdate()->orderByDesc('seq')->first();
                    if ($status === null || $status->status !== 'active') {
                        throw BusinessRejection::forCode('students.transfer_requires_active', 'a home-branch transfer requires the student to be active');
                    }
                    $fromBranchId = trim((string) ($locked->current_home_branch_id ?? ''));
                    if ($fromBranchId !== '' && $fromBranchId === $targetBranchId) {
                        throw BusinessRejection::forCode('students.transfer_same_branch', 'the student is already assigned to this home branch');
                    }

                    $transfer = StudentBranchTransfer::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $locked->id,
                        'from_branch_id' => $fromBranchId !== '' ? $fromBranchId : null,
                        'to_branch_id' => $targetBranchId,
                        'effective_from' => (new CarbonImmutable)->startOfDay()->toDateString(),
                        'reason' => $reason,
                        'transferred_by' => $actor->actorId,
                    ]);

                    $changes = ['current_home_branch_id' => $targetBranchId];
                    if (trim((string) ($locked->originating_branch_id ?? '')) === '') {
                        $changes['originating_branch_id'] = $targetBranchId;
                    }
                    $locked->forceFill($changes)->save();

                    $event = $this->audit->record($actor->actorId, 'students.transfer', 'student', $locked->id, [
                        'from_branch_id' => $fromBranchId !== '' ? $fromBranchId : null,
                        'current_home_branch_id' => $fromBranchId !== '' ? $fromBranchId : null,
                    ], [
                        'to_branch_id' => $targetBranchId,
                        'current_home_branch_id' => $targetBranchId,
                        'reason' => $reason,
                    ]);

                    return [
                        'student_id' => $locked->id,
                        'from_branch_id' => $fromBranchId !== '' ? $fromBranchId : null,
                        'to_branch_id' => $targetBranchId,
                        'transfer_id' => $transfer->id,
                        'correlation_id' => $event->correlation_id,
                    ];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'students.transfer', 'student', $student->id);
        }
    }
}
