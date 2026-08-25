<?php

declare(strict_types=1);

namespace App\Support\Authorization;

/**
 * Organizational scope of a target or grant. Resolution order is
 * organization -> campus -> branch -> department; a grant on an ancestor
 * covers all descendants.
 */
final class StructureScope
{
    public function __construct(
        public readonly string $organizationId,
        public readonly ?string $campusId = null,
        public readonly ?string $branchId = null,
        public readonly ?string $departmentId = null,
    ) {}

    /**
     * Scope keys from the most specific to the organization root. A grant on
     * any of them authorizes an operation inside this scope.
     *
     * @return list<string>
     */
    public function coveringScopeKeys(): array
    {
        $keys = [];
        if ($this->departmentId !== null) {
            $keys[] = 'department:'.$this->departmentId;
        }
        if ($this->branchId !== null) {
            $keys[] = 'branch:'.$this->branchId;
        }
        if ($this->campusId !== null) {
            $keys[] = 'campus:'.$this->campusId;
        }
        $keys[] = 'organization:'.$this->organizationId;

        return $keys;
    }
}
