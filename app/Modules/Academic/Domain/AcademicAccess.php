<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\BranchScopedAccess;

/**
 * Academic authorization adapter. Delivery targets use a server-derived
 * branch scope; governance records explicitly use the global path. Both paths
 * delegate to the single AccessDecision authority.
 */
final class AcademicAccess
{
    private readonly BranchScopedAccess $scoped;

    public function __construct(AccessDecision $access)
    {
        $this->scoped = new BranchScopedAccess($access);
    }

    public function require(Actor $actor, string $capability, ?string $branchId, string $errorCode): void
    {
        $this->scoped->require($actor, $capability, $branchId, $errorCode);
    }

    /** Branchless curriculum/governance records only. */
    public function requireGlobal(Actor $actor, string $capability, string $errorCode): void
    {
        $this->scoped->requireGlobal($actor, $capability, $errorCode);
    }
}
