<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\FinanceLifecycle;
use App\Modules\Finance\Domain\FinancialCoverageLock;
use App\Modules\Finance\Models\FinancialCorrection;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\FundAllocation;
use App\Modules\Finance\Models\FundingSource;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\ObligationLine;
use App\Modules\Finance\Models\Payment;
use App\Modules\Finance\Models\PaymentAllocation;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use App\Support\MoneyAmount;
use Illuminate\Support\Facades\DB;

/**
 * Staged Finance correction instrument. It never edits an obligation or an
 * allocation: approval appends a source-linked compensating fact.
 */
final class MaintainFinancialCorrection
{
    public const CAPABILITY_PROPOSE = 'finance.correct';

    public const CAPABILITY_APPROVE = 'finance.correct_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{correction_id: string, correlation_id: string} */
    public function proposeObligationAdjustment(Actor $requester, Obligation $obligation, string $amount, string $direction, string $reason, string $idempotencyKey): array
    {
        return $this->propose($requester, $obligation->period_id, FinancialCorrection::TYPE_OBLIGATION_ADJUSTMENT, $obligation->id, $amount, $direction, $reason, $idempotencyKey);
    }

    /** @return array{correction_id: string, correlation_id: string} */
    public function proposeAllocationReversal(Actor $requester, PaymentAllocation $allocation, string $amount, string $reason, string $idempotencyKey): array
    {
        $periodId = (string) Obligation::query()->whereKey($allocation->obligation_id)->value('period_id');

        return $this->propose($requester, $periodId, FinancialCorrection::TYPE_ALLOCATION_REVERSAL, $allocation->id, $amount, FinancialCorrection::DIRECTION_DECREASE, $reason, $idempotencyKey);
    }

    /** @return array{correction_id: string, correlation_id: string} */
    public function proposeFundAllocationReversal(Actor $requester, FundAllocation $allocation, string $amount, string $reason, string $idempotencyKey): array
    {
        $periodId = (string) Obligation::query()
            ->join('obligation_lines', 'obligation_lines.obligation_id', '=', 'obligations.id')
            ->where('obligation_lines.id', $allocation->obligation_line_id)
            ->value('obligations.period_id');

        return $this->propose($requester, $periodId, FinancialCorrection::TYPE_FUND_ALLOCATION_REVERSAL, $allocation->id, $amount, FinancialCorrection::DIRECTION_DECREASE, $reason, $idempotencyKey);
    }

    /** @return array{correction_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, FinancialCorrection $correction, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.correction.approve', $correction->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('finance.correction.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $correction): array {
                    $coverageStudentId = $this->sourceStudentId($correction);
                    FinancialCoverageLock::acquire($coverageStudentId);

                    /** @var FinancialCorrection $locked */
                    $locked = FinancialCorrection::query()->whereKey($correction->id)->lockForUpdate()->firstOrFail();
                    if ($this->sourceStudentId($locked) !== $coverageStudentId) {
                        throw BusinessRejection::forCode('finance.correction_student_changed', 'the correction source student changed while the coverage lock was acquired');
                    }
                    if ($locked->lifecycle_state !== FinancialCorrection::STATE_PROPOSED) {
                        throw BusinessRejection::forCode('finance.correction_not_proposed', 'only a proposed financial correction can be approved');
                    }
                    if (trim((string) $locked->requested_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('finance.correction_not_independent', 'the correction requester and approver must differ');
                    }
                    $this->assertPeriodOpen($locked->period_id);
                    $this->lockSource($locked);
                    $this->assertCorrectionAvailable($locked);
                    $branch = $this->sourceBranch($locked);
                    if ($branch === null) {
                        throw BusinessRejection::forCode('finance.correction_provenance_required', 'a financial correction requires known source branch provenance');
                    }
                    $this->require($approver, self::CAPABILITY_APPROVE, $branch->structureScope());

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill([
                        'lifecycle_state' => FinancialCorrection::STATE_RECORDED,
                        'approved_by' => $approver->actorId,
                        'approved_at' => now(),
                    ])->save();
                    $event = $this->audit->record($approver->actorId, 'finance.correction.approve', 'financial_correction', $locked->id, $before, [
                        'lifecycle_state' => FinancialCorrection::STATE_RECORDED,
                        'correction_type' => $locked->correction_type,
                        'branch_id' => $branch->id,
                        'organization_id' => $branch->structureScope()->organizationId,
                        'amount' => $locked->amount,
                        'direction' => $locked->direction,
                    ]);

                    return ['correction_id' => $locked->id, 'lifecycle_state' => $locked->lifecycle_state, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'finance.correction.approve', 'financial_correction', $correction->id);
        }
    }

    /** @return array{correction_id: string, correlation_id: string} */
    private function propose(Actor $requester, string $periodId, string $type, string $sourceId, string $amount, string $direction, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.correction.propose', $periodId, $type, $sourceId, $amount, $direction, $reason, $requester->actorId]));

        try {
            return $this->idempotency->execute('finance.correction.propose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($requester, $periodId, $type, $sourceId, $amount, $direction, $reason): array {
                    if ($reason === '' || ! MoneyAmount::positive($amount)) {
                        throw BusinessRejection::forCode('finance.correction_terms', 'a financial correction requires a positive amount and reason');
                    }
                    if (! in_array($type, [FinancialCorrection::TYPE_OBLIGATION_ADJUSTMENT, FinancialCorrection::TYPE_ALLOCATION_REVERSAL, FinancialCorrection::TYPE_FUND_ALLOCATION_REVERSAL], true)) {
                        throw BusinessRejection::forCode('finance.correction_type_unknown', 'the financial correction source type is not supported');
                    }
                    if (! in_array($direction, [FinancialCorrection::DIRECTION_DECREASE, FinancialCorrection::DIRECTION_INCREASE], true)) {
                        throw BusinessRejection::forCode('finance.correction_direction_unknown', 'the financial correction direction is not supported');
                    }
                    if (in_array($type, [FinancialCorrection::TYPE_ALLOCATION_REVERSAL, FinancialCorrection::TYPE_FUND_ALLOCATION_REVERSAL], true) && $direction !== FinancialCorrection::DIRECTION_DECREASE) {
                        throw BusinessRejection::forCode('finance.correction_direction_invalid', 'an allocation reversal can only decrease its source allocation');
                    }
                    $this->assertPeriodOpen($periodId);
                    [$obligationId, $allocationId, $fundAllocationId, $sourceAmount] = $this->resolveSource($type, $sourceId, $periodId);
                    $branch = $this->sourceBranchIds($obligationId, $allocationId, $fundAllocationId);
                    if ($branch === null) {
                        throw BusinessRejection::forCode('finance.correction_provenance_required', 'a financial correction requires known source branch provenance');
                    }
                    $this->require($requester, self::CAPABILITY_PROPOSE, $branch->structureScope());
                    if (bccomp($amount, $sourceAmount, 2) === 1) {
                        throw BusinessRejection::forCode('finance.correction_exceeds_source', 'the correction exceeds its immutable source amount');
                    }

                    $row = FinancialCorrection::query()->create([
                        'id' => RandomIdentifier::new(),
                        'period_id' => $periodId,
                        'correction_type' => $type,
                        'obligation_id' => $obligationId,
                        'payment_allocation_id' => $allocationId,
                        'fund_allocation_id' => $fundAllocationId,
                        'amount' => $amount,
                        'direction' => $direction,
                        'reason' => $reason,
                        'lifecycle_state' => FinancialCorrection::STATE_PROPOSED,
                        'requested_by' => $requester->actorId,
                    ]);
                    $event = $this->audit->record($requester->actorId, 'finance.correction.propose', 'financial_correction', $row->id, null, [
                        'correction_type' => $type, 'source_id' => $sourceId, 'branch_id' => $branch->id, 'organization_id' => $branch->structureScope()->organizationId, 'amount' => $amount, 'direction' => $direction,
                        'workflow' => [
                            'definition_key' => 'finance.correction_approval',
                            'source_type' => 'financial_correction',
                            'source_id' => $row->id,
                            'queue_key' => 'finance.correction',
                            'source_version' => 1,
                        ],
                    ]);

                    return ['correction_id' => $row->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $requester, 'finance.correction.propose', 'financial_correction', $sourceId);
        }
    }

    /** @return array{0: string|null, 1: string|null, 2: string|null, 3: string} */
    private function resolveSource(string $type, string $sourceId, string $periodId): array
    {
        if ($type === FinancialCorrection::TYPE_OBLIGATION_ADJUSTMENT) {
            /** @var Obligation|null $obligation */
            $obligation = Obligation::query()->whereKey($sourceId)->first();
            if ($obligation === null || $obligation->period_id !== $periodId) {
                throw BusinessRejection::forCode('finance.correction_source_unknown', 'the correction obligation source is unknown or belongs to another period');
            }

            return [$obligation->id, null, null, (string) $obligation->original_amount];
        }

        if ($type === FinancialCorrection::TYPE_ALLOCATION_REVERSAL) {
            /** @var PaymentAllocation|null $allocation */
            $allocation = PaymentAllocation::query()->whereKey($sourceId)->first();
            if ($allocation === null) {
                throw BusinessRejection::forCode('finance.correction_source_unknown', 'the correction allocation source is unknown');
            }
            $period = Obligation::query()->whereKey($allocation->obligation_id)->value('period_id');
            if ($period !== $periodId) {
                throw BusinessRejection::forCode('finance.correction_source_unknown', 'the correction allocation belongs to another period');
            }

            return [null, $allocation->id, null, (string) $allocation->amount];
        }

        /** @var FundAllocation|null $allocation */
        $allocation = FundAllocation::query()->whereKey($sourceId)->first();
        if ($allocation === null) {
            throw BusinessRejection::forCode('finance.correction_source_unknown', 'the fund allocation source is unknown');
        }
        $period = Obligation::query()
            ->join('obligation_lines', 'obligation_lines.obligation_id', '=', 'obligations.id')
            ->where('obligation_lines.id', $allocation->obligation_line_id)
            ->value('obligations.period_id');
        if ($period !== $periodId) {
            throw BusinessRejection::forCode('finance.correction_source_unknown', 'the fund allocation belongs to another period');
        }

        return [null, null, $allocation->id, (string) $allocation->amount];
    }

    private function lockSource(FinancialCorrection $correction): void
    {
        if ($correction->obligation_id !== null) {
            Obligation::query()->whereKey($correction->obligation_id)->lockForUpdate()->firstOrFail();
        } elseif ($correction->payment_allocation_id !== null) {
            /** @var PaymentAllocation $allocation */
            $allocation = PaymentAllocation::query()->whereKey($correction->payment_allocation_id)->firstOrFail();
            Payment::query()->whereKey($allocation->payment_id)->lockForUpdate()->firstOrFail();
            PaymentAllocation::query()->whereKey($correction->payment_allocation_id)->lockForUpdate()->firstOrFail();
        } elseif ($correction->fund_allocation_id !== null) {
            /** @var FundAllocation $allocation */
            $allocation = FundAllocation::query()->whereKey($correction->fund_allocation_id)->firstOrFail();
            FundingSource::query()->whereKey($allocation->fund_id)->lockForUpdate()->firstOrFail();
            $allocation = FundAllocation::query()->whereKey($correction->fund_allocation_id)->lockForUpdate()->firstOrFail();
            $line = ObligationLine::query()->whereKey($allocation->obligation_line_id)->lockForUpdate()->firstOrFail();
            Obligation::query()->whereKey($line->obligation_id)->lockForUpdate()->firstOrFail();
        }
    }

    private function assertCorrectionAvailable(FinancialCorrection $correction): void
    {
        if ($correction->obligation_id !== null) {
            $sourceAmount = (string) Obligation::query()->whereKey($correction->obligation_id)->value('original_amount');
            $prior = (string) FinancialCorrection::query()
                ->where('obligation_id', $correction->obligation_id)
                ->where('correction_type', FinancialCorrection::TYPE_OBLIGATION_ADJUSTMENT)
                ->where('direction', $correction->direction)
                ->where('lifecycle_state', FinancialCorrection::STATE_RECORDED)
                ->sum('amount');
        } elseif ($correction->payment_allocation_id !== null) {
            $sourceAmount = (string) PaymentAllocation::query()->whereKey($correction->payment_allocation_id)->value('amount');
            $prior = (string) FinancialCorrection::query()
                ->where('payment_allocation_id', $correction->payment_allocation_id)
                ->where('correction_type', FinancialCorrection::TYPE_ALLOCATION_REVERSAL)
                ->where('lifecycle_state', FinancialCorrection::STATE_RECORDED)
                ->sum('amount');
        } else {
            $sourceAmount = (string) FundAllocation::query()->whereKey($correction->fund_allocation_id)->value('amount');
            $prior = (string) FinancialCorrection::query()
                ->where('fund_allocation_id', $correction->fund_allocation_id)
                ->where('correction_type', FinancialCorrection::TYPE_FUND_ALLOCATION_REVERSAL)
                ->where('lifecycle_state', FinancialCorrection::STATE_RECORDED)
                ->sum('amount');
        }
        if (bccomp(bcadd($prior, (string) $correction->amount, 2), $sourceAmount, 2) === 1) {
            throw BusinessRejection::forCode('finance.correction_exceeds_source', 'the recorded corrections exceed their immutable source amount');
        }
    }

    private function sourceStudentId(FinancialCorrection $correction): string
    {
        if ($correction->obligation_id !== null) {
            $studentId = Obligation::query()->whereKey($correction->obligation_id)->value('student_id');
        } elseif ($correction->payment_allocation_id !== null) {
            $studentId = PaymentAllocation::query()
                ->join('obligations', 'obligations.id', '=', 'payment_allocations.obligation_id')
                ->where('payment_allocations.id', $correction->payment_allocation_id)
                ->value('obligations.student_id');
        } elseif ($correction->fund_allocation_id !== null) {
            $studentId = FundAllocation::query()
                ->join('obligation_lines', 'obligation_lines.id', '=', 'fund_allocations.obligation_line_id')
                ->join('obligations', 'obligations.id', '=', 'obligation_lines.obligation_id')
                ->where('fund_allocations.id', $correction->fund_allocation_id)
                ->value('obligations.student_id');
        } else {
            $studentId = null;
        }
        if ($studentId === null || trim((string) $studentId) === '') {
            throw BusinessRejection::forCode('finance.correction_student_unknown', 'a financial correction source requires a known student');
        }

        return (string) $studentId;
    }

    private function sourceBranch(FinancialCorrection $correction): ?Branch
    {
        return $this->sourceBranchIds($correction->obligation_id, $correction->payment_allocation_id, $correction->fund_allocation_id);
    }

    private function sourceBranchIds(?string $obligationId, ?string $allocationId, ?string $fundAllocationId = null): ?Branch
    {
        if ($obligationId === null && $allocationId !== null) {
            $obligationId = (string) PaymentAllocation::query()->whereKey($allocationId)->value('obligation_id');
        }
        if ($obligationId === null && $fundAllocationId !== null) {
            $lineId = (string) FundAllocation::query()->whereKey($fundAllocationId)->value('obligation_line_id');
            $obligationId = (string) ObligationLine::query()->whereKey($lineId)->value('obligation_id');
        }
        $obligation = $obligationId === null ? null : Obligation::query()->whereKey($obligationId)->first();
        if ($obligation === null) {
            return null;
        }
        $branchId = trim((string) ($obligation->current_home_branch_id ?? $obligation->originating_branch_id ?? ''));

        return $branchId === '' ? null : Branch::query()->whereKey($branchId)->first();
    }

    private function assertPeriodOpen(string $periodId): void
    {
        $period = FinancialPeriod::query()->whereKey($periodId)->lockForUpdate()->firstOrFail();
        if ($period->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN) {
            throw BusinessRejection::forCode('finance.period_not_open', 'financial corrections require an open source period');
        }
    }

    private function require(Actor $actor, string $capability, \App\Support\Authorization\StructureScope $scope): void
    {
        $outcome = $this->access->decide($actor, $capability, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.correction_denied', $outcome->reason);
        }
    }
}
