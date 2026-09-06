<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * The canonical five placement components from the master contract §18.
 */
final class PlacementComponent
{
    public const GRAMMAR = 'grammar';

    public const READING = 'reading';

    public const LISTENING = 'listening';

    public const WRITING = 'writing';

    public const SPEAKING = 'speaking';

    /** @return list<string> */
    public static function all(): array
    {
        return [self::GRAMMAR, self::READING, self::LISTENING, self::WRITING, self::SPEAKING];
    }

    public static function has(string $component): bool
    {
        return in_array($component, self::all(), true);
    }

    public static function label(string $component): string
    {
        return match ($component) {
            self::GRAMMAR => 'Grammar',
            self::READING => 'Reading',
            self::LISTENING => 'Listening',
            self::WRITING => 'Writing',
            self::SPEAKING => 'Speaking',
            default => $component,
        };
    }

    public static function require(string $component): void
    {
        if (! self::has($component)) {
            throw BusinessRejection::forCode('placement.component_unknown', sprintf('unknown placement component %s', $component));
        }
    }
}
