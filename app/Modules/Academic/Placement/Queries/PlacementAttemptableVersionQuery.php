<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Queries;

use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementTest;
use App\Modules\Academic\Placement\Models\PlacementTestVersion;
use Illuminate\Support\Collection;

/**
 * Read projection for the only frozen test versions that can legally begin
 * an attempt for one Placement profile. Catalog-maintenance authorization is
 * deliberately not a prerequisite: a conduct-authorized proctor must be able
 * to discover the published evidence contract for their own branch/profile.
 */
final class PlacementAttemptableVersionQuery
{
    /** @return Collection<int, PlacementTestVersion> */
    public function for(PlacementProfile $profile): Collection
    {
        $originatingBranchId = trim((string) ($profile->originating_branch_id ?? ''));
        $currentHomeBranchId = trim((string) ($profile->current_home_branch_id ?? ''));
        if ($originatingBranchId === '' || $currentHomeBranchId === '') {
            // This is a read projection, not a legacy-repair path. A profile
            // without concrete provenance has no safely discoverable test.
            return collect();
        }

        $tests = PlacementTest::query()
            ->where('originating_branch_id', $originatingBranchId)
            ->where('current_home_branch_id', $currentHomeBranchId)
            ->where('lifecycle_state', 'published');
        $profileProgramVersionId = trim((string) ($profile->program_version_id ?? ''));
        if ($profileProgramVersionId !== '') {
            // A generic test can assess a profile-selected program; a test
            // explicitly targeted elsewhere can never be its evidence source.
            $tests->where(function ($query) use ($profileProgramVersionId): void {
                $query->whereNull('program_version_id')
                    ->orWhere('program_version_id', $profileProgramVersionId);
            });
        }

        return PlacementTestVersion::query()
            ->whereIn('placement_test_id', $tests->select('id'))
            ->where('lifecycle_state', 'published')
            ->orderByDesc('version_no')
            ->limit(100)
            ->get();
    }
}
