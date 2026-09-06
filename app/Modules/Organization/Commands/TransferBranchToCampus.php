<?php

declare(strict_types=1);

namespace App\Modules\Organization\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Organization\Domain\OrganizationLifecycle;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Campus;
use App\Modules\Organization\Models\CampusAssignment;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\StructureDecision;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Errors\ConcurrencyConflict;
use App\Support\Errors\DomainError;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * Campus transfer closes the branch's current attribution the day before the
 * transfer date and opens exactly one new attribution; history is retained
 * and the partial unique index serializes concurrent transfers at the
 * persistence boundary.
 */
final class TransferBranchToCampus
{
    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{branch_id: string, from_campus_id: string, to_campus_id: string, effective_from: string, correlation_id: string} */
    public function transfer(Branch $branch, Campus $toCampus, CarbonImmutable $effectiveFrom, StructureDecision $decision, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'organization.branch.transfer',
            $branch->id,
            $toCampus->id,
            $effectiveFrom->startOfDay()->toDateString(),
            implode(',', $decision->participantIds()),
        ]));

        try {
            return $this->idempotency->execute('organization.branch.transfer', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($branch, $toCampus, $effectiveFrom, $decision): array {
                    /** @var Branch $lockedBranch */
                    $lockedBranch = Branch::query()->whereKey($branch->id)->lockForUpdate()->firstOrFail();
                    if ($lockedBranch->lifecycle_state !== OrganizationLifecycle::STATE_ACTIVE) {
                        throw BusinessRejection::forCode('organization.transfer_requires_active_branch', 'only an active branch can transfer between campuses');
                    }

                    /** @var Campus $lockedCampus */
                    $lockedCampus = Campus::query()->whereKey($toCampus->id)->lockForUpdate()->firstOrFail();
                    if ($lockedCampus->lifecycle_state !== OrganizationLifecycle::STATE_ACTIVE) {
                        throw BusinessRejection::forCode('organization.transfer_requires_active_campus', 'destination campus must be active');
                    }

                    $decision->authorize($this->access, $lockedBranch->structureScope());

                    /** @var CampusAssignment|null $current */
                    $current = CampusAssignment::query()
                        ->where('branch_id', $lockedBranch->id)
                        ->whereNull('effective_to')
                        ->lockForUpdate()
                        ->first();
                    if ($current === null) {
                        throw BusinessRejection::forCode('organization.branch_without_campus', 'branch has no open campus attribution');
                    }
                    if ($current->campus_id === $lockedCampus->id) {
                        throw BusinessRejection::forCode('organization.transfer_same_campus', 'branch is already attributed to this campus');
                    }

                    $from = $effectiveFrom->startOfDay();
                    if ($from->toDateString() <= $current->effective_from) {
                        throw BusinessRejection::forCode('organization.transfer_overlaps_history', 'transfer date must follow the current attribution start');
                    }

                    $current->effective_to = $from->toDateString();
                    $current->save();

                    $correlationId = DomainError::newCorrelationId();
                    try {
                        CampusAssignment::query()->create([
                            'id' => RandomIdentifier::new(),
                            'branch_id' => $lockedBranch->id,
                            'campus_id' => $lockedCampus->id,
                            'effective_from' => $from->toDateString(),
                            'effective_to' => null,
                            'transfer_correlation_id' => $correlationId,
                        ]);
                    } catch (UniqueConstraintViolationException) {
                        throw ConcurrencyConflict::forCode('organization.transfer.concurrent', 'another transfer already opened the next attribution');
                    }

                    $this->audit->record(
                        $decision->initiator->actorId,
                        'organization.branch.transfer',
                        'branch',
                        $lockedBranch->id,
                        ['campus_id' => $current->campus_id, 'effective_to' => $current->effective_to],
                        ['campus_id' => $lockedCampus->id, 'effective_from' => $from->toDateString()],
                        $correlationId,
                    );

                    return [
                        'branch_id' => $lockedBranch->id,
                        'from_campus_id' => $current->campus_id,
                        'to_campus_id' => $lockedCampus->id,
                        'effective_from' => $from->toDateString(),
                        'correlation_id' => $correlationId,
                    ];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $decision->initiator, 'organization.branch.transfer', 'branch', $branch->id);
        }
    }
}
