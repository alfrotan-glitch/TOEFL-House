<?php

declare(strict_types=1);

namespace Tests\Unit\Reporting;

use App\Modules\Reporting\Domain\MetricCalculator;
use App\Modules\Reporting\Domain\MetricCatalog;
use App\Support\Errors\BusinessRejection;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

final class MetricCatalogTest extends TestCase
{
    public function test_catalog_matrix_declares_owner_authority_and_scopes(): void
    {
        $expected = [
            'student_outstanding_balance' => ['finance', 'financial_period', ['global', 'student']],
            'payroll_total' => ['payroll', 'payroll_period', ['global']],
            'active_enrollment_count' => ['academic_delivery', 'academic_period', ['global', 'class']],
            'attendance_rate' => ['academic', 'academic_period', ['global', 'class']],
            'fund_utilization' => ['funding', 'financial_period', ['fund']],
        ];

        $this->assertSame(array_keys($expected), MetricCatalog::keys());
        foreach ($expected as $key => [$owner, $authority, $scopes]) {
            $entry = MetricCatalog::entry($key);
            $this->assertSame($owner, $entry['owner']);
            $this->assertSame($authority, $entry['authority']);
            $this->assertSame($scopes, $entry['scopes']);
            $this->assertTrue(class_exists($entry['calculator']), sprintf('calculator for %s must exist', $key));
            $this->assertTrue(is_a($entry['calculator'], MetricCalculator::class, true));
        }
    }

    public function test_unknown_metric_keys_are_rejected(): void
    {
        try {
            MetricCatalog::entry('net_promoter_score');
            $this->fail('metrics outside the canonical catalog must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('reporting.metric_unknown', $rejection->errorCode());
        }
    }

    public function test_periods_resolve_only_under_their_own_authority(): void
    {
        DB::table('financial_periods')->insert(['id' => '11111111-1111-1111-1111-111111111111', 'period_key' => '2026-12', 'date_from' => '2026-12-01', 'date_to' => '2026-12-31', 'lifecycle_state' => 'open', 'created_at' => now(), 'updated_at' => now()]);
        DB::table('payroll_periods')->insert(['id' => '22222222-2222-2222-2222-222222222222', 'period_key' => '2026-12', 'date_from' => '2026-12-01', 'date_to' => '2026-12-31', 'lifecycle_state' => 'open', 'created_at' => now(), 'updated_at' => now()]);
        DB::table('academic_periods')->insert(['id' => '33333333-3333-3333-3333-333333333333', 'name' => 'Fall 2026', 'starts_on' => '2026-09-01', 'ends_on' => '2026-12-18', 'lifecycle_state' => 'published', 'created_at' => now(), 'updated_at' => now()]);

        // the same human key resolves per authority — reporting never redefines periods
        $this->assertSame('11111111-1111-1111-1111-111111111111', MetricCatalog::resolvePeriod('financial_period', '2026-12'));
        $this->assertSame('22222222-2222-2222-2222-222222222222', MetricCatalog::resolvePeriod('payroll_period', '2026-12'));
        // academic periods are addressed by their identifier
        $this->assertSame('33333333-3333-3333-3333-333333333333', MetricCatalog::resolvePeriod('academic_period', '33333333-3333-3333-3333-333333333333'));

        // no cross-authority leakage: the financial key is not an academic id, the academic id is not a payroll key
        foreach ([['financial_period', '33333333-3333-3333-3333-333333333333'], ['payroll_period', '11111111-1111-1111-1111-111111111111'], ['academic_period', '2026-12']] as [$authority, $key]) {
            try {
                MetricCatalog::resolvePeriod($authority, $key);
                $this->fail(sprintf('%s must not resolve %s', $authority, $key));
            } catch (BusinessRejection $rejection) {
                $this->assertSame('reporting.period_unknown', $rejection->errorCode());
            }
        }

        try {
            MetricCatalog::resolvePeriod('fiscal_quarter', '2026-12');
            $this->fail('unknown period authorities must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('reporting.period_authority_unknown', $rejection->errorCode());
        }
    }
}
