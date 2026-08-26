<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Reporting\Domain\MetricCalculator;
use Illuminate\Support\Facades\DB;

/**
 * Enrollment counts (lineage registry): active membership facts as-of an
 * academic period.
 */
final class ActiveEnrollmentCalculator implements MetricCalculator
{
    public function compute(string $periodId, ?string $scopeId): array
    {
        $query = DB::table('enrollments')
            ->join('classes', 'classes.id', '=', 'enrollments.class_id')
            ->where('classes.period_id', $periodId)
            ->where('enrollments.lifecycle_state', 'active');
        if ($scopeId !== null) {
            $query->where('enrollments.class_id', $scopeId);
        }
        $count = (int) $query->count();

        return ['value' => (string) $count, 'meta' => ['active_enrollments' => $count]];
    }
}
