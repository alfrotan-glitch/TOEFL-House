<?php

declare(strict_types=1);

namespace App\Support\Authorization;

/**
 * Organizational scope of a target or grant. Resolution order is
 * organization -> campus -> branch -> department; a grant on an ancestor
 * covers all descendants.
 *
 * A scope with unknown provenance is deliberately different from a null
 * scope. Null is reserved for explicitly branchless governance operations;
 * unknown is a fail-closed operational target.
 */
final class StructureScope
{
    public function __construct(
        public readonly string $organizationId,
        public readonly ?string $campusId = null,
        public readonly ?string $branchId = null,
        public readonly ?string $departmentId = null,
        public readonly bool $unknownProvenance = false,
        public readonly bool $allowInactiveLifecycle = false,
    ) {}

    public static function organization(string $organizationId): self
    {
        return new self($organizationId);
    }

    public static function unknown(): self
    {
        return new self('', null, null, null, true, false);
    }

    public function withInactiveLifecycleAccess(): self
    {
        return new self(
            $this->organizationId,
            $this->campusId,
            $this->branchId,
            $this->departmentId,
            $this->unknownProvenance,
            true,
        );
    }

    public function isUnknown(): bool
    {
        return $this->unknownProvenance;
    }

    /**
     * Scope keys from the most specific to the organization root. A grant on
     * any of them authorizes an operation inside this scope.
     *
     * @return list<string>
     */
    public function coveringScopeKeys(): array
    {
        if ($this->unknownProvenance) {
            return [];
        }

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
        if ($this->organizationId !== '') {
            $keys[] = 'organization:'.$this->organizationId;
        }

        return $keys;
    }
}
