<?php

declare(strict_types=1);

namespace Tests\Unit\Calendar;

use App\Modules\Calendar\CalendarAuthority;
use App\Modules\Calendar\Domain\SolarHijriDate;
use App\Support\EffectiveDating\EffectivePeriod;
use App\Support\Errors\BusinessRejection;
use App\Support\Errors\ValidationError;
use Carbon\CarbonImmutable;
use PHPUnit\Framework\TestCase;

final class CalendarAuthorityTest extends TestCase
{
    private CalendarAuthority $authority;

    protected function setUp(): void
    {
        $this->authority = new CalendarAuthority;
    }

    // -------- ratified reference-vector conformance (F4-A.3 T01-T13) --------

    public function test_ratified_nowruz_year_starts_t01_t13(): void
    {
        $vectors = [
            ['2020-03-20', 1399, 1, 1],
            ['2021-03-21', 1400, 1, 1],
            ['2024-03-20', 1403, 1, 1],
            ['2025-03-21', 1404, 1, 1],
            ['2026-03-21', 1405, 1, 1],
            ['2027-03-21', 1406, 1, 1],
            ['2028-03-20', 1407, 1, 1],
            ['2029-03-21', 1408, 1, 1],
            ['2030-03-21', 1409, 1, 1],
        ];

        foreach ($vectors as [$ymd, $year, $month, $day]) {
            $sh = $this->authority->forwardFromString($ymd);
            $this->assertSame([$year, $month, $day], [$sh->year, $sh->month, $sh->day], "forward $ymd");
            $this->assertSame($ymd, $this->authority->reverseToString(new SolarHijriDate($year, $month, $day)), "reverse $year-$month-$day");
        }
    }

    public function test_leap_year_hut_boundaries(): void
    {
        // 1399 is leap (Hut 30); its final day is 2021-03-20 = 30 Hut 1399.
        // This reconciles F4-A.3 §7 T03, corrected (F4-C) from the
        // self-inconsistent "29 Hut 1399" to "30 Hut 1399" (a 29-day Hut would
        // make 1399 common, contradicting the ratified leap series).
        $this->assertTrue($this->authority->isLeapYear(1399));
        $this->assertSame('2021-03-20', $this->authority->reverseToString(new SolarHijriDate(1399, 12, 30)));
        $this->assertSame('2021-03-19', $this->authority->reverseToString(new SolarHijriDate(1399, 12, 29)));

        $this->assertTrue($this->authority->isLeapYear(1403));
        $this->assertSame('2025-03-20', $this->authority->reverseToString(new SolarHijriDate(1403, 12, 30)));
        $sh = $this->authority->forwardFromString('2025-03-20');
        $this->assertSame([1403, 12, 30], [$sh->year, $sh->month, $sh->day]);
    }

    public function test_ordinary_drift_vectors_t09_t15(): void
    {
        $sh = $this->authority->forwardFromString('2026-09-02'); // 11 Sunbula 1405
        $this->assertSame([1405, 6, 11], [$sh->year, $sh->month, $sh->day]);
        $this->assertSame('2026-09-02', $this->authority->reverseToString(new SolarHijriDate(1405, 6, 11)));

        $sh = $this->authority->forwardFromString('2026-01-01'); // 11 Jadi 1404
        $this->assertSame([1404, 10, 11], [$sh->year, $sh->month, $sh->day]);
    }

    public function test_reporting_year_membership_edges_t16(): void
    {
        $this->assertSame(1404, $this->authority->forwardFromString('2026-01-01')->year);
        $this->assertSame(1405, $this->authority->forwardFromString('2026-12-31')->year);
    }

    // -------- round-trip --------

    public function test_round_trip_across_boundaries(): void
    {
        $dates = [
            '2020-03-20', '2020-12-31', '2021-03-19', '2021-03-20', '2021-03-21',
            '2024-03-19', '2024-03-20', '2025-03-20', '2025-03-21', '2025-12-31',
            '2026-01-01', '2026-09-03', '2028-02-29', '2028-12-31', '2029-03-20',
            '2029-03-21', '2031-06-30', '2033-12-31', '2034-03-21', '2035-03-20',
            '2035-03-21', '2035-12-31', '2036-03-20', '2036-12-31', '2037-03-19',
        ];

        foreach ($dates as $ymd) {
            $sh = $this->authority->forwardFromString($ymd);
            $this->assertSame($ymd, $this->authority->reverseToString($sh), "round-trip $ymd");
        }
    }

    // -------- month boundaries / year info --------

    public function test_month_first_days_1404(): void
    {
        $expected = [
            1 => '2025-03-21', 2 => '2025-04-21', 3 => '2025-05-22', 4 => '2025-06-22',
            5 => '2025-07-23', 6 => '2025-08-23', 7 => '2025-09-23', 8 => '2025-10-23',
            9 => '2025-11-22', 10 => '2025-12-22', 11 => '2026-01-21', 12 => '2026-02-20',
        ];
        foreach ($expected as $month => $firstYmd) {
            $this->assertSame($firstYmd, $this->authority->monthInfo(1404, $month)->firstDayGregorian->toDateString(), "1404-$month first");
            $this->assertSame($firstYmd, $this->authority->reverseToString(new SolarHijriDate(1404, $month, 1)), "1404-$month reverse");
        }
    }

    public function test_month_lengths_1404_common_and_invalid_day(): void
    {
        $lens = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];
        foreach ($lens as $i => $len) {
            $month = $i + 1;
            $mi = $this->authority->monthInfo(1404, $month);
            $this->assertSame($len, $mi->length, "1404 month $month length");
            $this->assertSame($mi->firstDayGregorian->addDays($len - 1)->toDateString(), $mi->lastDayGregorian()->toDateString());
        }
        $this->assertRejection('calendar.invalid_day', fn (): mixed => $this->authority->reverse(new SolarHijriDate(1404, 12, 30)));
    }

    public function test_year_boundaries(): void
    {
        $p = $this->authority->yearBoundaries(1404);
        $this->assertInstanceOf(EffectivePeriod::class, $p);
        $this->assertSame('2025-03-21', $p->effectiveFrom->toDateString());
        $this->assertSame('2026-03-21', $p->effectiveTo?->toDateString());
    }

    // -------- 20/21 March transitions and 1408 Kabul divergence --------

    public function test_1408_kabul_divergence_is_encoded(): void
    {
        // Kabul branch (D2): 1407 is leap (Hut 30). 2029-03-20 = 30 Hut 1407 and
        // 2029-03-21 = 1 Hamal 1408. A Tehran/arithmetic calendar would make
        // 2029-03-20 = 1 Hamal 1408 (1407 common). This test proves we follow the
        // ratified Kabul series, never a generic Jalali implementation.
        $this->assertTrue($this->authority->isLeapYear(1407));
        $sh = $this->authority->forwardFromString('2029-03-20');
        $this->assertSame([1407, 12, 30], [$sh->year, $sh->month, $sh->day]);
        $this->assertSame('2029-03-20', $this->authority->reverseToString(new SolarHijriDate(1407, 12, 30)));

        $n = $this->authority->forwardFromString('2029-03-21');
        $this->assertSame([1408, 1, 1], [$n->year, $n->month, $n->day]);
        $this->assertFalse($this->authority->isLeapYear(1408));
    }

    public function test_20_21_march_transitions(): void
    {
        // 1404 Nowruz = 2025-03-21; 1405 Nowruz = 2026-03-21.
        $a = $this->authority->forwardFromString('2025-03-21');
        $this->assertSame([1404, 1, 1], [$a->year, $a->month, $a->day]);
        $b = $this->authority->forwardFromString('2026-03-21');
        $this->assertSame([1405, 1, 1], [$b->year, $b->month, $b->day]);
    }

    public function test_active_window_nowruz_starts_1409_1415(): void
    {
        // The ratified active operational window (D1) is SH 1399-1415. F4-A.3
        // §4.2 ratifies Nowruz 1399-1414 plus 1 Hamal 1415 = 2036-03-20; the
        // owner ratification of 2026-09-04 formally incorporates
        // 1 Hamal 1416 = 2037-03-20 as a version-1 anchor. This asserts the
        // remaining Nowruz chain and the final two window boundaries.
        $vectors = [
            ['2030-03-21', 1409, 1, 1],
            ['2031-03-21', 1410, 1, 1],
            ['2032-03-20', 1411, 1, 1],
            ['2033-03-20', 1412, 1, 1],
            ['2034-03-21', 1413, 1, 1],
            ['2035-03-21', 1414, 1, 1],
            ['2036-03-20', 1415, 1, 1],
        ];
        foreach ($vectors as [$ymd, $year, $month, $day]) {
            $sh = $this->authority->forwardFromString($ymd);
            $this->assertSame([$year, $month, $day], [$sh->year, $sh->month, $sh->day], "forward $ymd");
            $this->assertSame($ymd, $this->authority->reverseToString(new SolarHijriDate($year, $month, $day)), "reverse $year-$month-$day");
        }

        // 1414 common (Hut 29): 2036-03-19 = 29 Hut 1414, 2036-03-20 = 1 Hamal 1415.
        $this->assertFalse($this->authority->isLeapYear(1414));
        $this->assertSame('2036-03-19', $this->authority->reverseToString(new SolarHijriDate(1414, 12, 29)));
        $this->assertSame('2036-03-20', $this->authority->reverseToString(new SolarHijriDate(1415, 1, 1)));
        // 1415 common (Hut 29): 2037-03-19 = 29 Hut 1415; 2037-03-20 = 1 Hamal 1416
        // is the exclusive end of the served interval (not served).
        $this->assertFalse($this->authority->isLeapYear(1415));
        $this->assertSame('2037-03-19', $this->authority->reverseToString(new SolarHijriDate(1415, 12, 29)));
        $sh = $this->authority->forwardFromString('2037-03-19');
        $this->assertSame([1415, 12, 29], [$sh->year, $sh->month, $sh->day]);
    }

    // -------- range metadata / fail closed --------

    public function test_range_and_served_metadata(): void
    {
        $this->assertSame([1336, 1425], $this->authority->supportedShYearRange());
        $this->assertSame([1399, 1415], $this->authority->servedShYearRange());
        $this->assertTrue($this->authority->isSupportedShYear(1336));
        $this->assertTrue($this->authority->isSupportedShYear(1425));
        $this->assertFalse($this->authority->isSupportedShYear(1335));
        $this->assertFalse($this->authority->isSupportedShYear(1426));
        $this->assertTrue($this->authority->isServedShYear(1399));
        $this->assertTrue($this->authority->isServedShYear(1415));
        $this->assertFalse($this->authority->isServedShYear(1398));
        $this->assertFalse($this->authority->isServedShYear(1416));
        $this->assertTrue($this->authority->isGregorianDateServed('2020-03-20'));
        $this->assertTrue($this->authority->isGregorianDateServed('2037-03-19'));
        $this->assertFalse($this->authority->isGregorianDateServed('2037-03-20'));
    }

    public function test_out_of_supported_range_fails_closed(): void
    {
        $this->assertRejection('calendar.out_of_supported_range', fn (): mixed => $this->authority->reverse(new SolarHijriDate(1335, 1, 1)));
        $this->assertRejection('calendar.out_of_supported_range', fn (): mixed => $this->authority->reverse(new SolarHijriDate(1426, 1, 1)));
        $this->assertRejection('calendar.out_of_supported_range', fn (): mixed => $this->authority->forwardFromString('1950-06-01'));
    }

    public function test_declared_but_unratified_years_do_not_extrapolate(): void
    {
        // Within the D1-declared supported range SH 1336-1425 but outside the
        // ratified/serviceable active window 1399-1415, the authority must fail
        // closed rather than extrapolate. 1416 is the ratified boundary Nowruz
        // but its year (and the rest of the tail) is not served.
        $this->assertRejection('calendar.year_not_ratified', fn (): mixed => $this->authority->reverse(new SolarHijriDate(1398, 1, 1)));
        $this->assertRejection('calendar.year_not_ratified', fn (): mixed => $this->authority->reverse(new SolarHijriDate(1416, 1, 1)));
        $this->assertRejection('calendar.year_not_ratified', fn (): mixed => $this->authority->reverse(new SolarHijriDate(1417, 1, 1)));
        $this->assertRejection('calendar.year_not_ratified', fn (): mixed => $this->authority->reverse(new SolarHijriDate(1425, 1, 1)));
        $this->assertRejection('calendar.year_not_ratified', fn (): mixed => $this->authority->forwardFromString('2037-06-01'));
        $this->assertRejection('calendar.year_not_ratified', fn (): mixed => $this->authority->forwardFromString('2019-06-01'));
    }

    public function test_add_days_canonical_arithmetic_and_range_guard(): void
    {
        $from = CarbonImmutable::parse('2025-03-21', 'UTC');
        $this->assertSame('2025-03-22', $this->authority->addDays($from, 1)->toDateString());
        $this->assertSame('2025-12-31', $this->authority->addDays($from, 285)->toDateString());
        // Stepping from the last served day (2037-03-19) by 1 lands on
        // 2037-03-20 = 1 Hamal 1416 (the ratified boundary Nowruz), whose year is
        // not served without a ratified N(1417) -> not extrapolated.
        $this->assertRejection('calendar.year_not_ratified', fn (): mixed => $this->authority->addDays(CarbonImmutable::parse('2037-03-19', 'UTC'), 1));
        // Stepping far beyond the supported range fails as out-of-range.
        $this->assertRejection('calendar.out_of_supported_range', fn (): mixed => $this->authority->addDays($from, 99999));
    }

    // -------- invalid Solar Hijri dates --------

    public function test_structural_invalid_dates_rejected_by_value_object(): void
    {
        $this->expectException(ValidationError::class);
        $this->expectExceptionMessage('month');
        new SolarHijriDate(1404, 0, 1);

        $this->expectException(ValidationError::class);
        $this->expectExceptionMessage('month');
        new SolarHijriDate(1404, 13, 1);

        $this->expectException(ValidationError::class);
        $this->expectExceptionMessage('day');
        new SolarHijriDate(1404, 1, 0);
    }

    public function test_day_exceeding_real_month_length_rejected(): void
    {
        // 1404 common: Hut has 29 days; 30 Hut invalid.
        $this->assertRejection('calendar.invalid_day', fn (): mixed => $this->authority->validateSolarHijri(new SolarHijriDate(1404, 12, 30)));
        $this->assertRejection('calendar.invalid_day', fn (): mixed => $this->authority->reverse(new SolarHijriDate(1404, 12, 30)));
        // Month 7 (Mizan) has 30 days; day 31 invalid.
        $this->assertRejection('calendar.invalid_day', fn (): mixed => $this->authority->validateSolarHijri(new SolarHijriDate(1404, 7, 31)));
    }

    // -------- Kabul civil clock / current business date / timezone --------

    public function test_kabul_civil_day_from_instant_ignores_server_timezone(): void
    {
        // 2025-03-20 20:30 UTC = Kabul 2025-03-21 01:00 -> Kabul civil day 2025-03-21.
        $this->assertSame('2025-03-21', $this->authority->gregorianCivilDayFromInstant(CarbonImmutable::parse('2025-03-20 20:30:00', 'UTC'))->toDateString());
        // Same instant carried with an explicit non-UTC timezone is equivalent.
        $alt = CarbonImmutable::parse('2025-03-20 20:30:00', 'UTC')->setTimezone('Asia/Kabul');
        $this->assertSame('2025-03-21', $this->authority->gregorianCivilDayFromInstant($alt)->toDateString());
    }

    public function test_current_business_date_resolves_on_kabul_civil_day(): void
    {
        // Fixed "now": 2026-09-03 07:30 UTC = Kabul 2026-09-03 12:00 (civil day 2026-09-03).
        $authority = new CalendarAuthority(null, static fn (): CarbonImmutable => CarbonImmutable::parse('2026-09-03 07:30:00', 'UTC'));
        $this->assertSame('2026-09-03', $authority->gregorianCivilDayFromInstant(CarbonImmutable::parse('2026-09-03 07:30:00', 'UTC'))->toDateString());
        $today = $authority->currentBusinessDate();
        // 2026-09-03 = 12 Sunbula 1405 (F4-A.3-validated).
        $this->assertSame([1405, 6, 12], [$today->year, $today->month, $today->day]);
    }

    // -------- historical reproducibility / versioning --------

    public function test_historical_reproducibility_with_explicit_version(): void
    {
        $sh = $this->authority->forwardFromString('2029-03-21');
        $explicit = $this->authority->forward(CarbonImmutable::parse('2029-03-21', 'UTC'), 'v1');
        $this->assertTrue($sh->equals($explicit));
        $this->assertSame('v1', $this->authority->version()->id);
        $this->assertSame('v1', $this->authority->version('v1')->id);
        $this->assertRejection('calendar.unknown_version', fn (): mixed => $this->authority->version('v99'));
    }

    // -------- comparisons --------

    public function test_compare_operations(): void
    {
        $this->assertSame(-1, $this->authority->compareSolarHijri(new SolarHijriDate(1404, 1, 1), new SolarHijriDate(1405, 1, 1)));
        $this->assertSame(0, $this->authority->compareSolarHijri(new SolarHijriDate(1404, 3, 15), new SolarHijriDate(1404, 3, 15)));
        $this->assertSame(1, $this->authority->compareSolarHijri(new SolarHijriDate(1404, 3, 16), new SolarHijriDate(1404, 3, 15)));
        $this->assertSame(-1, $this->authority->compareGregorian(CarbonImmutable::parse('2025-03-20', 'UTC'), CarbonImmutable::parse('2025-03-21', 'UTC')));
        $this->assertSame(0, $this->authority->compareGregorian(CarbonImmutable::parse('2025-03-21', 'UTC'), CarbonImmutable::parse('2025-03-21', 'UTC')));
    }

    // -------- helpers --------

    /**
     * @param  callable(): mixed  $callable
     */
    private function assertRejection(string $code, callable $callable): void
    {
        try {
            $callable();
            $this->fail('Expected a rejection but none was thrown.');
        } catch (BusinessRejection|ValidationError $e) {
            $this->assertSame($code, $e->errorCode());
        }
    }
}
