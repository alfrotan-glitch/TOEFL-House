<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Reporting\Domain\MetricCalculator;
use Illuminate\Support\Facades\DB;

/**
 * Visitor pipeline (lineage registry): conversion rate = converted leads in
 * the period divided by leads captured in the period. A rate is never
 * fabricated; a period with no captures yields an explicit 0 (none), not a
 * misleading percentage.
 */
final class VisitorConversionRateCalculator implements MetricCalculator
{
    public function compute(string $periodId, ?string $scopeId): array
    {
        $period = DB::table('academic_periods')->where('id', $periodId)->first(['starts_on', 'ends_on']);
        if ($period === null) {
            return ['value' => '0.0000', 'meta' => ['conversion_rate' => 0.0, 'note' => 'unknown_period']];
        }

        $base = DB::table('visitors');
        if ($scopeId !== null) {
            $base->where('origin_branch_id', $scopeId);
        }
        $captured = (int) (clone $base)
            ->whereBetween('created_at', [$period->starts_on.' 00:00:00', $period->ends_on.' 23:59:59'])
            ->count();

        $converted = (int) DB::table('visitor_conversions')
            ->join('visitors', 'visitors.id', '=', 'visitor_conversions.visitor_id')
            ->whereBetween('visitor_conversions.converted_at', [$period->starts_on.' 00:00:00', $period->ends_on.' 23:59:59'])
            ->when($scopeId !== null, fn ($q) => $q->where('visitors.origin_branch_id', $scopeId))
            ->count();

        $rate = $captured > 0 ? round($converted / $captured, 4) : 0.0;

        return ['value' => number_format($rate, 4, '.', ''), 'meta' => ['conversion_rate' => $rate, 'converted' => $converted, 'captured' => $captured]];
    }
}
