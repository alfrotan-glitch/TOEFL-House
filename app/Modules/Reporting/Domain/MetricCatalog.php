<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Domain;

use App\Modules\Reporting\Queries\ActiveEnrollmentCalculator;
use App\Modules\Reporting\Queries\AttendanceRateCalculator;
use App\Modules\Reporting\Queries\FundUtilizationCalculator;
use App\Modules\Reporting\Queries\OutstandingBalanceCalculator;
use App\Modules\Reporting\Queries\PayrollTotalCalculator;
use App\Modules\Reporting\Queries\VisitorCaptureCountCalculator;
use App\Modules\Reporting\Queries\VisitorConversionCountCalculator;
use App\Modules\Reporting\Queries\VisitorConversionRateCalculator;
use App\Support\Errors\BusinessRejection;
use Illuminate\Support\Facades\DB;

/**
 * The canonical metric catalog (derived-data lineage registry): every
 * definable metric is registered here with its source owner, period
 * authority, and allowed scopes. The catalog resolves the authoritative
 * period by key from the owning period table — Reporting never defines
 * its own periods.
 */
final class MetricCatalog
{
    /** @var array<string, array{owner: string, authority: string, scopes: list<string>, calculator: class-string<MetricCalculator>}> */
    private const METRICS = [
        'student_outstanding_balance' => [
            'owner' => 'finance', 'authority' => 'financial_period', 'scopes' => ['global', 'student'],
            'calculator' => OutstandingBalanceCalculator::class,
        ],
        'payroll_total' => [
            'owner' => 'payroll', 'authority' => 'payroll_period', 'scopes' => ['global'],
            'calculator' => PayrollTotalCalculator::class,
        ],
        'active_enrollment_count' => [
            'owner' => 'academic_delivery', 'authority' => 'academic_period', 'scopes' => ['global', 'class'],
            'calculator' => ActiveEnrollmentCalculator::class,
        ],
        'attendance_rate' => [
            'owner' => 'academic', 'authority' => 'academic_period', 'scopes' => ['global', 'class'],
            'calculator' => AttendanceRateCalculator::class,
        ],
        'fund_utilization' => [
            'owner' => 'funding', 'authority' => 'financial_period', 'scopes' => ['fund'],
            'calculator' => FundUtilizationCalculator::class,
        ],
        'visitor_capture_count' => [
            'owner' => 'crm', 'authority' => 'academic_period', 'scopes' => ['global', 'branch'],
            'calculator' => VisitorCaptureCountCalculator::class,
        ],
        'visitor_conversion_count' => [
            'owner' => 'crm', 'authority' => 'academic_period', 'scopes' => ['global', 'branch'],
            'calculator' => VisitorConversionCountCalculator::class,
        ],
        'visitor_conversion_rate' => [
            'owner' => 'crm', 'authority' => 'academic_period', 'scopes' => ['global', 'branch'],
            'calculator' => VisitorConversionRateCalculator::class,
        ],
    ];

    /** @return array{owner: string, authority: string, scopes: list<string>, calculator: class-string<MetricCalculator>} */
    public static function entry(string $metricKey): array
    {
        if (! isset(self::METRICS[$metricKey])) {
            throw BusinessRejection::forCode('reporting.metric_unknown', sprintf('metric %s is not in the canonical catalog', $metricKey));
        }

        return self::METRICS[$metricKey];
    }

    public static function exists(string $metricKey): bool
    {
        return isset(self::METRICS[$metricKey]);
    }

    /** Resolves the authoritative period id for a key under the metric's period authority. */
    public static function resolvePeriod(string $authority, string $periodKey): string
    {
        $table = match ($authority) {
            'financial_period' => 'financial_periods',
            'payroll_period' => 'payroll_periods',
            'academic_period' => 'academic_periods',
            default => null,
        };
        if ($table === null) {
            throw BusinessRejection::forCode('reporting.period_authority_unknown', sprintf('unknown period authority %s', $authority));
        }
        $column = $table === 'academic_periods' ? 'id' : 'period_key';
        $periodId = DB::table($table)->where($column, $periodKey)->value('id');
        if ($periodId === null) {
            throw BusinessRejection::forCode('reporting.period_unknown', sprintf('period %s does not exist under the %s authority', $periodKey, $authority));
        }

        return (string) $periodId;
    }

    /** @return list<string> */
    public static function keys(): array
    {
        return array_keys(self::METRICS);
    }
}
