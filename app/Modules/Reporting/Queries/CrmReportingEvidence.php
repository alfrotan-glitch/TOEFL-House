<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use Carbon\CarbonImmutable;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

/**
 * Shared Reporting adapter for CRM-owned temporal evidence.
 *
 * CRM capture is cohorted by its database INSERT fact. A conversion is
 * cohorted by the database-recorded audit event owned by Admissions/Students,
 * never by CRM's mirror-row creation timestamp. The prospective source guards
 * have explicit deployment epochs so a period that overlaps older
 * unclassified history is withheld rather than guessed from compatibility
 * timestamps.
 */
final class CrmReportingEvidence
{
    public const CAPTURE_EPOCH = 'crm_capture_time_v1';

    public const CONVERSION_EPOCH = 'crm_conversion_time_v1';

    /**
     * @param object{starts_on: string, ends_on: string} $period
     * @return array{starts_at: string, ends_exclusive_at: string}
     */
    public static function window(object $period): array
    {
        $startsAt = CarbonImmutable::parse((string) $period->starts_on, 'UTC')->startOfDay();
        $endsExclusiveAt = CarbonImmutable::parse((string) $period->ends_on, 'UTC')->addDay()->startOfDay();

        return [
            'starts_at' => $startsAt->format('Y-m-d H:i:s'),
            'ends_exclusive_at' => $endsExclusiveAt->format('Y-m-d H:i:s'),
        ];
    }

    /**
     * A full academic period can be complete only if it starts no earlier than
     * the database-recorded deployment boundary for this source fact.
     */
    public static function periodIsWhollyGuarded(string $epochKey, string $periodStartsAt): bool
    {
        $effectiveAt = DB::table('reporting_evidence_epochs')
            ->where('source_key', $epochKey)
            ->value('effective_at');
        if ($effectiveAt === null) {
            return false;
        }

        return CarbonImmutable::parse($periodStartsAt, 'UTC')
            ->greaterThanOrEqualTo(CarbonImmutable::parse((string) $effectiveAt, 'UTC'));
    }

    /** @return Builder */
    public static function capturedIn(array $window, ?string $scopeId): Builder
    {
        $query = DB::table('visitors')
            ->where('capture_time_basis', 'database_insert')
            ->whereNotNull('captured_at')
            ->where('captured_at', '>=', $window['starts_at'])
            ->where('captured_at', '<', $window['ends_exclusive_at']);
        if ($scopeId !== null) {
            $query->where('origin_branch_id', $scopeId);
        }

        return $query;
    }

    /** @return Builder */
    public static function convertedIn(array $window, ?string $scopeId): Builder
    {
        $query = DB::table('visitor_conversions')
            ->join('visitors', 'visitors.id', '=', 'visitor_conversions.visitor_id')
            ->where('visitor_conversions.conversion_time_basis', 'authority_audit_event')
            ->whereNotNull('visitor_conversions.converted_at')
            ->where('visitor_conversions.converted_at', '>=', $window['starts_at'])
            ->where('visitor_conversions.converted_at', '<', $window['ends_exclusive_at']);
        if ($scopeId !== null) {
            $query->where('visitors.origin_branch_id', $scopeId);
        }

        return $query;
    }

    /**
     * Compatibility timestamp columns are used only to surface an anomalous
     * unclassified row after the source boundary. They never add an item to a
     * metric cohort. Periods beginning before the epoch are independently
     * incomplete because old rows cannot be assigned truthfully at all.
     *
     * @return Builder
     */
    public static function unclassifiedCapturesIn(array $window, ?string $scopeId): Builder
    {
        $query = DB::table('visitors')
            ->where(function (Builder $facts): void {
                $facts->whereNull('capture_time_basis')
                    ->orWhere('capture_time_basis', '<>', 'database_insert')
                    ->orWhereNull('captured_at');
            })
            ->where('created_at', '>=', $window['starts_at'])
            ->where('created_at', '<', $window['ends_exclusive_at']);
        if ($scopeId !== null) {
            $query->where('origin_branch_id', $scopeId);
        }

        return $query;
    }

    /** @return Builder */
    public static function unclassifiedConversionsIn(array $window, ?string $scopeId): Builder
    {
        $query = DB::table('visitor_conversions')
            ->join('visitors', 'visitors.id', '=', 'visitor_conversions.visitor_id')
            ->where(function (Builder $facts): void {
                $facts->whereNull('visitor_conversions.conversion_time_basis')
                    ->orWhere('visitor_conversions.conversion_time_basis', '<>', 'authority_audit_event')
                    ->orWhereNull('visitor_conversions.converted_at');
            })
            ->where('visitor_conversions.converted_at', '>=', $window['starts_at'])
            ->where('visitor_conversions.converted_at', '<', $window['ends_exclusive_at']);
        if ($scopeId !== null) {
            $query->where('visitors.origin_branch_id', $scopeId);
        }

        return $query;
    }
}
