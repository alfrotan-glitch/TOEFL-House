<?php

declare(strict_types=1);

namespace App\Modules\Finance\Queries;

use App\Modules\Academic\Models\Enrollment;
use App\Modules\Finance\Domain\FinancialGateEvidence;
use App\Modules\Finance\Models\FinancialCoverageCommitment;
use App\Modules\Finance\Models\Obligation;
use App\Support\Errors\BusinessRejection;
use App\Support\MoneyAmount;
use Illuminate\Support\Carbon;

/**
 * Finance-authoritative enrollment gate assessment.
 *
 * FinancialBalanceQuery derives actual monetary obligation remainder from
 * immutable monetary facts. Approved credits, installments, and exceptions
 * are a separate, attributed coverage layer: each must have immutable
 * obligation commitments whose total equals its approved source amount. This
 * prevents one student-level remainder from being approved repeatedly while
 * retaining the balance query as the sole monetary-balance authority.
 */
final class FinancialGateQuery
{
    public function __construct(
        private readonly FinancialBalanceQuery $balances,
        private readonly FinancialCoverageCommitmentQuery $coverageCommitments,
    ) {}

    /** @return array<string, mixed> */
    public function assess(Enrollment $enrollment): array
    {
        return $this->assessment(
            (string) $enrollment->student_id,
            $this->nullableId($enrollment->offering_id),
            $this->nullableId($enrollment->class_id),
            false,
        );
    }

    /**
     * Student-level clearance for graduation and certification visibility.
     *
     * This is intentionally stricter than an enrollment-target assessment:
     * an offering/class-scoped settlement is not proof of general student
     * clearance. Only student-wide credits, plans, and exceptions are allowed
     * to supplement actual Finance settlement in this context.
     *
     * @return array<string, mixed>
     */
    public function assessStudent(string $studentId): array
    {
        return $this->assessment($studentId, null, null, true);
    }

    /** @return array<string, mixed> */
    private function assessment(string $studentId, ?string $offeringId, ?string $classId, bool $studentClearance): array
    {
        /** @var list<Obligation> $obligations */
        $obligations = Obligation::query()
            ->where('student_id', $studentId)
            ->orderBy('created_at')
            ->orderBy('id')
            ->get()
            ->all();
        $obligationIds = array_map(static fn (Obligation $obligation): string => (string) $obligation->id, $obligations);
        $today = Carbon::today()->toDateString();
        $commitments = $studentClearance
            ? $this->coverageCommitments->activeForStudentClearance($obligationIds, $today)
            : $this->coverageCommitments->activeForEnrollment($obligationIds, $offeringId, $classId, $today);

        /** @var array<string, list<FinancialCoverageCommitment>> $commitmentsByObligation */
        $commitmentsByObligation = [];
        foreach ($commitments as $commitment) {
            $commitmentsByObligation[(string) $commitment->obligation_id][] = $commitment;
        }

        $obligationEvidence = [];
        $commitmentEvidence = [];
        /** @var numeric-string $uncovered */
        $uncovered = '0.00';
        /** @var numeric-string $coveredByExisting */
        $coveredByExisting = '0.00';
        /** @var numeric-string $coveredByCredit */
        $coveredByCredit = '0.00';
        /** @var numeric-string $coveredByInstallment */
        $coveredByInstallment = '0.00';
        /** @var numeric-string $coveredByException */
        $coveredByException = '0.00';
        $creditIds = [];
        $installmentIds = [];
        $exceptionIds = [];

        foreach ($obligations as $obligation) {
            $breakdown = $this->balances->obligationBreakdown($obligation);
            $remaining = $breakdown['remaining'];
            $this->assertNonNegativeObligationRemainder($obligation, $remaining);
            $uncovered = bcadd($uncovered, $remaining, 2);
            $coveredByExisting = bcadd($coveredByExisting, $this->actualSettlementReduction($breakdown), 2);

            /** @var numeric-string $committedAgainstObligation */
            $committedAgainstObligation = '0.00';
            $obligationCommitmentEvidence = [];
            foreach ($commitmentsByObligation[$obligation->id] ?? [] as $commitment) {
                $amount = MoneyAmount::decimal($commitment->amount);
                if (! MoneyAmount::positive($amount)) {
                    throw BusinessRejection::forCode('finance.coverage_commitment_invalid', 'a gate coverage commitment must have a positive amount');
                }
                $committedAgainstObligation = bcadd($committedAgainstObligation, $amount, 2);
                $sourceType = (string) $commitment->coverage_source_type;
                $sourceId = (string) $commitment->coverage_source_id;
                if ($sourceType === FinancialCoverageCommitment::SOURCE_FINANCIAL_CREDIT) {
                    $coveredByCredit = bcadd($coveredByCredit, $amount, 2);
                    $creditIds[] = $sourceId;
                } elseif ($sourceType === FinancialCoverageCommitment::SOURCE_INSTALLMENT_PLAN) {
                    $coveredByInstallment = bcadd($coveredByInstallment, $amount, 2);
                    $installmentIds[] = $sourceId;
                } elseif ($sourceType === FinancialCoverageCommitment::SOURCE_GATE_EXCEPTION) {
                    $coveredByException = bcadd($coveredByException, $amount, 2);
                    $exceptionIds[] = $sourceId;
                } else {
                    throw BusinessRejection::forCode('finance.coverage_commitment_invalid', 'an unknown gate coverage commitment source cannot authorize enrollment');
                }
                $entry = [
                    'commitment_id' => (string) $commitment->id,
                    'source_type' => $sourceType,
                    'source_id' => $sourceId,
                    'obligation_id' => (string) $obligation->id,
                    'amount' => $amount,
                ];
                $obligationCommitmentEvidence[] = $entry;
                $commitmentEvidence[] = $entry;
            }
            if (bccomp($committedAgainstObligation, $remaining, 2) === 1) {
                throw BusinessRejection::forCode(
                    'finance.coverage_commitment_overallocated',
                    sprintf('obligation %s has gate coverage commitments beyond its Finance remainder', $obligation->id),
                );
            }

            $obligationEvidence[] = [
                'obligation_id' => $obligation->id,
                'obligation_amount' => $obligation->original_amount,
                'obligation_remaining' => $remaining,
                'coverage_commitments' => $obligationCommitmentEvidence,
            ];
        }

        // `uncovered` is already net of cash settlement, discounts, funds,
        // and recorded obligation corrections. Only explicit gate commitments
        // reduce it further. There is deliberately no min()/clamping here:
        // an overcommitment is invalid Finance history, never free coverage.
        $remaining = bcsub($uncovered, $coveredByCredit, 2);
        $remaining = bcsub($remaining, $coveredByInstallment, 2);
        $remaining = bcsub($remaining, $coveredByException, 2);
        if (bccomp($remaining, '0.00', 2) === -1) {
            throw BusinessRejection::forCode('finance.coverage_commitment_overallocated', 'gate coverage commitments exceed the authoritative Finance uncovered amount');
        }
        $satisfied = bccomp($remaining, '0.00', 2) === 0;

        $evidence = [
            'schema_version' => FinancialGateEvidence::SCHEMA_VERSION,
            'assessed_at' => now()->toIso8601String(),
            'student_id' => $studentId,
            'obligations' => $obligationEvidence,
            'uncovered' => $uncovered,
            'coverage' => [
                'payment_discount_funding' => $coveredByExisting,
                'credit' => $coveredByCredit,
                'installment' => $coveredByInstallment,
                'exception' => $coveredByException,
            ],
            'coverage_commitments' => $commitmentEvidence,
            'credits' => $this->uniqueIds($creditIds),
            'installment_plans' => $this->uniqueIds($installmentIds),
            'exceptions' => $this->uniqueIds($exceptionIds),
            'remaining' => $remaining,
            'satisfied' => $satisfied,
        ];
        if ($studentClearance) {
            $evidence['scope'] = 'student';
        } else {
            $evidence['offering_id'] = $offeringId;
            $evidence['class_id'] = $classId;
        }

        $signed = FinancialGateEvidence::sign($evidence);

        return [
            'evidence' => $evidence,
            'canonical' => $signed['canonical'],
            'digest' => $signed['digest'],
            'signature' => $signed['signature'],
            'algorithm' => $signed['algorithm'],
            'key_version' => $signed['key_version'],
            'satisfied' => $satisfied,
            'uncovered' => $uncovered,
            'remaining' => $remaining,
            'assessed_at' => $evidence['assessed_at'],
        ];
    }

    /**
     * @param array{allocated: string, reversed: string, funded: string, discounted: string, decreased: string, increased: string, original: string, remaining: string} $breakdown
     * @return numeric-string
     */
    private function actualSettlementReduction(array $breakdown): string
    {
        $allocated = bcsub($breakdown['allocated'], $breakdown['reversed'], 2);
        $funded = $breakdown['funded'];
        $discounted = $breakdown['discounted'];
        $decreased = $breakdown['decreased'];

        return bcadd(bcadd($allocated, $funded, 2), bcadd($discounted, $decreased, 2), 2);
    }

    /** @param list<string> $ids
     * @return list<string>
     */
    private function uniqueIds(array $ids): array
    {
        return array_values(array_unique($ids, SORT_STRING));
    }

    private function nullableId(?string $id): ?string
    {
        $id = trim((string) $id);

        return $id === '' ? null : $id;
    }

    /**
     * The enrollment gate must fail closed when historical data violates the
     * Finance settlement invariant. Treating a negative obligation remainder
     * as extra coverage would incorrectly activate a seat from corrupted or
     * pre-hardening source facts.
     *
     * @param numeric-string $remaining
     */
    private function assertNonNegativeObligationRemainder(Obligation $obligation, string $remaining): void
    {
        if (bccomp($remaining, '0.00', 2) === -1) {
            throw BusinessRejection::forCode(
                'finance.obligation_over_settled',
                sprintf('obligation %s has an invalid negative remaining balance %s', $obligation->id, $remaining),
            );
        }
    }
}
