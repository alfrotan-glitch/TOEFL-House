<?php

declare(strict_types=1);

namespace App\Support\Authorization;

use App\Modules\Organization\Models\Branch;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Illuminate\Database\Eloquent\ModelNotFoundException;

/**
 * Shared target-scope adapter for branch-homed contexts. It derives scope
 * from server-owned records and makes unknown provenance an explicit
 * fail-closed decision. AccessDecision remains the only authority.
 */
final class BranchScopedAccess
{
    public function __construct(private readonly AccessDecision $access) {}

    public function require(Actor $actor, string $capability, ?string $branchId, string $errorCode, ?string $expectedOrganizationId = null): void
    {
        $branchId = trim((string) ($branchId ?? ''));
        if ($branchId === '') {
            $outcome = $this->access->decide($actor, $capability, StructureScope::unknown());
            throw AuthorizationDenied::forCode($errorCode, $outcome->reason);
        }

        /** @var Branch|null $branch */
        $branch = Branch::query()->whereKey($branchId)->lockForUpdate()->first();
        if ($branch === null) {
            throw BusinessRejection::forCode('organization.branch_unknown', 'the referenced branch does not exist');
        }

        try {
            $scope = $branch->structureScope();
        } catch (ModelNotFoundException) {
            throw AuthorizationDenied::forCode($errorCode, 'the branch has no resolvable active organization provenance');
        }
        if ($expectedOrganizationId !== null && trim($expectedOrganizationId) !== trim($scope->organizationId)) {
            throw AuthorizationDenied::forCode($errorCode, 'the branch and stored organization provenance no longer agree');
        }
        $outcome = $this->access->decide($actor, $capability, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode($errorCode, $outcome->reason);
        }
    }

    /** Explicitly branchless governance only. */
    public function requireGlobal(Actor $actor, string $capability, string $errorCode): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode($errorCode, $outcome->reason);
        }
    }
}
