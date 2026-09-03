<?php

declare(strict_types=1);

namespace App\Modules\Calendar\Domain;

use App\Support\EffectiveDating\EffectivePeriod;
use Carbon\CarbonImmutable;

/** Read-only information about one month of a served Solar Hijri year. */
final class ShamsiMonth
{
    public function __construct(
        public readonly int $year,
        public readonly int $month,
        public readonly string $name,
        public readonly int $length,
        public readonly CarbonImmutable $firstDayGregorian,
    ) {}

    public function lastDayGregorian(): CarbonImmutable
    {
        return $this->firstDayGregorian->addDays($this->length - 1);
    }

    /** Exact canonical Gregorian [start, end) window of the SH month. */
    public function boundaries(): EffectivePeriod
    {
        return EffectivePeriod::closed($this->firstDayGregorian, $this->lastDayGregorian()->addDay());
    }
}
