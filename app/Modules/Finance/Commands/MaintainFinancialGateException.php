<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Academic\Domain\RecordBranch;
use App\Modules\Organization\Models\Branch;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Offering;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\FinancialCoverageCommitmentAllocator;
use App\Modules\Finance\Domain\FinancialCoverageLock;
use App\Modules\Finance\Models\FinancialGateException;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use App\Support\MoneyAmount;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Finance-owned, approved gate exception. An approved exception carries an
 * explicit reason and effectiveness window and is scoped to a student (and,
 * when given, an offering/class). It is never a frontend bypass.
 */
final class MaintainFinancialGateException
{
    public const CAPABILITY_PROPOSE = 'finance.gate_exception';

    public const CAPABILITY_APPROVE = 'finance.gate_exception_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly FinancialCoverageCommitmentAllocator $coverageCommitments,
    ) {}

    /** @return array{exception_id: string, correlation_id: string} */
    public function propose(Actor $proposer, string $studentId, ?string $offeringId, ?string $classId, string $amount, string $reason, string $effectiveFrom, ?string $effectiveTo, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.gate_exception.propose', $studentId, (string) $offeringId, (string) $classId, $amount, $reason, $effectiveFrom, (string) $effectiveTo, $proposer->actorId]));

        try {
            return $this->idempotency->execute('finance.gate_exception.propose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($proposer, $studentId, $offeringId, $classId, $amount, $reason, $effectiveFrom, $effectiveTo): array {
                    $this->validate($studentId, $offeringId, $classId, $amount, $reason, $effectiveFrom, $effectiveTo);
                    $targetBranches = $this->branchesForTarget($studentId, $offeringId, $classId);
                    foreach ($targetBranches as $branch) {
                        $this->require($proposer, self::CAPABILITY_PROPOSE, $branch->structureScope());
                    }
                    $provenance = $this->provenanceForBranches($targetBranches);

                    $exception = FinancialGateException::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $studentId,
                        'offering_id' => $offeringId !== null && $offeringId !== '' ? $offeringId : null,
                        'class_id' => $classId !== null && $classId !== '' ? $classId : null,
                        'amount' => $amount,
                        'reason' => $reason,
                        'effective_from' => $effectiveFrom,
                        'effective_to' => $effectiveTo !== null && $effectiveTo !== '' ? $effectiveTo : null,
                        'lifecycle_state' => FinancialGateException::STATE_PROPOSED,
                        'requested_by' => $proposer->actorId,
                    ]);
                    $event = $this->audit->record($proposer->actorId, 'finance.gate_exception.propose', 'financial_gate_exception', $exception->id, null, [
                        'student_id' => $studentId, 'amount' => $amount, 'reason' => $reason,
                        'branch_id' => $provenance['branch_id'], 'organization_id' => $provenance['organization_id'],
                    ]);

                    return ['exception_id' => $exception->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $proposer, 'finance.gate_exception.propose', 'financial_gate_exception', $reason);
        }
    }

    /** @return array{exception_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, FinancialGateException $exception, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.gate_exception.approve', $exception->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('finance.gate_exception.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $exception): array {
                    FinancialCoverageLock::acquire((string) $exception->student_id);

                    /** @var FinancialGateException $locked */
                    $locked = FinancialGateException::query()->whereKey($exception->id)->lockForUpdate()->firstOrFail();
                    $targetBranches = $this->branchesForTarget($locked->student_id, $locked->offering_id, $locked->class_id);
                    foreach ($targetBranches as $branch) {
                        $this->require($approver, self::CAPABILITY_APPROVE, $branch->structureScope());
                    }
                    $provenance = $this->provenanceForBranches($targetBranches);
                    if ($locked->lifecycle_state !== FinancialGateException::STATE_PROPOSED) {
                        throw BusinessRejection::forCode('finance.gate_exception_not_proposed', 'only a proposed gate exception can be approved');
                    }
                    if (trim((string) $locked->requested_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('finance.gate_exception_not_independent', 'the approver must differ from the proposer');
                    }
                    $this->assertEffectiveToday($locked);

                    // A scoped exception is an attributable commitment to
                    // eligible obligation remainder, not a second unscoped
                    // student-balance allowance.
                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => FinancialGateException::STATE_APPROVED, 'approved_by' => $approver->actorId, 'approved_at' => now()]);
                    $locked->save();
                    $commitments = $this->coverageCommitments->commitGateException($locked);
                    $event = $this->audit->record($approver->actorId, 'finance.gate_exception.approve', 'financial_gate_exception', $locked->id, $before, [
                        'lifecycle_state' => FinancialGateException::STATE_APPROVED,
                        'branch_id' => $provenance['branch_id'],
                        'organization_id' => $provenance['organization_id'],
                        'coverage_commitments' => $commitments,
                    ]);

                    return ['exception_id' => $locked->id, 'lifecycle_state' => FinancialGateException::STATE_APPROVED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'finance.gate_exception.approve', 'financial_gate_exception', $exception->id);
        }
    }

    private function validate(string $studentId, ?string $offeringId, ?string $classId, string $amount, string $reason, string $effectiveFrom, ?string $effectiveTo): void
    {
        if ($reason === '') {
            throw BusinessRejection::forCode('finance.gate_exception_reason', 'a gate exception requires its explicit reason');
        }
        if (! MoneyAmount::positive($amount)) {
            throw BusinessRejection::forCode('finance.gate_exception_amount', 'the gate exception amount must be a positive number');
        }
        if ($effectiveTo !== null && $effectiveTo !== '' && $effectiveTo < $effectiveFrom) {
            throw BusinessRejection::forCode('finance.gate_exception_window', 'the gate exception effective window is inverted');
        }
        if (Student::query()->whereKey($studentId)->doesntExist()) {
            throw BusinessRejection::forCode('finance.gate_exception_student_unknown', 'a gate exception requires a known student');
        }
        if ($offeringId !== null && $offeringId !== '' && Offering::query()->whereKey($offeringId)->doesntExist()) {
            throw BusinessRejection::forCode('finance.gate_exception_offering_unknown', 'a gate exception offering must exist');
        }
        if ($classId !== null && $classId !== '' && ClassModel::query()->whereKey($classId)->doesntExist()) {
            throw BusinessRejection::forCode('finance.gate_exception_class_unknown', 'a gate exception class must exist');
        }
        if ($classId !== null && $classId !== '' && ($offeringId === null || $offeringId === '')) {
            throw BusinessRejection::forCode('finance.gate_exception_scope', 'a class-scoped gate exception must identify its offering');
        }
        if ($classId !== null && $classId !== '') {
            $classOfferingId = trim((string) ClassModel::query()->whereKey($classId)->value('offering_id'));
            if ($classOfferingId === '' || $classOfferingId !== trim((string) $offeringId)) {
                throw BusinessRejection::forCode('finance.gate_exception_scope', 'a class-scoped gate exception must identify the class\'s exact offering');
            }
        }
    }

    private function assertEffectiveToday(FinancialGateException $exception): void
    {
        $today = CarbonImmutable::today()->toDateString();
        $effectiveFrom = (string) $exception->effective_from;
        $effectiveTo = $exception->effective_to !== null ? (string) $exception->effective_to : null;
        if ($effectiveFrom > $today || ($effectiveTo !== null && $effectiveTo < $today)) {
            throw BusinessRejection::forCode('finance.gate_exception_not_effective', 'a gate exception can be approved only while its declared effective window is active');
        }
    }

    /** @return list<Branch> */
    private function branchesForTarget(string $studentId, ?string $offeringId, ?string $classId): array
    {
        $branches = [];
        $studentBranch = $this->branchForStudent($studentId);
        if ($studentBranch === null) {
            throw BusinessRejection::forCode('finance.gate_exception_provenance_required', 'a gate exception requires known student branch provenance');
        }
        $branches[$studentBranch->id] = $studentBranch;
        if ($offeringId !== null && $offeringId !== '') {
            $branchId = trim((string) Offering::query()->whereKey($offeringId)->value('branch_id'));
            $offeringBranch = $branchId === '' ? null : Branch::query()->whereKey($branchId)->first();
            if ($offeringBranch === null) {
                throw BusinessRejection::forCode('finance.gate_exception_provenance_required', 'a gate exception offering requires known branch provenance');
            }
            $branches[$offeringBranch->id] = $offeringBranch;
        }
        if ($classId !== null && $classId !== '') {
            $branchId = trim((string) ClassModel::query()->whereKey($classId)->value('branch_id'));
            $classBranch = $branchId === '' ? null : Branch::query()->whereKey($branchId)->first();
            if ($classBranch === null) {
                throw BusinessRejection::forCode('finance.gate_exception_provenance_required', 'a gate exception class requires known branch provenance');
            }
            $branches[$classBranch->id] = $classBranch;
        }

        return array_values($branches);
    }

    private function branchForStudent(string $studentId): ?Branch
    {
        $branchId = RecordBranch::studentBranchForId($studentId);

        return $branchId === null ? null : Branch::query()->whereKey($branchId)->first();
    }

    /**
     * @param list<Branch> $branches
     *
     * @return array{branch_id: string|null, organization_id: string|null}
     */
    private function provenanceForBranches(array $branches): array
    {
        $branchIds = [];
        $organizationIds = [];
        foreach ($branches as $branch) {
            if ($branch->lifecycle_state !== 'active') {
                throw BusinessRejection::forCode('finance.gate_exception_provenance_required', 'a gate exception target requires active branch provenance');
            }
            $scope = $branch->structureScope();
            if ($scope->organizationId === '') {
                throw BusinessRejection::forCode('finance.gate_exception_provenance_required', 'a gate exception target requires active campus organization provenance');
            }
            $branchIds[] = (string) $branch->id;
            $organizationIds[] = $scope->organizationId;
        }
        $branchIds = array_values(array_unique($branchIds));
        $organizationIds = array_values(array_unique($organizationIds));

        return [
            'branch_id' => count($branchIds) === 1 ? $branchIds[0] : null,
            'organization_id' => count($organizationIds) === 1 ? $organizationIds[0] : null,
        ];
    }

    private function require(Actor $actor, string $capability, \App\Support\Authorization\StructureScope $scope): void
    {
        $outcome = $this->access->decide($actor, $capability, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.gate_exception_denied', $outcome->reason);
        }
    }
}
