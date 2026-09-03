<?php

declare(strict_types=1);

namespace App\Modules\Calendar\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Registry of immutable ratified calendar versions and the active one.
 *
 * Only the ratified version-1 exists in this phase. The catalog supports
 * historical resolution by explicit version id so that past (canonical date,
 * version) pairs always reproduce the same Solar Hijri result. A new calendar
 * version is introduced by ratifying a new immutable series and adding it here
 * (append-only) — version-1 semantics are never silently replaced; selecting an
 * unknown version fails closed.
 */
final class CalendarVersionCatalog
{
    public const DEFAULT_VERSION_ID = 'v1';

    /** @var array<string, CalendarVersion> */
    private array $versions = [];

    private string $activeId = self::DEFAULT_VERSION_ID;

    public function __construct()
    {
        $this->register(Version1Series::version());
    }

    public function register(CalendarVersion $version): void
    {
        if (isset($this->versions[$version->id])) {
            throw BusinessRejection::forCode('calendar.version_already_registered', sprintf('calendar version "%s" is already registered', $version->id));
        }

        $this->versions[$version->id] = $version;
    }

    public function active(): CalendarVersion
    {
        return $this->forVersion($this->activeId);
    }

    public function activeId(): string
    {
        return $this->activeId;
    }

    public function has(string $id): bool
    {
        return isset($this->versions[$id]);
    }

    public function forVersion(string $id): CalendarVersion
    {
        if (! isset($this->versions[$id])) {
            throw BusinessRejection::forCode('calendar.unknown_version', sprintf('calendar version "%s" is not registered', $id));
        }

        return $this->versions[$id];
    }
}
