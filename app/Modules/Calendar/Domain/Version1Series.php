<?php

declare(strict_types=1);

namespace App\Modules\Calendar\Domain;

/**
 * The ratified F4-A.3 version-1 reference series (D3), Kabul-civil branch (D2).
 *
 * nowruz is the Kabul-civil first day of Hamal (F4-A.3 §4.2 "Kabul reference A"
 * table). equinox_utc is the astronomical equinox instant (F4-A.3 §4.1) kept as
 * informational/audit data only — it is never used as the civil-day source.
 *
 * Version-1 anchors Solar Hijri years 1399-1415 (each year's Nowruz is ratified).
 * F4-A.3 §§4.1/4.2 tabulate accurate equinox instants and civil Nowruz days for
 * 1399-1414 and ratify 2036-03-20 as the next day after Hut 1414 (1 Hamal 1415);
 * this implementation pins that ratified 1415 anchor and its equinox instant.
 * A year is fully served only when its own and its successor's Nowruz are pinned,
 * so the served range is 1399-1414.
 *
 * Years 1336-1398 and 1415-1425 are within the D1-declared supported range but
 * are NOT fully covered by ratified version-1 anchors (F4-B §2.5 requires the
 * post-2035 tail to be pinned from an authoritative ephemeris, transformed by
 * the Kabul rule, extended into the vector set, and ratified as part of
 * version-1 before the authority may serve it); the Calendar Authority must
 * fail closed for those years and never extrapolate. Pinning 1416 (1 Hamal 1416
 * = 2037-03-20 under the Kabul noon-cutoff rule) is the implementation side of
 * that future extension, but it is intentionally NOT ratified here.
 */
final class Version1Series
{
    private const ID = 'v1';

    private const LABEL = 'Ratified F4-A.3 reference series - Kabul civil clock (AFT UTC+04:30)';

    /**
     * @return array<int, array{nowruz: string, equinox_utc: string}>
     */
    private static function anchors(): array
    {
        return [
            1399 => ['nowruz' => '2020-03-20', 'equinox_utc' => '2020-03-20 03:49'],
            1400 => ['nowruz' => '2021-03-21', 'equinox_utc' => '2021-03-20 09:37'],
            1401 => ['nowruz' => '2022-03-21', 'equinox_utc' => '2022-03-20 15:33'],
            1402 => ['nowruz' => '2023-03-21', 'equinox_utc' => '2023-03-20 21:24'],
            1403 => ['nowruz' => '2024-03-20', 'equinox_utc' => '2024-03-20 03:06'],
            1404 => ['nowruz' => '2025-03-21', 'equinox_utc' => '2025-03-20 09:01'],
            1405 => ['nowruz' => '2026-03-21', 'equinox_utc' => '2026-03-20 14:46'],
            1406 => ['nowruz' => '2027-03-21', 'equinox_utc' => '2027-03-20 20:24'],
            1407 => ['nowruz' => '2028-03-20', 'equinox_utc' => '2028-03-20 02:17'],
            1408 => ['nowruz' => '2029-03-21', 'equinox_utc' => '2029-03-20 08:02'],
            1409 => ['nowruz' => '2030-03-21', 'equinox_utc' => '2030-03-20 13:51'],
            1410 => ['nowruz' => '2031-03-21', 'equinox_utc' => '2031-03-20 19:41'],
            1411 => ['nowruz' => '2032-03-20', 'equinox_utc' => '2032-03-20 01:21'],
            1412 => ['nowruz' => '2033-03-20', 'equinox_utc' => '2033-03-20 07:22'],
            1413 => ['nowruz' => '2034-03-21', 'equinox_utc' => '2034-03-20 13:17'],
            1414 => ['nowruz' => '2035-03-21', 'equinox_utc' => '2035-03-20 19:02'],
            1415 => ['nowruz' => '2036-03-20', 'equinox_utc' => '2036-03-20 01:02'],
        ];
    }

    public static function version(): CalendarVersion
    {
        return new CalendarVersion(self::ID, self::LABEL, self::anchors());
    }
}
