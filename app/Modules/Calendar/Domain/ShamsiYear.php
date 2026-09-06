<?php

declare(strict_types=1);

namespace App\Modules\Calendar\Domain;

use App\Support\EffectiveDating\EffectivePeriod;
use Carbon\CarbonImmutable;

/** Read-only information about one served Solar Hijri year in a calendar version. */
final class ShamsiYear
{
    public function __construct(
        public readonly int $year,
        public readonly CarbonImmutable $nowruz,
        public readonly CarbonImmutable $nextNowruz,
        public readonly bool $leap,
    ) {}

    public function daysInYear(): int
    {
        return $this->leap ? 366 : 365;
    }

    public function hutDays(): int
    {
        return $this->leap ? 30 : 29;
    }

    /** Exact canonical Gregorian [start, end) window of the SH year. */
    public function boundaries(): EffectivePeriod
    {
        return EffectivePeriod::closed($this->nowruz, $this->nextNowruz);
    }
}
