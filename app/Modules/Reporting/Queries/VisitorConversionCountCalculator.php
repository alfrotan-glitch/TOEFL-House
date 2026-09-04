<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Reporting\Domain\MetricCalculator;
use Illuminate\Support\Facades\DB;

/**
 * Visitor pipeline (lineage registry): how many lead records produced an
 * applicant/student conversion within an academic period.
 */
final class VisitorConversionCountCalculator implements MetricCalculator
{
    public function compute(string $periodId, ?string $scopeId): array
    {
        $period = DB::table('academic_periods')->where('id', $periodId)->first(['starts_on', 'ends_on']);
        if ($period === null) {
            return ['value' => '0', 'meta' => ['visitor_conversions' => 0, 'note' => 'unknown_period']];
        }

        $query = DB::table('visitor_conversions')
            ->join('visitors', 'visitors.id', '=', 'visitor_conversions.visitor_id')
            ->whereBetween('visitor_conversions.converted_at', [$period->starts_on.' 00:00:00', $period->ends_on.' 23:59:59']);
        if ($scopeId !== null) {
            $query->where('visitors.origin_branch_id', $scopeId);
        }
        $count = (int) $query->count();

        return ['value' => (string) $count, 'meta' => ['visitor_conversions' => $count]];
    }
}
