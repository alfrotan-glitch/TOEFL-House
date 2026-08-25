<?php

declare(strict_types=1);

namespace App\Support\EffectiveDating;

use App\Support\Errors\ValidationError;
use Carbon\CarbonImmutable;

/**
 * Closed-open effective period on day granularity: [effectiveFrom, effectiveTo).
 * An open period has no end and extends indefinitely.
 */
final class EffectivePeriod
{
    private function __construct(
        public readonly CarbonImmutable $effectiveFrom,
        public readonly ?CarbonImmutable $effectiveTo,
    ) {}

    public static function open(CarbonImmutable $effectiveFrom): self
    {
        return new self($effectiveFrom, null);
    }

    public static function closed(CarbonImmutable $effectiveFrom, CarbonImmutable $effectiveTo): self
    {
        if ($effectiveTo->startOfDay()->lessThan($effectiveFrom->startOfDay())) {
            throw ValidationError::forCode('effective_period.inverted', 'effective end precedes effective start');
        }

        return new self($effectiveFrom->startOfDay(), $effectiveTo->startOfDay());
    }

    public function isOpen(): bool
    {
        return $this->effectiveTo === null;
    }

    public function contains(CarbonImmutable $day): bool
    {
        $day = $day->startOfDay();

        return $day->greaterThanOrEqualTo($this->effectiveFrom)
            && ($this->effectiveTo === null || $day->lessThan($this->effectiveTo));
    }

    /** Period ended strictly before the given day keeps history gapless. */
    public function endsBefore(CarbonImmutable $day): bool
    {
        return $this->effectiveTo !== null && $this->effectiveTo->lessThan($day->startOfDay());
    }

    public function endsAfter(CarbonImmutable $day): bool
    {
        return $this->effectiveTo !== null && $this->effectiveTo->greaterThan($day->startOfDay());
    }

    public function dayBeforeEnd(): CarbonImmutable
    {
        if ($this->effectiveTo === null) {
            throw ValidationError::forCode('effective_period.open', 'open period has no day before end');
        }

        return $this->effectiveTo->subDay();
    }
}
