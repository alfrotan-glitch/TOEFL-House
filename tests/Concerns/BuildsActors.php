<?php

declare(strict_types=1);

namespace Tests\Concerns;

use App\Support\Authorization\Actor;

/**
 * Actor evidence fixtures mapped to the authority registry roles: the
 * General Manager initiates structure decisions, the affected manager
 * reviews, and two distinct Owners approve.
 */
trait BuildsActors
{
    private function generalManager(string $actorId = 'gm-1'): Actor
    {
        return new Actor($actorId, 'General Manager', ['*' => ['organization.structure.initiate']]);
    }

    private function structureManager(string $scopeKey, string $actorId = 'mgr-1'): Actor
    {
        return new Actor($actorId, 'Structure Manager', [$scopeKey => ['organization.structure.review']]);
    }

    private function structureOwner(string $scopeKey, string $actorId): Actor
    {
        return new Actor($actorId, 'Owner', [$scopeKey => ['organization.structure.approve']]);
    }

    private function identityVerifier(string $actorId = 'idv-1'): Actor
    {
        return new Actor($actorId, 'Identity Verifier', ['*' => ['identity.verify']]);
    }

    private function identityAdministrator(string $actorId = 'ida-1'): Actor
    {
        return new Actor($actorId, 'Identity Administrator', ['*' => ['identity.admin']]);
    }

    private function actorWithoutAnyCapability(string $actorId = 'nobody-1'): Actor
    {
        return new Actor($actorId, 'Unauthorized Actor', []);
    }
}
