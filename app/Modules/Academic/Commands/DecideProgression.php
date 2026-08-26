<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\ProgressionLifecycle;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Support\Authorization\AccessDecision;
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
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{decision_id: string, correlation_id: string} */
    public function propose(Actor $proposer, string $studentId, string $classId, string $outcome, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.progression.propose', $studentId, $classId, $outcome, $reason, $proposer->actorId]));

        try {
            return $this->idempotency->execute('academic.progression.propose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($proposer, $studentId, $classId, $outcome, $reason): array {
                    $this->require($proposer, self::CAPABILITY_PROPOSE, 'academic.progression_denied');
                    if (! in_array($outcome, ['advance', 'repeat'], true)) {
                        throw BusinessRejection::forCode('academic.progression_outcome_unknown', sprintf('unknown progression outcome %s', $outcome));
                    }
                    if ($reason === '') {
                        throw BusinessRejection::forCode('academic.progression_reason', 'a progression decision requires a reason');
                    }
                    if (ProgressionDecision::query()->where('student_id', $studentId)->where('class_id', $classId)->whereIn('lifecycle_state', ['proposed', 'reviewed', 'approved', 'appealed'])->exists()) {
                        throw BusinessRejection::forCode('academic.progression_open_decision', 'this student and class already have an open progression decision');
                    }

                    $decision = ProgressionDecision::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $studentId,
                        'class_id' => $classId,
                        'outcome' => $outcome,
                        'reason' => $reason,
                        'lifecycle_state' => ProgressionLifecycle::STATE_PROPOSED,
                        'proposed_by' => $proposer->actorId,
                    ]);
                    $event = $this->audit->record($proposer->actorId, 'academic.progression.propose', 'progression_decision', $decision->id, null, [
                        'student_id' => $studentId, 'class_id' => $classId, 'outcome' => $outcome,
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
    public function supersede(Actor $reviewer, Actor $approver, ProgressionDecision $original, string $outcome, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.progression.supersede', $original->id, $outcome, $reason, $reviewer->actorId, $approver->actorId]));

        try {
            return $this->idempotency->execute('academic.progression.supersede', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($reviewer, $approver, $original, $outcome, $reason): array {
                    $this->require($reviewer, self::CAPABILITY_REVIEW, 'academic.progression_denied');
                    $this->require($approver, self::CAPABILITY_APPROVE, 'academic.progression_denied');
                    if (trim((string) $original->proposed_by) === $reviewer->actorId || trim((string) $original->proposed_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('academic.appeal_not_independent', 'the original decision-maker may not review or approve the appeal outcome');
                    }
                    if (! in_array($outcome, ['advance', 'repeat'], true) || $reason === '') {
                        throw BusinessRejection::forCode('academic.progression_reason', 'a superseding decision requires outcome and reason');
                    }

                    /** @var ProgressionDecision $locked */
                    $locked = ProgressionDecision::query()->whereKey($original->id)->lockForUpdate()->firstOrFail();
                    ProgressionLifecycle::requireTransition($locked->lifecycle_state, ProgressionLifecycle::STATE_SUPERSEDED);

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
                    ]);

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
                    $this->require($actor, $capability, 'academic.progression_denied');

                    /** @var ProgressionDecision $locked */
                    $locked = ProgressionDecision::query()->whereKey($decision->id)->lockForUpdate()->firstOrFail();
                    ProgressionLifecycle::requireTransition($locked->lifecycle_state, $toState);
                    if (in_array($toState, [ProgressionLifecycle::STATE_REVIEWED], true) && trim((string) $locked->proposed_by) === $actor->actorId) {
                        throw AuthorizationDenied::forCode('academic.review_not_independent', 'the reviewer may not be the proposer of the decision under review');
                    }
                    if ($toState === ProgressionLifecycle::STATE_APPROVED && (trim((string) $locked->proposed_by) === $actor->actorId || trim((string) $locked->reviewed_by) === $actor->actorId)) {
                        throw AuthorizationDenied::forCode('academic.approval_not_independent', 'the approver must differ from the proposer and the reviewer');
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
                    $event = $this->audit->record($actor->actorId, 'academic.progression.'.$verb, 'progression_decision', $locked->id, $before, ['lifecycle_state' => $toState]);

                    return ['decision_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.progression.'.$verb, 'progression_decision', $decision->id);
        }
    }

    private function require(Actor $actor, string $capability, string $errorCode): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode($errorCode, $outcome->reason);
        }
    }
}
