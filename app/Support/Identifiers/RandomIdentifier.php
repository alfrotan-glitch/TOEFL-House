<?php

declare(strict_types=1);

namespace App\Support\Identifiers;

/**
 * Version 4 UUID identifiers for facts, evidence, and deduplication rows
 * across modules; correlation identifiers come from the error contract.
 */
final class RandomIdentifier
{
    /** @return non-empty-string */
    public static function new(): string
    {
        /** @var non-empty-string $identifier */
        $identifier = sprintf(
            '%08x-%04x-%04x-%04x-%012x',
            random_int(0, 0xFFFFFFFF),
            random_int(0, 0xFFFF),
            random_int(0, 0xFFFF) & 0x0FFF | 0x4000,
            random_int(0, 0xFFFF) & 0x3FFF | 0x8000,
            random_int(0, 0xFFFFFFFFFFFF),
        );

        return $identifier;
    }
}
