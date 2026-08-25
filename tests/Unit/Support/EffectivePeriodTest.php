<?php

declare(strict_types=1);

namespace Tests\Unit\Support;

use App\Support\EffectiveDating\EffectivePeriod;
use App\Support\Errors\ValidationError;
use Carbon\CarbonImmutable;
use PHPUnit\Framework\TestCase;

final class EffectivePeriodTest extends TestCase
{
    public function test_open_period_contains_every_later_day(): void
    {
        $period = EffectivePeriod::open(new CarbonImmutable('2026-01-01'));

        $this->assertTrue($period->isOpen());
        $this->assertTrue($period->contains(new CarbonImmutable('2026-08-25')));
        $this->assertFalse($period->contains(new CarbonImmutable('2025-12-31')));
    }

    public function test_closed_period_excludes_its_end_date(): void
    {
        $period = EffectivePeriod::closed(new CarbonImmutable('2026-01-01'), new CarbonImmutable('2026-06-01'));

        $this->assertFalse($period->isOpen());
        $this->assertTrue($period->contains(new CarbonImmutable('2026-05-31')));
        $this->assertFalse($period->contains(new CarbonImmutable('2026-06-01')));
    }

    public function test_inverted_period_is_rejected(): void
    {
        $this->expectException(ValidationError::class);

        EffectivePeriod::closed(new CarbonImmutable('2026-06-01'), new CarbonImmutable('2026-01-01'));
    }

    public function test_day_before_end_resolves_the_last_effective_day(): void
    {
        $period = EffectivePeriod::closed(new CarbonImmutable('2026-01-01'), new CarbonImmutable('2026-06-01'));

        $this->assertSame('2026-05-31', $period->dayBeforeEnd()->toDateString());
    }
}
