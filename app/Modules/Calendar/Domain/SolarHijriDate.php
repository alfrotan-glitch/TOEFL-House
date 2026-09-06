<?php

declare(strict_types=1);

namespace App\Modules\Calendar\Domain;

use App\Support\Errors\ValidationError;

/**
 * Immutable Solar Hijri civil date {year, month, day} in Afghan (Dari) month
 * order (1 Hamal ... 12 Hut). This value object enforces only structural
 * invariants (year >= 1, month 1..12, day 1..31). Whether a specific day is
 * valid for a specific year — i.e. day <= the month's real length, where Hut is
 * 30 only in leap years — is a series fact owned by the Calendar Version and is
 * checked by the Calendar Authority (never guessed here, and never derived from
 * a generic Jalali arithmetic formula).
 */
final class SolarHijriDate
{
    /** Dari month names in calendar order (index 0 => Hamal). */
    public const MONTH_NAMES = [
        'Hamal',
        'Sawr',
        'Jawza',
        'Saratan',
        'Asad',
        'Sunbula',
        'Mizan',
        'Aqrab',
        'Qaws',
        'Jadi',
        'Dalwa',
        'Hut',
    ];

    /** Fixed structure (months 1-6 = 31, 7-11 = 30). Hut (12) is 29/30. */
    private const FIXED_LENGTHS = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30];

    public function __construct(
        public readonly int $year,
        public readonly int $month,
        public readonly int $day,
    ) {
        if ($year < 1) {
            throw ValidationError::forCode('calendar.invalid_year', sprintf('Solar Hijri year must be >= 1, got %d', $year));
        }

        if ($month < 1 || $month > 12) {
            throw ValidationError::forCode('calendar.invalid_month', sprintf('Solar Hijri month must be 1-12, got %d', $month));
        }

        if ($day < 1 || $day > 31) {
            throw ValidationError::forCode('calendar.invalid_day', sprintf('Solar Hijri day must be 1-31, got %d', $day));
        }
    }

    public static function monthLength(int $month, bool $leap): int
    {
        if ($month < 1 || $month > 12) {
            throw ValidationError::forCode('calendar.invalid_month', sprintf('Solar Hijri month must be 1-12, got %d', $month));
        }

        if ($month === 12) {
            return $leap ? 30 : 29;
        }

        return self::FIXED_LENGTHS[$month - 1];
    }

    /** Sum of the fixed lengths of months 1..(month-1) for a given leap flag. */
    public static function daysBeforeMonth(int $month, bool $leap): int
    {
        if ($month < 1 || $month > 12) {
            throw ValidationError::forCode('calendar.invalid_month', sprintf('Solar Hijri month must be 1-12, got %d', $month));
        }

        $total = 0;
        for ($m = 1; $m < $month; $m++) {
            $total += self::monthLength($m, $leap);
        }

        return $total;
    }

    public function monthName(): string
    {
        return self::MONTH_NAMES[$this->month - 1];
    }

    public function equals(self $other): bool
    {
        return $this->year === $other->year
            && $this->month === $other->month
            && $this->day === $other->day;
    }

    /** Canonical SH text representation, e.g. 1404-03-21 (year-month-day). */
    public function toCanonicalString(): string
    {
        return sprintf('%04d-%02d-%02d', $this->year, $this->month, $this->day);
    }
}
