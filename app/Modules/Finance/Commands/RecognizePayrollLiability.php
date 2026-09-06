<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Models\PayrollLiabilityFact;
use App\Modules\Organization\Models\Branch;
use App\Modules\Payroll\Models\PayrollAdjustment;
use App\Modules\Payroll\Models\PayrollResult;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\MoneyAmount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Finance command that recognizes one approved Payroll source as a monetary
 * liability. Payroll never writes this table and Reporting never substitutes
 * the source calculation for the recognized Finance fact.
 */
final class RecognizePayrollLiability
{
    public const CAPABILITY = 'finance.payroll_liability';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{liability_id: string, duplicate: bool, correlation_id: string} */
    public function recognize(Actor $actor, string $sourceType, string $sourceId, string $amount, string $evidenceRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['finance.payroll_liability.recognize', $sourceType, $sourceId, $amount, $evidenceRef, $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.payroll_liability.recognize', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $sourceType, $sourceId, $amount, $evidenceRef): array {
                    if (! in_array($sourceType, ['payroll_result', 'payroll_adjustment'], true) || trim($sourceId) === '' || trim($evidenceRef) === '') {
                        throw BusinessRejection::forCode('finance.payroll_liability_source', 'Finance recognition requires a valid Payroll source and evidence reference');
                    }

                    $source = $sourceType === 'payroll_result'
                        ? PayrollResult::query()->whereKey($sourceId)->lockForUpdate()->first()
                        : PayrollAdjustment::query()->whereKey($sourceId)->lockForUpdate()->first();

                    if ($source instanceof PayrollResult) {
                        if ($source->lifecycle_state !== 'approved') {
                            throw BusinessRejection::forCode('finance.payroll_liability_unapproved', 'only an approved Payroll result may be recognized');
                        }
                        $periodId = (string) $source->period_id;
                        $employmentId = (string) $source->employment_id;
                        $expectedAmount = (string) $source->amount;
                        $sourceBranchId = trim((string) ($source->originating_branch_id ?? ''));
                    } elseif ($source instanceof PayrollAdjustment) {
                        /** @var PayrollResult|null $result */
                        $result = PayrollResult::query()->whereKey($source->result_id)->lockForUpdate()->first();
                        if ($result === null || $result->lifecycle_state !== 'approved') {
                            throw BusinessRejection::forCode('finance.payroll_liability_unapproved', 'an adjustment must reference an approved Payroll result');
                        }
                        $periodId = (string) $result->period_id;
                        $employmentId = (string) $result->employment_id;
                        $expectedAmount = (string) $source->amount;
                        $sourceBranchId = trim((string) ($result->originating_branch_id ?? ''));
                    } else {
                        throw BusinessRejection::forCode('finance.payroll_liability_unknown_source', 'the Payroll source does not exist');
                    }

                    /**
                     * Use the immutable branch snapshot captured by Payroll at
                     * approval. Finance never reconstructs historical source
                     * provenance from today's mutable employee designation.
                     */
                    $branch = $sourceBranchId === '' ? null : Branch::query()->whereKey($sourceBranchId)->first();
                    if ($branch === null || $branch->lifecycle_state !== 'active' || $branch->structureScope()->organizationId === '') {
                        throw BusinessRejection::forCode('finance.payroll_liability_provenance', 'Payroll recognition requires the approved source branch snapshot to name an active branch and organization');
                    }
                    if (trim((string) $source->approved_by) === $actor->actorId) {
                        throw AuthorizationDenied::forCode('finance.payroll_liability_not_independent', 'Payroll approval and Finance recognition require distinct actors');
                    }
                    $outcome = $this->access->decide($actor, self::CAPABILITY, $branch->structureScope());
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('finance.payroll_liability_denied', $outcome->reason);
                    }

                    if (bccomp($expectedAmount, '0', 2) === 0) {
                        throw BusinessRejection::forCode('finance.payroll_liability_zero', 'a zero Payroll source does not create a Finance liability fact');
                    }
                    if (bccomp($expectedAmount, MoneyAmount::decimal($amount), 2) !== 0) {
                        throw BusinessRejection::forCode('finance.payroll_liability_amount_mismatch', 'Finance recognition must match the immutable Payroll source amount');
                    }

                    $existing = PayrollLiabilityFact::query()
                        ->where('source_type', $sourceType)
                        ->where('source_id', $sourceId)
                        ->first();
                    if ($existing !== null) {
                        return ['liability_id' => $existing->id, 'duplicate' => true, 'correlation_id' => (string) $existing->correlation_id];
                    }

                    $correlationId = RandomIdentifier::new();
                    $fact = PayrollLiabilityFact::query()->create([
                        'id' => RandomIdentifier::new(),
                        'source_type' => $sourceType,
                        'source_id' => $sourceId,
                        'period_id' => $periodId,
                        'employment_id' => $employmentId,
                        'originating_branch_id' => $branch->id,
                        'amount' => $amount,
                        'recognized_by' => $actor->actorId,
                        'correlation_id' => $correlationId,
                        'evidence_ref' => $evidenceRef,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'finance.payroll_liability.recognize', 'payroll_liability_fact', $fact->id, null, [
                        'source_type' => $sourceType, 'source_id' => $sourceId, 'period_id' => $periodId, 'employment_id' => $employmentId,
                        'originating_branch_id' => $branch->id, 'branch_id' => $branch->id,
                        'organization_id' => $branch->structureScope()->organizationId, 'amount' => $amount,
                    ], $correlationId);

                    return ['liability_id' => $fact->id, 'duplicate' => false, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.payroll_liability.recognize', 'payroll_liability_fact', $sourceId);
        }
    }
}
