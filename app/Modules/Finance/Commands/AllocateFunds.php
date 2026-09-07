<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\FinancialCoverageLock;
use App\Modules\Finance\Models\FundAllocation;
use App\Modules\Finance\Models\FinancialCorrection;
use App\Modules\Finance\Models\FundingSource;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\ObligationLine;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Organization;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use App\Support\MoneyAmount;
use Illuminate\Support\Facades\DB;

/**
 * Funding: an immutable funding agreement establishes a pool and its
 * restriction (never reclassified — BR-FUND-002); allocations apply fund
 * money to student obligation lines of the permitted use only, never
 * exceed the committed pool, and commit under a fund row lock. Utilization
 * is derived from allocations, never stored.
 */
final class AllocateFunds
{
    public const CAPABILITY_ESTABLISH = 'finance.fund';

    public const CAPABILITY_ALLOCATE = 'finance.fund_allocate';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly AllocatePayment $allocations,
    ) {}

    /** @return array{fund_id: string, correlation_id: string} */
    public function establish(Actor $actor, string $organizationId, string $name, string $agreementRef, string $committedAmount, ?string $restrictedCategory, ?string $restrictionNote, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.fund.establish', $organizationId, $name, $agreementRef, $committedAmount, (string) $restrictedCategory, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.fund.establish', $idempotencyKey,
                $payload,
                fn (): array => DB::transaction(function () use ($actor, $organizationId, $name, $agreementRef, $committedAmount, $restrictedCategory, $restrictionNote): array {
                    $organizationId = trim($organizationId);
                    /** @var Organization|null $organization */
                    $organization = $organizationId === '' ? null : Organization::query()
                        ->whereKey($organizationId)
                        ->where('lifecycle_state', 'active')
                        ->first();
                    if ($organization === null) {
                        throw BusinessRejection::forCode('finance.fund_organization_unknown', 'a funding source requires an active organization');
                    }
                    $this->require($actor, self::CAPABILITY_ESTABLISH, StructureScope::organization($organization->id));
                    if ($name === '' || $agreementRef === '') {
                        throw BusinessRejection::forCode('finance.fund_terms', 'a funding source requires a name and its agreement reference');
                    }
                    if (! MoneyAmount::positive($committedAmount)) {
                        throw BusinessRejection::forCode('finance.fund_committed', 'the committed pool must be a positive number');
                    }
                    if ($restrictedCategory !== null && $restrictedCategory !== '' && ($restrictionNote === null || $restrictionNote === '')) {
                        throw BusinessRejection::forCode('finance.fund_restriction_note', 'a restricted fund requires its restriction note');
                    }

                    $fund = FundingSource::query()->create([
                        'id' => RandomIdentifier::new(),
                        'organization_id' => $organization->id,
                        'name' => $name,
                        'agreement_ref' => $agreementRef,
                        'committed_amount' => $committedAmount,
                        'restricted_category' => ($restrictedCategory === '' ? null : $restrictedCategory),
                        'restriction_note' => $restrictionNote,
                        'established_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'finance.fund.establish', 'funding_source', $fund->id, null, [
                        'organization_id' => $organization->id, 'agreement_ref' => $agreementRef, 'committed_amount' => $committedAmount, 'restricted_category' => $fund->restricted_category,
                    ]);

                    return ['fund_id' => $fund->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.fund.establish', 'funding_source', $name);
        }
    }

    /** @return array{allocation_id: string, correlation_id: string} */
    public function allocate(Actor $actor, FundingSource $fund, ObligationLine $line, string $amount, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.fund.allocate', $fund->id, $line->id, $amount, $reason, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.fund.allocate', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $fund, $line, $amount, $reason): array {
                    if ($reason === '') {
                        throw BusinessRejection::forCode('finance.fund_allocation_reason', 'a fund allocation requires a reason');
                    }
                    if (! MoneyAmount::positive($amount)) {
                        throw BusinessRejection::forCode('finance.fund_allocation_amount', 'the fund allocation amount must be a positive number');
                    }
                    $studentId = (string) ObligationLine::query()
                        ->join('obligations', 'obligations.id', '=', 'obligation_lines.obligation_id')
                        ->where('obligation_lines.id', $line->id)
                        ->value('obligations.student_id');
                    FinancialCoverageLock::acquire($studentId);

                    /** @var FundingSource $lockedFund */
                    $lockedFund = FundingSource::query()->whereKey($fund->id)->lockForUpdate()->firstOrFail();
                    /** @var ObligationLine $lockedLine */
                    $lockedLine = ObligationLine::query()->whereKey($line->id)->lockForUpdate()->firstOrFail();
                    /** @var Obligation $obligation */
                    $obligation = Obligation::query()->whereKey($lockedLine->obligation_id)->lockForUpdate()->firstOrFail();
                    if (trim((string) $obligation->student_id) !== trim($studentId)) {
                        throw BusinessRejection::forCode('finance.fund_allocation_student_mismatch', 'the fund allocation line student changed while the coverage lock was acquired');
                    }
                    $branchId = trim((string) $obligation->current_home_branch_id);
                    if ($branchId === '') {
                        $branchId = trim((string) $obligation->originating_branch_id);
                    }
                    $branch = $branchId === '' ? null : Branch::query()->whereKey($branchId)->first();
                    if ($branch === null || $branch->lifecycle_state !== 'active') {
                        throw BusinessRejection::forCode('finance.fund_allocation_provenance_required', 'a fund allocation requires known active obligation branch provenance');
                    }
                    $scope = $branch->structureScope();
                    $fundOrganizationId = trim((string) $lockedFund->organization_id);
                    if ($fundOrganizationId === '' || ! Organization::query()->whereKey($fundOrganizationId)->where('lifecycle_state', 'active')->exists()) {
                        throw BusinessRejection::forCode('finance.fund_organization_unknown', 'a fund allocation requires a funding source with active organization provenance');
                    }
                    if ($scope->organizationId === '' || $fundOrganizationId !== $scope->organizationId) {
                        throw BusinessRejection::forCode('finance.fund_organization_mismatch', 'a fund allocation must remain inside its funding source organization');
                    }
                    // The allocation capability is deliberately evaluated on
                    // the concrete obligation branch. The source/target
                    // organization equality above keeps that delegated branch
                    // operation inside the fund's owning organization without
                    // treating an organization-A source as a B authorization
                    // oracle.
                    $this->require($actor, self::CAPABILITY_ALLOCATE, $scope);

                    $restriction = trim((string) $lockedFund->restricted_category);
                    if ($restriction !== '' && $restriction !== trim((string) $lockedLine->category)) {
                        throw BusinessRejection::forCode('finance.fund_restriction', sprintf('the fund is restricted to %s; the obligation line is %s', $restriction, $lockedLine->category));
                    }

                    $fundAllocationIds = FundAllocation::query()->where('fund_id', $lockedFund->id)->pluck('id');
                    $utilized = MoneyAmount::decimal(FundAllocation::query()->whereIn('id', $fundAllocationIds)->sum('amount'));
                    $reversed = MoneyAmount::decimal(FinancialCorrection::query()
                        ->whereIn('fund_allocation_id', $fundAllocationIds)
                        ->where('correction_type', FinancialCorrection::TYPE_FUND_ALLOCATION_REVERSAL)
                        ->where('lifecycle_state', FinancialCorrection::STATE_RECORDED)
                        ->sum('amount'));
                    $available = bcsub((string) $lockedFund->committed_amount, bcsub($utilized, $reversed, 2), 2);
                    if (bccomp($amount, $available, 2) === 1) {
                        throw BusinessRejection::forCode('finance.fund_exhausted', sprintf('the allocation exceeds the unutilized pool remainder %s', $available));
                    }

                    $lineAllocationIds = FundAllocation::query()->where('obligation_line_id', $lockedLine->id)->pluck('id');
                    $lineFunded = MoneyAmount::decimal(FundAllocation::query()->whereIn('id', $lineAllocationIds)->sum('amount'));
                    $lineReversed = MoneyAmount::decimal(FinancialCorrection::query()
                        ->whereIn('fund_allocation_id', $lineAllocationIds)
                        ->where('correction_type', FinancialCorrection::TYPE_FUND_ALLOCATION_REVERSAL)
                        ->where('lifecycle_state', FinancialCorrection::STATE_RECORDED)
                        ->sum('amount'));
                    $lineRemaining = bcsub((string) $lockedLine->amount, bcsub($lineFunded, $lineReversed, 2), 2);
                    if (bccomp($amount, $lineRemaining, 2) === 1) {
                        throw BusinessRejection::forCode('finance.fund_exceeds_line', sprintf('the allocation exceeds the uncovered line remainder %s', $lineRemaining));
                    }
                    if (bccomp($amount, $this->allocations->obligationRemaining($obligation), 2) === 1) {
                        throw BusinessRejection::forCode('finance.fund_exceeds_obligation', 'the allocation exceeds the uncovered obligation remainder');
                    }

                    $allocation = FundAllocation::query()->create([
                        'id' => RandomIdentifier::new(),
                        'fund_id' => $lockedFund->id,
                        'obligation_line_id' => $lockedLine->id,
                        'amount' => $amount,
                        'reason' => $reason,
                        'allocated_by' => $actor->actorId,
                        'originating_branch_id' => $obligation->originating_branch_id,
                        'current_home_branch_id' => $obligation->current_home_branch_id,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'finance.fund.allocate', 'fund_allocation', $allocation->id, null, [
                        'fund_id' => $lockedFund->id, 'obligation_line_id' => $line->id, 'branch_id' => $branch->id, 'organization_id' => $branch->structureScope()->organizationId, 'amount' => $amount,
                    ]);

                    return ['allocation_id' => $allocation->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.fund.allocate', 'fund_allocation', $fund->id);
        }
    }

    private function require(Actor $actor, string $capability, ?StructureScope $scope = null): void
    {
        $outcome = $this->access->decide($actor, $capability, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.fund_denied', $outcome->reason);
        }
    }
}
