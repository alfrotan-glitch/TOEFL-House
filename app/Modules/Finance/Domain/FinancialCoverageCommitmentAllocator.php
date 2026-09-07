<?php

declare(strict_types=1);

namespace App\Modules\Finance\Domain;

use App\Modules\Finance\Models\EnrollmentInstallmentPlan;
use App\Modules\Finance\Models\FinancialCoverageCommitment;
use App\Modules\Finance\Models\FinancialCredit;
use App\Modules\Finance\Models\FinancialGateException;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Queries\FinancialBalanceQuery;
use App\Modules\Finance\Queries\FinancialCoverageCommitmentQuery;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use App\Support\MoneyAmount;
use Illuminate\Support\Carbon;

/**
 * Materializes an approved enrollment-gate source into immutable, exact
 * obligation commitments.
 *
 * Callers must hold FinancialCoverageLock for the source student and perform
 * the source approval plus this materialization in one transaction. The
 * allocator intentionally consumes FinancialBalanceQuery rather than keeping
 * a mutable student balance: it reserves only the uncommitted portion of each
 * authoritative obligation remainder.
 */
final class FinancialCoverageCommitmentAllocator
{
    public function __construct(
        private readonly FinancialBalanceQuery $balances,
        private readonly FinancialCoverageCommitmentQuery $commitments,
    ) {}

    /** @return list<array{commitment_id: string, obligation_id: string, amount: numeric-string}> */
    public function commitCredit(FinancialCredit $credit): array
    {
        return $this->commit(
            FinancialCoverageCommitment::SOURCE_FINANCIAL_CREDIT,
            (string) $credit->id,
            (string) $credit->student_id,
            MoneyAmount::decimal($credit->amount),
            null,
            'finance.credit_exceeds_uncovered',
            'the credit exceeds the student\'s uncommitted uncovered obligation remainder',
        );
    }

    /** @return list<array{commitment_id: string, obligation_id: string, amount: numeric-string}> */
    public function commitInstallment(EnrollmentInstallmentPlan $plan): array
    {
        return $this->commit(
            FinancialCoverageCommitment::SOURCE_INSTALLMENT_PLAN,
            (string) $plan->id,
            (string) $plan->student_id,
            MoneyAmount::decimal($plan->amount),
            $this->nullableId($plan->offering_id),
            'finance.installment_exceeds_uncovered',
            'the installment plan exceeds the uncommitted uncovered obligation remainder within its declared scope',
        );
    }

    /** @return list<array{commitment_id: string, obligation_id: string, amount: numeric-string}> */
    public function commitGateException(FinancialGateException $exception): array
    {
        return $this->commit(
            FinancialCoverageCommitment::SOURCE_GATE_EXCEPTION,
            (string) $exception->id,
            (string) $exception->student_id,
            MoneyAmount::decimal($exception->amount),
            $this->nullableId($exception->offering_id),
            'finance.gate_exception_exceeds_uncovered',
            'the gate exception exceeds the uncommitted uncovered obligation remainder within its declared scope',
        );
    }

    /**
     * @param numeric-string $amount
     * @return list<array{commitment_id: string, obligation_id: string, amount: numeric-string}>
     */
    private function commit(string $sourceType, string $sourceId, string $studentId, string $amount, ?string $offeringId, string $exceedsCode, string $exceedsMessage): array
    {
        if (! MoneyAmount::positive($amount)) {
            throw BusinessRejection::forCode('finance.coverage_commitment_amount', 'a gate coverage commitment requires a positive approved source amount');
        }
        if (FinancialCoverageCommitment::query()
            ->where('coverage_source_type', $sourceType)
            ->where('coverage_source_id', $sourceId)
            ->exists()) {
            throw BusinessRejection::forCode('finance.coverage_commitment_exists', 'an approved gate source already has immutable coverage commitments');
        }

        /** @var list<Obligation> $obligations */
        $obligations = Obligation::query()
            ->where('student_id', $studentId)
            ->orderBy('created_at')
            ->orderBy('id')
            ->lockForUpdate()
            ->get()
            ->all();
        $obligationIds = array_map(static fn (Obligation $obligation): string => (string) $obligation->id, $obligations);
        $existing = $this->commitments->activeForCoverageAllocation($obligationIds, Carbon::today()->toDateString());
        /** @var array<string, numeric-string> $committedByObligation */
        $committedByObligation = [];
        foreach ($existing as $commitment) {
            $obligationId = (string) $commitment->obligation_id;
            $committedByObligation[$obligationId] = bcadd(
                $committedByObligation[$obligationId] ?? '0.00',
                MoneyAmount::decimal($commitment->amount),
                2,
            );
        }

        $uncommitted = $amount;
        $created = [];
        foreach ($obligations as $obligation) {
            if (! $this->obligationIsEligible($obligation, $offeringId)) {
                continue;
            }
            $remaining = $this->balances->obligationRemaining($obligation);
            if (bccomp($remaining, '0.00', 2) === -1) {
                throw BusinessRejection::forCode(
                    'finance.coverage_obligation_over_settled',
                    sprintf('obligation %s has an invalid negative Finance remainder %s', $obligation->id, $remaining),
                );
            }
            $alreadyCommitted = $committedByObligation[$obligation->id] ?? '0.00';
            $available = bcsub($remaining, $alreadyCommitted, 2);
            if (bccomp($available, '0.00', 2) === -1) {
                throw BusinessRejection::forCode(
                    'finance.coverage_commitment_overallocated',
                    sprintf('obligation %s already has coverage commitments beyond its Finance remainder', $obligation->id),
                );
            }
            if (bccomp($available, '0.00', 2) !== 1 || bccomp($uncommitted, '0.00', 2) !== 1) {
                continue;
            }

            $commitmentAmount = bccomp($uncommitted, $available, 2) === 1 ? $available : $uncommitted;
            $commitment = FinancialCoverageCommitment::query()->create([
                'id' => RandomIdentifier::new(),
                'coverage_source_type' => $sourceType,
                'coverage_source_id' => $sourceId,
                'obligation_id' => $obligation->id,
                'amount' => $commitmentAmount,
            ]);
            $created[] = [
                'commitment_id' => (string) $commitment->id,
                'obligation_id' => (string) $obligation->id,
                'amount' => $commitmentAmount,
            ];
            $committedByObligation[$obligation->id] = bcadd($alreadyCommitted, $commitmentAmount, 2);
            $uncommitted = bcsub($uncommitted, $commitmentAmount, 2);
        }

        if (bccomp($uncommitted, '0.00', 2) === 1) {
            throw BusinessRejection::forCode($exceedsCode, $exceedsMessage);
        }

        return $created;
    }

    private function obligationIsEligible(Obligation $obligation, ?string $offeringId): bool
    {
        return $offeringId === null || $this->nullableId($obligation->offering_id) === $offeringId;
    }

    private function nullableId(?string $id): ?string
    {
        $id = trim((string) $id);

        return $id === '' ? null : $id;
    }
}
