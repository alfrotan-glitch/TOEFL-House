<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Reporting\Domain\MetricCalculator;
use Illuminate\Support\Facades\DB;

/**
 * Finance-owned payroll liability total. Payroll results and adjustments are
 * source evidence only; only Finance-recognized facts enter the metric.
 */
final class PayrollTotalCalculator implements MetricCalculator
{
    public function compute(string $periodId, ?string $scopeId): array
    {
        $query = DB::table('payroll_liability_facts')->where('period_id', $periodId);
        if ($scopeId !== null) {
            $query->where('originating_branch_id', $scopeId);
        }
        $recognized = (string) $query->sum('amount');

        return ['value' => bcadd($recognized, '0', 2), 'meta' => ['finance_liability_facts' => $recognized, 'source_owner' => 'finance']];
    }
}
