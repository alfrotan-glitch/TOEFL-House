<?php

declare(strict_types=1);

namespace App\Modules\Governance;

use App\Modules\Governance\Domain\GovernedConfigType;
use App\Modules\Governance\Models\GovernedConfig;
use App\Modules\Governance\Models\GovernedConfigDefinition;
use App\Support\Errors\BusinessRejection;
use Carbon\CarbonImmutable;

/**
 * Read-side resolver of governed configuration (WP-2 S1). Reads are broader
 * than writes: resolving the current value is a pure, deterministic query that
 * any authorized operation may perform; it never carries write authority and
 * never triggers a change. Resolution is FAIL-CLOSED — a governed
 * configuration that is absent, has no version effective on the requested
 * day, holds an invalid stored value, or (defensively) could be ambiguous
 * always rejects; it never falls back to defaults, stale values, environment
 * variables, or unrelated constants.
 */
final class GovernedConfigRegistry
{
    /**
     * The single authoritative version governing the key on the given day.
     */
    public function effective(string $configKey, CarbonImmutable $day): GovernedConfig
    {
        if (! GovernedConfigDefinition::query()->where('config_key', $configKey)->exists()) {
            throw BusinessRejection::forCode('governance.config_undefined', sprintf('governed configuration "%s" is not defined', $configKey));
        }

        $day = $day->startOfDay();

        /** @var list<GovernedConfig> $covering */
        $covering = GovernedConfig::query()
            ->where('config_key', $configKey)
            ->where('effective_from', '<=', $day->toDateString())
            ->where(function ($query) use ($day): void {
                $query->whereNull('effective_to')->orWhere('effective_to', '>', $day->toDateString());
            })
            ->orderBy('effective_from')
            ->orderBy('version_no')
            ->get()
            ->all();

        if ($covering === []) {
            throw BusinessRejection::forCode('governance.no_effective_version', sprintf('governed configuration "%s" has no version effective on %s', $configKey, $day->toDateString()));
        }

        if (count($covering) > 1) {
            // Defensive: the DB exclusion constraint makes overlap impossible,
            // but if it ever became ambiguous we must fail closed, not guess.
            throw BusinessRejection::forCode('governance.ambiguous_authority', sprintf('governed configuration "%s" is ambiguous on %s', $configKey, $day->toDateString()));
        }

        // Validate the stored typed value against its declared type. DB
        // triggers already guarantee this, but re-check so an authoritative
        // value is never handed out untyped/unvalidated.
        $version = $covering[0];
        try {
            GovernedConfigType::assertValue($version->config_type, $version->typedValue());
        } catch (\Throwable $e) {
            throw BusinessRejection::forCode('governance.invalid_stored_value', sprintf('stored governed configuration "%s" is invalid for its type', $configKey));
        }

        return $version;
    }

    /** The current OPEN (active) version of a key, when one exists. */
    public function currentOpen(string $configKey): ?GovernedConfig
    {
        /** @var GovernedConfig|null $open */
        $open = GovernedConfig::query()
            ->where('config_key', $configKey)
            ->where('lifecycle_state', GovernedConfig::STATE_ACTIVE)
            ->first();

        return $open;
    }
}
