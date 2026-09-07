<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Reporting\Domain\MetricCalculator;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Placement release-event cohort: profiles whose immutable database-recorded
 * approved-to-released transition occurred inside an academic period. The
 * profile may subsequently be superseded or retired; its release fact still
 * belongs in the original period. `updated_at`, a current `released` state,
 * and a later eligibility-snapshot signature are deliberately not temporal
 * substitutes. Legacy releases without an exact event clock make the result
 * incomplete rather than being guessed into an arbitrary period.
 */
final class PlacementReleaseCountCalculator implements MetricCalculator
{
    public function compute(string $periodId, ?string $scopeId): array
    {
        $period = DB::table('academic_periods')->where('id', $periodId)->first(['starts_on', 'ends_on']);
        if ($period === null) {
            return ['value' => '0', 'completeness' => 'incomplete', 'meta' => [
                'placement_releases' => 0,
                'release_time_basis' => 'database_transition',
                'note' => 'unknown_period',
            ]];
        }

        $periodStartsAt = CarbonImmutable::parse((string) $period->starts_on)->startOfDay()->toDateTimeString();
        $periodEndsExclusiveAt = CarbonImmutable::parse((string) $period->ends_on)->addDay()->startOfDay()->toDateTimeString();
        $knownReleases = DB::table('placement_profiles')
            ->where('release_time_basis', 'database_transition')
            ->whereNotNull('released_at')
            ->where('released_at', '>=', $periodStartsAt)
            ->where('released_at', '<', $periodEndsExclusiveAt);
        $unresolvedReleases = DB::table('placement_profiles')
            ->whereNull('released_at')
            ->where(function ($profiles): void {
                // `superseded` implies a prior release under the lifecycle;
                // `released_by` preserves legacy release evidence when a later
                // retirement no longer exposes the released lifecycle state.
                $profiles->whereIn('lifecycle_state', ['released', 'superseded'])
                    ->orWhereNotNull('released_by');
            });
        if ($scopeId !== null) {
            // The original operational branch is immutable fact provenance;
            // a current-home designation must not move a historical release
            // cohort between branch reports.
            $knownReleases->where('originating_branch_id', $scopeId);
            $unresolvedReleases->where('originating_branch_id', $scopeId);
        }

        $unassignedKnownCount = $scopeId === null
            ? (int) (clone $knownReleases)->whereNull('originating_branch_id')->count()
            : 0;
        $count = (int) $knownReleases->count();
        $unresolvedCount = (int) $unresolvedReleases->count();

        return [
            'value' => (string) $count,
            'completeness' => $unresolvedCount === 0 ? 'complete' : 'incomplete',
            'meta' => [
                'placement_releases' => $count,
                'release_time_basis' => 'database_transition',
                'unresolved_release_timing_profiles' => $unresolvedCount,
                'unresolved_release_timing_excluded_from_period' => $unresolvedCount > 0,
                'unassigned_provenance_count' => $unassignedKnownCount,
                'unassigned_provenance_excluded' => $scopeId !== null,
            ],
        ];
    }
}
