<?php

declare(strict_types=1);

namespace App\Modules\Reporting\Queries;

use App\Modules\Reporting\Domain\MetricCalculator;
use Illuminate\Support\Facades\DB;

/**
 * CRM acquisition count for the half-open UTC academic-period window.
 *
 * `captured_at` is a database-owned CRM fact. Legacy created_at values remain
 * retained compatibility data, but cannot silently determine a reporting
 * cohort. A period crossing the prospective evidence epoch is therefore
 * returned as incomplete with its known post-guard count kept only as audit
 * metadata/result history (and withheld by Reporting read surfaces).
 */
final class VisitorCaptureCountCalculator implements MetricCalculator
{
    public function compute(string $periodId, ?string $scopeId): array
    {
        $period = DB::table('academic_periods')->where('id', $periodId)->first(['starts_on', 'ends_on']);
        if ($period === null) {
            return ['value' => '0', 'completeness' => 'incomplete', 'meta' => [
                'visitors_captured' => 0,
                'note' => 'unknown_period',
                'cohort_basis' => 'crm_database_capture_time',
            ]];
        }

        $window = CrmReportingEvidence::window($period);
        $knownCaptures = CrmReportingEvidence::capturedIn($window, $scopeId);
        $count = (int) (clone $knownCaptures)->count();
        $unassigned = $scopeId === null
            ? (int) (clone $knownCaptures)->whereNull('origin_branch_id')->count()
            : 0;
        $unclassified = (int) CrmReportingEvidence::unclassifiedCapturesIn($window, $scopeId)->count();
        $epochCoversPeriod = CrmReportingEvidence::periodIsWhollyGuarded(
            CrmReportingEvidence::CAPTURE_EPOCH,
            $window['starts_at'],
        );
        $complete = $epochCoversPeriod && $unclassified === 0;

        return [
            'value' => (string) $count,
            'completeness' => $complete ? 'complete' : 'incomplete',
            'meta' => [
                'visitors_captured' => $count,
                'cohort_basis' => 'crm_database_capture_time',
                'window_start_utc' => $window['starts_at'],
                'window_end_exclusive_utc' => $window['ends_exclusive_at'],
                'evidence_epoch_key' => CrmReportingEvidence::CAPTURE_EPOCH,
                'evidence_epoch_covers_period' => $epochCoversPeriod,
                'unclassified_capture_candidates' => $unclassified,
                'unclassified_capture_candidates_excluded' => $unclassified > 0,
                'unassigned_provenance_count' => $unassigned,
                'unassigned_provenance_excluded' => $scopeId !== null,
            ],
        ];
    }
}
