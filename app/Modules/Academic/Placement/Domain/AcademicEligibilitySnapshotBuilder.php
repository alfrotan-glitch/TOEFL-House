<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Domain;

use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementRecommendation;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Support\Authorization\Actor;
use App\Support\Signing\AcademicEligibilitySigner;
use App\Support\Signing\CanonicalJson;
use Illuminate\Support\Carbon;

/**
 * Builds the complete academic-context payload that a released placement
 * recommendation publishes. The payload is deterministic (canonical JSON
 * with recursively sorted keys), so Finance, Admissions and Academic can
 * reproduce the digest independently from the persisted event.
 */
final class AcademicEligibilitySnapshotBuilder
{
    public const SCHEMA_VERSION = 'academic-context-snapshot-v1';

    /** @return array<string, mixed> */
    public function build(PlacementProfile $profile, PlacementRecommendation $recommendation, Actor $signer, int $versionNo, ?string $supersedesSnapshotId): array
    {
        $attempt = PlacementAttempt::query()
            ->where('profile_id', $profile->id)
            ->latest('id')
            ->firstOrFail();
        $sectionResults = PlacementSectionResult::query()
            ->where('attempt_id', $attempt->id)
            ->orderBy('component')
            ->get();

        $programVersion = ProgramVersion::query()->findOrFail($profile->program_version_id);
        $level = $recommendation->recommended_level_id !== null
            ? ProgramVersionLevel::query()->find($recommendation->recommended_level_id)
            : null;
        $class = $recommendation->recommended_class_id !== null ? ClassModel::query()->find($recommendation->recommended_class_id) : null;
        $offering = $recommendation->recommended_offering_id !== null ? Offering::query()->find($recommendation->recommended_offering_id) : null;
        $academicPeriodId = $class !== null ? $class->period_id : ($offering !== null ? $offering->academic_period_id : null);

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
                'program_version_id' => $profile->program_version_id,
                'program' => $programVersion->program->name ?? null,
                'program_version_summary' => $programVersion->summary ?? null,
                'attempt_id' => $attempt->id,
                'attempt_no' => $attempt->attempt_no ?? null,
                'attempt_status' => $attempt->status,
                'recommendation_id' => $recommendation->id,
                'recommended_cefr_ref' => $level !== null ? $level->cefr_ref : null,
                'recommended_level_id' => $recommendation->recommended_level_id ?? null,
                'recommended_level_title' => $level !== null ? $level->title : null,
                'recommended_class_id' => $recommendation->recommended_class_id ?? null,
                'recommended_offering_id' => $recommendation->recommended_offering_id ?? null,
                'academic_period_id' => $academicPeriodId,
                'overall_cefr_ref' => $profile->overall_cefr_ref,
            ],
            'recommendation' => [
                'recommended_cefr_ref' => $level !== null ? $level->cefr_ref : null,
                'recommended_level_id' => $recommendation->recommended_level_id ?? null,
                'recommended_class_id' => $recommendation->recommended_class_id ?? null,
                'recommended_offering_id' => $recommendation->recommended_offering_id ?? null,
                'rationale' => $recommendation->rationale ?? null,
                'model_version' => $recommendation->model_version ?? null,
                'score_snapshot' => $recommendation->score_snapshot ?? [],
            ],
            'academic_context' => [
                'program_version_summary' => $programVersion->summary ?? null,
                'recommended_level_title' => $level !== null ? $level->title : null,
                'recommended_class_id' => $class !== null ? $class->id : null,
                'recommended_offering_id' => $offering !== null ? $offering->id : null,
            ],
            'evidence' => [
                'attempt' => [
                    'id' => $attempt->id,
                    'attempt_no' => $attempt->attempt_no ?? null,
                    'test_version_id' => $attempt->test_version_id,
                    'delivery_mode' => $attempt->delivery_mode,
                    'status' => $attempt->status,
                    'started_at' => $attempt->started_at !== null ? Carbon::parse($attempt->started_at)->toIso8601String() : null,
                    'ended_at' => $attempt->ended_at !== null ? Carbon::parse($attempt->ended_at)->toIso8601String() : null,
                    'duration_seconds' => $attempt->duration_seconds ?? null,
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
            'program_version_id' => $profile->program_version_id,
            'recommended_level_id' => $recommendation->recommended_level_id,
            'recommended_class_id' => $recommendation->recommended_class_id,
            'recommended_offering_id' => $recommendation->recommended_offering_id,
            'academic_period_id' => $academicPeriodId,
        ];
    }
}
