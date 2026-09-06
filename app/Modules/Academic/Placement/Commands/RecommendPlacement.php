<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Commands;

use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Placement\Domain\PlacementAccess;
use App\Modules\Academic\Placement\Domain\PlacementBand;
use App\Modules\Academic\Placement\Domain\PlacementComponent;
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
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Explainable placement recommendation: rubric-modified section scores are
 * reduced to component percentages, weighted by the test's component
 * weights, mapped to an overall CEFR band, then to an active
 * ProgramVersionLevel and the current operational class/offering at that
 * level. The decision is append-only history.
 */
final class RecommendPlacement
{
    public const CAPABILITY = 'placement.recommend';

    public function __construct(
        private readonly PlacementAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
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
                    if (! in_array($locked->lifecycle_state, [PlacementProfile::STATE_SCORED, PlacementProfile::STATE_RECOMMENDED], true)) {
                        throw BusinessRejection::forCode('placement.recommend_requires_scored', 'a placement recommendation requires a scored profile');
                    }

                    $attempt = PlacementAttempt::query()->where('profile_id', $locked->id)->where('status', PlacementAttempt::STATUS_SUBMITTED)->latest('id')->first();
                    if ($attempt === null) {
                        throw BusinessRejection::forCode('placement.recommend_attempt_missing', 'the profile has no submitted attempt to recommend');
                    }
                    $results = PlacementSectionResult::query()->where('attempt_id', $attempt->id)->whereNull('raw_score')->exists();
                    if ($results) {
                        throw BusinessRejection::forCode('placement.recommend_scores_incomplete', 'every placement section must be scored before recommendation');
                    }

                    $version = PlacementTestVersion::query()->findOrFail($attempt->test_version_id);
                    /** @var PlacementTest $test */
                    $test = PlacementTest::query()->whereKey($version->placement_test_id)->firstOrFail();
                    /** @var array<string, float> $weights */
                    $weights = $test->component_weights;
                    $componentPercentages = $this->componentPercentages($attempt->id);
                    $overall = PlacementScoring::overallPercentage($componentPercentages, $weights);
                    $overallCefr = PlacementBand::forPercentage($overall);
                    $targetVersion = $locked->program_version_id ?? $test->program_version_id;
                    if ($targetVersion === null) {
                        throw BusinessRejection::forCode('placement.recommend_program_missing', 'a recommendation requires a target program version');
                    }
                    $level = $this->resolveLevel($targetVersion, $overallCefr);
                    $class = ClassModel::query()->where('program_version_level_id', $level->id)->where('lifecycle_state', 'active')->orderBy('id')->first();
                    $offering = Offering::query()->where('program_version_level_id', $level->id)->where('lifecycle_state', 'open')->orderBy('id')->first();

                    $snapshot = [
                        'overall_percentage' => round($overall, 2),
                        'overall_cefr' => $overallCefr,
                        'component_percentages' => array_map(static fn (float $p): float => round($p, 2), $componentPercentages),
                        'component_cefr' => $this->componentCefr($version->id, $componentPercentages),
                        'model_version' => PlacementScoring::MODEL_VERSION,
                    ];
                    $rationale = sprintf(
                        'Weighted placement performance is %.2f%% (CEFR %s); recommended level "%s" (%s)%s.',
                        $overall,
                        $overallCefr,
                        $level->title,
                        (string) $level->level_key,
                        $class !== null ? sprintf('; operational class "%s" at that level', $class->id) : '',
                    );
                    $recommendation = PlacementRecommendation::query()->create([
                        'id' => RandomIdentifier::new(),
                        'profile_id' => $locked->id,
                        'recommended_level_id' => $level->id,
                        'recommended_class_id' => $class?->id,
                        'recommended_offering_id' => $offering?->id,
                        'rationale' => $rationale,
                        'model_version' => PlacementScoring::MODEL_VERSION,
                        'score_snapshot' => $snapshot,
                        'recommended_by' => $actor->actorId,
                    ]);

                    $locked->forceFill([
                        'recommended_level_id' => $level->id,
                        'recommended_class_id' => $class?->id,
                        'recommended_offering_id' => $offering?->id,
                        'overall_cefr_ref' => $overallCefr,
                        'lifecycle_state' => PlacementProfile::STATE_RECOMMENDED,
                    ])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.recommend', 'placement_recommendation', $recommendation->id, null, [
                        'profile_id' => $locked->id, 'level_id' => $level->id, 'cefr' => $overallCefr, 'overall_percentage' => round($overall, 2),
                    ]);

                    return ['recommendation_id' => $recommendation->id, 'recommended_level_id' => $level->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.recommend', 'placement_profile', $profile->id);
        }
    }

    /** @return array<string, float> */
    private function componentPercentages(string $attemptId): array
    {
        $results = PlacementSectionResult::query()->where('attempt_id', $attemptId)->get();
        /** @var array<string, list<float>> $byComponent */
        $byComponent = [];
        foreach ($results as $result) {
            $percentage = $result->weighted_score !== null ? (float) $result->weighted_score : (float) $result->raw_score;
            $byComponent[$result->component][] = $percentage;
        }
        $percentages = [];
        foreach ($byComponent as $component => $values) {
            $percentages[$component] = $values === [] ? 0.0 : array_sum($values) / count($values);
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

        $exact = $levels->first(fn (ProgramVersionLevel $level): bool => strtoupper((string) $level->cefr_ref) === $overallCefr);
        if ($exact !== null) {
            return $exact;
        }
        $overallRank = PlacementBand::rank($overallCefr);
        $eligible = $levels->filter(fn (ProgramVersionLevel $level): bool => PlacementBand::rank((string) strtoupper((string) $level->cefr_ref)) <= $overallRank);
        if ($eligible->isNotEmpty()) {
            return $eligible->last();
        }

        return $levels->first();
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
