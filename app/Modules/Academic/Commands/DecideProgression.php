<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\AcademicAccess;
use App\Modules\Academic\Domain\EnrollmentLifecycle;
use App\Modules\Academic\Domain\ProgressionLifecycle;
use App\Modules\Academic\Domain\RecordBranch;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\LevelProgressFact;
use App\Modules\Academic\Models\LevelProgressionRule;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Academic\Queries\AcademicHistoryQuery;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Progression decisions are explicit, dated, and appealable: a teacher or
 * Academic member proposes, an independent Academic reviewer reviews, and
 * Academic Management approves — three distinct actors. No student
 * advances automatically (BR-ACAD-002). An appeal-resolved decision
 * supersedes the original, which is retained.
 */
final class DecideProgression
{
    public const CAPABILITY_PROPOSE = 'academic.progression_propose';

    public const CAPABILITY_REVIEW = 'academic.progression_review';

    public const CAPABILITY_APPROVE = 'academic.progression_approve';

    public function __construct(
        private readonly AcademicAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly AcademicHistoryQuery $history,
    ) {}

    /**
     * @return array{decision_id: string, correlation_id: string}
     */
    public function propose(Actor $proposer, string $studentId, string $classId, string $outcome, string $reason, string $idempotencyKey, ?string $assessmentResultId = null, ?string $basis = null, ?int $repeatCount = null): array
    {
        $payload = hash('sha256', implode('|', ['academic.progression.propose', $studentId, $classId, $outcome, $reason, $assessmentResultId ?? '', $basis ?? '', (string) ($repeatCount ?? ''), $proposer->actorId]));

        try {
            return $this->idempotency->execute('academic.progression.propose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($proposer, $studentId, $classId, $outcome, $reason, $assessmentResultId, $basis, $repeatCount): array {
                    $this->require($proposer, self::CAPABILITY_PROPOSE, RecordBranch::studentBranchForId($studentId), 'academic.progression_denied');
                    if (! in_array($outcome, ['advance', 'repeat'], true)) {
                        throw BusinessRejection::forCode('academic.progression_outcome_unknown', sprintf('unknown progression outcome %s', $outcome));
                    }
                    if ($reason === '') {
                        throw BusinessRejection::forCode('academic.progression_reason', 'a progression decision requires a reason');
                    }
                    if (ProgressionDecision::query()->where('student_id', $studentId)->where('class_id', $classId)->whereIn('lifecycle_state', ['proposed', 'reviewed', 'approved', 'appealed'])->exists()) {
                        throw BusinessRejection::forCode('academic.progression_open_decision', 'this student and class already have an open progression decision');
                    }

                    /** @var ClassModel $class */
                    $class = ClassModel::query()->whereKey($classId)->firstOrFail();
                    $levels = $this->resolveLevelFields($class, $studentId, $outcome, $assessmentResultId, $basis, $repeatCount);

                    $decision = ProgressionDecision::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $studentId,
                        'class_id' => $classId,
                        'outcome' => $outcome,
                        'reason' => $reason,
                        'lifecycle_state' => ProgressionLifecycle::STATE_PROPOSED,
                        'proposed_by' => $proposer->actorId,
                        'from_level_id' => $levels['from_level_id'],
                        'to_level_id' => $levels['to_level_id'],
                        'assessment_result_id' => $levels['assessment_result_id'],
                        'basis' => $levels['basis'],
                        'repeat_count' => $levels['repeat_count'],
                    ]);
                    $event = $this->audit->record($proposer->actorId, 'academic.progression.propose', 'progression_decision', $decision->id, null, [
                        'student_id' => $studentId, 'class_id' => $classId, 'outcome' => $outcome,
                        'from_level_id' => $levels['from_level_id'], 'to_level_id' => $levels['to_level_id'], 'basis' => $levels['basis'],
                    ]);

                    return ['decision_id' => $decision->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $proposer, 'academic.progression.propose', 'progression_decision', $studentId);
        }
    }

    /** @return array{decision_id: string, lifecycle_state: string, correlation_id: string} */
    public function review(Actor $reviewer, ProgressionDecision $decision, string $idempotencyKey): array
    {
        return $this->transition($reviewer, $decision, ProgressionLifecycle::STATE_REVIEWED, self::CAPABILITY_REVIEW, 'review', $idempotencyKey);
    }

    /** @return array{decision_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, ProgressionDecision $decision, string $idempotencyKey): array
    {
        return $this->transition($approver, $decision, ProgressionLifecycle::STATE_APPROVED, self::CAPABILITY_APPROVE, 'approve', $idempotencyKey);
    }

    /** @return array{decision_id: string, lifecycle_state: string, correlation_id: string} */
    public function reject(Actor $approver, ProgressionDecision $decision, string $idempotencyKey): array
    {
        return $this->transition($approver, $decision, ProgressionLifecycle::STATE_REJECTED, self::CAPABILITY_APPROVE, 'reject', $idempotencyKey);
    }

    /** @return array{decision_id: string, lifecycle_state: string, correlation_id: string} */
    public function markAppealed(Actor $actor, ProgressionDecision $decision, string $idempotencyKey): array
    {
        return $this->transition($actor, $decision, ProgressionLifecycle::STATE_APPEALED, self::CAPABILITY_REVIEW, 'mark_appealed', $idempotencyKey);
    }

    /**
     * Appeal resolution supersedes the original decision with a new
     * proposal; the original row stays in history pointing at its
     * successor.
     *
     * @return array{decision_id: string, superseded_id: string, correlation_id: string}
     */
    public function supersede(Actor $reviewer, Actor $approver, ProgressionDecision $original, string $outcome, string $reason, string $idempotencyKey, ?string $assessmentResultId = null, ?string $basis = null, ?int $repeatCount = null): array
    {
        $payload = hash('sha256', implode('|', ['academic.progression.supersede', $original->id, $outcome, $reason, $assessmentResultId ?? '', $basis ?? '', (string) ($repeatCount ?? ''), $reviewer->actorId, $approver->actorId]));

        try {
            return $this->idempotency->execute('academic.progression.supersede', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($reviewer, $approver, $original, $outcome, $reason, $assessmentResultId, $basis, $repeatCount): array {
                    $subjectBranch = RecordBranch::studentBranchForId((string) $original->student_id);
                    $this->require($reviewer, self::CAPABILITY_REVIEW, $subjectBranch, 'academic.progression_denied');
                    $this->require($approver, self::CAPABILITY_APPROVE, $subjectBranch, 'academic.progression_denied');
                    if (trim((string) $original->proposed_by) === $reviewer->actorId || trim((string) $original->proposed_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('academic.appeal_not_independent', 'the original decision-maker may not review or approve the appeal outcome');
                    }
                    if (! in_array($outcome, ['advance', 'repeat'], true) || $reason === '') {
                        throw BusinessRejection::forCode('academic.progression_reason', 'a superseding decision requires outcome and reason');
                    }

                    /** @var ProgressionDecision $locked */
                    $locked = ProgressionDecision::query()->whereKey($original->id)->lockForUpdate()->firstOrFail();
                    ProgressionLifecycle::requireTransition($locked->lifecycle_state, ProgressionLifecycle::STATE_SUPERSEDED);

                    /** @var ClassModel $class */
                    $class = ClassModel::query()->whereKey($locked->class_id)->firstOrFail();
                    $levels = $this->resolveLevelFields($class, $locked->student_id, $outcome, $assessmentResultId ?? $locked->assessment_result_id, $basis ?? $locked->basis, $repeatCount ?? $locked->repeat_count, $locked);

                    $successorId = RandomIdentifier::new();
                    $locked->forceFill(['lifecycle_state' => ProgressionLifecycle::STATE_SUPERSEDED, 'superseded_by_id' => $successorId]);
                    $locked->save();

                    $successor = ProgressionDecision::query()->create([
                        'id' => $successorId,
                        'student_id' => $locked->student_id,
                        'class_id' => $locked->class_id,
                        'outcome' => $outcome,
                        'reason' => $reason,
                        'lifecycle_state' => ProgressionLifecycle::STATE_APPROVED,
                        'proposed_by' => $reviewer->actorId,
                        'reviewed_by' => $reviewer->actorId,
                        'approved_by' => $approver->actorId,
                        'from_level_id' => $levels['from_level_id'],
                        'to_level_id' => $levels['to_level_id'],
                        'assessment_result_id' => $levels['assessment_result_id'],
                        'basis' => $levels['basis'],
                        'repeat_count' => $levels['repeat_count'],
                    ]);
                    $this->writeFact($successor);

                    $event = $this->audit->record($reviewer->actorId, 'academic.progression.supersede', 'progression_decision', $successor->id, ['outcome' => $locked->outcome], [
                        'supersedes_id' => $locked->id, 'outcome' => $outcome, 'reason' => $reason,
                    ]);

                    return ['decision_id' => $successor->id, 'superseded_id' => $locked->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $reviewer, 'academic.progression.supersede', 'progression_decision', $original->id);
        }
    }

    /** @return array{decision_id: string, lifecycle_state: string, correlation_id: string} */
    private function transition(Actor $actor, ProgressionDecision $decision, string $toState, string $capability, string $verb, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.progression.'.$verb, $decision->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.progression.'.$verb, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $decision, $toState, $capability, $verb): array {
                    /** @var ProgressionDecision $locked */
                    $locked = ProgressionDecision::query()->whereKey($decision->id)->lockForUpdate()->firstOrFail();
                    $this->require($actor, $capability, RecordBranch::progressionBranch($locked), 'academic.progression_denied');
                    ProgressionLifecycle::requireTransition($locked->lifecycle_state, $toState);
                    if (in_array($toState, [ProgressionLifecycle::STATE_REVIEWED], true) && trim((string) $locked->proposed_by) === $actor->actorId) {
                        throw AuthorizationDenied::forCode('academic.review_not_independent', 'the reviewer may not be the proposer of the decision under review');
                    }
                    if ($toState === ProgressionLifecycle::STATE_APPROVED && (trim((string) $locked->proposed_by) === $actor->actorId || trim((string) $locked->reviewed_by) === $actor->actorId)) {
                        throw AuthorizationDenied::forCode('academic.approval_not_independent', 'the approver must differ from the proposer and the reviewer');
                    }

                    if ($toState === ProgressionLifecycle::STATE_APPROVED) {
                        $this->revalidateLevelGates($locked);
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState]);
                    if ($toState === ProgressionLifecycle::STATE_REVIEWED) {
                        $locked->reviewed_by = $actor->actorId;
                    }
                    if ($toState === ProgressionLifecycle::STATE_APPROVED || $toState === ProgressionLifecycle::STATE_REJECTED) {
                        $locked->approved_by = $actor->actorId;
                    }
                    $locked->save();
                    if ($toState === ProgressionLifecycle::STATE_APPROVED) {
                        $this->writeFact($locked->fresh() ?? $locked);
                    }
                    $event = $this->audit->record($actor->actorId, 'academic.progression.'.$verb, 'progression_decision', $locked->id, $before, ['lifecycle_state' => $toState]);

                    return ['decision_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.progression.'.$verb, 'progression_decision', $decision->id);
        }
    }

    /**
     * Level-aware fields for a decision. Null fields mean the legacy
     * class-scoped path; a class that targets a level always produces
     * from/to level, a non-empty basis, and the applicable repeat count.
     *
     * @return array{from_level_id: string|null, to_level_id: string|null, assessment_result_id: string|null, basis: string|null, repeat_count: int|null}
     */
    private function resolveLevelFields(ClassModel $class, string $studentId, string $outcome, ?string $assessmentResultId, ?string $basis, ?int $repeatCount, ?ProgressionDecision $fallback = null): array
    {
        if ($class->program_version_level_id === null || $class->program_version_level_id === '') {
            if ($assessmentResultId !== null || $basis !== null || $repeatCount !== null) {
                throw BusinessRejection::forCode('academic.progression_level_unexpected', 'level-aware fields cannot be used on a legacy non-level class');
            }

            return ['from_level_id' => null, 'to_level_id' => null, 'assessment_result_id' => null, 'basis' => null, 'repeat_count' => null];
        }

        /** @var ProgramVersionLevel $from */
        $from = ProgramVersionLevel::query()->whereKey($class->program_version_level_id)->firstOrFail();
        if (trim((string) $from->program_version_id) !== trim((string) $class->program_version_id)) {
            throw BusinessRejection::forCode('academic.progression_level_version_mismatch', 'the class level must belong to the class program version');
        }

        if ($outcome === 'advance') {
            $to = ProgramVersionLevel::query()
                ->where('program_version_id', $class->program_version_id)
                ->where('ordinal', (int) $from->ordinal + 1)
                ->first();
            if ($to === null) {
                throw BusinessRejection::forCode('academic.progression_advance_past_last', 'an advance cannot target past the last level; completion is a separate decision');
            }
        } else {
            $to = $from;
        }

        $effectiveBasis = $basis !== null ? $basis : ($fallback !== null ? $fallback->basis : '');
        if (trim($effectiveBasis) === '') {
            throw BusinessRejection::forCode('academic.progression_basis_required', 'a level-aware progression requires its basis');
        }
        $effectiveResult = $assessmentResultId !== null ? $assessmentResultId : ($fallback !== null ? $fallback->assessment_result_id : null);
        $effectiveRepeatCount = $repeatCount !== null ? $repeatCount : ($fallback !== null ? $fallback->repeat_count : null);

        $enrollment = $this->enrollmentFor($class->id, $studentId);
        if ($enrollment === null) {
            throw BusinessRejection::forCode('academic.progression_enrollment_required', 'a level-aware progression requires the student to be enrolled in the class');
        }
        if ($effectiveResult !== null) {
            $this->assertAssessmentResultOnEnrollment($effectiveResult, $enrollment->id);
        }

        if ($outcome === 'advance') {
            $this->assertPrerequisitesSatisfied($studentId, $to, $from);
            $this->assertMinimumPassing($from, $effectiveResult);
            $effectiveRepeatCount = null;
        } else {
            $effectiveRepeatCount ??= $this->nextRepeatCount($studentId, (string) $from->program_version_id, (string) $from->id);
            $this->assertRepeatAllowed($from, $effectiveRepeatCount);
        }

        return [
            'from_level_id' => $from->id,
            'to_level_id' => $to->id,
            'assessment_result_id' => $effectiveResult,
            'basis' => $effectiveBasis,
            'repeat_count' => $effectiveRepeatCount,
        ];
    }

    private function revalidateLevelGates(ProgressionDecision $decision): void
    {
        if ($decision->from_level_id === null) {
            return;
        }
        if (trim((string) $decision->basis) === '') {
            throw BusinessRejection::forCode('academic.progression_basis_required', 'a level-aware progression requires its basis');
        }

        /** @var ClassModel $class */
        $class = ClassModel::query()->whereKey($decision->class_id)->firstOrFail();
        /** @var ProgramVersionLevel $from */
        $from = ProgramVersionLevel::query()->whereKey($decision->from_level_id)->firstOrFail();
        $to = $decision->outcome === 'advance'
            ? ProgramVersionLevel::query()->whereKey($decision->to_level_id)->firstOrFail()
            : $from;
        if ($this->enrollmentFor($class->id, $decision->student_id) === null) {
            throw BusinessRejection::forCode('academic.progression_enrollment_required', 'a level-aware progression requires the student to be enrolled in the class');
        }
        if ($decision->outcome === 'advance') {
            $this->assertPrerequisitesSatisfied($decision->student_id, $to, $from);
            $this->assertMinimumPassing($from, $decision->assessment_result_id);
        } else {
            $this->assertRepeatAllowed($from, (int) $decision->repeat_count);
        }
    }

    private function writeFact(ProgressionDecision $decision): void
    {
        if ($decision->from_level_id === null) {
            return;
        }

        /** @var ClassModel $class */
        $class = ClassModel::query()->whereKey($decision->class_id)->firstOrFail();
        $enrollment = $this->enrollmentFor($class->id, $decision->student_id);
        if ($enrollment === null) {
            throw BusinessRejection::forCode('academic.progression_enrollment_required', 'a level-aware progression requires the student to be enrolled in the class');
        }

        LevelProgressFact::query()->create([
            'id' => RandomIdentifier::new(),
            'student_id' => $decision->student_id,
            'program_version_id' => $class->program_version_id,
            'level_id' => $decision->from_level_id,
            'to_level_id' => $decision->to_level_id,
            'class_id' => $decision->class_id,
            'offering_id' => $enrollment->offering_id,
            'academic_period_id' => $class->period_id,
            'decision_id' => $decision->id,
            'assessment_result_id' => $decision->assessment_result_id,
            'outcome' => $decision->outcome,
            'repeat_count' => $decision->repeat_count ?? 0,
            'achieved_at' => now(),
        ]);
    }

    private function enrollmentFor(string $classId, string $studentId): ?Enrollment
    {
        return Enrollment::query()
            ->where('class_id', $classId)
            ->where('student_id', $studentId)
            ->whereIn('lifecycle_state', [EnrollmentLifecycle::STATE_ACTIVE, EnrollmentLifecycle::STATE_FROZEN])
            ->latest()
            ->first();
    }

    private function assertAssessmentResultOnEnrollment(string $assessmentResultId, string $enrollmentId): void
    {
        /** @var AssessmentResult $result */
        $result = AssessmentResult::query()->whereKey($assessmentResultId)->firstOrFail();
        $attempt = $result->attempt()->firstOrFail();
        if (trim((string) $attempt->enrollment_id) !== trim($enrollmentId)) {
            throw BusinessRejection::forCode('academic.progression_result_enrollment_mismatch', 'the assessment result must belong to the class enrollment');
        }
    }

    private function assertPrerequisitesSatisfied(string $studentId, ProgramVersionLevel $target, ?ProgramVersionLevel $current = null): void
    {
        $violations = $this->history->prerequisiteViolations($studentId, $target);
        if ($current !== null) {
            $violations = array_values(array_filter(
                $violations,
                fn (array $violation): bool => (string) $violation['required_level_id'] !== (string) $current->id,
            ));
        }
        if ($violations !== []) {
            $keys = implode(', ', array_column($violations, 'level_key'));
            throw BusinessRejection::forCode('academic.progression_prerequisite_unsatisfied', 'level prerequisites are unsatisfied: '.$keys);
        }
    }

    private function assertMinimumPassing(ProgramVersionLevel $level, ?string $assessmentResultId): void
    {
        /** @var LevelProgressionRule|null $rule */
        $rule = LevelProgressionRule::query()
            ->where('program_version_level_id', $level->id)
            ->where('lifecycle_state', LevelProgressionRule::STATE_ACTIVE)
            ->first();
        if ($rule === null || $rule->minimum_passing_score === null) {
            return;
        }
        if ($assessmentResultId === null) {
            throw BusinessRejection::forCode('academic.progression_result_required', 'this level requires a passing assessment result to advance');
        }
        /** @var AssessmentResult $result */
        $result = AssessmentResult::query()->whereKey($assessmentResultId)->firstOrFail();
        if ((float) $result->score < (float) $rule->minimum_passing_score) {
            throw BusinessRejection::forCode('academic.progression_minimum_score', 'the assessment result is below the required minimum passing score');
        }
    }

    private function assertRepeatAllowed(ProgramVersionLevel $level, int $repeatCount): void
    {
        /** @var LevelProgressionRule|null $rule */
        $rule = LevelProgressionRule::query()
            ->where('program_version_level_id', $level->id)
            ->where('lifecycle_state', LevelProgressionRule::STATE_ACTIVE)
            ->first();
        if ($rule === null || $rule->max_repeats === null) {
            return;
        }
        if ($repeatCount > (int) $rule->max_repeats) {
            throw BusinessRejection::forCode('academic.progression_repeat_cap', sprintf('repeat %d exceeds the allowed maximum of %d', $repeatCount, (int) $rule->max_repeats));
        }
    }

    private function nextRepeatCount(string $studentId, string $programVersionId, string $levelId): int
    {
        return (int) LevelProgressFact::query()
            ->where('student_id', $studentId)
            ->where('program_version_id', $programVersionId)
            ->where('level_id', $levelId)
            ->where('outcome', LevelProgressFact::OUTCOME_REPEAT)
            ->count() + 1;
    }

    private function require(Actor $actor, string $capability, ?string $branchId, string $errorCode): void
    {
        $this->access->require($actor, $capability, $branchId, $errorCode);
    }
}
