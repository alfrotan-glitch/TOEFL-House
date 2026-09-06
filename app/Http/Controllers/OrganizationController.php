<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Access\Models\Position;
use App\Modules\Organization\Models\Branch;
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
        return view('organization.index', [
            'organizations' => Organization::query()->orderBy('name')->limit(200)->get(),
            'departments' => Department::query()->orderBy('name')->limit(200)->get(),
            'branches' => Branch::query()->orderBy('name')->limit(200)->get(),
            'positions' => Position::query()->orderBy('name')->limit(200)->get(),
        ]);
    }
}
