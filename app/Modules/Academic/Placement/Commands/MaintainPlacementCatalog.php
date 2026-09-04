<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Commands;

use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Placement\Domain\PlacementAccess;
use App\Modules\Academic\Placement\Domain\PlacementComponent;
use App\Modules\Academic\Placement\Domain\PlacementDelivery;
use App\Modules\Academic\Placement\Models\PlacementQuestion;
use App\Modules\Academic\Placement\Models\PlacementQuestionMedia;
use App\Modules\Academic\Placement\Models\PlacementRubric;
use App\Modules\Academic\Placement\Models\PlacementSection;
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
 * Placement test-bank control: tests, immutable versions, sections, the
 * five canonical components, questions, media, and rubrics. Published
 * versions are immutable; corrections publish a new version.
 */
final class MaintainPlacementCatalog
{
    public const CAPABILITY = 'placement.catalog';

    private const QUESTION_TYPES = ['mcq', 'short_answer', 'essay', 'speaking'];

    public function __construct(
        private readonly PlacementAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @param  array<string, float>  $componentWeights
     * @return array{test_id: string, correlation_id: string} */
    public function defineTest(Actor $actor, string $key, string $name, ?string $programVersionId, int $totalTimeMinutes, array $componentWeights, string $idempotencyKey, ?string $branchId = null): array
    {
        $payload = hash('sha256', implode('|', [
            'placement.test.define', $key, $name, $programVersionId ?? '', (string) $totalTimeMinutes,
            json_encode($componentWeights), $branchId ?? '', $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('placement.test.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $key, $name, $programVersionId, $totalTimeMinutes, $componentWeights, $branchId): array {
                    $this->require($actor, $branchId);
                    if ($key === '' || $name === '') {
                        throw BusinessRejection::forCode('placement.test_required_fields', 'a placement test requires a key and a name');
                    }
                    if ($totalTimeMinutes <= 0) {
                        throw BusinessRejection::forCode('placement.test_time_invalid', 'placement test time must be positive');
                    }
                    $this->assertWeights($componentWeights);
                    if ($programVersionId !== null && ProgramVersion::query()->whereKey($programVersionId)->doesntExist()) {
                        throw BusinessRejection::forCode('placement.test_program_version_unknown', 'referenced program version does not exist');
                    }

                    $test = PlacementTest::query()->create([
                        'id' => RandomIdentifier::new(),
                        'key' => $key,
                        'name' => $name,
                        'program_version_id' => $programVersionId,
                        'total_time_minutes' => $totalTimeMinutes,
                        'scoring_version' => 'rubric-v1',
                        'component_weights' => $componentWeights,
                        'lifecycle_state' => 'draft',
                        'originating_branch_id' => $branchId,
                        'current_home_branch_id' => $branchId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'placement.test.define', 'placement_test', $test->id, null, [
                        'key' => $key, 'program_version_id' => $programVersionId, 'branch' => $branchId,
                    ]);

                    return ['test_id' => $test->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.test.define', 'placement_test', $key);
        }
    }

    /** @return array{test_id: string, lifecycle_state: string, correlation_id: string} */
    public function transitionTest(Actor $actor, PlacementTest $test, string $toState, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['placement.test.transition', $test->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('placement.test.transition', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $test, $toState): array {
                    /** @var PlacementTest $locked */
                    $locked = PlacementTest::query()->whereKey($test->id)->lockForUpdate()->firstOrFail();
                    $this->require($actor, $locked->originating_branch_id);
                    self::assertTestTransition($locked->lifecycle_state, $toState);
                    $locked->forceFill(['lifecycle_state' => $toState])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.test.transition', 'placement_test', $locked->id, ['lifecycle_state' => $locked->getOriginal('lifecycle_state')], ['lifecycle_state' => $toState]);

                    return ['test_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.test.transition', 'placement_test', $test->id);
        }
    }

    /** @return array{version_id: string, correlation_id: string} */
    public function createVersion(Actor $actor, PlacementTest $test, string $summary, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['placement.version.create', $test->id, $summary, $actor->actorId]));

        try {
            return $this->idempotency->execute('placement.version.create', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $test, $summary): array {
                    /** @var PlacementTest $locked */
                    $locked = PlacementTest::query()->whereKey($test->id)->lockForUpdate()->firstOrFail();
                    $this->require($actor, $locked->originating_branch_id);
                    if ($summary === '') {
                        throw BusinessRejection::forCode('placement.version_summary_required', 'a placement version requires a summary');
                    }
                    $next = (int) PlacementTestVersion::query()->where('placement_test_id', $locked->id)->max('version_no') + 1;
                    $version = PlacementTestVersion::query()->create([
                        'id' => RandomIdentifier::new(),
                        'placement_test_id' => $locked->id,
                        'version_no' => $next,
                        'summary' => $summary,
                        'lifecycle_state' => 'draft',
                    ]);
                    $event = $this->audit->record($actor->actorId, 'placement.version.create', 'placement_test_version', $version->id, null, [
                        'test_id' => $locked->id, 'version_no' => $next,
                    ]);

                    return ['version_id' => $version->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.version.create', 'placement_test_version', $test->id);
        }
    }

    /** @return array{version_id: string, lifecycle_state: string, correlation_id: string} */
    public function publishVersion(Actor $actor, PlacementTestVersion $version, string $idempotencyKey): array
    {
        return $this->transitionVersion($actor, $version, 'published', $idempotencyKey);
    }

    /** @return array{version_id: string, lifecycle_state: string, correlation_id: string} */
    public function transitionVersion(Actor $actor, PlacementTestVersion $version, string $toState, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['placement.version.transition', $version->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('placement.version.transition', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $version, $toState): array {
                    /** @var PlacementTestVersion $locked */
                    $locked = PlacementTestVersion::query()->whereKey($version->id)->lockForUpdate()->firstOrFail();
                    /** @var PlacementTest $test */
                    $test = PlacementTest::query()->whereKey($locked->placement_test_id)->lockForUpdate()->firstOrFail();
                    $this->require($actor, $test->originating_branch_id);
                    self::assertVersionTransition($locked->lifecycle_state, $toState);
                    if ($toState === 'published' && $test->lifecycle_state !== 'published') {
                        throw BusinessRejection::forCode('placement.version_test_not_published', 'only a published test can publish a placement version');
                    }
                    $locked->forceFill([
                        'lifecycle_state' => $toState,
                        'published_at' => $toState === 'published' ? now() : $locked->published_at,
                    ])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.version.transition', 'placement_test_version', $locked->id, ['lifecycle_state' => $locked->getOriginal('lifecycle_state')], ['lifecycle_state' => $toState]);

                    return ['version_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.version.transition', 'placement_test_version', $version->id);
        }
    }

    /** @return array{section_id: string, correlation_id: string} */
    public function defineSection(Actor $actor, PlacementTestVersion $version, string $code, string $name, string $component, int $sectionOrder, int $timeMinutes, string $deliveryMode, bool $canAutoScore, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'placement.section.define', $version->id, $code, $name, $component, (string) $sectionOrder,
            (string) $timeMinutes, $deliveryMode, $canAutoScore ? '1' : '0', $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('placement.section.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $version, $code, $name, $component, $sectionOrder, $timeMinutes, $deliveryMode, $canAutoScore): array {
                    $this->requireVersionBranch($actor, $version);
                    PlacementComponent::require($component);
                    PlacementDelivery::require($deliveryMode);
                    if ($code === '' || $name === '') {
                        throw BusinessRejection::forCode('placement.section_required_fields', 'a section requires a code and a name');
                    }
                    if ($timeMinutes <= 0) {
                        throw BusinessRejection::forCode('placement.section_time_invalid', 'section time must be positive');
                    }
                    if ($sectionOrder < 0) {
                        throw BusinessRejection::forCode('placement.section_order_invalid', 'section order cannot be negative');
                    }
                    if (! $canAutoScore && ! in_array($component, ['writing', 'speaking'], true)) {
                        throw BusinessRejection::forCode('placement.section_manual_component', 'non-auto-scored sections must be writing or speaking');
                    }

                    $section = PlacementSection::query()->create([
                        'id' => RandomIdentifier::new(),
                        'test_version_id' => $version->id,
                        'code' => $code,
                        'name' => $name,
                        'component' => $component,
                        'section_order' => $sectionOrder,
                        'time_minutes' => $timeMinutes,
                        'delivery_mode' => $deliveryMode,
                        'can_auto_score' => $canAutoScore,
                        'lifecycle_state' => 'draft',
                    ]);
                    $event = $this->audit->record($actor->actorId, 'placement.section.define', 'placement_section', $section->id, null, [
                        'version_id' => $version->id, 'component' => $component,
                    ]);

                    return ['section_id' => $section->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.section.define', 'placement_section', $version->id);
        }
    }

    /** @param  array<string, mixed>|null  $options
     * @return array{question_id: string, correlation_id: string} */
    public function defineQuestion(Actor $actor, PlacementSection $section, string $code, string $stem, string $questionType, float $points, ?array $options, ?string $correctAnswer, ?string $mediaRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'placement.question.define', $section->id, $code, $stem, $questionType, (string) $points,
            $options === null ? '' : json_encode($options), $correctAnswer ?? '', $mediaRef ?? '', $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('placement.question.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $section, $code, $stem, $questionType, $points, $options, $correctAnswer, $mediaRef): array {
                    $this->requireSectionBranch($actor, $section);
                    PlacementComponent::require($section->component);
                    if (! in_array($questionType, self::QUESTION_TYPES, true)) {
                        throw BusinessRejection::forCode('placement.question_type_unknown', sprintf('unknown question type %s', $questionType));
                    }
                    if ($code === '' || $stem === '') {
                        throw BusinessRejection::forCode('placement.question_required_fields', 'a question requires a code and a stem');
                    }
                    if ($points <= 0) {
                        throw BusinessRejection::forCode('placement.question_points_invalid', 'question points must be positive');
                    }
                    if (in_array($questionType, ['mcq', 'short_answer'], true) && ($correctAnswer === null || $correctAnswer === '')) {
                        throw BusinessRejection::forCode('placement.question_answer_required', 'auto-scored questions require a correct answer');
                    }

                    $question = PlacementQuestion::query()->create([
                        'id' => RandomIdentifier::new(),
                        'section_id' => $section->id,
                        'code' => $code,
                        'stem' => $stem,
                        'component' => $section->component,
                        'question_type' => $questionType,
                        'points' => $points,
                        'options' => $options,
                        'correct_answer' => $correctAnswer,
                        'media_ref' => $mediaRef,
                        'lifecycle_state' => 'draft',
                    ]);
                    $event = $this->audit->record($actor->actorId, 'placement.question.define', 'placement_question', $question->id, null, [
                        'section_id' => $section->id, 'question_type' => $questionType,
                    ]);

                    return ['question_id' => $question->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.question.define', 'placement_question', $section->id);
        }
    }

    /** @return array{media_id: string, correlation_id: string} */
    public function attachMedia(Actor $actor, PlacementQuestion $question, string $uri, string $mediaType, string $sha256, string $mimeType, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['placement.media.attach', $question->id, $uri, $mediaType, $sha256, $mimeType, $actor->actorId]));

        try {
            return $this->idempotency->execute('placement.media.attach', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $question, $uri, $mediaType, $sha256, $mimeType): array {
                    $this->requireQuestionBranch($actor, $question);
                    if ($uri === '' || $mediaType === '') {
                        throw BusinessRejection::forCode('placement.media_required_fields', 'media requires a uri and type');
                    }
                    if (preg_match('/^[0-9a-f]{64}$/', $sha256) !== 1) {
                        throw BusinessRejection::forCode('placement.media_checksum_invalid', 'media sha256 must be 64 lowercase hex characters');
                    }
                    $media = PlacementQuestionMedia::query()->create([
                        'id' => RandomIdentifier::new(),
                        'question_id' => $question->id,
                        'uri' => $uri,
                        'media_type' => $mediaType,
                        'sha256' => $sha256,
                        'mime_type' => $mimeType,
                        'lifecycle_state' => 'active',
                    ]);
                    $event = $this->audit->record($actor->actorId, 'placement.media.attach', 'placement_question_media', $media->id, null, [
                        'question_id' => $question->id, 'sha256' => $sha256,
                    ]);

                    return ['media_id' => $media->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.media.attach', 'placement_question_media', $question->id);
        }
    }

    /** @return array{rubric_id: string, correlation_id: string} */
    public function defineRubric(Actor $actor, PlacementTestVersion $version, string $component, string $band, float $minScore, float $maxScore, string $cefrRef, string $description, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'placement.rubric.define', $version->id, $component, $band, (string) $minScore, (string) $maxScore,
            $cefrRef, $description, $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('placement.rubric.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $version, $component, $band, $minScore, $maxScore, $cefrRef, $description): array {
                    $this->requireVersionBranch($actor, $version);
                    PlacementComponent::require($component);
                    if ($band === '' || $description === '') {
                        throw BusinessRejection::forCode('placement.rubric_required_fields', 'a rubric requires a band and description');
                    }
                    if ($minScore < 0 || $maxScore < 0 || $minScore > $maxScore || $maxScore > 100) {
                        throw BusinessRejection::forCode('placement.rubric_range_invalid', 'rubric score range must be within 0-100 and non-inverted');
                    }
                    $rubric = PlacementRubric::query()->create([
                        'id' => RandomIdentifier::new(),
                        'test_version_id' => $version->id,
                        'component' => $component,
                        'band' => $band,
                        'min_score' => $minScore,
                        'max_score' => $maxScore,
                        'cefr_ref' => $cefrRef,
                        'description' => $description,
                        'lifecycle_state' => 'draft',
                    ]);
                    $event = $this->audit->record($actor->actorId, 'placement.rubric.define', 'placement_rubric', $rubric->id, null, [
                        'version_id' => $version->id, 'component' => $component, 'cefr' => $cefrRef,
                    ]);

                    return ['rubric_id' => $rubric->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.rubric.define', 'placement_rubric', $version->id);
        }
    }

    /** @return array{section_id: string, lifecycle_state: string, correlation_id: string} */
    public function transitionSection(Actor $actor, PlacementSection $section, string $toState, string $idempotencyKey): array
    {
        return $this->transitionSectionEntity($actor, $section, $toState, $idempotencyKey);
    }

    /** @return array{rubric_id: string, lifecycle_state: string, correlation_id: string} */
    public function transitionRubric(Actor $actor, PlacementRubric $rubric, string $toState, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['placement.rubric.transition', $rubric->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('placement.rubric.transition', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $rubric, $toState): array {
                    /** @var PlacementRubric $locked */
                    $locked = PlacementRubric::query()->whereKey($rubric->id)->lockForUpdate()->firstOrFail();
                    $this->requireVersionBranch($actor, PlacementTestVersion::query()->findOrFail($locked->test_version_id));
                    self::assertObjectTransition($locked->lifecycle_state, $toState);
                    $locked->forceFill(['lifecycle_state' => $toState])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.rubric.transition', 'placement_rubric', $locked->id, ['lifecycle_state' => $locked->getOriginal('lifecycle_state')], ['lifecycle_state' => $toState]);

                    return ['rubric_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.rubric.transition', 'placement_rubric', $rubric->id);
        }
    }

    /** @return array{question_id: string, lifecycle_state: string, correlation_id: string} */
    public function transitionQuestion(Actor $actor, PlacementQuestion $question, string $toState, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['placement.question.transition', $question->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('placement.question.transition', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $question, $toState): array {
                    /** @var PlacementQuestion $locked */
                    $locked = PlacementQuestion::query()->whereKey($question->id)->lockForUpdate()->firstOrFail();
                    $this->requireQuestionBranch($actor, $locked);
                    self::assertObjectTransition($locked->lifecycle_state, $toState);
                    $locked->forceFill(['lifecycle_state' => $toState])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.question.transition', 'placement_question', $locked->id, ['lifecycle_state' => $locked->getOriginal('lifecycle_state')], ['lifecycle_state' => $toState]);

                    return ['question_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.question.transition', 'placement_question', $question->id);
        }
    }

    /** @return array{section_id: string, lifecycle_state: string, correlation_id: string} */
    private function transitionSectionEntity(Actor $actor, PlacementSection $section, string $toState, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['placement.section.transition', $section->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('placement.section.transition', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $section, $toState): array {
                    /** @var PlacementSection $locked */
                    $locked = PlacementSection::query()->whereKey($section->id)->lockForUpdate()->firstOrFail();
                    $this->requireSectionBranch($actor, $locked);
                    self::assertObjectTransition($locked->lifecycle_state, $toState);
                    $locked->forceFill(['lifecycle_state' => $toState])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.section.transition', 'placement_section', $locked->id, ['lifecycle_state' => $locked->getOriginal('lifecycle_state')], ['lifecycle_state' => $toState]);

                    return ['section_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.section.transition', 'placement_section', $section->id);
        }
    }

    /** @param  array<string, float>  $weights */
    private function assertWeights(array $weights): void
    {
        foreach (PlacementComponent::all() as $component) {
            if (! isset($weights[$component]) || (float) $weights[$component] <= 0) {
                throw BusinessRejection::forCode('placement.test_weights_invalid', sprintf('component %s must carry a positive weight', $component));
            }
        }
        $sum = array_sum(array_map(static fn ($value): float => (float) $value, $weights));
        if (abs($sum - 100.0) > 0.01) {
            throw BusinessRejection::forCode('placement.test_weights_sum', sprintf('component weights must total 100 (got %.2f)', $sum));
        }
    }

    private static function assertTestTransition(string $from, string $to): void
    {
        $allowed = ['draft' => ['published'], 'published' => ['retired'], 'retired' => []];
        if (! in_array($to, $allowed[$from] ?? [], true)) {
            throw BusinessRejection::forCode('placement.test_transition_forbidden', sprintf('test transition %s -> %s is not allowed', $from, $to));
        }
    }

    private static function assertVersionTransition(string $from, string $to): void
    {
        $allowed = ['draft' => ['published', 'retired'], 'published' => ['retired'], 'retired' => []];
        if (! in_array($to, $allowed[$from] ?? [], true)) {
            throw BusinessRejection::forCode('placement.version_transition_forbidden', sprintf('version transition %s -> %s is not allowed', $from, $to));
        }
    }

    private static function assertObjectTransition(string $from, string $to): void
    {
        $allowed = ['draft' => ['published', 'retired'], 'published' => ['retired'], 'retired' => []];
        if (! in_array($to, $allowed[$from] ?? [], true)) {
            throw BusinessRejection::forCode('placement.catalog_transition_forbidden', sprintf('catalog transition %s -> %s is not allowed', $from, $to));
        }
    }

    private function requireVersionBranch(Actor $actor, PlacementTestVersion $version): void
    {
        $branchId = PlacementTest::query()->whereKey($version->placement_test_id)->value('originating_branch_id');
        $this->require($actor, $branchId);
    }

    private function requireSectionBranch(Actor $actor, PlacementSection $section): void
    {
        $branchId = PlacementTest::query()
            ->whereKey(PlacementTestVersion::query()->whereKey($section->test_version_id)->value('placement_test_id'))
            ->value('originating_branch_id');
        $this->require($actor, $branchId);
    }

    private function requireQuestionBranch(Actor $actor, PlacementQuestion $question): void
    {
        $section = PlacementSection::query()->find($question->section_id);
        $branchId = null;
        if ($section !== null) {
            $branchId = PlacementTest::query()
                ->whereKey(PlacementTestVersion::query()->whereKey($section->test_version_id)->value('placement_test_id'))
                ->value('originating_branch_id');
        }
        $this->require($actor, $branchId);
    }

    private function require(Actor $actor, ?string $branchId): void
    {
        $this->access->require($actor, self::CAPABILITY, $branchId);
    }
}
