<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Commands;

use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Placement\Domain\PlacementAccess;
use App\Modules\Academic\Placement\Domain\PlacementBand;
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
use App\Modules\Organization\Models\Branch;
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
                    $branchId = $branchId === null ? null : trim($branchId);
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
                        ...$this->branchProvenance($branchId),
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
                    $event = $this->audit->record($actor->actorId, 'placement.test.transition', 'placement_test', $locked->id, ['lifecycle_state' => $locked->getOriginal('lifecycle_state')], [
                        'lifecycle_state' => $toState,
                        ...$this->branchProvenance((string) $locked->originating_branch_id),
                    ]);

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
                    if ($locked->lifecycle_state === 'retired') {
                        throw BusinessRejection::forCode('placement.version_test_retired', 'a new placement version cannot be created for a retired test');
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
                        ...$this->branchProvenance((string) $locked->originating_branch_id),
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
                    if ($toState === 'published') {
                        $this->assertVersionPublishable($locked);
                    }
                    $locked->forceFill([
                        'lifecycle_state' => $toState,
                        'published_at' => $toState === 'published' ? now() : $locked->published_at,
                    ])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.version.transition', 'placement_test_version', $locked->id, ['lifecycle_state' => $locked->getOriginal('lifecycle_state')], [
                        'lifecycle_state' => $toState,
                        ...$this->branchProvenance((string) $test->originating_branch_id),
                    ]);

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
                    /** @var PlacementTestVersion $lockedVersion */
                    $lockedVersion = PlacementTestVersion::query()->whereKey($version->id)->lockForUpdate()->firstOrFail();
                    $this->requireVersionBranch($actor, $lockedVersion);
                    if ($lockedVersion->lifecycle_state !== 'draft') {
                        throw BusinessRejection::forCode('placement.catalog_version_not_draft', 'sections can be defined only on a draft placement version');
                    }
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
                    // A digital bank keeps human marking to productive
                    // writing/speaking. A fully proctored physical bank may
                    // instead preserve its paper/recording as the evidence
                    // source and have an accountable marker score any
                    // component; this is the only valid evidence-only
                    // physical delivery shape.
                    if (! $canAutoScore
                        && $deliveryMode !== PlacementDelivery::PHYSICAL
                        && ! in_array($component, ['writing', 'speaking'], true)) {
                        throw BusinessRejection::forCode('placement.section_manual_component', 'a non-auto-scored digital section must be writing or speaking');
                    }
                    /** @var PlacementTest $test */
                    $test = PlacementTest::query()->whereKey($lockedVersion->placement_test_id)->lockForUpdate()->firstOrFail();
                    $allocatedMinutes = (int) PlacementSection::query()
                        ->where('test_version_id', $lockedVersion->id)
                        ->sum('time_minutes');
                    if ($allocatedMinutes + $timeMinutes > (int) $test->total_time_minutes) {
                        throw BusinessRejection::forCode('placement.section_time_exceeds_test', 'section timing cannot exceed the authoritative total test duration');
                    }

                    $section = PlacementSection::query()->create([
                        'id' => RandomIdentifier::new(),
                        'test_version_id' => $lockedVersion->id,
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
                        'version_id' => $lockedVersion->id, 'component' => $component,
                        ...$this->versionProvenance($lockedVersion),
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
    public function defineQuestion(Actor $actor, PlacementSection $section, string $code, string $stem, string $questionType, float $points, ?array $options, ?string $correctAnswer, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'placement.question.define', $section->id, $code, $stem, $questionType, (string) $points,
            $options === null ? '' : json_encode($options), $correctAnswer ?? '', $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('placement.question.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $section, $code, $stem, $questionType, $points, $options, $correctAnswer): array {
                    /** @var PlacementSection $lockedSection */
                    $lockedSection = PlacementSection::query()->whereKey($section->id)->lockForUpdate()->firstOrFail();
                    /** @var PlacementTestVersion $version */
                    $version = PlacementTestVersion::query()->whereKey($lockedSection->test_version_id)->lockForUpdate()->firstOrFail();
                    $this->requireSectionBranch($actor, $lockedSection);
                    if ($version->lifecycle_state !== 'draft' || $lockedSection->lifecycle_state !== 'draft') {
                        throw BusinessRejection::forCode('placement.catalog_section_not_draft', 'questions can be defined only on a draft section of a draft placement version');
                    }
                    PlacementComponent::require($lockedSection->component);
                    if (! in_array($questionType, self::QUESTION_TYPES, true)) {
                        throw BusinessRejection::forCode('placement.question_type_unknown', sprintf('unknown question type %s', $questionType));
                    }
                    if ($lockedSection->can_auto_score && ! in_array($questionType, ['mcq', 'short_answer'], true)) {
                        throw BusinessRejection::forCode('placement.question_auto_type_invalid', 'an auto-scored placement section may contain only mcq or short-answer questions');
                    }
                    if (! $lockedSection->can_auto_score
                        && $lockedSection->delivery_mode !== PlacementDelivery::PHYSICAL
                        && ! in_array($questionType, ['essay', 'speaking'], true)) {
                        throw BusinessRejection::forCode('placement.question_professional_type_invalid', 'a professionally marked digital placement section must contain essay or speaking evidence');
                    }
                    if ($code === '' || $stem === '') {
                        throw BusinessRejection::forCode('placement.question_required_fields', 'a question requires a code and a stem');
                    }
                    if ($points <= 0) {
                        throw BusinessRejection::forCode('placement.question_points_invalid', 'question points must be positive');
                    }
                    $correctAnswer = $correctAnswer === null ? null : trim($correctAnswer);
                    if ($lockedSection->can_auto_score && ($correctAnswer === null || $correctAnswer === '')) {
                        throw BusinessRejection::forCode('placement.question_answer_required', 'auto-scored questions require a correct answer');
                    }
                    if (! $lockedSection->can_auto_score && $correctAnswer !== null) {
                        throw BusinessRejection::forCode('placement.question_answer_forbidden', 'professionally marked questions must not carry a competing server answer key');
                    }

                    $question = PlacementQuestion::query()->create([
                        'id' => RandomIdentifier::new(),
                        'section_id' => $lockedSection->id,
                        'code' => $code,
                        'stem' => $stem,
                        'component' => $lockedSection->component,
                        'question_type' => $questionType,
                        'points' => $points,
                        'options' => $options,
                        'correct_answer' => $correctAnswer,
                        // Question media is represented only by immutable,
                        // checksummed placement_question_media rows. The
                        // legacy media_ref column is deliberately left null.
                        'lifecycle_state' => 'draft',
                    ]);
                    $event = $this->audit->record($actor->actorId, 'placement.question.define', 'placement_question', $question->id, null, [
                        'section_id' => $lockedSection->id, 'question_type' => $questionType,
                        ...$this->sectionProvenance($lockedSection),
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
                    /** @var PlacementQuestion $lockedQuestion */
                    $lockedQuestion = PlacementQuestion::query()->whereKey($question->id)->lockForUpdate()->firstOrFail();
                    /** @var PlacementSection $section */
                    $section = PlacementSection::query()->whereKey($lockedQuestion->section_id)->lockForUpdate()->firstOrFail();
                    /** @var PlacementTestVersion $version */
                    $version = PlacementTestVersion::query()->whereKey($section->test_version_id)->lockForUpdate()->firstOrFail();
                    $this->requireQuestionBranch($actor, $lockedQuestion);
                    if ($version->lifecycle_state !== 'draft' || $section->lifecycle_state !== 'draft' || $lockedQuestion->lifecycle_state !== 'draft') {
                        throw BusinessRejection::forCode('placement.catalog_question_not_draft', 'media can be attached only to a draft question of a draft placement version');
                    }
                    if ($uri === '' || $mediaType === '') {
                        throw BusinessRejection::forCode('placement.media_required_fields', 'media requires a uri and type');
                    }
                    if (preg_match('/^[0-9a-f]{64}$/', $sha256) !== 1) {
                        throw BusinessRejection::forCode('placement.media_checksum_invalid', 'media sha256 must be 64 lowercase hex characters');
                    }
                    $media = PlacementQuestionMedia::query()->create([
                        'id' => RandomIdentifier::new(),
                        'question_id' => $lockedQuestion->id,
                        'uri' => $uri,
                        'media_type' => $mediaType,
                        'sha256' => $sha256,
                        'mime_type' => $mimeType,
                        'lifecycle_state' => 'active',
                    ]);
                    $event = $this->audit->record($actor->actorId, 'placement.media.attach', 'placement_question_media', $media->id, null, [
                        'question_id' => $lockedQuestion->id, 'sha256' => $sha256,
                        ...$this->questionProvenance($lockedQuestion),
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
                    /** @var PlacementTestVersion $lockedVersion */
                    $lockedVersion = PlacementTestVersion::query()->whereKey($version->id)->lockForUpdate()->firstOrFail();
                    $this->requireVersionBranch($actor, $lockedVersion);
                    if ($lockedVersion->lifecycle_state !== 'draft') {
                        throw BusinessRejection::forCode('placement.catalog_version_not_draft', 'rubrics can be defined only on a draft placement version');
                    }
                    PlacementComponent::require($component);
                    $cefrRef = strtoupper(trim($cefrRef));
                    if ($band === '' || $description === '' || $cefrRef === '') {
                        throw BusinessRejection::forCode('placement.rubric_required_fields', 'a rubric requires a band, CEFR reference, and description');
                    }
                    if (! in_array($cefrRef, PlacementBand::order(), true)) {
                        throw BusinessRejection::forCode('placement.rubric_cefr_invalid', 'a placement rubric CEFR reference must be one of A1, A2, B1, B2, or C1');
                    }
                    if ($minScore < 0 || $maxScore < 0 || $minScore > $maxScore || $maxScore > 100) {
                        throw BusinessRejection::forCode('placement.rubric_range_invalid', 'rubric score range must be within 0-100 and non-inverted');
                    }
                    $rubric = PlacementRubric::query()->create([
                        'id' => RandomIdentifier::new(),
                        'test_version_id' => $lockedVersion->id,
                        'component' => $component,
                        'band' => $band,
                        'min_score' => $minScore,
                        'max_score' => $maxScore,
                        'cefr_ref' => $cefrRef,
                        'description' => $description,
                        'lifecycle_state' => 'draft',
                    ]);
                    $event = $this->audit->record($actor->actorId, 'placement.rubric.define', 'placement_rubric', $rubric->id, null, [
                        'version_id' => $lockedVersion->id, 'component' => $component, 'cefr' => $cefrRef,
                        ...$this->versionProvenance($lockedVersion),
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
                    /** @var PlacementTestVersion $version */
                    $version = PlacementTestVersion::query()->whereKey($locked->test_version_id)->lockForUpdate()->firstOrFail();
                    $this->requireVersionBranch($actor, $version);
                    $this->requireCatalogMutableVersion($version);
                    self::assertObjectTransition($locked->lifecycle_state, $toState);
                    $locked->forceFill(['lifecycle_state' => $toState])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.rubric.transition', 'placement_rubric', $locked->id, ['lifecycle_state' => $locked->getOriginal('lifecycle_state')], [
                        'lifecycle_state' => $toState,
                        ...$this->versionProvenance($version),
                    ]);

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
                    /** @var PlacementSection $section */
                    $section = PlacementSection::query()->whereKey($locked->section_id)->lockForUpdate()->firstOrFail();
                    /** @var PlacementTestVersion $version */
                    $version = PlacementTestVersion::query()->whereKey($section->test_version_id)->lockForUpdate()->firstOrFail();
                    $this->requireQuestionBranch($actor, $locked);
                    $this->requireCatalogMutableVersion($version);
                    self::assertObjectTransition($locked->lifecycle_state, $toState);
                    $locked->forceFill(['lifecycle_state' => $toState])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.question.transition', 'placement_question', $locked->id, ['lifecycle_state' => $locked->getOriginal('lifecycle_state')], [
                        'lifecycle_state' => $toState,
                        ...$this->questionProvenance($locked),
                    ]);

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
                    /** @var PlacementTestVersion $version */
                    $version = PlacementTestVersion::query()->whereKey($locked->test_version_id)->lockForUpdate()->firstOrFail();
                    $this->requireSectionBranch($actor, $locked);
                    $this->requireCatalogMutableVersion($version);
                    self::assertObjectTransition($locked->lifecycle_state, $toState);
                    $locked->forceFill(['lifecycle_state' => $toState])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.section.transition', 'placement_section', $locked->id, ['lifecycle_state' => $locked->getOriginal('lifecycle_state')], [
                        'lifecycle_state' => $toState,
                        ...$this->sectionProvenance($locked),
                    ]);

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
        $unknownComponents = array_diff(array_keys($weights), PlacementComponent::all());
        if ($unknownComponents !== [] || count($weights) !== count(PlacementComponent::all())) {
            throw BusinessRejection::forCode('placement.test_weights_invalid', 'component weights must contain exactly the five canonical placement components');
        }
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

    private function requireCatalogMutableVersion(PlacementTestVersion $version): void
    {
        if ($version->lifecycle_state !== 'draft') {
            throw BusinessRejection::forCode('placement.catalog_version_not_draft', 'published or retired placement versions are immutable; publish a corrected version instead');
        }
    }

    /**
     * A published test version is the frozen scoring contract. Do not publish
     * a partial bank and discover missing components only after candidates
     * have submitted evidence.
     */
    private function assertVersionPublishable(PlacementTestVersion $version): void
    {
        $sections = PlacementSection::query()
            ->where('test_version_id', $version->id)
            ->orderBy('section_order')
            ->get();
        if ($sections->count() !== count(PlacementComponent::all())
            || array_diff($sections->pluck('component')->all(), PlacementComponent::all()) !== []) {
            throw BusinessRejection::forCode('placement.version_component_incomplete', 'a published placement version requires exactly the five canonical component sections');
        }
        if ($sections->pluck('delivery_mode')->unique()->count() !== 1) {
            throw BusinessRejection::forCode('placement.version_delivery_mixed', 'every section in an attemptable placement version must use one coherent delivery mode');
        }
        $versionQuestionIds = PlacementQuestion::query()
            ->whereIn('section_id', $sections->pluck('id'))
            ->pluck('id');
        if (PlacementQuestion::query()
            ->whereIn('id', $versionQuestionIds)
            ->whereNotNull('media_ref')
            ->exists()) {
            throw BusinessRejection::forCode('placement.version_legacy_media_reference', 'a publishable placement version must use checksummed question-media records rather than the legacy media reference');
        }
        $invalidActiveMedia = PlacementQuestionMedia::query()
            ->whereIn('question_id', $versionQuestionIds)
            ->where('lifecycle_state', 'active')
            ->get()
            ->contains(static fn (PlacementQuestionMedia $media): bool => trim($media->uri) === ''
                || trim($media->media_type) === ''
                || trim($media->mime_type) === ''
                || preg_match('/^[0-9a-f]{64}$/', $media->sha256) !== 1);
        if ($invalidActiveMedia) {
            throw BusinessRejection::forCode('placement.version_media_invalid', 'active placement question media must carry immutable complete checksum metadata before publication');
        }

        foreach (PlacementComponent::all() as $component) {
            $componentSections = $sections->where('component', $component)->values();
            if ($componentSections->count() !== 1) {
                throw BusinessRejection::forCode('placement.version_component_incomplete', sprintf('a published placement version requires exactly one %s section', $component));
            }
            /** @var PlacementSection|null $section */
            $section = $componentSections->first();
            if ($section === null || $section->lifecycle_state !== 'published') {
                throw BusinessRejection::forCode('placement.version_section_not_published', sprintf('placement section %s must be published with its version', $section?->code ?? $component));
            }
            if (! $section->can_auto_score
                && $section->delivery_mode !== PlacementDelivery::PHYSICAL
                && ! in_array($section->component, ['writing', 'speaking'], true)) {
                throw BusinessRejection::forCode('placement.version_manual_component_invalid', sprintf('only writing or speaking may require professional marking in a digital version (%s)', $section->code));
            }
            $questions = PlacementQuestion::query()
                ->where('section_id', $section->id)
                ->get();
            if ($questions->isEmpty() || $questions->contains(fn (PlacementQuestion $question): bool => $question->lifecycle_state !== 'published')) {
                throw BusinessRejection::forCode('placement.version_section_empty', sprintf('placement section %s requires only published evidence questions', $section->code));
            }
            $allowedTypes = $section->can_auto_score
                ? ['mcq', 'short_answer']
                : ($section->delivery_mode === PlacementDelivery::PHYSICAL
                    ? self::QUESTION_TYPES
                    : ['essay', 'speaking']);
            if ($questions->contains(fn (PlacementQuestion $question): bool => $question->component !== $section->component || ! in_array($question->question_type, $allowedTypes, true))) {
                throw BusinessRejection::forCode('placement.version_question_type_invalid', sprintf('placement section %s contains a mismatched component or question type incompatible with its scoring mode', $section->code));
            }
            if ($section->can_auto_score && $questions->contains(static fn (PlacementQuestion $question): bool => trim((string) $question->correct_answer) === '')) {
                throw BusinessRejection::forCode('placement.version_question_answer_missing', sprintf('auto-scored placement section %s requires a server-side correct answer for every question', $section->code));
            }
            if (! $section->can_auto_score && $questions->contains(static fn (PlacementQuestion $question): bool => $question->correct_answer !== null)) {
                throw BusinessRejection::forCode('placement.version_question_answer_forbidden', sprintf('professionally marked placement section %s must not retain a server auto-score answer', $section->code));
            }
            $this->assertComponentRubricCoverage($version, $component);
        }
    }

    private function assertComponentRubricCoverage(PlacementTestVersion $version, string $component): void
    {
        $rubrics = PlacementRubric::query()
            ->where('test_version_id', $version->id)
            ->where('component', $component)
            ->orderBy('min_score')
            ->get();
        if ($rubrics->isEmpty() || $rubrics->contains(static fn (PlacementRubric $rubric): bool => $rubric->lifecycle_state !== 'published')) {
            throw BusinessRejection::forCode('placement.version_rubric_incomplete', sprintf('the %s component requires only published scoring rubrics', $component));
        }

        $nextMinimum = 0.0;
        foreach ($rubrics as $rubric) {
            $minimum = (float) $rubric->min_score;
            $maximum = (float) $rubric->max_score;
            if (abs($minimum - $nextMinimum) > 0.005 || $maximum < $minimum || $maximum > 100.0) {
                throw BusinessRejection::forCode('placement.version_rubric_coverage_invalid', sprintf('published %s rubrics must provide contiguous, non-overlapping coverage from 0 to 100', $component));
            }
            $nextMinimum = round($maximum + 0.01, 2);
        }
        if (abs($nextMinimum - 100.01) > 0.005) {
            throw BusinessRejection::forCode('placement.version_rubric_coverage_invalid', sprintf('published %s rubrics must provide contiguous, non-overlapping coverage from 0 to 100', $component));
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

    /** @return array{branch_id: string, campus_id: string, organization_id: string} */
    private function branchProvenance(?string $branchId): array
    {
        $id = trim((string) ($branchId ?? ''));
        if ($id === '') {
            throw BusinessRejection::forCode('placement.provenance_required', 'a placement catalog event requires an operational branch provenance');
        }
        $branch = Branch::query()->whereKey($id)->first();
        if ($branch === null || $branch->lifecycle_state !== 'active') {
            throw BusinessRejection::forCode('placement.provenance_required', 'a placement event requires an active branch provenance');
        }
        $scope = $branch->structureScope();
        if ($scope->organizationId === '' || $scope->campusId === null) {
            throw BusinessRejection::forCode('placement.provenance_required', 'a placement event requires active campus organization provenance');
        }

        return ['branch_id' => (string) $branch->id, 'campus_id' => (string) $scope->campusId, 'organization_id' => $scope->organizationId];
    }

    /** @return array{branch_id: string, campus_id: string, organization_id: string} */
    private function versionProvenance(PlacementTestVersion $version): array
    {
        $testId = trim((string) $version->placement_test_id);

        return $this->branchProvenance(PlacementTest::query()->whereKey($testId)->value('originating_branch_id'));
    }

    /** @return array{branch_id: string, campus_id: string, organization_id: string} */
    private function sectionProvenance(PlacementSection $section): array
    {
        $version = PlacementTestVersion::query()->whereKey($section->test_version_id)->first();
        if ($version === null) {
            throw BusinessRejection::forCode('placement.provenance_required', 'a placement section requires a source version');
        }

        return $this->versionProvenance($version);
    }

    /** @return array{branch_id: string, campus_id: string, organization_id: string} */
    private function questionProvenance(PlacementQuestion $question): array
    {
        $section = PlacementSection::query()->whereKey($question->section_id)->first();
        if ($section === null) {
            throw BusinessRejection::forCode('placement.provenance_required', 'a placement question requires a source section');
        }

        return $this->sectionProvenance($section);
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
