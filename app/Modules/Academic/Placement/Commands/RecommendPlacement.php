<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Commands;

use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Placement\Domain\PlacementAccess;
use App\Modules\Academic\Placement\Domain\PlacementBand;
use App\Modules\Academic\Placement\Domain\PlacementComponent;
use App\Modules\Academic\Placement\Domain\PlacementEvidenceVerifier;
use App\Modules\Academic\Placement\Domain\PlacementScoring;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementRecommendation;
use App\Modules\Academic\Placement\Models\PlacementRubric;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Modules\Academic\Placement\Models\PlacementTest;
use App\Modules\Academic\Placement\Models\PlacementTestVersion;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Explainable Placement recommendation. It binds exactly one immutable,
 * server-verified attempt to an academic ProgramVersionLevel. Scheduling and
 * Enrollment own class/offering selection; Placement deliberately does not
 * create a competing class-assignment authority.
 */
final class RecommendPlacement
{
    public const CAPABILITY = 'placement.recommend';

    public function __construct(
        private readonly PlacementAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly PlacementEvidenceVerifier $evidenceVerifier,
    ) {}

    /** @return array{recommendation_id: string, recommended_level_id: string, correlation_id: string} */
    public function recommend(Actor $actor, PlacementProfile $profile, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['placement.recommend', $profile->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('placement.recommend', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $profile): array {
                    /** @var PlacementProfile $locked */
                    $locked = PlacementProfile::query()->whereKey($profile->id)->lockForUpdate()->firstOrFail();
                    $this->access->require($actor, self::CAPABILITY, $locked->originating_branch_id);
                    if ($locked->lineage_version !== PlacementProfile::LINEAGE_VERSION) {
                        throw BusinessRejection::forCode('placement.profile_lineage_remediation_required', 'a pre-lineage placement profile cannot produce a new recommendation without governed remediation');
                    }
                    if ($locked->lifecycle_state !== PlacementProfile::STATE_SCORED) {
                        throw BusinessRejection::forCode('placement.recommend_requires_scored', 'a placement recommendation requires a scored profile with no earlier recommendation');
                    }
                    if ($locked->placement_recommendation_id !== null) {
                        throw BusinessRejection::forCode('placement.recommendation_exists', 'a profile already has its immutable placement recommendation');
                    }

                    $attempt = $this->decisionAttempt($locked);
                    $this->evidenceVerifier->requireDecisionEligible($attempt);
                    if (! $this->evidenceVerifier->scoringIsComplete($attempt)) {
                        throw BusinessRejection::forCode('placement.recommend_scores_incomplete', 'the exact placement attempt has incomplete or extraneous section results');
                    }

                    /** @var PlacementTestVersion $version */
                    $version = PlacementTestVersion::query()->findOrFail($attempt->test_version_id);
                    /** @var PlacementTest $test */
                    $test = PlacementTest::query()->findOrFail($version->placement_test_id);
                    /** @var array<string, float> $weights */
                    $weights = $test->component_weights;
                    $componentPercentages = $this->componentPercentages($attempt->id);
                    $overall = PlacementScoring::overallPercentage($componentPercentages, $weights);
                    $overallCefr = PlacementBand::forPercentage($overall);
                    $targetVersion = trim((string) ($locked->program_version_id ?? ''));
                    if ($targetVersion === '') {
                        $targetVersion = trim((string) ($test->program_version_id ?? ''));
                    }
                    if ($targetVersion === '') {
                        throw BusinessRejection::forCode('placement.recommend_program_missing', 'a recommendation requires a target program version from the profile or immutable test');
                    }
                    $level = $this->resolveLevel($targetVersion, $overallCefr);

                    $snapshot = [
                        'overall_percentage' => round($overall, 2),
                        'overall_cefr' => $overallCefr,
                        'component_percentages' => array_map(static fn (float $percentage): float => round($percentage, 2), $componentPercentages),
                        'component_cefr' => $this->componentCefr($version->id, $componentPercentages),
                        'model_version' => PlacementScoring::MODEL_VERSION,
                    ];
                    $rationale = sprintf(
                        'Weighted placement performance is %.2f%% (CEFR %s); recommended academic level "%s" (%s). Class and offering selection remains an Enrollment/Scheduling decision.',
                        $overall,
                        $overallCefr,
                        $level->title,
                        (string) $level->level_key,
                    );
                    $recommendation = PlacementRecommendation::query()->create([
                        'id' => RandomIdentifier::new(),
                        'profile_id' => $locked->id,
                        'attempt_id' => $attempt->id,
                        'program_version_id' => $targetVersion,
                        'lineage_version' => PlacementRecommendation::LINEAGE_VERSION,
                        'recommended_level_id' => $level->id,
                        // Legacy columns remain nullable historical fields;
                        // no post-convergence recommendation writes an
                        // operational class or offering assignment.
                        'recommended_class_id' => null,
                        'recommended_offering_id' => null,
                        'rationale' => $rationale,
                        'model_version' => PlacementScoring::MODEL_VERSION,
                        'score_snapshot' => $snapshot,
                        'recommended_by' => $actor->actorId,
                    ]);

                    $locked->forceFill([
                        // Persist the fallback target once, before the
                        // profile becomes a decision fact, so legacy profile
                        // readers cannot disagree with the recommendation.
                        'program_version_id' => $targetVersion,
                        'placement_recommendation_id' => $recommendation->id,
                        'recommended_level_id' => $level->id,
                        'recommended_class_id' => null,
                        'recommended_offering_id' => null,
                        'overall_cefr_ref' => $overallCefr,
                        'lifecycle_state' => PlacementProfile::STATE_RECOMMENDED,
                    ])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.recommend', 'placement_recommendation', $recommendation->id, null, [
                        'profile_id' => $locked->id,
                        'attempt_id' => $attempt->id,
                        'program_version_id' => $targetVersion,
                        'level_id' => $level->id,
                        'cefr' => $overallCefr,
                        'overall_percentage' => round($overall, 2),
                        ...$this->branchProvenance($locked->originating_branch_id),
                    ]);

                    return ['recommendation_id' => $recommendation->id, 'recommended_level_id' => $level->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.recommend', 'placement_profile', $profile->id);
        }
    }

    private function decisionAttempt(PlacementProfile $profile): PlacementAttempt
    {
        $attempts = PlacementAttempt::query()
            ->where('profile_id', $profile->id)
            ->where('lineage_version', PlacementAttempt::LINEAGE_VERSION)
            ->where('status', PlacementAttempt::STATUS_SUBMITTED)
            ->orderByDesc('attempt_no')
            ->get();
        if ($attempts->count() !== 1) {
            throw BusinessRejection::forCode('placement.recommend_attempt_ambiguous', 'a recommendation requires exactly one submitted immutable attempt for the profile');
        }

        /** @var PlacementAttempt $attempt */
        $attempt = $attempts->first();

        return $attempt;
    }

    /** @return array<string, float> */
    private function componentPercentages(string $attemptId): array
    {
        $results = PlacementSectionResult::query()
            ->where('attempt_id', $attemptId)
            ->orderBy('component')
            ->get();
        /** @var array<string, list<float>> $byComponent */
        $byComponent = [];
        foreach ($results as $result) {
            $percentage = $result->weighted_score !== null ? (float) $result->weighted_score : (float) $result->raw_score;
            $byComponent[$result->component][] = $percentage;
        }
        $percentages = [];
        foreach (PlacementComponent::all() as $component) {
            $values = $byComponent[$component] ?? [];
            if ($values === []) {
                throw BusinessRejection::forCode('placement.recommend_component_missing', sprintf('the exact attempt has no %s result', $component));
            }
            $percentages[$component] = array_sum($values) / count($values);
        }

        return $percentages;
    }

    private function resolveLevel(string $programVersionId, string $overallCefr): ProgramVersionLevel
    {
        $levels = ProgramVersionLevel::query()
            ->where('program_version_id', $programVersionId)
            ->where('lifecycle_state', 'active')
            ->orderBy('ordinal')
            ->get();
        if ($levels->isEmpty()) {
            throw BusinessRejection::forCode('placement.recommend_level_active_missing', 'the target program version has no active levels');
        }

        // A null/unknown academic CEFR is not a lowest level. Treating its
        // rank (-1) as eligible would let an unclassified setup row win a
        // placement decision merely because it has a later ordinal.
        $rankedLevels = $levels->filter(static fn (ProgramVersionLevel $level): bool => PlacementBand::rank((string) $level->cefr_ref) >= 0)->values();
        if ($rankedLevels->isEmpty()) {
            throw BusinessRejection::forCode('placement.recommend_level_cefr_invalid', 'the target program version has no active level with a canonical CEFR reference');
        }
        $exact = $rankedLevels->first(fn (ProgramVersionLevel $level): bool => strtoupper(trim((string) $level->cefr_ref)) === $overallCefr);
        if ($exact !== null) {
            return $exact;
        }
        $overallRank = PlacementBand::rank($overallCefr);
        $eligible = $rankedLevels->filter(fn (ProgramVersionLevel $level): bool => PlacementBand::rank((string) $level->cefr_ref) <= $overallRank);
        if ($eligible->isNotEmpty()) {
            return $eligible->last();
        }

        return $rankedLevels->first();
    }

    /** @return array{branch_id: string, campus_id: string, organization_id: string} */
    private function branchProvenance(?string $branchId): array
    {
        $id = trim((string) ($branchId ?? ''));
        if ($id === '') {
            throw BusinessRejection::forCode('placement.recommendation_provenance_required', 'a placement recommendation requires an operational branch provenance');
        }
        $branch = Branch::query()->whereKey($id)->first();
        if ($branch === null || $branch->lifecycle_state !== 'active') {
            throw BusinessRejection::forCode('placement.recommendation_provenance_required', 'a placement recommendation requires an active branch provenance');
        }
        $scope = $branch->structureScope();
        if ($scope->organizationId === '' || $scope->campusId === null) {
            throw BusinessRejection::forCode('placement.recommendation_provenance_required', 'a placement recommendation requires active campus organization provenance');
        }

        return ['branch_id' => (string) $branch->id, 'campus_id' => (string) $scope->campusId, 'organization_id' => $scope->organizationId];
    }

    /**
     * @param  array<string, float>  $percentages
     * @return array<string, string|null>
     */
    private function componentCefr(string $versionId, array $percentages): array
    {
        $rubrics = PlacementRubric::query()->where('test_version_id', $versionId)->get();
        $result = [];
        foreach (PlacementComponent::all() as $component) {
            $result[$component] = PlacementScoring::cefrForComponent($component, $percentages[$component] ?? 0.0, $rubrics);
        }

        return $result;
    }
}
