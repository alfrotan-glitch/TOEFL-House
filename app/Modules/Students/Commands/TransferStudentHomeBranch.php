<?php

declare(strict_types=1);

namespace App\Modules\Students\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Models\StudentBranchTransfer;
use App\Modules\Students\Models\StudentStatus;
use App\Modules\Academic\Domain\RecordBranch;
use App\Support\Authorization\BranchScopedAccess;
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
        private readonly BranchScopedAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{student_id: string, from_branch_id: string|null, to_branch_id: string, transfer_id: string, correlation_id: string} */
    public function transfer(Actor $actor, Student $student, string $targetBranchId, string $reason, string $idempotencyKey): array
    {
        $targetBranchId = trim($targetBranchId);
        $reason = trim($reason);
        $payload = hash('sha256', implode('|', ['students.transfer', $student->id, $targetBranchId, $reason, $actor->actorId]));

        try {
            return $this->idempotency->execute('students.transfer', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $student, $targetBranchId, $reason): array {
                    if ($reason === '') {
                        throw BusinessRejection::forCode('students.transfer_reason', 'a branch transfer requires a reason');
                    }
                    /** @var Student $locked */
                    $locked = Student::query()->whereKey($student->id)->lockForUpdate()->firstOrFail();
                    /** @var Branch|null $target */
                    $target = Branch::query()->whereKey($targetBranchId)->first();
                    if ($target === null || $target->lifecycle_state !== 'active') {
                        throw BusinessRejection::forCode('students.transfer_branch_inactive', 'the target branch must exist and be active');
                    }
                    /** @var StudentStatus|null $status */
                    $status = StudentStatus::query()->where('student_id', $locked->id)->lockForUpdate()->orderByDesc('seq')->first();
                    if ($status === null || $status->status !== 'active') {
                        throw BusinessRejection::forCode('students.transfer_requires_active', 'a home-branch transfer requires the student to be active');
                    }
                    $sourceBranchId = RecordBranch::studentBranch($locked);
                    if ($sourceBranchId === null) {
                        throw BusinessRejection::forCode('students.transfer_provenance_missing', 'a student without recorded branch provenance cannot be transferred');
                    }
                    // A transfer changes authority-relevant home scope. The
                    // actor must be authorized for both the source record and
                    // the receiving branch; neither scope is client-trusted.
                    $fromBranchId = trim((string) ($locked->current_home_branch_id ?? ''));
                    if ($fromBranchId !== '' && $fromBranchId === $targetBranchId) {
                        throw BusinessRejection::forCode('students.transfer_same_branch', 'the student is already assigned to this home branch');
                    }
                    $scopeBranches = array_values(array_unique(array_filter([$sourceBranchId, (string) $target->id])));
                    sort($scopeBranches);
                    foreach ($scopeBranches as $scopeBranchId) {
                        $this->access->require($actor, self::CAPABILITY, $scopeBranchId, 'students.transfer_denied');
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
                    $locked->forceFill($changes)->save();

                    $event = $this->audit->record($actor->actorId, 'students.transfer', 'student', $locked->id, [
                        'from_branch_id' => $fromBranchId !== '' ? $fromBranchId : null,
                        'current_home_branch_id' => $fromBranchId !== '' ? $fromBranchId : null,
                        'originating_branch_id' => $locked->originating_branch_id,
                    ], [
                        'to_branch_id' => $targetBranchId,
                        'branch_id' => $targetBranchId,
                        'current_home_branch_id' => $targetBranchId,
                        'originating_branch_id' => $locked->originating_branch_id,
                        'organization_id' => $target->structureScope()->organizationId,
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
