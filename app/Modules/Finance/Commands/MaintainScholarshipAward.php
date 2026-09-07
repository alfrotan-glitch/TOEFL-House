<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Academic\Domain\RecordBranch;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\FinanceLifecycle;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\FundingSource;
use App\Modules\Finance\Models\ScholarshipAward;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Organization;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use App\Support\MoneyAmount;
use Illuminate\Support\Facades\DB;

/**
 * Finance-owned per-case scholarship award (BR-FIN-00x): an attributed student
 * benefit decision that binds a student to a funding source and period under a
 * concrete award rule. Proposed by a Finance actor, approved by a distinct
 * actor in an open period, and immutable once approved. The monetary
 * application to an obligation line continues through FundAllocation.
 */
final class MaintainScholarshipAward
{
    public const CAPABILITY_PROPOSE = 'finance.scholarship';

    public const CAPABILITY_APPROVE = 'finance.scholarship_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{award_id: string, correlation_id: string} */
    public function propose(Actor $requester, string $studentId, FundingSource $fund, FinancialPeriod $period, string $amount, string $awardRuleRef, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.scholarship.propose', $studentId, $fund->id, $period->id, $amount, $awardRuleRef, $reason, $requester->actorId]));

        try {
            return $this->idempotency->execute('finance.scholarship.propose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($requester, $studentId, $fund, $period, $amount, $awardRuleRef, $reason): array {
                    $this->validate($studentId, $amount, $awardRuleRef, $reason);
                    $branch = $this->studentBranch($studentId);
                    if ($branch === null) {
                        throw BusinessRejection::forCode('finance.scholarship_provenance_required', 'a scholarship award requires known student branch provenance');
                    }
                    $this->require($requester, self::CAPABILITY_PROPOSE, $branch->structureScope());

                    /** @var FinancialPeriod $lockedPeriod */
                    $lockedPeriod = FinancialPeriod::query()->whereKey($period->id)->lockForUpdate()->firstOrFail();
                    if ($lockedPeriod->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN) {
                        throw BusinessRejection::forCode('finance.period_not_open', 'a scholarship award attaches only to an open financial period');
                    }
                    /** @var FundingSource $lockedFund */
                    $lockedFund = FundingSource::query()->whereKey($fund->id)->lockForUpdate()->firstOrFail();
                    $this->assertSameOrganization($branch, $lockedFund);

                    if (ScholarshipAward::query()
                        ->where('student_id', $studentId)
                        ->where('funding_source_id', $lockedFund->id)
                        ->where('period_id', $lockedPeriod->id)
                        ->exists()) {
                        throw BusinessRejection::forCode('finance.scholarship_award_exists', 'this student already has an award for this donor and period');
                    }

                    $award = ScholarshipAward::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $studentId,
                        'funding_source_id' => $lockedFund->id,
                        'period_id' => $lockedPeriod->id,
                        'amount' => $amount,
                        'award_rule_ref' => $awardRuleRef,
                        'reason' => $reason,
                        'lifecycle_state' => ScholarshipAward::STATE_PROPOSED,
                        'requested_by' => $requester->actorId,
                    ]);
                    $event = $this->audit->record($requester->actorId, 'finance.scholarship.propose', 'scholarship_award', $award->id, null, [
                        'student_id' => $studentId, 'funding_source_id' => $lockedFund->id, 'branch_id' => $branch->id, 'organization_id' => $branch->structureScope()->organizationId, 'amount' => $amount, 'award_rule_ref' => $awardRuleRef,
                    ]);

                    return ['award_id' => $award->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $requester, 'finance.scholarship.propose', 'scholarship_award', $fund->id);
        }
    }

    /** @return array{award_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, ScholarshipAward $award, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.scholarship.approve', $award->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('finance.scholarship.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $award): array {
                    /** @var ScholarshipAward $locked */
                    $locked = ScholarshipAward::query()->whereKey($award->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== ScholarshipAward::STATE_PROPOSED) {
                        throw BusinessRejection::forCode('finance.scholarship_not_proposed', sprintf('only a proposed scholarship award can be approved (state: %s)', $locked->lifecycle_state));
                    }
                    if (trim((string) $locked->requested_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('finance.scholarship_not_independent', 'the scholarship requester and approver must differ');
                    }
                    $branch = $this->studentBranch((string) $locked->student_id);
                    if ($branch === null) {
                        throw BusinessRejection::forCode('finance.scholarship_provenance_required', 'a scholarship award requires known student branch provenance');
                    }
                    $this->require($approver, self::CAPABILITY_APPROVE, $branch->structureScope());
                    $period = FinancialPeriod::query()->whereKey($locked->period_id)->lockForUpdate()->firstOrFail();
                    if ($period->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN) {
                        throw BusinessRejection::forCode('finance.period_not_open', 'a scholarship award can be approved only in its open financial period');
                    }
                    /** @var FundingSource $fund */
                    $fund = FundingSource::query()->whereKey($locked->funding_source_id)->lockForUpdate()->firstOrFail();
                    $this->assertSameOrganization($branch, $fund);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill([
                        'lifecycle_state' => ScholarshipAward::STATE_APPROVED,
                        'approved_by' => $approver->actorId,
                        'approved_at' => now(),
                    ])->save();
                    $event = $this->audit->record($approver->actorId, 'finance.scholarship.approve', 'scholarship_award', $locked->id, $before, [
                        'lifecycle_state' => ScholarshipAward::STATE_APPROVED,
                        'branch_id' => $branch->id,
                        'organization_id' => $branch->structureScope()->organizationId,
                        'amount' => $locked->amount,
                    ]);

                    return ['award_id' => $locked->id, 'lifecycle_state' => ScholarshipAward::STATE_APPROVED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'finance.scholarship.approve', 'scholarship_award', $award->id);
        }
    }

    private function validate(string $studentId, string $amount, string $awardRuleRef, string $reason): void
    {
        if ($awardRuleRef === '' || $reason === '') {
            throw BusinessRejection::forCode('finance.scholarship_terms', 'a scholarship award requires its award rule reference and reason');
        }
        if (! MoneyAmount::positive($amount)) {
            throw BusinessRejection::forCode('finance.scholarship_amount', 'the scholarship amount must be a positive number');
        }
        if (Student::query()->whereKey($studentId)->doesntExist()) {
            throw BusinessRejection::forCode('finance.scholarship_student_unknown', 'a scholarship award requires a known student');
        }
    }

    private function studentBranch(string $studentId): ?Branch
    {
        $branchId = RecordBranch::studentBranchForId($studentId);
        if ($branchId === null) {
            return null;
        }
        /** @var Branch|null $branch */
        $branch = Branch::query()->whereKey($branchId)->first();

        return $branch !== null && $branch->lifecycle_state === 'active' ? $branch : null;
    }

    private function assertSameOrganization(Branch $studentBranch, FundingSource $fund): void
    {
        $studentOrganizationId = trim((string) $studentBranch->structureScope()->organizationId);
        $fundOrganizationId = trim((string) ($fund->organization_id ?? ''));
        if ($studentOrganizationId === '' || $fundOrganizationId === '' || ! Organization::query()->whereKey($fundOrganizationId)->where('lifecycle_state', 'active')->exists()) {
            throw BusinessRejection::forCode('finance.scholarship_fund_organization_unknown', 'a scholarship award requires an active funding-source organization');
        }
        if ($studentOrganizationId !== $fundOrganizationId) {
            throw BusinessRejection::forCode('finance.scholarship_organization_mismatch', 'a scholarship award cannot cross funding-source and student organizations');
        }
    }

    private function require(Actor $actor, string $capability, \App\Support\Authorization\StructureScope $scope): void
    {
        $outcome = $this->access->decide($actor, $capability, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.scholarship_denied', $outcome->reason);
        }
    }
}
