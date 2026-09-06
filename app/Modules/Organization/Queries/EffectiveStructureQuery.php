<?php

declare(strict_types=1);

namespace App\Modules\Organization\Queries;

use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Campus;
use App\Modules\Organization\Models\CampusAssignment;
use App\Modules\Organization\Models\Department;
use App\Modules\Organization\Models\Organization;
use App\Support\Authorization\StructureScope;
use Carbon\CarbonImmutable;

/**
 * Read model of the effective organization structure as of a day. Queries
 * never mutate and never authorize a change: the result is filtered data
 * only, and campus attribution is resolved from effective dating.
 */
final class EffectiveStructureQuery
{
    /**
     * @return array{
     *     as_of: string,
     *     organizations: list<array<string, mixed>>,
     *     campuses: list<array<string, mixed>>,
     *     branches: list<array<string, mixed>>,
     *     departments: list<array<string, mixed>>
     * }
     */
    public function effectiveStructure(CarbonImmutable $asOf, ?StructureScope $filter = null): array
    {
        $day = $asOf->startOfDay()->toDateString();

        $organizations = Organization::query()
            ->where('lifecycle_state', 'active')
            ->when($filter !== null, fn ($query) => $query->where('id', $filter->organizationId))
            ->orderBy('name')
            ->get(['id', 'name'])
            ->map(fn (Organization $organization): array => ['id' => $organization->id, 'name' => $organization->name])
            ->all();

        $campuses = Campus::query()
            ->where('lifecycle_state', 'active')
            ->when($filter !== null, fn ($query) => $query->where('organization_id', $filter->organizationId))
            ->orderBy('name')
            ->get(['id', 'organization_id', 'name'])
            ->map(fn (Campus $campus): array => [
                'id' => $campus->id,
                'organization_id' => $campus->organization_id,
                'name' => $campus->name,
            ])
            ->all();

        $assignments = CampusAssignment::query()
            ->where('effective_from', '<=', $day)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $day))
            ->get();

        $branches = Branch::query()
            ->where('lifecycle_state', 'active')
            ->when($filter?->branchId !== null, fn ($query) => $query->where('id', $filter->branchId))
            ->when($filter?->campusId !== null, fn ($query) => $query->whereIn('id', $assignments->where('campus_id', $filter->campusId)->pluck('branch_id')))
            ->orderBy('name')
            ->get(['id', 'name'])
            ->map(fn (Branch $branch): array => [
                'id' => $branch->id,
                'name' => $branch->name,
                'campus_id' => $assignments->firstWhere('branch_id', $branch->id)?->campus_id,
            ])
            ->all();

        $departments = Department::query()
            ->where('lifecycle_state', 'active')
            ->when($filter !== null, fn ($query) => $query->where(function ($query) use ($filter): void {
                $query->where(function ($query) use ($filter): void {
                    $query->where('scope_type', 'organization')->where('scope_id', $filter->organizationId);
                });
                if ($filter->campusId !== null) {
                    $query->orWhere(function ($query) use ($filter): void {
                        $query->where('scope_type', 'campus')->where('scope_id', $filter->campusId);
                    });
                }
                if ($filter->branchId !== null) {
                    $query->orWhere(function ($query) use ($filter): void {
                        $query->where('scope_type', 'branch')->where('scope_id', $filter->branchId);
                    });
                }
            }))
            ->orderBy('name')
            ->get(['id', 'name', 'scope_type', 'scope_id'])
            ->map(fn (Department $department): array => [
                'id' => $department->id,
                'name' => $department->name,
                'scope_type' => $department->scope_type,
                'scope_id' => $department->scope_id,
            ])
            ->all();

        return [
            'as_of' => $day,
            'organizations' => array_values($organizations),
            'campuses' => array_values($campuses),
            'branches' => array_values($branches),
            'departments' => array_values($departments),
        ];
    }
}
