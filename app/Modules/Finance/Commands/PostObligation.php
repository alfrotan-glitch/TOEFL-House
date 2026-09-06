<?php

declare(strict_types=1);

namespace App\Modules\Finance\Commands;

use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Domain\RecordBranch;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Finance\Domain\FinanceLifecycle;
use App\Modules\Finance\Domain\FinancialCoverageLock;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\ObligationLine;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Domain\StudentOperationalEligibility;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use App\Support\MoneyAmount;
use Illuminate\Support\Facades\DB;

/**
 * Approved charge: posts the obligation and its atomic lines in one
 * transaction — the lines must sum exactly to the obligation amount. The
 * obligation is an immutable source fact; balances are derived, never
 * stored.
 */
final class PostObligation
{
    public const CAPABILITY = 'finance.obligation';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly StudentOperationalEligibility $studentEligibility,
    ) {}

    /**
     * @param  list<array{category: string, amount: string, source_ref: string}>  $lines
     * @return array{obligation_id: string, correlation_id: string}
     */
    public function post(Actor $actor, FinancialPeriod $period, string $studentId, string $source, string $reason, array $lines, string $idempotencyKey, ?string $offeringId = null): array
    {
        $payload = hash('sha256', implode('|', ['finance.obligation.post', $period->id, $studentId, $source, $reason, json_encode($lines), $offeringId ?? '', $actor->actorId]));

        try {
            return $this->idempotency->execute('finance.obligation.post', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $period, $studentId, $source, $reason, $lines, $offeringId): array {
                    if ($lines === [] || $reason === '' || $source === '') {
                        throw BusinessRejection::forCode('finance.obligation_terms', 'an obligation requires a source, lines, and a reason');
                    }
                    $this->studentEligibility->assertActive($studentId, 'finance.obligation_student_not_active');
                    $originatingBranchId = $this->obligationBranch($offeringId, $studentId);
                    if ($originatingBranchId === null) {
                        throw BusinessRejection::forCode('finance.obligation_provenance_required', 'a new obligation requires verified branch provenance');
                    }
                    $currentHomeBranchId = RecordBranch::studentBranchForId($studentId);
                    $authorizationBranch = Branch::query()->whereKey($originatingBranchId)->first();
                    if ($authorizationBranch === null) {
                        throw BusinessRejection::forCode('finance.obligation_provenance_required', 'the obligation branch provenance is unknown');
                    }
                    $this->require($actor, $authorizationBranch->structureScope());
                    FinancialCoverageLock::acquire($studentId);

                    /** @var FinancialPeriod $lockedPeriod */
                    $lockedPeriod = FinancialPeriod::query()->whereKey($period->id)->lockForUpdate()->firstOrFail();
                    if ($lockedPeriod->lifecycle_state !== FinanceLifecycle::PERIOD_OPEN) {
                        throw BusinessRejection::forCode('finance.period_not_open', 'obligations post only to an open financial period');
                    }

                    $total = '0.00';
                    foreach ($lines as $line) {
                        if ($line['category'] === '' || $line['source_ref'] === '') {
                            throw BusinessRejection::forCode('finance.obligation_line_terms', 'every obligation line requires a category and source reference');
                        }
                        $lineAmount = MoneyAmount::decimal($line['amount']);
                        if (! MoneyAmount::positive($lineAmount)) {
                            throw BusinessRejection::forCode('finance.obligation_line_amount', 'every line amount must be a positive number');
                        }
                        $total = bcadd($total, $lineAmount, 2);
                    }

                    if ($offeringId !== null && $offeringId !== '') {
                        $this->assertOfferingLinkedToActiveEnrollment($offeringId, $studentId);
                    }

                    $obligation = Obligation::query()->create([
                        'id' => RandomIdentifier::new(),
                        'period_id' => $lockedPeriod->id,
                        'student_id' => $studentId,
                        'source' => $source,
                        'original_amount' => $total,
                        'reason' => $reason,
                        'posted_by' => $actor->actorId,
                        'originating_branch_id' => $originatingBranchId,
                        'current_home_branch_id' => $currentHomeBranchId,
                        'offering_id' => $offeringId !== null && $offeringId !== '' ? $offeringId : null,
                    ]);
                    foreach ($lines as $line) {
                        ObligationLine::query()->create([
                            'id' => RandomIdentifier::new(),
                            'obligation_id' => $obligation->id,
                            'category' => $line['category'],
                            'amount' => $line['amount'],
                            'source_ref' => $line['source_ref'],
                        ]);
                    }
                    $event = $this->audit->record($actor->actorId, 'finance.obligation.post', 'obligation', $obligation->id, null, [
                        'student_id' => $studentId, 'branch_id' => $originatingBranchId, 'organization_id' => $authorizationBranch->structureScope()->organizationId, 'original_amount' => $total, 'lines' => count($lines), 'offering_id' => $obligation->offering_id,
                    ]);

                    return ['obligation_id' => $obligation->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'finance.obligation.post', 'obligation', $studentId);
        }
    }

    private function obligationBranch(?string $offeringId, string $studentId): ?string
    {
        $offeringId = trim((string) ($offeringId ?? ''));
        if ($offeringId !== '') {
            $branchId = Offering::query()->whereKey($offeringId)->value('branch_id');
            $branchId = trim((string) ($branchId ?? ''));
            if ($branchId !== '') {
                return $branchId;
            }
        }

        return RecordBranch::studentBranchForId($studentId);
    }

    private function assertOfferingLinkedToActiveEnrollment(string $offeringId, string $studentId): void
    {
        /** @var Offering|null $offering */
        $offering = Offering::query()->find($offeringId);
        if ($offering === null || $offering->lifecycle_state === Offering::STATE_CANCELLED) {
            throw BusinessRejection::forCode('finance.obligation_offering_invalid', 'an obligation offering must be a known non-cancelled academic offering');
        }
        if (! Enrollment::query()
            ->where('student_id', $studentId)
            ->where('offering_id', $offeringId)
            ->where('lifecycle_state', 'active')
            ->exists()) {
            throw BusinessRejection::forCode('finance.obligation_offering_enrollment_mismatch', 'the obligation offering must belong to an active enrollment of the student');
        }
    }

    private function require(Actor $actor, \App\Support\Authorization\StructureScope $scope): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('finance.obligation_denied', $outcome->reason);
        }
    }
}
