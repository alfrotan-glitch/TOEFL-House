<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Reporting\Domain\MetricCalculator;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Placement intake cohort: profiles opened inside an academic period. The
 * immutable originating branch is the delivery provenance; a later home
 * designation must not move a historical profile between branch reports.
 */
final class PlacementProfileCountCalculator implements MetricCalculator
{
    public function compute(string $periodId, ?string $scopeId): array
    {
        $period = DB::table('academic_periods')->where('id', $periodId)->first(['starts_on', 'ends_on']);
        if ($period === null) {
            return ['value' => '0', 'meta' => ['placement_profiles' => 0, 'note' => 'unknown_period']];
        }

        $periodStartsAt = CarbonImmutable::parse((string) $period->starts_on)->startOfDay()->toDateTimeString();
        $periodEndsExclusiveAt = CarbonImmutable::parse((string) $period->ends_on)->addDay()->startOfDay()->toDateTimeString();
        $query = DB::table('placement_profiles')
            ->where('created_at', '>=', $periodStartsAt)
            ->where('created_at', '<', $periodEndsExclusiveAt);
        if ($scopeId !== null) {
            $query->where('originating_branch_id', $scopeId);
        }

        $unassigned = $scopeId === null
            ? (int) (clone $query)->whereNull('originating_branch_id')->count()
            : 0;
        $count = (int) $query->count();

        return ['value' => (string) $count, 'meta' => [
            'placement_profiles' => $count,
            'unassigned_provenance_count' => $unassigned,
            'unassigned_provenance_excluded' => $scopeId !== null,
        ]];
    }
}
