<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Access\Models\Position;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Campus;
use App\Modules\Organization\Models\Department;
use App\Modules\Organization\Models\Organization;
use Illuminate\View\View;

/**
 * Organization &amp; Configuration console: read view of the authoritative
 * structure (organizations, departments, branches, positions). Structural
 * changes are governed commands in the organization module.
 */
final class OrganizationController extends Controller
{
    public function index(): View
    {
        $this->requireOrganizationRead('organization.structure.initiate', 'organization.console.index');
        $organizationIds = $this->authorizedOrganizations('organization.structure.initiate');
        $branchIds = $this->authorizedBranches('organization.structure.initiate');
        $campusIds = Campus::query()->whereIn('organization_id', $organizationIds)->pluck('id');

        return view('organization.index', [
            'organizations' => Organization::query()->whereIn('id', $organizationIds)->orderBy('name')->limit(200)->get(),
            'departments' => Department::query()->where(function ($scope) use ($organizationIds, $campusIds, $branchIds): void {
                $scope->where(function ($organization) use ($organizationIds): void {
                    $organization->where('scope_type', 'organization')->whereIn('scope_id', $organizationIds);
                })->orWhere(function ($campus) use ($campusIds): void {
                    $campus->where('scope_type', 'campus')->whereIn('scope_id', $campusIds);
                })->orWhere(function ($branch) use ($branchIds): void {
                    $branch->where('scope_type', 'branch')->whereIn('scope_id', $branchIds);
                });
            })->orderBy('name')->limit(200)->get(),
            'branches' => Branch::query()->whereIn('id', $branchIds)->orderBy('name')->limit(200)->get(),
            'positions' => Position::query()->whereIn('organization_id', $organizationIds)->orderBy('name')->limit(200)->get(),
        ]);
    }
}
