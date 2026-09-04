<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Placement delivery modes (master contract §18): DIGITAL / PHYSICAL.
 */
final class PlacementDelivery
{
    public const DIGITAL = 'digital';

    public const PHYSICAL = 'physical';

    /** @return list<string> */
    public static function all(): array
    {
        return [self::DIGITAL, self::PHYSICAL];
    }

    public static function require(string $mode): void
    {
        if (! in_array($mode, self::all(), true)) {
            throw BusinessRejection::forCode('placement.delivery_unknown', sprintf('unknown placement delivery mode %s', $mode));
        }
    }
}
