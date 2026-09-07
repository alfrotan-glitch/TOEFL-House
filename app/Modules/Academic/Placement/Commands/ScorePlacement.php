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
use App\Modules\Organization\Models\Branch;
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
                    if ($locked->lineage_version !== PlacementAttempt::LINEAGE_VERSION) {
                        throw BusinessRejection::forCode('placement.attempt_lineage_remediation_required', 'a pre-lineage placement attempt cannot receive new score evidence without governed remediation');
                    }
                    /** @var PlacementSection $section */
                    $section = PlacementSection::query()->whereKey($sectionId)->firstOrFail();
                    if ($section->test_version_id !== $locked->test_version_id || $section->lifecycle_state !== 'published') {
                        throw BusinessRejection::forCode('placement.section_version_mismatch', 'the section must be a published section in this exact attempt version');
                    }
                    if ($section->can_auto_score) {
                        throw BusinessRejection::forCode('placement.section_auto_score_authority', 'an auto-scored section is calculated only from normalized submitted answers, never manually overwritten');
                    }
                    if ($rawScore < 0 || $rawScore > 100) {
                        throw BusinessRejection::forCode('placement.section_score_invalid', 'a professional section score must be between 0 and 100');
                    }
                    if ($rationale === '') {
                        throw BusinessRejection::forCode('placement.section_rationale_required', 'professional marking requires a rationale');
                    }
                    if ($rubricId === null || trim($rubricId) === '') {
                        throw BusinessRejection::forCode('placement.section_rubric_required', 'professional placement marking requires a published rubric');
                    }
                    /** @var PlacementRubric $rubric */
                    $rubric = PlacementRubric::query()->whereKey($rubricId)->firstOrFail();
                    if ($rubric->test_version_id !== $locked->test_version_id || $rubric->component !== $section->component) {
                        throw BusinessRejection::forCode('placement.section_rubric_mismatch', 'the rubric does not match this section version/component');
                    }
                    if ($rubric->lifecycle_state !== 'published') {
                        throw BusinessRejection::forCode('placement.section_rubric_not_published', 'professional placement marking requires a published rubric');
                    }
                    if ($rawScore < (float) $rubric->min_score || $rawScore > (float) $rubric->max_score) {
                        throw BusinessRejection::forCode('placement.section_score_out_of_rubric', sprintf('score %.2f is outside rubric %s [%.2f, %.2f]', $rawScore, $rubric->band, (float) $rubric->min_score, (float) $rubric->max_score));
                    }
                    if ($cefrRef !== null && trim($cefrRef) !== '' && strtoupper(trim($cefrRef)) !== strtoupper((string) $rubric->cefr_ref)) {
                        throw BusinessRejection::forCode('placement.section_cefr_rubric_mismatch', 'the stated CEFR reference must match the published scoring rubric');
                    }
                    $cefrRef = (string) $rubric->cefr_ref;

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
                            'scoring_method' => PlacementSectionResult::SCORING_METHOD_PROFESSIONAL,
                            'scored_by' => $scorer->actorId,
                            'rationale' => $rationale,
                        ]);
                    } else {
                        if ($result->lifecycle_state !== PlacementSectionResult::STATE_SCORED
                            || $result->raw_score !== null
                            || $result->scoring_method !== PlacementSectionResult::SCORING_METHOD_PROFESSIONAL
                            || $result->scored_by !== null) {
                            throw BusinessRejection::forCode('placement.section_result_locked', 'only an unscored professional-marking stub can be completed');
                        }
                        $result->forceFill([
                            'raw_score' => $rawScore,
                            'rubric_id' => $rubricId,
                            'cefr_ref' => $cefrRef,
                            'scored_by' => $scorer->actorId,
                            'rationale' => $rationale,
                        ])->save();
                    }
                    $event = $this->audit->record($scorer->actorId, 'placement.section.score', 'placement_section_result', $result->id, null, [
                        'attempt_id' => $locked->id, 'section_id' => $section->id, 'score' => $rawScore, 'cefr' => $cefrRef,
                        ...$this->branchProvenance($locked->originating_branch_id),
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
                    if ($attempt->lineage_version !== PlacementAttempt::LINEAGE_VERSION) {
                        throw BusinessRejection::forCode('placement.attempt_lineage_remediation_required', 'a pre-lineage placement attempt cannot receive a new review transition without governed remediation');
                    }
                    if ($toState === PlacementSectionResult::STATE_MODERATED && $locked->raw_score === null) {
                        throw BusinessRejection::forCode('placement.section_score_incomplete', 'an unscored professional-marking stub must receive its rubric score before moderation');
                    }
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
                    $event = $this->audit->record($actor->actorId, 'placement.section.'.$verb, 'placement_section_result', $locked->id, $before, [
                        'lifecycle_state' => $toState,
                        ...$this->branchProvenance($attempt->originating_branch_id),
                    ]);

                    return ['section_result_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.section.'.$verb, 'placement_section_result', $result->id);
        }
    }

    /** @return array{branch_id: string, campus_id: string, organization_id: string} */
    private function branchProvenance(?string $branchId): array
    {
        $id = trim((string) ($branchId ?? ''));
        if ($id === '') {
            throw BusinessRejection::forCode('placement.scoring_provenance_required', 'a placement scoring event requires an operational branch provenance');
        }
        $branch = Branch::query()->whereKey($id)->first();
        if ($branch === null || $branch->lifecycle_state !== 'active') {
            throw BusinessRejection::forCode('placement.scoring_provenance_required', 'a placement scoring event requires an active branch provenance');
        }
        $scope = $branch->structureScope();
        if ($scope->organizationId === '' || $scope->campusId === null) {
            throw BusinessRejection::forCode('placement.scoring_provenance_required', 'a placement scoring event requires active campus organization provenance');
        }

        return ['branch_id' => (string) $branch->id, 'campus_id' => (string) $scope->campusId, 'organization_id' => $scope->organizationId];
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
