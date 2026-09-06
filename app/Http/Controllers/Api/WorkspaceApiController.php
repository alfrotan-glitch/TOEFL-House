<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Workspace\Queries\EmployeeWorkspaceQuery;
use App\Modules\Workspace\Queries\ManagementWorkspaceQuery;
use App\Support\Authorization\AccessDecision;
use Illuminate\Http\JsonResponse;

/** Read-only workspace transport; canonical domains retain all write authority. */
final class WorkspaceApiController extends Controller
{
    public function __construct(
        private readonly EmployeeWorkspaceQuery $employeeWorkspace,
        private readonly ManagementWorkspaceQuery $managementWorkspace,
    ) {}

    public function employee(): JsonResponse
    {
        return response()->json([
            'data' => $this->employeeWorkspace->snapshot($this->actor()),
        ]);
    }

    public function management(): JsonResponse
    {
        $actor = $this->actor();
        $organizationScope = app(AccessDecision::class)->decide($actor, 'reporting.run', null)->allowed;
        $branches = $this->authorizedBranches('reporting.run');

        if (! $organizationScope && $branches === []) {
            return response()->json([
                'error' => 'management_scope_required',
                'message' => 'No effective reporting or branch scope is available for this workspace.',
            ], 403);
        }

        return response()->json([
            'data' => $this->managementWorkspace->snapshot($actor, $organizationScope, $branches),
        ]);
    }
}
