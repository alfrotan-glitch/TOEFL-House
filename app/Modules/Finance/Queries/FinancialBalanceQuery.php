<?php

declare(strict_types=1);

namespace App\Modules\Finance\Queries;

use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\ObligationLine;
use App\Modules\Finance\Models\Payment;
use App\Modules\Finance\Models\PaymentAllocation;
use App\Modules\Finance\Models\Refund;
use App\Modules\Finance\Models\Discount;
use App\Modules\Finance\Models\FinancialCorrection;
use App\Modules\Finance\Models\FundAllocation;
use App\Modules\Finance\Models\FundingSource;

/**
 * Finance's single derived-balance authority.
 *
 * Source rows remain immutable. This query composes their compensating facts
 * and approved settlement facts into balances consumed by Academic, gates,
 * reporting, and Finance commands. No other bounded context may reimplement
 * these arithmetic rules from raw tables.
 */
final class FinancialBalanceQuery
{
    /** @return array{remaining: string, allocated: string, reversed: string, funded: string, discounted: string, decreased: string, increased: string, original: string} */
    public function obligationBreakdown(Obligation $obligation): array
    {
        $lineIds = ObligationLine::query()
            ->where('obligation_id', $obligation->id)
            ->pluck('id');
        $fundAllocationIds = FundAllocation::query()
            ->whereIn('obligation_line_id', $lineIds)
            ->pluck('id');
        $funded = (string) FundAllocation::query()
            ->whereIn('id', $fundAllocationIds)
            ->sum('amount');
        $fundReversed = (string) FinancialCorrection::query()
            ->whereIn('fund_allocation_id', $fundAllocationIds)
            ->where('correction_type', FinancialCorrection::TYPE_FUND_ALLOCATION_REVERSAL)
            ->where('lifecycle_state', FinancialCorrection::STATE_RECORDED)
            ->sum('amount');
        $funded = bcsub($funded, $fundReversed, 2);
        $allocationIds = PaymentAllocation::query()
            ->where('obligation_id', $obligation->id)
            ->pluck('id');
        $allocated = (string) PaymentAllocation::query()
            ->where('obligation_id', $obligation->id)
            ->sum('amount');
        $reversed = (string) FinancialCorrection::query()
            ->whereIn('payment_allocation_id', $allocationIds)
            ->where('correction_type', FinancialCorrection::TYPE_ALLOCATION_REVERSAL)
            ->where('lifecycle_state', FinancialCorrection::STATE_RECORDED)
            ->sum('amount');
        $discounted = (string) Discount::query()
            ->where('obligation_id', $obligation->id)
            ->where('lifecycle_state', 'approved')
            ->sum('amount');
        $decreased = (string) FinancialCorrection::query()
            ->where('obligation_id', $obligation->id)
            ->where('correction_type', FinancialCorrection::TYPE_OBLIGATION_ADJUSTMENT)
            ->where('direction', FinancialCorrection::DIRECTION_DECREASE)
            ->where('lifecycle_state', FinancialCorrection::STATE_RECORDED)
            ->sum('amount');
        $increased = (string) FinancialCorrection::query()
            ->where('obligation_id', $obligation->id)
            ->where('correction_type', FinancialCorrection::TYPE_OBLIGATION_ADJUSTMENT)
            ->where('direction', FinancialCorrection::DIRECTION_INCREASE)
            ->where('lifecycle_state', FinancialCorrection::STATE_RECORDED)
            ->sum('amount');

        $netAllocated = bcsub($allocated, $reversed, 2);
        $remaining = bcsub((string) $obligation->original_amount, (string) $funded, 2);
        $remaining = bcsub($remaining, $netAllocated, 2);
        $remaining = bcsub($remaining, $discounted, 2);
        $remaining = bcsub($remaining, $decreased, 2);

        return [
            'remaining' => bcadd($remaining, $increased, 2),
            'allocated' => $allocated,
            'reversed' => $reversed,
            'funded' => $funded,
            'discounted' => $discounted,
            'decreased' => $decreased,
            'increased' => $increased,
            'original' => (string) $obligation->original_amount,
        ];
    }

    public function obligationRemaining(Obligation $obligation): string
    {
        return $this->obligationBreakdown($obligation)['remaining'];
    }

    public function paymentRemaining(Payment $payment): string
    {
        $allocationIds = PaymentAllocation::query()
            ->where('payment_id', $payment->id)
            ->pluck('id');
        $allocated = (string) PaymentAllocation::query()
            ->where('payment_id', $payment->id)
            ->sum('amount');
        $reversed = (string) FinancialCorrection::query()
            ->whereIn('payment_allocation_id', $allocationIds)
            ->where('correction_type', FinancialCorrection::TYPE_ALLOCATION_REVERSAL)
            ->where('lifecycle_state', FinancialCorrection::STATE_RECORDED)
            ->sum('amount');
        $netAllocated = bcsub($allocated, $reversed, 2);
        $refunded = (string) Refund::query()
            ->where('payment_id', $payment->id)
            ->where('lifecycle_state', 'recorded')
            ->sum('amount');

        return bcsub(bcsub((string) $payment->amount, $netAllocated, 2), $refunded, 2);
    }

    public function studentUncovered(string $studentId): string
    {
        $uncovered = '0.00';
        foreach (Obligation::query()->where('student_id', $studentId)->get() as $obligation) {
            $uncovered = bcadd($uncovered, $this->obligationRemaining($obligation), 2);
        }

        return $uncovered;
    }

    /** @return array{allocated: string, committed: string, utilization: string} */
    public function fundUtilization(FundingSource $fund, string $periodEnd): array
    {
        $allocationIds = FundAllocation::query()
            ->where('fund_id', $fund->id)
            ->whereDate('created_at', '<=', $periodEnd)
            ->pluck('id');
        $allocated = (string) FundAllocation::query()
            ->whereIn('id', $allocationIds)
            ->sum('amount');
        $reversed = (string) FinancialCorrection::query()
            ->whereIn('fund_allocation_id', $allocationIds)
            ->where('correction_type', FinancialCorrection::TYPE_FUND_ALLOCATION_REVERSAL)
            ->where('lifecycle_state', FinancialCorrection::STATE_RECORDED)
            ->whereDate('created_at', '<=', $periodEnd)
            ->sum('amount');
        $net = bcsub($allocated, $reversed, 2);

        $committed = (string) $fund->committed_amount;

        return [
            'allocated' => $net,
            'committed' => $committed,
            'utilization' => bccomp($committed, '0.00', 2) === 0 ? '0.0000' : bcdiv($net, $committed, 4),
        ];
    }

    /** @return array{value: string, meta: array<string, string|int>} */
    public function periodBalance(string $periodId, ?string $studentId = null): array
    {
        $query = Obligation::query()->where('period_id', $periodId);
        if ($studentId !== null) {
            $query->where('student_id', $studentId);
        }
        $original = '0.00';
        $remaining = '0.00';
        $allocated = '0.00';
        $reversed = '0.00';
        $funded = '0.00';
        $discounted = '0.00';
        $decreased = '0.00';
        $increased = '0.00';
        $count = 0;
        foreach ($query->get() as $obligation) {
            $breakdown = $this->obligationBreakdown($obligation);
            $original = bcadd($original, $breakdown['original'], 2);
            $remaining = bcadd($remaining, $breakdown['remaining'], 2);
            $allocated = bcadd($allocated, $breakdown['allocated'], 2);
            $reversed = bcadd($reversed, $breakdown['reversed'], 2);
            $funded = bcadd($funded, $breakdown['funded'], 2);
            $discounted = bcadd($discounted, $breakdown['discounted'], 2);
            $decreased = bcadd($decreased, $breakdown['decreased'], 2);
            $increased = bcadd($increased, $breakdown['increased'], 2);
            $count++;
        }

        return [
            'value' => $remaining,
            'meta' => [
                'original' => $original,
                'allocated' => $allocated,
                'reversed' => $reversed,
                'discounted' => $discounted,
                'funded' => $funded,
                'decreased' => $decreased,
                'increased' => $increased,
                'obligations' => $count,
            ],
        ];
    }
}
