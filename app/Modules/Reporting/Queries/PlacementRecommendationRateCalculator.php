<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Reporting\Domain\MetricCalculator;
use Illuminate\Support\Facades\DB;

/**
 * Placement pipeline (lineage registry): what share of placement profiles
 * opened in an academic period reached a recommendation.
 */
final class PlacementRecommendationRateCalculator implements MetricCalculator
{
    public function compute(string $periodId, ?string $scopeId): array
    {
        $period = DB::table('academic_periods')->where('id', $periodId)->first(['starts_on', 'ends_on']);
        if ($period === null) {
            return ['value' => '0', 'meta' => ['recommendation_rate' => 0, 'note' => 'unknown_period']];
        }

        $opened = DB::table('placement_profiles')
            ->whereBetween('created_at', [$period->starts_on.' 00:00:00', $period->ends_on.' 23:59:59']);
        $recommended = clone $opened;
        if ($scopeId !== null) {
            $opened->where('originating_branch_id', $scopeId);
            $recommended->where('originating_branch_id', $scopeId);
        }
        $openedCount = (int) $opened->count();
        $recommendedCount = (int) $recommended->where('recommended_level_id', '<>', null)->count();
        $rate = $openedCount > 0 ? $recommendedCount / $openedCount * 100 : 0.0;

        return [
            'value' => (string) round($rate, 2),
            'meta' => ['recommendation_rate' => round($rate, 2), 'profiles' => $openedCount, 'recommended' => $recommendedCount],
        ];
    }
}
