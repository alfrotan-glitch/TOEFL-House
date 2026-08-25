<?php

declare(strict_types=1);

namespace App\Support\Authorization;

use App\Support\Errors\AuthorizationDenied;

/**
 * Default-deny capability evaluation used by package 02 commands. It never
 * grants authority that the actor evidence does not carry, and it fails
 * closed when scope data is missing.
 */
final class AuthorizationGate implements AccessDecision
{
    public function decide(Actor $actor, string $capability, ?StructureScope $scope): Decision
    {
        if ($actor->actorId === '') {
            return Decision::deny('actor identity missing');
        }

        return $actor->hasCapability($capability, $scope)
            ? Decision::allow()
            : Decision::deny(sprintf('capability %s not granted in scope', $capability));
    }

    public static function require(AccessDecision $decision, Actor $actor, string $capability, ?StructureScope $scope, string $errorCode): void
    {
        $outcome = $decision->decide($actor, $capability, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode($errorCode, $outcome->reason);
        }
    }
}
