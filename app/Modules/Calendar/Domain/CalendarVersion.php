<?php

declare(strict_types=1);

namespace App\Modules\Calendar\Domain;

use App\Support\Errors\SystemFailure;
use App\Support\Errors\ValidationError;
use Carbon\CarbonImmutable;

/**
 * An immutable, versioned instance of the ratified Solar Hijri civil series.
 *
 * The authoritative rule (F4-A / D3) is: the civil first day of each Solar Hijri
 * year (1 Hamal / Nowruz) is pinned per-year by the ratified reference series —
 * never derived from a 33-year, 2820-year, ICU/Persian or generic Jalali
 * arithmetic formula. The anchor set is contiguous in Solar Hijri years; a year
 * is fully servable only when BOTH its own Nowruz and its successor's Nowruz are
 * pinned (that is what fixes its length / leap status). Leap = year length of
 * 366 canonical days between the two Nowruz days.
 *
 * Storage/date handling stays canonical Gregorian (G2): anchors carry their
 * Nowruz as a Gregorian civil date and their equinox instant (UTC) as purely
 * informational/audit data. The equinox instant is never used as the civil-day
 * source (the astronomical instant and the Kabul-civil Nowruz day are distinct).
 */
final class CalendarVersion
{
    /**
     * Parsed anchor points ordered by Solar Hijri year.
     *
     * @var list<array{year: int, nowruz: CarbonImmutable, equinoxUtc: CarbonImmutable|null}>
     */
    private readonly array $points;

    /**
     * @param  array<int, array{nowruz: string, equinox_utc?: string|null}>  $anchors
     *                                                                                 nowruz: 'YYYY-MM-DD' (Kabul-civil Nowruz day), equinox_utc: optional 'YYYY-MM-DD HH:MM' UTC.
     */
    public function __construct(
        public readonly string $id,
        public readonly string $label,
        array $anchors,
    ) {
        if ($anchors === []) {
            throw SystemFailure::forCode('calendar.series_empty', sprintf('calendar version "%s" carries no anchors', $id));
        }

        $sorted = $anchors;
        ksort($sorted, SORT_NUMERIC);

        $points = [];
        $previousYear = null;
        $previousNowruz = null;
        foreach ($sorted as $year => $row) {
            if (! is_int($year)) {
                throw SystemFailure::forCode('calendar.series_invalid', 'anchor keys must be integer Solar Hijri years');
            }

            if ($previousYear !== null && $year !== $previousYear + 1) {
                throw SystemFailure::forCode('calendar.series_invalid', sprintf('calendar version "%s" anchors must be contiguous Solar Hijri years', $id));
            }

            $nowruz = CarbonImmutable::createMidnightDate((int) substr((string) $row['nowruz'], 0, 4), (int) substr((string) $row['nowruz'], 5, 2), (int) substr((string) $row['nowruz'], 8, 2), 'UTC');

            $equinoxUtcText = $row['equinox_utc'] ?? null;
            $equinoxUtc = is_string($equinoxUtcText) && $equinoxUtcText !== ''
                ? CarbonImmutable::parse($equinoxUtcText, 'UTC')
                : null;

            if ($previousNowruz !== null) {
                $span = (int) $previousNowruz->diffInDays($nowruz);
                if ($span !== 365 && $span !== 366) {
                    throw SystemFailure::forCode('calendar.series_invalid', sprintf('calendar version "%s": Solar Hijri year span must be 365 or 366 days', $id));
                }
            }

            $points[] = ['year' => $year, 'nowruz' => $nowruz, 'equinoxUtc' => $equinoxUtc];
            $previousYear = $year;
            $previousNowruz = $nowruz;
        }

        $this->points = $points;
    }

    /** @return list<int> Solar Hijri years that carry a pinned Nowruz. */
    public function anchoredYears(): array
    {
        return array_map(static fn (array $p): int => $p['year'], $this->points);
    }

    public function minAnchoredYear(): int
    {
        return $this->points[0]['year'];
    }

    public function maxAnchoredYear(): int
    {
        return $this->points[count($this->points) - 1]['year'];
    }

    /** First fully servable year (has both its own and successor Nowruz). */
    public function servedYearMin(): int
    {
        return $this->minAnchoredYear();
    }

    /** Last fully servable year. */
    public function servedYearMax(): int
    {
        return $this->maxAnchoredYear() - 1;
    }

    /** @return array{0: int, 1: int} [min, max] fully servable Solar Hijri years. */
    public function servedYearRange(): array
    {
        return [$this->servedYearMin(), $this->servedYearMax()];
    }

    public function isServedYear(int $year): bool
    {
        return $year >= $this->servedYearMin() && $year <= $this->servedYearMax();
    }

    public function hasNowruz(int $year): bool
    {
        foreach ($this->points as $p) {
            if ($p['year'] === $year) {
                return true;
            }
        }

        return false;
    }

    /** First civil day of the served interval (Nowruz of the first served year). */
    public function servedCivilStart(): CarbonImmutable
    {
        return $this->nowruzForYear($this->servedYearMin());
    }

    /** Exclusive end of the served civil interval. */
    public function servedCivilEndExclusive(): CarbonImmutable
    {
        return $this->nowruzForYear($this->maxAnchoredYear());
    }

    /** True when a canonical Gregorian civil day falls inside the served interval. */
    public function containsCivilDay(CarbonImmutable $day): bool
    {
        $day = $day->startOfDay();

        return $day->greaterThanOrEqualTo($this->servedCivilStart())
            && $day->lessThan($this->servedCivilEndExclusive());
    }

    public function nowruzForYear(int $year): CarbonImmutable
    {
        foreach ($this->points as $p) {
            if ($p['year'] === $year) {
                return $p['nowruz'];
            }
        }

        throw ValidationError::forCode('calendar.anchor_missing', sprintf('no ratified Nowruz anchor exists for Solar Hijri year %d', $year));
    }

    /** Leap is a series fact: the Solar Hijri year has 366 canonical days. */
    public function isLeap(int $year): bool
    {
        if (! $this->isServedYear($year)) {
            throw ValidationError::forCode('calendar.anchor_missing', sprintf('Solar Hijri year %d is not fully served (no successor anchor)', $year));
        }

        return (int) $this->nowruzForYear($year)->diffInDays($this->nowruzForYear($year + 1)) === 366;
    }

    public function hutDays(int $year): int
    {
        return $this->isLeap($year) ? 30 : 29;
    }

    /** Greatest served year whose Nowruz is <= the given civil day. */
    public function yearForNowruz(CarbonImmutable $day): int
    {
        $day = $day->startOfDay();
        $chosen = null;
        foreach ($this->points as $p) {
            if (! $p['nowruz']->greaterThan($day)) {
                $chosen = $p['year'];
            } else {
                break;
            }
        }

        if ($chosen === null) {
            throw ValidationError::forCode('calendar.below_served_interval', 'civil day is before the first served Nowruz');
        }

        return $chosen;
    }
}
