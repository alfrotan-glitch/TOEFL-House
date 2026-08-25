<?php

declare(strict_types=1);

namespace App\Support\Authorization;

/**
 * Authenticated actor with the capabilities granted to it by the access
 * domain. Package 02 validates command authority from these grants; the
 * authorization package later resolves them from positions and assignments.
 */
final class Actor
{
    /** @param array<string, list<string>> $capabilities scope key => capability list */
    public function __construct(
        public readonly string $actorId,
        public readonly string $displayName,
        private readonly array $capabilities = [],
    ) {}

    /** Global scope covers every organizational scope. */
    public function hasCapability(string $capability, ?StructureScope $scope = null): bool
    {
        $scopes = ['*'];
        if ($scope !== null) {
            $scopes = array_merge($scopes, $scope->coveringScopeKeys());
        }

        foreach ($scopes as $scopeKey) {
            $granted = $this->capabilities[$scopeKey] ?? [];
            if (in_array($capability, $granted, true)) {
                return true;
            }
        }

        return false;
    }
}
