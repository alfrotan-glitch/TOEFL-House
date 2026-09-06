<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Reporting\Domain\MetricCalculator;
use Illuminate\Support\Facades\DB;

/**
 * Visitor pipeline (lineage registry): how many lead records were opened
 * inside an academic period (the capture is made on the calendar date, not
 * the period creation).
 */
final class VisitorCaptureCountCalculator implements MetricCalculator
{
    public function compute(string $periodId, ?string $scopeId): array
    {
        $period = DB::table('academic_periods')->where('id', $periodId)->first(['starts_on', 'ends_on']);
        if ($period === null) {
            return ['value' => '0', 'meta' => ['visitors_captured' => 0, 'note' => 'unknown_period']];
        }

        $query = DB::table('visitors')
            ->whereBetween('created_at', [$period->starts_on.' 00:00:00', $period->ends_on.' 23:59:59']);
        if ($scopeId !== null) {
            $query->where('origin_branch_id', $scopeId);
        }
        $count = (int) $query->count();

        return ['value' => (string) $count, 'meta' => ['visitors_captured' => $count]];
    }
}
