<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Reporting\Domain\MetricCalculator;
use Illuminate\Support\Facades\DB;

/**
 * Attendance percentage (lineage registry): share of present marks among
 * recorded attendance facts for an academic period — correction history
 * stays in the source; the projection reads current facts.
 */
final class AttendanceRateCalculator implements MetricCalculator
{
    public function compute(string $periodId, ?string $scopeId): array
    {
        $query = DB::table('attendance_facts')
            ->join('class_sessions', 'class_sessions.id', '=', 'attendance_facts.session_id')
            ->join('classes', 'classes.id', '=', 'class_sessions.class_id')
            ->where('classes.period_id', $periodId);
        if ($scopeId !== null) {
            $query->where('classes.id', $scopeId);
        }
        $total = (clone $query)->count();
        $present = (clone $query)->where('attendance_facts.status', 'present')->count();
        $rate = $total === 0 ? '0.0000' : bcdiv((string) $present, (string) $total, 4);

        return ['value' => $rate, 'meta' => ['facts' => $total, 'present' => $present]];
    }
}
