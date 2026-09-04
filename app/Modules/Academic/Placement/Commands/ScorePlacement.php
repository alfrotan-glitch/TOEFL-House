<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Commands;

use App\Modules\Academic\Placement\Domain\PlacementAccess;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementRubric;
use App\Modules\Academic\Placement\Models\PlacementSection;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Professional marking + section-level staged review. Productive sections
 * (writing/speaking) are marked against a rubric; every section passes an
 * independent moderation/approval before a profile recommendation can go to
 * academic review.
 */
final class ScorePlacement
{
    public const CAPABILITY_SCORE = 'placement.score';

    public const CAPABILITY_MODERATE = 'placement.moderate';

    public const CAPABILITY_APPROVE = 'placement.approve';

    public function __construct(
        private readonly PlacementAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{section_result_id: string, correlation_id: string} */
    public function scoreSection(Actor $scorer, PlacementAttempt $attempt, string $sectionId, float $rawScore, ?string $rubricId, ?string $cefrRef, string $rationale, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'placement.section.score', $attempt->id, $sectionId, (string) $rawScore,
            $rubricId ?? '', $cefrRef ?? '', $rationale, $scorer->actorId,
        ]));

        try {
            return $this->idempotency->execute('placement.section.score', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($scorer, $attempt, $sectionId, $rawScore, $rubricId, $cefrRef, $rationale): array {
                    /** @var PlacementAttempt $locked */
                    $locked = PlacementAttempt::query()->whereKey($attempt->id)->lockForUpdate()->firstOrFail();
                    $this->access->require($scorer, self::CAPABILITY_SCORE, $locked->originating_branch_id);
                    if ($locked->status !== PlacementAttempt::STATUS_SUBMITTED) {
                        throw BusinessRejection::forCode('placement.section_attempt_not_submitted', 'sections can be scored only after the attempt is submitted');
                    }
                    /** @var PlacementSection $section */
                    $section = PlacementSection::query()->whereKey($sectionId)->firstOrFail();
                    if ($section->test_version_id !== $locked->test_version_id) {
                        throw BusinessRejection::forCode('placement.section_version_mismatch', 'the section does not belong to this attempt version');
                    }
                    if ($rawScore < 0) {
                        throw BusinessRejection::forCode('placement.section_score_invalid', 'a section score cannot be negative');
                    }
                    if ($rationale === '') {
                        throw BusinessRejection::forCode('placement.section_rationale_required', 'professional marking requires a rationale');
                    }
                    if ($rubricId !== null) {
                        /** @var PlacementRubric $rubric */
                        $rubric = PlacementRubric::query()->whereKey($rubricId)->firstOrFail();
                        if ($rubric->test_version_id !== $locked->test_version_id || $rubric->component !== $section->component) {
                            throw BusinessRejection::forCode('placement.section_rubric_mismatch', 'the rubric does not match this section version/component');
                        }
                        if ($rawScore < (float) $rubric->min_score || $rawScore > (float) $rubric->max_score) {
                            throw BusinessRejection::forCode('placement.section_score_out_of_rubric', sprintf('score %.2f is outside rubric %s [%.2f, %.2f]', $rawScore, $rubric->band, (float) $rubric->min_score, (float) $rubric->max_score));
                        }
                        $cefrRef ??= $rubric->cefr_ref;
                    }
                    if ($cefrRef === '' || $cefrRef === null) {
                        throw BusinessRejection::forCode('placement.section_cefr_required', 'a section score requires a CEFR reference');
                    }

                    /** @var PlacementSectionResult|null $result */
                    $result = PlacementSectionResult::query()->where('attempt_id', $locked->id)->where('section_id', $section->id)->lockForUpdate()->first();
                    if ($result === null) {
                        $result = PlacementSectionResult::query()->create([
                            'id' => RandomIdentifier::new(),
                            'attempt_id' => $locked->id,
                            'section_id' => $section->id,
                            'component' => $section->component,
                            'raw_score' => $rawScore,
                            'rubric_id' => $rubricId,
                            'cefr_ref' => $cefrRef,
                            'lifecycle_state' => PlacementSectionResult::STATE_SCORED,
                            'scored_by' => $scorer->actorId,
                            'rationale' => $rationale,
                        ]);
                    } else {
                        if ($result->lifecycle_state !== PlacementSectionResult::STATE_SCORED || $result->raw_score !== null) {
                            throw BusinessRejection::forCode('placement.section_result_locked', 'only an unscored, not-approved section result can be professional-marked');
                        }
                        $result->forceFill([
                            'raw_score' => $rawScore,
                            'rubric_id' => $rubricId,
                            'cefr_ref' => $cefrRef,
                            'rationale' => $rationale,
                        ])->save();
                    }
                    $event = $this->audit->record($scorer->actorId, 'placement.section.score', 'placement_section_result', $result->id, null, [
                        'attempt_id' => $locked->id, 'section_id' => $section->id, 'score' => $rawScore, 'cefr' => $cefrRef,
                    ]);

                    return ['section_result_id' => $result->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $scorer, 'placement.section.score', 'placement_attempt', $attempt->id);
        }
    }

    /** @return array{section_result_id: string, lifecycle_state: string, correlation_id: string} */
    public function moderateSection(Actor $moderator, PlacementSectionResult $result, string $idempotencyKey): array
    {
        return $this->transitionSectionResult($moderator, $result, PlacementSectionResult::STATE_MODERATED, self::CAPABILITY_MODERATE, 'moderate', $idempotencyKey);
    }

    /** @return array{section_result_id: string, lifecycle_state: string, correlation_id: string} */
    public function approveSection(Actor $approver, PlacementSectionResult $result, string $idempotencyKey): array
    {
        return $this->transitionSectionResult($approver, $result, PlacementSectionResult::STATE_APPROVED, self::CAPABILITY_APPROVE, 'approve', $idempotencyKey);
    }

    /** @return array{section_result_id: string, lifecycle_state: string, correlation_id: string} */
    private function transitionSectionResult(Actor $actor, PlacementSectionResult $result, string $toState, string $capability, string $verb, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['placement.section.'.$verb, $result->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('placement.section.'.$verb, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $result, $toState, $capability, $verb): array {
                    /** @var PlacementSectionResult $locked */
                    $locked = PlacementSectionResult::query()->whereKey($result->id)->lockForUpdate()->firstOrFail();
                    $attempt = PlacementAttempt::query()->findOrFail($locked->attempt_id);
                    $this->access->require($actor, $capability, $attempt->originating_branch_id);
                    $this->assertTransition($locked, $toState);
                    if ($toState === PlacementSectionResult::STATE_MODERATED && trim((string) $locked->scored_by) === $actor->actorId) {
                        throw AuthorizationDenied::forCode('placement.review_not_independent', 'the moderator may not be the scorer of the section under review');
                    }
                    if ($toState === PlacementSectionResult::STATE_APPROVED && trim((string) $locked->scored_by) === $actor->actorId) {
                        throw AuthorizationDenied::forCode('placement.review_not_independent', 'the approver may not be the scorer of the section under review');
                    }
                    if ($toState === PlacementSectionResult::STATE_APPROVED && trim((string) $locked->moderated_by) === $actor->actorId) {
                        throw AuthorizationDenied::forCode('placement.approval_not_independent', 'the approver must differ from the moderator');
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill([
                        'lifecycle_state' => $toState,
                        $toState === PlacementSectionResult::STATE_MODERATED ? 'moderated_by' : 'approved_by' => $actor->actorId,
                    ])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.section.'.$verb, 'placement_section_result', $locked->id, $before, ['lifecycle_state' => $toState]);

                    return ['section_result_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.section.'.$verb, 'placement_section_result', $result->id);
        }
    }

    private function assertTransition(PlacementSectionResult $result, string $toState): void
    {
        $allowed = [
            PlacementSectionResult::STATE_SCORED => [PlacementSectionResult::STATE_MODERATED],
            PlacementSectionResult::STATE_MODERATED => [PlacementSectionResult::STATE_APPROVED],
            PlacementSectionResult::STATE_APPROVED => [],
        ];
        if (! in_array($toState, $allowed[$result->lifecycle_state] ?? [], true)) {
            throw BusinessRejection::forCode('placement.section_transition_forbidden', sprintf('section result transition %s -> %s is not allowed', $result->lifecycle_state, $toState));
        }
    }
}
