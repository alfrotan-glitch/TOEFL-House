<?php

declare(strict_types=1);

namespace App\Modules\Finance\Queries;

use App\Modules\Academic\Models\Enrollment;
use App\Modules\Finance\Domain\FinancialGateEvidence;
use App\Modules\Finance\Models\EnrollmentInstallmentPlan;
use App\Modules\Finance\Models\FinancialCredit;
use App\Modules\Finance\Models\FinancialGateException;
use App\Modules\Finance\Models\Obligation;
use App\Support\Errors\BusinessRejection;
use App\Support\MoneyAmount;
use Illuminate\Support\Carbon;

/**
 * Finance-authoritative enrollment gate assessment.
 *
 * Academic calls this read/assess query before activating an enrollment. The
 * query derives the uncovered amount from immutable Finance facts (obligation
 * remainder already nets payments, discounts/waivers, and restricted
 * fund/sponsorship allocations) and applies approved credit, installment, and
 * approved-exception facts. It returns a deterministic, signed evidence
 * payload; Academic freezes that evidence, it never re-derives a balance.
 */
final class FinancialGateQuery
{
    public function __construct(
        private readonly FinancialBalanceQuery $balances,
    ) {}

    /** @return array<string, mixed> */
    public function assess(Enrollment $enrollment): array
    {
        $studentId = $enrollment->student_id;
        $obligations = Obligation::query()
            ->where('student_id', $studentId)
            ->orderBy('created_at')
            ->orderBy('id')
            ->get();

        $obligationEvidence = [];
        /** @var numeric-string $originalTotal */
        $originalTotal = '0.00';
        /** @var numeric-string $uncovered */
        $uncovered = '0.00';
        foreach ($obligations as $obligation) {
            $remaining = $this->balances->obligationRemaining($obligation);
            $this->assertNonNegativeObligationRemainder($obligation, $remaining);
            $originalTotal = bcadd($originalTotal, $obligation->original_amount, 2);
            $uncovered = bcadd($uncovered, $remaining, 2);
            $obligationEvidence[] = [
                'obligation_id' => $obligation->id,
                'obligation_amount' => $obligation->original_amount,
                'obligation_remaining' => $remaining,
            ];
        }

        $credits = FinancialCredit::query()
            ->where('student_id', $studentId)
            ->where('lifecycle_state', FinancialCredit::STATE_APPROVED)
            ->orderBy('created_at')
            ->orderBy('id')
            ->get();
        $installments = EnrollmentInstallmentPlan::query()
            ->where('student_id', $studentId)
            ->where('lifecycle_state', EnrollmentInstallmentPlan::STATE_APPROVED)
            ->where(function ($query) use ($enrollment): void {
                $query->whereNull('offering_id')->orWhere('offering_id', $enrollment->offering_id ?? '');
            })
            ->orderBy('created_at')
            ->orderBy('id')
            ->get();
        $today = Carbon::today()->toDateString();
        $exceptions = FinancialGateException::query()
            ->where('student_id', $studentId)
            ->where('lifecycle_state', FinancialGateException::STATE_APPROVED)
            ->where(function ($query) use ($enrollment): void {
                $query->whereNull('offering_id')->orWhere('offering_id', $enrollment->offering_id ?? '');
            })
            ->where(function ($query) use ($enrollment): void {
                $query->whereNull('class_id')->orWhere('class_id', $enrollment->class_id);
            })
            ->where('effective_from', '<=', $today)
            ->where(function ($query) use ($today): void {
                $query->whereNull('effective_to')->orWhere('effective_to', '>=', $today);
            })
            ->orderBy('created_at')
            ->orderBy('id')
            ->get();

        $creditAmount = $this->sum(array_map(static fn (mixed $amount): string => MoneyAmount::decimal($amount), array_values($credits->pluck('amount')->all())));
        $installmentAmount = $this->sum(array_map(static fn (mixed $amount): string => MoneyAmount::decimal($amount), array_values($installments->pluck('amount')->all())));
        $exceptionAmount = $this->sum(array_map(static fn (mixed $amount): string => MoneyAmount::decimal($amount), array_values($exceptions->pluck('amount')->all())));

        $coveredByExisting = bcsub($originalTotal, $uncovered, 2);
        $coveredByCredit = $this->minOf($creditAmount, $uncovered);
        $afterCredit = bcsub($uncovered, $coveredByCredit, 2);
        $coveredByInstallment = $this->minOf($installmentAmount, $afterCredit);
        $afterInstallment = bcsub($afterCredit, $coveredByInstallment, 2);
        $coveredByException = $this->minOf($exceptionAmount, $afterInstallment);
        $remaining = bcsub($afterInstallment, $coveredByException, 2);
        $satisfied = bccomp($remaining, '0.00', 2) !== 1;

        $evidence = [
            'schema_version' => FinancialGateEvidence::SCHEMA_VERSION,
            'assessed_at' => now()->toIso8601String(),
            'student_id' => $studentId,
            'offering_id' => $enrollment->offering_id,
            'class_id' => $enrollment->class_id,
            'obligations' => $obligationEvidence,
            'uncovered' => $uncovered,
            'coverage' => [
                'payment_discount_funding' => $coveredByExisting,
                'credit' => $coveredByCredit,
                'installment' => $coveredByInstallment,
                'exception' => $coveredByException,
            ],
            'credits' => $credits->pluck('id')->all(),
            'installment_plans' => $installments->pluck('id')->all(),
            'exceptions' => $exceptions->pluck('id')->all(),
            'remaining' => $remaining,
            'satisfied' => $satisfied,
        ];

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
     * Student-level clearance assessment for graduation and certification
     * visibility. Same derivation as the enrollment gate, but without a seat
     * context: seat-scoped exceptions cannot be evaluated and are excluded,
     * so only global (unscoped) approved exceptions apply. Read-only Finance
     * truth for a human decision-maker — it never authorizes a refusal on
     * its own; no ratified rule refuses graduation on debt.
     *
     * @return array<string, mixed>
     */
    public function assessStudent(string $studentId): array
    {
        $obligations = Obligation::query()
            ->where('student_id', $studentId)
            ->orderBy('created_at')
            ->orderBy('id')
            ->get();

        $obligationEvidence = [];
        /** @var numeric-string $originalTotal */
        $originalTotal = '0.00';
        /** @var numeric-string $uncovered */
        $uncovered = '0.00';
        foreach ($obligations as $obligation) {
            $remaining = $this->balances->obligationRemaining($obligation);
            $this->assertNonNegativeObligationRemainder($obligation, $remaining);
            $originalTotal = bcadd($originalTotal, $obligation->original_amount, 2);
            $uncovered = bcadd($uncovered, $remaining, 2);
            $obligationEvidence[] = [
                'obligation_id' => $obligation->id,
                'obligation_amount' => $obligation->original_amount,
                'obligation_remaining' => $remaining,
            ];
        }

        $credits = FinancialCredit::query()
            ->where('student_id', $studentId)
            ->where('lifecycle_state', FinancialCredit::STATE_APPROVED)
            ->orderBy('created_at')
            ->orderBy('id')
            ->get();
        $installments = EnrollmentInstallmentPlan::query()
            ->where('student_id', $studentId)
            ->where('lifecycle_state', EnrollmentInstallmentPlan::STATE_APPROVED)
            ->orderBy('created_at')
            ->orderBy('id')
            ->get();
        $today = Carbon::today()->toDateString();
        $exceptions = FinancialGateException::query()
            ->where('student_id', $studentId)
            ->where('lifecycle_state', FinancialGateException::STATE_APPROVED)
            ->whereNull('offering_id')
            ->whereNull('class_id')
            ->where('effective_from', '<=', $today)
            ->where(function ($query) use ($today): void {
                $query->whereNull('effective_to')->orWhere('effective_to', '>=', $today);
            })
            ->orderBy('created_at')
            ->orderBy('id')
            ->get();

        $creditAmount = $this->sum(array_map(static fn (mixed $amount): string => MoneyAmount::decimal($amount), array_values($credits->pluck('amount')->all())));
        $installmentAmount = $this->sum(array_map(static fn (mixed $amount): string => MoneyAmount::decimal($amount), array_values($installments->pluck('amount')->all())));
        $exceptionAmount = $this->sum(array_map(static fn (mixed $amount): string => MoneyAmount::decimal($amount), array_values($exceptions->pluck('amount')->all())));

        $coveredByExisting = bcsub($originalTotal, $uncovered, 2);
        $coveredByCredit = $this->minOf($creditAmount, $uncovered);
        $afterCredit = bcsub($uncovered, $coveredByCredit, 2);
        $coveredByInstallment = $this->minOf($installmentAmount, $afterCredit);
        $afterInstallment = bcsub($afterCredit, $coveredByInstallment, 2);
        $coveredByException = $this->minOf($exceptionAmount, $afterInstallment);
        $remaining = bcsub($afterInstallment, $coveredByException, 2);
        $satisfied = bccomp($remaining, '0.00', 2) !== 1;

        $evidence = [
            'schema_version' => FinancialGateEvidence::SCHEMA_VERSION,
            'scope' => 'student',
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
            'credits' => $credits->pluck('id')->all(),
            'installment_plans' => $installments->pluck('id')->all(),
            'exceptions' => $exceptions->pluck('id')->all(),
            'remaining' => $remaining,
            'satisfied' => $satisfied,
        ];

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

    /**
     * @param list<numeric-string> $amounts
     *
     * @return numeric-string
     */
    private function sum(array $amounts): string
    {
        $total = '0.00';
        foreach ($amounts as $amount) {
            $total = bcadd($total, $amount, 2);
        }

        return $total;
    }

    /**
     * @param numeric-string $potential
     * @param numeric-string $limit
     *
     * @return numeric-string
     */
    private function minOf(string $potential, string $limit): string
    {
        return bccomp($potential, $limit, 2) === 1 ? $limit : $potential;
    }
}
