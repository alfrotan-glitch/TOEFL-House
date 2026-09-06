<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Queries;

use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementRecommendation;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use Illuminate\Support\Collection;

/**
 * Read model for a placement decision object's current state and full
 * evidence history — the explainable surface a reviewer and a candidate
 * see. All reads are over guarded, immutable evidence.
 */
final class PlacementProfileQuery
{
    public function __construct(
        private readonly AcademicEligibilitySnapshotQuery $eligibilitySnapshots,
    ) {}

    /** @return array<string, mixed> */
    public function for(PlacementProfile $profile): array
    {
        $attempts = PlacementAttempt::query()->where('profile_id', $profile->id)->orderBy('attempt_no')->get();
        $recommendations = PlacementRecommendation::query()->where('profile_id', $profile->id)->orderByDesc('created_at')->get();
        $sectionResults = PlacementSectionResult::query()
            ->whereIn('attempt_id', $attempts->pluck('id'))
            ->orderBy('component')
            ->get();

        return [
            'profile' => $profile->refresh(),
            'attempts' => $attempts,
            'section_results' => $sectionResults,
            'recommendations' => $recommendations,
            'eligibility_snapshot' => $this->eligibilitySnapshots->for($profile),
        ];
    }

    /** @return Collection<int, PlacementProfile> */
    public function search(?string $term, ?string $lifecycleState, ?string $programVersionId): Collection
    {
        $query = PlacementProfile::query()->with(['person', 'recommendedLevel', 'recommendedClass'])->orderByDesc('updated_at')->limit(200);
        if ($lifecycleState !== null && $lifecycleState !== '') {
            $query->where('lifecycle_state', $lifecycleState);
        }
        if ($programVersionId !== null && $programVersionId !== '') {
            $query->where('program_version_id', $programVersionId);
        }
        if ($term !== null && $term !== '') {
            $query->whereHas('person', function ($person) use ($term): void {
                $person->where('legal_name', 'ilike', '%'.$term.'%')
                    ->orWhere('identity_key', 'ilike', '%'.$term.'%');
            });
        }

        return $query->get();
    }
}
