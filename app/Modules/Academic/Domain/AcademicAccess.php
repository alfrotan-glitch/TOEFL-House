<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;

/**
 * Academic authorization: every protected operation resolves through the
 * single AccessDecision authority, and — when the target carries branch
 * provenance — against that branch's structure scope (WP-ACAD-SCOPE).
 *
 * Scope is always derived server-side from locked rows or verified inputs.
 * A null/empty branch means the target is genuinely branchless (governance
 * tier) or of unknown provenance (legacy rows): the global check applies.
 * An unknown branch id fails closed.
 */
final class AcademicAccess
{
    public function __construct(private readonly AccessDecision $access) {}

    public function require(Actor $actor, string $capability, ?string $branchId, string $errorCode): void
    {
        $outcome = $this->access->decide($actor, $capability, $this->scopeFor($branchId));
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode($errorCode, $outcome->reason);
        }
    }

    private function scopeFor(?string $branchId): ?StructureScope
    {
        $branchId = trim((string) ($branchId ?? ''));
        if ($branchId === '') {
            return null;
        }
        /** @var Branch|null $branch */
        $branch = Branch::query()->find($branchId);
        if ($branch === null) {
            throw BusinessRejection::forCode('academic.branch_unknown', 'the referenced branch does not exist');
        }

        return $branch->structureScope();
    }
}
