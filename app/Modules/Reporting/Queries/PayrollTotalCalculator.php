<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Reporting\Domain\MetricCalculator;
use Illuminate\Support\Facades\DB;

/**
 * Payroll total (lineage registry): approved payroll results plus their
 * approved adjustments for one payroll period — as-of the period.
 */
final class PayrollTotalCalculator implements MetricCalculator
{
    public function compute(string $periodId, ?string $scopeId): array
    {
        $results = (string) DB::table('payroll_results')->where('period_id', $periodId)->where('lifecycle_state', 'approved')->sum('amount');
        $adjustments = (string) DB::table('payroll_adjustments')
            ->whereIn('result_id', DB::table('payroll_results')->where('period_id', $periodId)->select('id'))
            ->sum('amount');

        return ['value' => bcadd($results, $adjustments, 2), 'meta' => ['results' => $results, 'adjustments' => $adjustments]];
    }
}
