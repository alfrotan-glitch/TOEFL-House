<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Academic\Domain\RecordBranch;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Offering;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\FinancialCoverageLock;
use App\Modules\Finance\Models\EnrollmentInstallmentPlan;
use App\Modules\Finance\Models\FinancialCoverageCommitment;
use App\Modules\Finance\Models\FinancialCoverageRevocation;
use App\Modules\Finance\Models\FinancialCredit;
use App\Modules\Finance\Models\FinancialGateException;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Corrects an already approved enrollment-gate source without rewriting it.
 *
 * A revocation is staged and independently recorded. Its source and original
 * commitments remain audit history; Finance issues a new evidenced source if
 * a replacement amount/scope is appropriate. The canonical student lock
 * serializes a revocation with competing coverage approvals and enrollment
 * gate assessments.
 */
final class RevokeFinancialCoverage
{
    public const CAPABILITY_PROPOSE = 'finance.coverage_revoke';

    public const CAPABILITY_APPROVE = 'finance.coverage_revoke_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{revocation_id: string, correlation_id: string} */
    public function propose(Actor $requester, string $sourceType, string $sourceId, string $reason, string $idempotencyKey): array
    {
        $sourceType = trim($sourceType);
        $sourceId = trim($sourceId);
        $reason = trim($reason);
        $payload = hash('sha256', implode('|', ['finance.coverage-revocation.propose', $sourceType, $sourceId, $reason, $requester->actorId]));

        try {
            return $this->idempotency->execute('finance.coverage-revocation.propose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($requester, $sourceType, $sourceId, $reason): array {
                    if (trim($reason) === '') {
                        throw BusinessRejection::forCode('finance.coverage_revocation_reason', 'a coverage-source revocation requires its documented reason');
                    }
                    [$studentId, $branches] = $this->sourceTarget($sourceType, $sourceId, false);
                    foreach ($branches as $branch) {
                        $this->require($requester, self::CAPABILITY_PROPOSE, $branch->structureScope());
                    }
                    if (FinancialCoverageRevocation::query()
                        ->where('coverage_source_type', $sourceType)
                        ->where('coverage_source_id', $sourceId)
                        ->where('lifecycle_state', FinancialCoverageRevocation::STATE_RECORDED)
                        ->exists()) {
                        throw BusinessRejection::forCode('finance.coverage_source_already_revoked', 'this approved coverage source has already been revoked');
                    }

                    $revocation = FinancialCoverageRevocation::query()->create([
                        'id' => RandomIdentifier::new(),
                        'coverage_source_type' => $sourceType,
                        'coverage_source_id' => $sourceId,
                        'student_id' => $studentId,
                        'reason' => $reason,
                        'lifecycle_state' => FinancialCoverageRevocation::STATE_PROPOSED,
                        'requested_by' => $requester->actorId,
                    ]);
                    $event = $this->audit->record($requester->actorId, 'finance.coverage-revocation.propose', 'financial_coverage_revocation', $revocation->id, null, [
                        'coverage_source_type' => $sourceType,
                        'coverage_source_id' => $sourceId,
                        'student_id' => $studentId,
                        'reason' => $reason,
                        ...$this->auditProvenance($branches),
                    ]);

                    return ['revocation_id' => $revocation->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $requester, 'finance.coverage-revocation.propose', 'financial_coverage_source', $sourceId);
        }
    }

    /** @return array{revocation_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, FinancialCoverageRevocation $revocation, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.coverage-revocation.approve', $revocation->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('finance.coverage-revocation.approve', $idempotencyKey,
                $payload,
                fn (): array => DB::transaction(function () use ($approver, $revocation): array {
                    $sourceStudentId = $this->sourceStudentId((string) $revocation->coverage_source_type, (string) $revocation->coverage_source_id);
                    FinancialCoverageLock::acquire($sourceStudentId);

                    /** @var FinancialCoverageRevocation $locked */
                    $locked = FinancialCoverageRevocation::query()->whereKey($revocation->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== FinancialCoverageRevocation::STATE_PROPOSED) {
                        throw BusinessRejection::forCode('finance.coverage_revocation_not_proposed', 'only a proposed coverage-source revocation can be recorded');
                    }
                    if (trim((string) $locked->requested_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('finance.coverage_revocation_not_independent', 'the coverage-source requester and approver must differ');
                    }
                    [$studentId, $branches] = $this->sourceTarget((string) $locked->coverage_source_type, (string) $locked->coverage_source_id, true);
                    if (trim($studentId) !== trim($sourceStudentId) || trim((string) $locked->student_id) !== trim($studentId)) {
                        throw BusinessRejection::forCode('finance.coverage_revocation_source_changed', 'the coverage source changed while the canonical student lock was acquired');
                    }
                    foreach ($branches as $branch) {
                        $this->require($approver, self::CAPABILITY_APPROVE, $branch->structureScope());
                    }
                    if (FinancialCoverageRevocation::query()
                        ->where('coverage_source_type', $locked->coverage_source_type)
                        ->where('coverage_source_id', $locked->coverage_source_id)
                        ->where('lifecycle_state', FinancialCoverageRevocation::STATE_RECORDED)
                        ->exists()) {
                        throw BusinessRejection::forCode('finance.coverage_source_already_revoked', 'this approved coverage source has already been revoked');
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill([
                        'lifecycle_state' => FinancialCoverageRevocation::STATE_RECORDED,
                        'approved_by' => $approver->actorId,
                        'approved_at' => now(),
                    ])->save();
                    $event = $this->audit->record($approver->actorId, 'finance.coverage-revocation.approve', 'financial_coverage_revocation', $locked->id, $before, [
                        'lifecycle_state' => FinancialCoverageRevocation::STATE_RECORDED,
                        'coverage_source_type' => $locked->coverage_source_type,
                        'coverage_source_id' => $locked->coverage_source_id,
                        'student_id' => $studentId,
                        'reason' => $locked->reason,
                        ...$this->auditProvenance($branches),
                    ]);

                    return [
                        'revocation_id' => $locked->id,
                        'lifecycle_state' => FinancialCoverageRevocation::STATE_RECORDED,
                        'correlation_id' => $event->correlation_id,
                    ];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'finance.coverage-revocation.approve', 'financial_coverage_revocation', $revocation->id);
        }
    }

    /**
     * @return array{0: string, 1: list<Branch>}
     */
    private function sourceTarget(string $sourceType, string $sourceId, bool $lock): array
    {
        $this->assertSourceType($sourceType);
        $query = match ($sourceType) {
            FinancialCoverageCommitment::SOURCE_FINANCIAL_CREDIT => FinancialCredit::query()->whereKey($sourceId),
            FinancialCoverageCommitment::SOURCE_INSTALLMENT_PLAN => EnrollmentInstallmentPlan::query()->whereKey($sourceId),
            FinancialCoverageCommitment::SOURCE_GATE_EXCEPTION => FinancialGateException::query()->whereKey($sourceId),
        };
        if ($lock) {
            $query->lockForUpdate();
        }
        /** @var FinancialCredit|EnrollmentInstallmentPlan|FinancialGateException|null $source */
        $source = $query->first();
        if ($source === null || $source->lifecycle_state !== 'approved') {
            throw BusinessRejection::forCode('finance.coverage_source_unknown', 'a coverage-source revocation requires an existing approved Finance gate source');
        }

        $studentId = trim((string) $source->student_id);
        if ($studentId === '') {
            throw BusinessRejection::forCode('finance.coverage_source_unknown', 'an approved coverage source must retain its student identity');
        }
        $branchIds = [];
        $studentBranchId = RecordBranch::studentBranchForId($studentId);
        if ($studentBranchId === null) {
            throw BusinessRejection::forCode('finance.coverage_revocation_provenance_required', 'a coverage-source revocation requires known student branch provenance');
        }
        $branchIds[] = $studentBranchId;

        if ($source instanceof EnrollmentInstallmentPlan || $source instanceof FinancialGateException) {
            $offeringId = trim((string) $source->offering_id);
            if ($offeringId !== '') {
                $offeringBranchId = trim((string) Offering::query()->whereKey($offeringId)->value('branch_id'));
                if ($offeringBranchId === '') {
                    throw BusinessRejection::forCode('finance.coverage_revocation_provenance_required', 'a scoped coverage source requires known offering branch provenance');
                }
                $branchIds[] = $offeringBranchId;
            }
        }
        if ($source instanceof FinancialGateException) {
            $classId = trim((string) $source->class_id);
            if ($classId !== '') {
                $classBranchId = trim((string) ClassModel::query()->whereKey($classId)->value('branch_id'));
                if ($classBranchId === '') {
                    throw BusinessRejection::forCode('finance.coverage_revocation_provenance_required', 'a class-scoped coverage source requires known class branch provenance');
                }
                $branchIds[] = $classBranchId;
            }
        }

        $branches = [];
        foreach (array_values(array_unique($branchIds, SORT_STRING)) as $branchId) {
            /** @var Branch|null $branch */
            $branch = Branch::query()->whereKey($branchId)->first();
            if ($branch === null || $branch->lifecycle_state !== 'active') {
                throw BusinessRejection::forCode('finance.coverage_revocation_provenance_required', 'a coverage-source revocation requires active branch provenance');
            }
            $branches[] = $branch;
        }

        return [$studentId, $branches];
    }

    private function sourceStudentId(string $sourceType, string $sourceId): string
    {
        [$studentId] = $this->sourceTarget($sourceType, $sourceId, false);

        return $studentId;
    }

    private function assertSourceType(string $sourceType): void
    {
        if (! in_array($sourceType, [
            FinancialCoverageCommitment::SOURCE_FINANCIAL_CREDIT,
            FinancialCoverageCommitment::SOURCE_INSTALLMENT_PLAN,
            FinancialCoverageCommitment::SOURCE_GATE_EXCEPTION,
        ], true)) {
            throw BusinessRejection::forCode('finance.coverage_source_type_unknown', 'the coverage-source type is not supported');
        }
    }

    /**
     * @param list<Branch> $branches
     * @return array{branch_id: string|null, organization_id: string|null, branch_ids: list<string>, organization_ids: list<string>}
     */
    private function auditProvenance(array $branches): array
    {
        $branchIds = [];
        $organizationIds = [];
        foreach ($branches as $branch) {
            $scope = $branch->structureScope();
            $branchIds[] = (string) $branch->id;
            $organizationIds[] = $scope->organizationId;
        }
        $branchIds = array_values(array_unique($branchIds, SORT_STRING));
        $organizationIds = array_values(array_unique($organizationIds, SORT_STRING));

        return [
            'branch_id' => count($branchIds) === 1 ? $branchIds[0] : null,
            'organization_id' => count($organizationIds) === 1 ? $organizationIds[0] : null,
            'branch_ids' => $branchIds,
            'organization_ids' => $organizationIds,
        ];
    }

    private function require(Actor $actor, string $capability, \App\Support\Authorization\StructureScope $scope): void
    {
        $outcome = $this->access->decide($actor, $capability, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.coverage_revocation_denied', $outcome->reason);
        }
    }
}
