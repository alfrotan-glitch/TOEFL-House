<?php

declare(strict_types=1);

namespace App\Support\Authorization;

/**
 * Server-side authorization port. Every protected operation resolves through
 * this interface; the default decision is deny. The authorization package
 * replaces the adapter with the position/assignment/permission resolution.
 */
interface AccessDecision
{
    public function decide(Actor $actor, string $capability, ?StructureScope $scope): Decision;
}
