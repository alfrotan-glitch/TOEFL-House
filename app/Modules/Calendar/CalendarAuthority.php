<?php

declare(strict_types=1);

namespace App\Modules\Calendar;

use App\Modules\Calendar\Domain\CalendarVersion;
use App\Modules\Calendar\Domain\CalendarVersionCatalog;
use App\Modules\Calendar\Domain\ShamsiMonth;
use App\Modules\Calendar\Domain\ShamsiYear;
use App\Modules\Calendar\Domain\SolarHijriDate;
use App\Support\EffectiveDating\EffectivePeriod;
use App\Support\Errors\BusinessRejection;
use App\Support\Errors\SystemFailure;
use App\Support\Errors\ValidationError;
use Carbon\CarbonImmutable;

/**
 * The single authoritative Calendar Authority (WP-2 F4-B option C - hybrid).
 *
 * Authority precedence (enforced by construction):
 *   1. Ratified reference series  -> every year boundary / Nowruz / leap comes
 *      from a CalendarVersion anchor row; never from an arithmetic formula.
 *   2. Deterministic stepper      -> within a served year the month/day stepper
 *      computes civil dates between the two pinned Nowruz anchors.
 *   3. Generic Jalali/Persian/ICU -> never used; never an authority.
 *
 * Storage and all range arithmetic are canonical Gregorian (G2); Solar Hijri is
 * derived only through this authority. Kabul AFT (UTC+04:30) is the civil
 * reference clock for instants; the server local timezone is never used and an
 * implicit Tehran timezone is never assumed. Fail-closed: any date/year the
 * ratified series does not cover is rejected (never extrapolated).
 */
final class CalendarAuthority
{
    /** D1-declared supported deterministic range. */
    public const SH_SUPPORTED_MIN = 1336;

    public const SH_SUPPORTED_MAX = 1425;

    /** Ratified Kabul civil reference clock (D2). */
    public const KABUL_AFT_UTC_OFFSET_MINUTES = 270;

    public const DEFAULT_VERSION_ID = CalendarVersionCatalog::DEFAULT_VERSION_ID;

    public function __construct(
        private readonly ?CalendarVersionCatalog $catalog = null,
        private readonly ?\Closure $nowUtc = null,
    ) {}

    private function catalog(): CalendarVersionCatalog
    {
        return $this->catalog ?? new CalendarVersionCatalog;
    }

    private function nowUtcInstant(): CarbonImmutable
    {
        return $this->nowUtc !== null
            ? call_user_func($this->nowUtc)
            : CarbonImmutable::now('UTC');
    }

    /** Resolve a calendar version by id; defaults to the active (version-1). */
    public function version(?string $versionId = null): CalendarVersion
    {
        return $this->catalog()->forVersion($versionId ?? self::DEFAULT_VERSION_ID);
    }

    /** Normalise any Carbon to its civil date as a UTC-midnight Gregorian date. */
    public function civilDate(CarbonImmutable $any): CarbonImmutable
    {
        return CarbonImmutable::createMidnightDate(
            (int) $any->format('Y'),
            (int) $any->format('n'),
            (int) $any->format('j'),
            'UTC',
        );
    }

    public function forward(CarbonImmutable $gregorian, ?string $versionId = null): SolarHijriDate
    {
        $version = $this->version($versionId);
        $day = $this->civilDate($gregorian);

        if (! $version->containsCivilDay($day)) {
            $this->failUnsupportedCivilDay($day, $version);
        }

        $year = $version->yearForNowruz($day);
        $offset = (int) $version->nowruzForYear($year)->diffInDays($day);
        $leap = $version->isLeap($year);

        $remaining = $offset;
        for ($month = 1; $month <= 12; $month++) {
            $length = SolarHijriDate::monthLength($month, $leap);
            if ($remaining < $length) {
                return new SolarHijriDate($year, $month, $remaining + 1);
            }
            $remaining -= $length;
        }

        throw SystemFailure::forCode('calendar.forward_impossible', 'civil day could not be placed in a Solar Hijri month');
    }

    public function forwardFromString(string $ymd, ?string $versionId = null): SolarHijriDate
    {
        return $this->forward(CarbonImmutable::parse($ymd, 'UTC'), $versionId);
    }

    public function reverse(SolarHijriDate $date, ?string $versionId = null): CarbonImmutable
    {
        $version = $this->version($versionId);
        $this->assertServedYear($date->year, $version);

        $leap = $version->isLeap($date->year);
        $length = SolarHijriDate::monthLength($date->month, $leap);
        if ($date->day > $length) {
            throw ValidationError::forCode(
                'calendar.invalid_day',
                sprintf('day %d is not valid for Solar Hijri %04d-%02d (month has %d days)', $date->day, $date->year, $date->month, $length),
            );
        }

        $daysBefore = SolarHijriDate::daysBeforeMonth($date->month, $leap);
        $start = $version->nowruzForYear($date->year);

        return $start->addDays($daysBefore + $date->day - 1)->startOfDay();
    }

    public function reverseToString(SolarHijriDate $date, ?string $versionId = null): string
    {
        return $this->reverse($date, $versionId)->toDateString();
    }

    public function validateSolarHijri(SolarHijriDate $date, ?string $versionId = null): void
    {
        $version = $this->version($versionId);
        $this->assertServedYear($date->year, $version);

        $length = SolarHijriDate::monthLength($date->month, $version->isLeap($date->year));
        if ($date->day > $length) {
            throw ValidationError::forCode(
                'calendar.invalid_day',
                sprintf('day %d is not valid for Solar Hijri %04d-%02d (month has %d days)', $date->day, $date->year, $date->month, $length),
            );
        }
    }

    public function yearInfo(int $year, ?string $versionId = null): ShamsiYear
    {
        $version = $this->version($versionId);
        $this->assertServedYear($year, $version);

        return new ShamsiYear(
            $year,
            $version->nowruzForYear($year),
            $version->nowruzForYear($year + 1),
            $version->isLeap($year),
        );
    }

    public function monthInfo(int $year, int $month, ?string $versionId = null): ShamsiMonth
    {
        $version = $this->version($versionId);
        $this->assertServedYear($year, $version);

        if ($month < 1 || $month > 12) {
            throw ValidationError::forCode('calendar.invalid_month', sprintf('Solar Hijri month must be 1-12, got %d', $month));
        }

        $leap = $version->isLeap($year);
        $firstGregorian = $version->nowruzForYear($year)->addDays(SolarHijriDate::daysBeforeMonth($month, $leap));

        return new ShamsiMonth(
            $year,
            $month,
            SolarHijriDate::MONTH_NAMES[$month - 1],
            SolarHijriDate::monthLength($month, $leap),
            $firstGregorian,
        );
    }

    public function yearBoundaries(int $year, ?string $versionId = null): EffectivePeriod
    {
        $version = $this->version($versionId);
        $this->assertServedYear($year, $version);

        return EffectivePeriod::closed($version->nowruzForYear($year), $version->nowruzForYear($year + 1));
    }

    public function monthBoundaries(int $year, int $month, ?string $versionId = null): EffectivePeriod
    {
        $monthInfo = $this->monthInfo($year, $month, $versionId);

        return EffectivePeriod::closed($monthInfo->firstDayGregorian, $monthInfo->firstDayGregorian->addDays($monthInfo->length));
    }

    /** Canonical (Gregorian) date arithmetic; must remain inside the served interval. */
    public function addDays(CarbonImmutable $from, int $days, ?string $versionId = null): CarbonImmutable
    {
        $version = $this->version($versionId);
        $start = $this->civilDate($from);
        $result = $start->addDays($days);

        if (! $version->containsCivilDay($result)) {
            $this->failUnsupportedCivilDay($result, $version);
        }

        return $result;
    }

    public function compareGregorian(CarbonImmutable $a, CarbonImmutable $b): int
    {
        $a = $this->civilDate($a);
        $b = $this->civilDate($b);

        if ($a->lessThan($b)) {
            return -1;
        }

        return $a->greaterThan($b) ? 1 : 0;
    }

    public function compareSolarHijri(SolarHijriDate $a, SolarHijriDate $b): int
    {
        if ($a->year !== $b->year) {
            return $a->year < $b->year ? -1 : 1;
        }
        if ($a->month !== $b->month) {
            return $a->month < $b->month ? -1 : 1;
        }

        return $a->day <=> $b->day;
    }

    /** "Today" as the authoritative SH date, resolved on the Kabul civil clock. */
    public function currentBusinessDate(?string $versionId = null): SolarHijriDate
    {
        $instant = $this->nowUtcInstant();

        return $this->forward($this->gregorianCivilDayFromInstant($instant), $versionId);
    }

    /**
     * Map an instant to the Kabul-civil (AFT = UTC+04:30) calendar day. This is
     * the only place an instant becomes a business civil day; the server local
     * timezone is never used.
     */
    public function gregorianCivilDayFromInstant(CarbonImmutable $instant): CarbonImmutable
    {
        $kabul = $instant->utc()->addMinutes(self::KABUL_AFT_UTC_OFFSET_MINUTES);

        return $this->civilDate($kabul);
    }

    /** @return array{0: int, 1: int} D1-declared supported range [min, max]. */
    public function supportedShYearRange(): array
    {
        return [self::SH_SUPPORTED_MIN, self::SH_SUPPORTED_MAX];
    }

    /** @return array{0: int, 1: int} years fully served by the ratified version-1 anchors. */
    public function servedShYearRange(?string $versionId = null): array
    {
        return $this->version($versionId)->servedYearRange();
    }

    public function isSupportedShYear(int $year): bool
    {
        return $year >= self::SH_SUPPORTED_MIN && $year <= self::SH_SUPPORTED_MAX;
    }

    public function isServedShYear(int $year, ?string $versionId = null): bool
    {
        return $this->version($versionId)->isServedYear($year);
    }

    public function isGregorianDateServed(string $ymd, ?string $versionId = null): bool
    {
        return $this->version($versionId)->containsCivilDay($this->civilDate(CarbonImmutable::parse($ymd, 'UTC')));
    }

    public function isLeapYear(int $year, ?string $versionId = null): bool
    {
        return $this->yearInfo($year, $versionId)->leap;
    }

    private function assertServedYear(int $year, CalendarVersion $version): void
    {
        if (! $this->isSupportedShYear($year)) {
            throw BusinessRejection::forCode(
                'calendar.out_of_supported_range',
                sprintf('Solar Hijri year %d is outside the supported range %d-%d', $year, self::SH_SUPPORTED_MIN, self::SH_SUPPORTED_MAX),
            );
        }

        if (! $version->isServedYear($year)) {
            throw BusinessRejection::forCode(
                'calendar.year_not_ratified',
                sprintf('Solar Hijri year %d is within the supported range but has no ratified version anchor (do not extrapolate)', $year),
            );
        }
    }

    private function failUnsupportedCivilDay(CarbonImmutable $day, CalendarVersion $version): never
    {
        $approxYear = $this->approximateShYear($day);

        if (! $this->isSupportedShYear($approxYear)) {
            throw BusinessRejection::forCode(
                'calendar.out_of_supported_range',
                sprintf('Gregorian civil day %s maps outside the supported Solar Hijri range %d-%d', $day->toDateString(), self::SH_SUPPORTED_MIN, self::SH_SUPPORTED_MAX),
            );
        }

        throw BusinessRejection::forCode(
            'calendar.year_not_ratified',
            sprintf('Gregorian civil day %s maps to Solar Hijri year %d which has no ratified version anchor (do not extrapolate)', $day->toDateString(), $approxYear),
        );
    }

    /**
     * Coarse SH year of a Gregorian civil date, used ONLY to classify an
     * out-of-served date as out-of-supported-range vs not-ratified. Nowruz is
     * always ~20/21 March, so this is exact except within ~1 day of Nowruz, which
     * never affects the coarse supported/not-ratified classification.
     */
    private function approximateShYear(CarbonImmutable $day): int
    {
        $afterNowruz = $day->month > 3 || ($day->month === 3 && $day->day >= 21);

        return $afterNowruz ? $day->year - 621 : $day->year - 622;
    }
}
