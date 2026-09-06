<?php

declare(strict_types=1);

namespace App\Support\Authorization;

/**
 * Authenticated actor identity: the person identifier behind the session or
 * system operation. Authority is never carried by the actor; it is resolved
 * from the canonical access model by the server policy decision.
 */
final class Actor
{
    public function __construct(
        public readonly string $actorId,
        public readonly string $displayName,
    ) {}
}
