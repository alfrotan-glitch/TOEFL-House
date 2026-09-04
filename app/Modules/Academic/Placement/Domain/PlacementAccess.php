<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Domain;

use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;

/**
 * Placement authorization: every protected operation resolves through the
 * single AccessDecision authority, and — when the record carries branch
 * provenance — against that branch's structure scope.
 */
final class PlacementAccess
{
    public function __construct(private readonly AccessDecision $access) {}

    public function require(Actor $actor, string $capability, ?string $branchId = null, string $errorCode = 'placement.denied'): void
    {
        $scope = $this->scopeFor($branchId);
        $outcome = $this->access->decide($actor, $capability, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode($errorCode, $outcome->reason);
        }
    }

    public function scopeFor(?string $branchId): ?StructureScope
    {
        if ($branchId === null || $branchId === '') {
            return null;
        }
        /** @var Branch|null $branch */
        $branch = Branch::query()->find($branchId);
        if ($branch === null) {
            throw BusinessRejection::forCode('placement.branch_unknown', 'the referenced branch does not exist');
        }

        return $branch->structureScope();
    }
}
