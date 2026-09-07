<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Domain;

use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementRecommendation;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Support\Authorization\Actor;
use App\Support\Errors\BusinessRejection;
use App\Support\Signing\AcademicEligibilitySigner;
use App\Support\Signing\CanonicalJson;
use Illuminate\Support\Carbon;

/**
 * Builds the complete signed academic-context payload from the immutable
 * recommendation and its exact evidence attempt. It intentionally does not
 * rediscover a "latest" attempt or an operational class/offering: UUIDs have
 * no temporal ordering and Enrollment/Scheduling own seat selection.
 */
final class AcademicEligibilitySnapshotBuilder
{
    public const SCHEMA_VERSION = 'academic-context-snapshot-v2';

    public const LEGACY_SCHEMA_VERSION = 'academic-context-snapshot-v1';

    /** @return array<string, mixed> */
    public function build(PlacementProfile $profile, PlacementRecommendation $recommendation, Actor $signer, int $versionNo, ?string $supersedesSnapshotId): array
    {
        if ($recommendation->lineage_version !== PlacementRecommendation::LINEAGE_VERSION
            || trim((string) $recommendation->profile_id) !== trim((string) $profile->id)
            || trim((string) $recommendation->attempt_id) === ''
            || trim((string) $recommendation->program_version_id) === '') {
            throw BusinessRejection::forCode('placement.snapshot_lineage_invalid', 'a signed eligibility snapshot requires an exact post-convergence placement recommendation lineage');
        }

        /** @var PlacementAttempt $attempt */
        $attempt = PlacementAttempt::query()->findOrFail($recommendation->attempt_id);
        if (trim((string) $attempt->profile_id) !== trim((string) $profile->id)
            || $attempt->lineage_version !== PlacementAttempt::LINEAGE_VERSION
            || $attempt->status !== PlacementAttempt::STATUS_SUBMITTED) {
            throw BusinessRejection::forCode('placement.snapshot_lineage_invalid', 'the recommendation evidence attempt does not belong to this submitted placement profile');
        }

        $sectionResults = PlacementSectionResult::query()
            ->where('attempt_id', $attempt->id)
            ->orderBy('section_id')
            ->get();

        /** @var ProgramVersion $programVersion */
        $programVersion = ProgramVersion::query()->findOrFail($recommendation->program_version_id);
        $level = ProgramVersionLevel::query()->find($recommendation->recommended_level_id);
        if ($level === null || trim((string) $level->program_version_id) !== trim((string) $programVersion->id)) {
            throw BusinessRejection::forCode('placement.snapshot_level_program_mismatch', 'the recommendation level must belong to its immutable target program version');
        }
        $scoreSnapshot = is_array($recommendation->score_snapshot) ? $recommendation->score_snapshot : [];
        $overallCefr = isset($scoreSnapshot['overall_cefr']) ? (string) $scoreSnapshot['overall_cefr'] : null;

        $payload = [
            'snapshot' => [
                'schema_version' => self::SCHEMA_VERSION,
                'version_no' => $versionNo,
                'supersedes_snapshot_id' => $supersedesSnapshotId,
                'signed_at' => now()->toIso8601String(),
                'signed_by' => $signer->actorId,
                'producer' => 'academic/placement',
            ],
            'subject' => [
                'person_id' => $profile->person_id,
                'visitor_id' => $profile->visitor_id,
                'originating_branch_id' => $profile->originating_branch_id,
                'current_home_branch_id' => $profile->current_home_branch_id,
            ],
            'placement' => [
                'placement_profile_id' => $profile->id,
                'program_version_id' => $programVersion->id,
                'program' => $programVersion->program?->name,
                'program_version_summary' => $programVersion->summary ?? null,
                'attempt_id' => $attempt->id,
                'attempt_no' => $attempt->attempt_no,
                'attempt_status' => $attempt->status,
                'recommendation_id' => $recommendation->id,
                'recommended_cefr_ref' => $level->cefr_ref,
                'recommended_level_id' => $recommendation->recommended_level_id,
                'recommended_level_title' => $level->title,
                'overall_cefr_ref' => $overallCefr,
            ],
            'recommendation' => [
                'program_version_id' => $programVersion->id,
                'recommended_cefr_ref' => $level->cefr_ref,
                'recommended_level_id' => $recommendation->recommended_level_id,
                'rationale' => $recommendation->rationale,
                'model_version' => $recommendation->model_version,
                'score_snapshot' => $scoreSnapshot,
            ],
            // A class or offering is intentionally absent. This signed fact
            // establishes academic level eligibility only; Scheduling and
            // Enrollment decide actual delivery capacity and class assignment.
            'academic_context' => [
                'program_version_summary' => $programVersion->summary ?? null,
                'recommended_level_title' => $level->title,
            ],
            'evidence' => [
                'attempt' => [
                    'id' => $attempt->id,
                    'attempt_no' => $attempt->attempt_no,
                    'test_version_id' => $attempt->test_version_id,
                    'delivery_mode' => $attempt->delivery_mode,
                    'status' => $attempt->status,
                    'started_at' => $attempt->started_at !== null ? Carbon::parse($attempt->started_at)->toIso8601String() : null,
                    'ended_at' => $attempt->ended_at !== null ? Carbon::parse($attempt->ended_at)->toIso8601String() : null,
                    'duration_seconds' => $attempt->duration_seconds,
                    'anti_tamper_hmac' => $attempt->anti_tamper_hmac,
                    'tamper_flagged' => (bool) $attempt->tamper_flagged,
                ],
                'section_results' => $sectionResults->map(fn (PlacementSectionResult $section): array => [
                    'id' => $section->id,
                    'section_id' => $section->section_id,
                    'component' => $section->component,
                    'raw_score' => $section->raw_score,
                    'adjusted_score' => $section->adjusted_score,
                    'weighted_score' => $section->weighted_score,
                    'rubric_id' => $section->rubric_id,
                    'cefr_ref' => $section->cefr_ref,
                    'lifecycle_state' => $section->lifecycle_state,
                    'scoring_method' => $section->scoring_method,
                    'scored_by' => $section->scored_by,
                    'moderated_by' => $section->moderated_by,
                    'approved_by' => $section->approved_by,
                ])->all(),
            ],
            'signature_material' => [
                'algorithm' => AcademicEligibilitySigner::ALGORITHM,
                'key_version' => AcademicEligibilitySigner::KEY_VERSION,
                'contract' => AcademicEligibilitySigner::CONTRACT,
            ],
        ];

        $canonical = CanonicalJson::encode($payload);
        $digest = hash('sha256', $canonical);
        $signature = AcademicEligibilitySigner::sign($canonical);

        return [
            'payload' => $payload,
            'canonical' => $canonical,
            'digest' => $digest,
            'signature' => $signature,
            'algorithm' => AcademicEligibilitySigner::ALGORITHM,
            'key_version' => AcademicEligibilitySigner::KEY_VERSION,
            'program_version_id' => $programVersion->id,
            'recommended_level_id' => $recommendation->recommended_level_id,
            'recommended_class_id' => null,
            'recommended_offering_id' => null,
            'academic_period_id' => null,
        ];
    }
}
