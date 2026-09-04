<?php

declare(strict_types=1);

namespace App\Modules\Academic\Queries;

use App\Modules\Academic\Models\BranchAvailability;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Offering;
use Illuminate\Support\Collection;

/**
 * Read-only branch × level × term catalogue: active/closed availabilities
 * with their open offerings and seat utilisation. No result is an authority
 * to mutate.
 */
final class OfferingCatalogQuery
{
    /** @return array{availabilities: list<array<string, mixed>>} */
    public function catalogue(?string $branchId = null, ?string $academicPeriodId = null): array
    {
        $availabilities = BranchAvailability::query()
            ->when($branchId !== null, fn ($query) => $query->where('branch_id', $branchId))
            ->when($academicPeriodId !== null, fn ($query) => $query->where('academic_period_id', $academicPeriodId))
            ->orderBy('academic_period_id')
            ->orderBy('branch_id')
            ->get();

        /** @var Collection<int, BranchAvailability> $availabilities */
        $rows = $availabilities->map(function (BranchAvailability $availability): array {
            /** @var Collection<int, Offering> $offerings */
            $offerings = Offering::query()
                ->where('branch_id', $availability->branch_id)
                ->where('program_version_level_id', $availability->program_version_level_id)
                ->where('academic_period_id', $availability->academic_period_id)
                ->orderBy('id')
                ->get();

            return [
                'availability_id' => trim((string) $availability->id),
                'branch_id' => trim((string) $availability->branch_id),
                'program_version_level_id' => trim((string) $availability->program_version_level_id),
                'academic_period_id' => trim((string) $availability->academic_period_id),
                'lifecycle_state' => $availability->lifecycle_state,
                'offerings' => $offerings->map(fn (Offering $offering): array => [
                    'offering_id' => trim((string) $offering->id),
                    'capacity' => (int) $offering->capacity,
                    'lifecycle_state' => $offering->lifecycle_state,
                    'active_seats' => Enrollment::query()->where('offering_id', $offering->id)->where('lifecycle_state', 'active')->count(),
                    'requested_seats' => Enrollment::query()->where('offering_id', $offering->id)->where('lifecycle_state', 'requested')->count(),
                ])->all(),
            ];
        })->all();

        return ['availabilities' => $rows];
    }
}
