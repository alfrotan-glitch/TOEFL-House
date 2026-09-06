<?php

declare(strict_types=1);

namespace App\Modules\Resources\Domain;

use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\BusinessRejection;

/**
 * Resolves and revalidates the immutable resource root scope. Resource rows
 * retain their originating branch/organization snapshot; a current topology
 * mismatch is not repaired from a mutable person or location field.
 */
final class ResourceScope
{
    public static function fromBranch(string $branchId): StructureScope
    {
        $branch = Branch::query()->whereKey($branchId)->first();
        if ($branch === null || $branch->lifecycle_state !== 'active') {
            throw BusinessRejection::forCode('resources.provenance_required', 'resources require an active originating branch');
        }

        try {
            $scope = $branch->structureScope();
        } catch (\Throwable) {
            throw BusinessRejection::forCode('resources.provenance_required', 'the originating branch has no active organization topology');
        }

        if ($scope->organizationId === '' || $scope->branchId !== $branch->id) {
            throw BusinessRejection::forCode('resources.provenance_required', 'the originating branch has invalid organization provenance');
        }

        return $scope;
    }

    public static function fromStored(?string $branchId, ?string $organizationId): StructureScope
    {
        $branchId = trim((string) ($branchId ?? ''));
        $organizationId = trim((string) ($organizationId ?? ''));
        if ($branchId === '' || $organizationId === '') {
            throw BusinessRejection::forCode('resources.provenance_required', 'legacy resource rows without provenance are not operationally writable');
        }

        $scope = self::fromBranch($branchId);
        if ($scope->organizationId !== $organizationId) {
            throw BusinessRejection::forCode('resources.provenance_mismatch', 'stored resource organization does not match its active branch');
        }

        return $scope;
    }
}
