<?php

declare(strict_types=1);

namespace App\Support\Authorization;

/**
 * Immutable allow/deny outcome with the reason required by the authorization
 * contract. There is no "hold" outcome at package 02 scope: no delegated or
 * temporary authority exists yet, so undecidable authority always denies.
 */
final class Decision
{
    private function __construct(
        public readonly bool $allowed,
        public readonly string $reason,
    ) {}

    public static function allow(): self
    {
        return new self(true, 'capability granted in scope');
    }

    public static function deny(string $reason): self
    {
        return new self(false, $reason);
    }
}
