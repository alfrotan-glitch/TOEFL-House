<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Domain;

/**
 * Deterministic overall-placement CEFR band table used when the weighted
 * component percentage is converted to an overall CEFR reference. This is
 * the explainable, versioned by model_version, part of the scoring rule.
 * Per-component CEFR comes from the placement rubric bands.
 */
final class PlacementBand
{
    /** @var list<array{level: string, min: float, max: float}> ordered ascending */
    private const BANDS = [
        ['level' => 'A1', 'min' => 0.0, 'max' => 39.99],
        ['level' => 'A2', 'min' => 40.0, 'max' => 54.99],
        ['level' => 'B1', 'min' => 55.0, 'max' => 69.99],
        ['level' => 'B2', 'min' => 70.0, 'max' => 84.99],
        ['level' => 'C1', 'min' => 85.0, 'max' => 100.0],
    ];

    public const ORDER = ['A1', 'A2', 'B1', 'B2', 'C1'];

    public static function forPercentage(float $percentage): string
    {
        // Section and recommendation snapshots are persisted to two decimal
        // places. Classify that canonical score rather than a binary floating
        // intermediate, which otherwise leaves gaps such as 39.995 between
        // the 39.99 and 40.00 bands and disagrees with PostgreSQL NUMERIC.
        $canonicalPercentage = round($percentage, 2);
        foreach (self::BANDS as $band) {
            if ($canonicalPercentage >= $band['min'] && $canonicalPercentage <= $band['max']) {
                return $band['level'];
            }
        }

        return 'A1';
    }

    /** @return list<string> */
    public static function order(): array
    {
        return self::ORDER;
    }

    public static function rank(string $cefr): int
    {
        $index = array_search(strtoupper(trim($cefr)), self::ORDER, true);

        return $index === false ? -1 : $index;
    }
}
