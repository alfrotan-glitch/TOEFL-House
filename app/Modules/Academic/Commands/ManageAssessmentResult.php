<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\AssessmentResultLifecycle;
use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\ResultCorrection;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Domain\CrmInteractionTraceRecorder;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Evidence and result chain: submit the raw attempt (immutable once
 * submitted), score it, moderate through an independent reviewer, approve
 * as Academic Management, and release. A score is never a decision
 * automatically; a correction appends a new result row with a reason and
 * closes the original as corrected.
 */
final class ManageAssessmentResult
{
    public const CAPABILITY_ASSESS = 'academic.assess';

    public const CAPABILITY_MODERATE = 'academic.moderate';

    public const CAPABILITY_APPROVE = 'academic.approve_result';

    public const CAPABILITY_RELEASE = 'academic.release';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly CrmInteractionTraceRecorder $crmTrace,
    ) {}

    /** @return array{attempt_id: string, correlation_id: string} */
    public function submitAttempt(Actor $assessor, Enrollment $enrollment, string $kind, string $evidenceRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.attempt.submit', $enrollment->id, $kind, $evidenceRef, $assessor->actorId]));

        try {
            return $this->idempotency->execute('academic.attempt.submit', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($assessor, $enrollment, $kind, $evidenceRef): array {
                    $this->require($assessor, self::CAPABILITY_ASSESS, 'academic.assess_denied');
                    if (! in_array($kind, ['placement', 'assessment'], true)) {
                        throw BusinessRejection::forCode('academic.attempt_kind_unknown', sprintf('unknown attempt kind %s', $kind));
                    }
                    if ($evidenceRef === '') {
                        throw BusinessRejection::forCode('academic.attempt_evidence_missing', 'an attempt requires an evidence reference');
                    }
                    /** @var Enrollment $locked */
                    $locked = Enrollment::query()->whereKey($enrollment->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'active') {
                        throw BusinessRejection::forCode('academic.attempt_enrollment_not_active', 'attempts attach only to an active enrollment');
                    }

                    $attempt = AssessmentAttempt::query()->create([
                        'id' => RandomIdentifier::new(),
                        'enrollment_id' => $locked->id,
                        'kind' => $kind,
                        'evidence_ref' => $evidenceRef,
                        'lifecycle_state' => 'submitted',
                        'recorded_by' => $assessor->actorId,
                    ]);
                    $event = $this->audit->record($assessor->actorId, 'academic.attempt.submit', 'assessment_attempt', $attempt->id, null, [
                        'enrollment_id' => $locked->id, 'kind' => $kind,
                    ]);
                    $this->traceVisitor($assessor, $locked, $attempt->id, $kind);

                    return ['attempt_id' => $attempt->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $assessor, 'academic.attempt.submit', 'assessment_attempt', $enrollment->id);
        }
    }

    /** @return array{result_id: string, correlation_id: string} */
    public function score(Actor $scorer, AssessmentAttempt $attempt, string $score, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.result.score', $attempt->id, $score, $scorer->actorId]));

        try {
            return $this->idempotency->execute('academic.result.score', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($scorer, $attempt, $score): array {
                    $this->require($scorer, self::CAPABILITY_ASSESS, 'academic.assess_denied');
                    /** @var AssessmentAttempt $locked */
                    $locked = AssessmentAttempt::query()->whereKey($attempt->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'submitted') {
                        throw BusinessRejection::forCode('academic.attempt_not_submitted', 'only a submitted attempt can be scored');
                    }
                    if (! is_numeric($score) || (float) $score < 0) {
                        throw BusinessRejection::forCode('academic.result_score_invalid', 'a score must be a non-negative number');
                    }
                    if (AssessmentResult::query()->where('attempt_id', $locked->id)->where('lifecycle_state', '!=', 'corrected')->exists()) {
                        throw BusinessRejection::forCode('academic.result_exists', 'this attempt already has a live result');
                    }

                    $result = AssessmentResult::query()->create([
                        'id' => RandomIdentifier::new(),
                        'attempt_id' => $locked->id,
                        'score' => $score,
                        'lifecycle_state' => AssessmentResultLifecycle::STATE_SCORED,
                        'scored_by' => $scorer->actorId,
                    ]);
                    $event = $this->audit->record($scorer->actorId, 'academic.result.score', 'assessment_result', $result->id, null, [
                        'attempt_id' => $locked->id, 'score' => $score,
                    ]);

                    return ['result_id' => $result->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $scorer, 'academic.result.score', 'assessment_attempt', $attempt->id);
        }
    }

    /** @return array{result_id: string, lifecycle_state: string, correlation_id: string} */
    public function moderate(Actor $moderator, AssessmentResult $result, string $idempotencyKey): array
    {
        return $this->transition($moderator, $result, AssessmentResultLifecycle::STATE_MODERATED, self::CAPABILITY_MODERATE, 'moderate', $idempotencyKey, fn (AssessmentResult $locked, Actor $actor) => $this->assertIndependent($locked, $actor, 'moderator'));
    }

    /** @return array{result_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, AssessmentResult $result, string $idempotencyKey): array
    {
        return $this->transition($approver, $result, AssessmentResultLifecycle::STATE_APPROVED, self::CAPABILITY_APPROVE, 'approve', $idempotencyKey, function (AssessmentResult $locked, Actor $actor): void {
            $this->assertIndependent($locked, $actor, 'approver');
            if (trim((string) $locked->moderated_by) === $actor->actorId) {
                throw AuthorizationDenied::forCode('academic.approval_not_independent', 'the approver must differ from the moderator');
            }
        });
    }

    /** @return array{result_id: string, lifecycle_state: string, correlation_id: string} */
    public function release(Actor $releaser, AssessmentResult $result, string $idempotencyKey): array
    {
        return $this->transition($releaser, $result, AssessmentResultLifecycle::STATE_RELEASED, self::CAPABILITY_RELEASE, 'release', $idempotencyKey, null);
    }

    /**
     * Correction appends a new result row referencing the original and
     * closes the original as corrected; the original score stays visible
     * in history.
     *
     * @return array{result_id: string, corrects_id: string, correlation_id: string}
     */
    /** @return array{correction_id: string, correlation_id: string} */
    public function proposeCorrection(Actor $moderator, AssessmentResult $original, string $score, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.result.correction.propose', $original->id, $score, $reason, $moderator->actorId]));

        try {
            return $this->idempotency->execute('academic.result.correction.propose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($moderator, $original, $score, $reason): array {
                    $this->require($moderator, self::CAPABILITY_MODERATE, 'academic.moderate_denied');
                    if ($reason === '') {
                        throw BusinessRejection::forCode('academic.correction_reason', 'a correction requires a reason');
                    }
                    if (! is_numeric($score) || (float) $score < 0) {
                        throw BusinessRejection::forCode('academic.result_score_invalid', 'a score must be a non-negative number');
                    }

                    /** @var AssessmentResult $locked */
                    $locked = AssessmentResult::query()->whereKey($original->id)->lockForUpdate()->firstOrFail();
                    AssessmentResultLifecycle::requireTransition($locked->lifecycle_state, AssessmentResultLifecycle::STATE_CORRECTED);
                    if (ResultCorrection::query()->where('result_id', $locked->id)->where('lifecycle_state', ResultCorrection::STATE_PROPOSED)->exists()) {
                        throw BusinessRejection::forCode('academic.correction_exists', 'this result already has an open correction');
                    }

                    $correction = ResultCorrection::query()->create([
                        'id' => RandomIdentifier::new(),
                        'result_id' => $locked->id,
                        'score' => $score,
                        'reason' => $reason,
                        'lifecycle_state' => ResultCorrection::STATE_PROPOSED,
                        'proposed_by' => $moderator->actorId,
                    ]);
                    $event = $this->audit->record($moderator->actorId, 'academic.result.correction.propose', 'result_correction', $correction->id, null, [
                        'result_id' => $locked->id, 'score' => $score,
                    ]);

                    return ['correction_id' => $correction->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $moderator, 'academic.result.correction.propose', 'result_correction', $original->id);
        }
    }

    /** @return array{result_id: string, corrects_id: string, correlation_id: string} */
    public function approveCorrection(Actor $approver, ResultCorrection $correction, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.result.correction.approve', $correction->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('academic.result.correction.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $correction): array {
                    $this->require($approver, self::CAPABILITY_APPROVE, 'academic.approve_result_denied');

                    /** @var ResultCorrection $lockedCorrection */
                    $lockedCorrection = ResultCorrection::query()->whereKey($correction->id)->lockForUpdate()->firstOrFail();
                    if ($lockedCorrection->lifecycle_state !== ResultCorrection::STATE_PROPOSED) {
                        throw BusinessRejection::forCode('academic.correction_state', sprintf('only a proposed correction can be approved, state is %s', $lockedCorrection->lifecycle_state));
                    }
                    if (trim((string) $lockedCorrection->proposed_by) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('academic.correction_single_actor', 'a correction needs a moderator and an approver as distinct actors');
                    }

                    /** @var AssessmentResult $locked */
                    $locked = AssessmentResult::query()->whereKey($lockedCorrection->result_id)->lockForUpdate()->firstOrFail();
                    AssessmentResultLifecycle::requireTransition($locked->lifecycle_state, AssessmentResultLifecycle::STATE_CORRECTED);

                    $locked->forceFill(['lifecycle_state' => AssessmentResultLifecycle::STATE_CORRECTED]);
                    $locked->save();

                    $corrected = AssessmentResult::query()->create([
                        'id' => RandomIdentifier::new(),
                        'attempt_id' => $locked->attempt_id,
                        'score' => $lockedCorrection->score,
                        'lifecycle_state' => AssessmentResultLifecycle::STATE_RELEASED,
                        'corrects_id' => $locked->id,
                        'correction_reason' => $lockedCorrection->reason,
                        'scored_by' => $lockedCorrection->proposed_by,
                    ]);

                    $lockedCorrection->forceFill([
                        'lifecycle_state' => ResultCorrection::STATE_APPROVED,
                        'approved_by' => $approver->actorId,
                    ])->save();
                    $event = $this->audit->record($approver->actorId, 'academic.result.correction.approve', 'assessment_result', $corrected->id, ['score' => $locked->score], [
                        'corrects_id' => $locked->id, 'score' => $lockedCorrection->score, 'correction_id' => $lockedCorrection->id,
                    ]);

                    return ['result_id' => $corrected->id, 'corrects_id' => $locked->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'academic.result.correction.approve', 'assessment_result', $correction->id);
        }
    }

    /** @param callable(AssessmentResult, Actor): void|null $guard
     * @return array{result_id: string, lifecycle_state: string, correlation_id: string} */
    private function transition(Actor $actor, AssessmentResult $result, string $toState, string $capability, string $verb, string $idempotencyKey, ?callable $guard): array
    {
        $payload = hash('sha256', implode('|', ['academic.result.'.$verb, $result->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.result.'.$verb, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $result, $toState, $capability, $verb, $guard): array {
                    $this->require($actor, $capability, 'academic.result_denied');

                    /** @var AssessmentResult $locked */
                    $locked = AssessmentResult::query()->whereKey($result->id)->lockForUpdate()->firstOrFail();
                    AssessmentResultLifecycle::requireTransition($locked->lifecycle_state, $toState);
                    if ($guard !== null) {
                        $guard($locked, $actor);
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState]);
                    $locked->forceFill(match ($toState) {
                        AssessmentResultLifecycle::STATE_MODERATED => ['moderated_by' => $actor->actorId],
                        AssessmentResultLifecycle::STATE_APPROVED => ['approved_by' => $actor->actorId],
                        AssessmentResultLifecycle::STATE_RELEASED => ['released_by' => $actor->actorId],
                        default => [],
                    });
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.result.'.$verb, 'assessment_result', $locked->id, $before, ['lifecycle_state' => $toState]);

                    return ['result_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.result.'.$verb, 'assessment_result', $result->id);
        }
    }

    private function assertIndependent(AssessmentResult $result, Actor $actor, string $role): void
    {
        if (trim((string) $result->scored_by) === $actor->actorId) {
            throw AuthorizationDenied::forCode('academic.review_not_independent', sprintf('the %s may not be the scorer of the result under review', $role));
        }
    }

    private function traceVisitor(Actor $actor, Enrollment $enrollment, string $attemptId, string $kind): void
    {
        $visitorId = $this->crmTrace->visitorIdForStudent($enrollment->student_id);
        if ($visitorId === null) {
            return;
        }
        $this->crmTrace->record(
            $actor,
            $visitorId,
            'outbound',
            'assessment',
            'other',
            sprintf('%s attempt submitted for the student linked to this lead.', ucfirst($kind)),
            CarbonImmutable::now(),
            assessmentAttemptId: $attemptId,
        );
    }

    private function require(Actor $actor, string $capability, string $errorCode): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode($errorCode, $outcome->reason);
        }
    }
}
