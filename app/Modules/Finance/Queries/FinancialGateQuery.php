<?php

declare(strict_types=1);

namespace App\Modules\Finance\Queries;

use App\Modules\Academic\Models\Enrollment;
use App\Modules\Finance\Commands\AllocatePayment;
use App\Modules\Finance\Domain\FinancialGateEvidence;
use App\Modules\Finance\Models\EnrollmentInstallmentPlan;
use App\Modules\Finance\Models\FinancialCredit;
use App\Modules\Finance\Models\FinancialGateException;
use App\Modules\Finance\Models\Obligation;
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
    public function __construct(private readonly AllocatePayment $allocations) {}

    /** @return array<string, mixed> */
    public function assess(Enrollment $enrollment): array
    {
        $studentId = $enrollment->student_id;
        $contextOfferingId = $enrollment->offering_id;
        $obligations = Obligation::query()
            ->where('student_id', $studentId)
            ->when($contextOfferingId !== null, fn ($query) => $query->where(fn ($q) => $q->whereNull('offering_id')->orWhere('offering_id', $contextOfferingId)))
            ->orderBy('created_at')
            ->get();

        $obligationEvidence = [];
        $originalTotal = '0.00';
        $uncovered = '0.00';
        foreach ($obligations as $obligation) {
            $remaining = $this->allocations->obligationRemaining($obligation);
            $originalTotal = bcadd($originalTotal, (string) $obligation->original_amount, 2);
            $uncovered = bcadd($uncovered, $remaining, 2);
            $obligationEvidence[] = [
                'obligation_id' => $obligation->id,
                'obligation_amount' => (string) $obligation->original_amount,
                'obligation_remaining' => $remaining,
            ];
        }

        $credits = FinancialCredit::query()
            ->where('student_id', $studentId)
            ->where('lifecycle_state', FinancialCredit::STATE_APPROVED)
            ->get();
        $installments = EnrollmentInstallmentPlan::query()
            ->where('student_id', $studentId)
            ->where('lifecycle_state', EnrollmentInstallmentPlan::STATE_APPROVED)
            ->when($contextOfferingId !== null, fn ($query) => $query->where(fn ($q) => $q->whereNull('offering_id')->orWhere('offering_id', $contextOfferingId)))
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
            ->get();

        $creditAmount = $this->sum($credits->pluck('amount')->all());
        $installmentAmount = $this->sum($installments->pluck('amount')->all());
        $exceptionAmount = $this->sum($exceptions->pluck('amount')->all());

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

    /** @param list<string> $amounts */
    private function sum(array $amounts): string
    {
        $total = '0.00';
        foreach ($amounts as $amount) {
            $total = bcadd($total, $amount, 2);
        }

        return $total;
    }

    private function minOf(string $potential, string $limit): string
    {
        return bccomp($potential, $limit, 2) === 1 ? $limit : $potential;
    }
}
