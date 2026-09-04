<?php

declare(strict_types=1);

namespace App\Modules\Crm\Domain;

use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;

/**
 * CRM authorization: every operation checks the capability through the single
 * AccessDecision authority, and — when the record carries branch provenance —
 * against that branch's structure scope (a branch grant covers it via the
 * organization root). An operation on a known branch uses the branch scope; a
 * global/unknown-provenance operation uses the unscoped decision.
 */
final class CrmAccess
{
    public function __construct(private readonly AccessDecision $access) {}

    public function require(Actor $actor, string $capability, ?string $branchId = null, string $errorCode = 'crm.denied'): void
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
            throw BusinessRejection::forCode('crm.branch_unknown', 'the referenced branch does not exist');
        }

        return $branch->structureScope();
    }
}
