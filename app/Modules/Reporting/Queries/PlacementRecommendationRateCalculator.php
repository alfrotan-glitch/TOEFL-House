<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementRecommendation;
use App\Modules\Reporting\Domain\MetricCalculator;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Placement intake-cohort outcome: the share of guarded profiles opened in an
 * academic period that have an exact append-only recommendation as of this
 * projection. The profile's recommendation pointer is a read projection, not
 * numerator authority: it must match the immutable recommendation row and a
 * database-owned profile decision-fact marker. Pre-marker cohorts are kept as
 * historical evidence but make the result incomplete rather than silently
 * turning a nullable profile field into a recommendation fact.
 */
final class PlacementRecommendationRateCalculator implements MetricCalculator
{
    public function compute(string $periodId, ?string $scopeId): array
    {
        $period = DB::table('academic_periods')->where('id', $periodId)->first(['starts_on', 'ends_on']);
        if ($period === null) {
            return ['value' => '0', 'completeness' => 'incomplete', 'meta' => [
                'recommendation_rate' => 0,
                'note' => 'unknown_period',
                'recommendation_fact_basis' => 'append_only_placement_recommendation_exact_profile_projection',
            ]];
        }

        $periodStartsAt = CarbonImmutable::parse((string) $period->starts_on)->startOfDay()->toDateTimeString();
        $periodEndsExclusiveAt = CarbonImmutable::parse((string) $period->ends_on)->addDay()->startOfDay()->toDateTimeString();
        $opened = DB::table('placement_profiles as profiles')
            ->where('profiles.created_at', '>=', $periodStartsAt)
            ->where('profiles.created_at', '<', $periodEndsExclusiveAt);
        if ($scopeId !== null) {
            // The original operational branch is immutable profile provenance;
            // a current-home change must not move an intake cohort.
            $opened->where('profiles.originating_branch_id', $scopeId);
        }

        $unassigned = $scopeId === null
            ? (int) (clone $opened)->whereNull('profiles.originating_branch_id')->count()
            : 0;
        $allCohortCount = (int) (clone $opened)->count();

        // v3 is assigned by the database guard, never accepted from the
        // caller. A prior v2 row may be genuine, but the old profile
        // transition boundary permitted rewrite during later transitions, so
        // it cannot be relabeled as trustworthy in this aggregate.
        $guardedCohort = (clone $opened)
            ->where('profiles.decision_fact_version', PlacementProfile::DECISION_FACT_VERSION);
        $guardedCount = (int) (clone $guardedCohort)->count();
        $unresolvedCohortCount = $allCohortCount - $guardedCount;

        // Count an immutable recommendation only when every profile-facing
        // field is the exact projection of the append-only v2 recommendation.
        // This retains a valid fact through release, supersession, or
        // retirement while rejecting a nullable/current profile pointer as a
        // source of truth in its own right.
        $exactRecommendations = (clone $guardedCohort)
            ->join('placement_recommendations as recommendations', function ($join): void {
                $join->on('recommendations.id', '=', 'profiles.placement_recommendation_id')
                    ->on('recommendations.profile_id', '=', 'profiles.id')
                    ->on('recommendations.program_version_id', '=', 'profiles.program_version_id')
                    ->on('recommendations.recommended_level_id', '=', 'profiles.recommended_level_id');
            })
            ->where('profiles.lineage_version', PlacementProfile::LINEAGE_VERSION)
            ->where('recommendations.lineage_version', PlacementRecommendation::LINEAGE_VERSION)
            ->whereNotNull('recommendations.attempt_id')
            ->whereNotNull('profiles.overall_cefr_ref')
            ->whereRaw("profiles.overall_cefr_ref IS NOT DISTINCT FROM recommendations.score_snapshot->>'overall_cefr'")
            ->whereNull('profiles.recommended_class_id')
            ->whereNull('profiles.recommended_offering_id')
            ->whereNull('recommendations.recommended_class_id')
            ->whereNull('recommendations.recommended_offering_id')
            ->distinct();
        $recommendedCount = (int) (clone $exactRecommendations)->count('profiles.id');

        // A guarded profile that claims recommendation-stage evidence but
        // cannot join to the exact immutable row is database corruption or a
        // pre-existing malformed record. Do not report a numerically neat
        // rate as complete in that case.
        $recommendationClaims = (clone $guardedCohort)
            ->where(function ($claim): void {
                $claim->whereNotNull('profiles.placement_recommendation_id')
                    ->orWhereNotNull('profiles.recommended_level_id')
                    ->orWhereNotNull('profiles.overall_cefr_ref')
                    ->orWhereIn('profiles.lifecycle_state', [
                        PlacementProfile::STATE_RECOMMENDED,
                        PlacementProfile::STATE_REVIEWED,
                        PlacementProfile::STATE_APPROVED,
                        PlacementProfile::STATE_RELEASED,
                        PlacementProfile::STATE_SUPERSEDED,
                    ]);
            });
        $recommendationClaimCount = (int) (clone $recommendationClaims)->count();
        $unverifiableRecommendationCount = max(0, $recommendationClaimCount - $recommendedCount);

        $rate = $guardedCount > 0 ? $recommendedCount / $guardedCount * 100 : 0.0;
        $roundedRate = round($rate, 2);
        $complete = $unresolvedCohortCount === 0 && $unverifiableRecommendationCount === 0;

        return [
            'value' => (string) $roundedRate,
            'completeness' => $complete ? 'complete' : 'incomplete',
            'meta' => [
                'recommendation_rate' => $roundedRate,
                'profiles' => $guardedCount,
                'recommended' => $recommendedCount,
                'cohort_basis' => 'guarded_profiles_opened_in_period_as_of_projection',
                'recommendation_fact_basis' => 'append_only_placement_recommendation_exact_profile_projection',
                'unresolved_decision_fact_profiles' => $unresolvedCohortCount,
                'unresolved_decision_fact_profiles_excluded' => $unresolvedCohortCount > 0,
                'unverifiable_recommendation_profiles' => $unverifiableRecommendationCount,
                'unverifiable_recommendation_profiles_excluded' => $unverifiableRecommendationCount > 0,
                'unassigned_provenance_count' => $unassigned,
                'unassigned_provenance_excluded' => $scopeId !== null,
            ],
        ];
    }
}
