<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\AppealLifecycle;
use App\Modules\Academic\Models\AcademicAppeal;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Academic\Placement\Models\PlacementProfile;
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
 * Appeal workflow: open -> assigned -> investigating -> resolved/rejected/
 * escalated -> closed, with outcome and evidence required and no silent
 * closure. The assigned reviewer may never be the original decision-maker
 * of the appealed subject.
 */
final class ManageAcademicAppeal
{
    public const CAPABILITY = 'academic.appeal_manage';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{appeal_id: string, correlation_id: string} */
    public function file(Actor $filer, string $studentId, string $subjectType, string $subjectId, string $reason, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.appeal.file', $studentId, $subjectType, $subjectId, $reason, $filer->actorId]));

        try {
            return $this->idempotency->execute('academic.appeal.file', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($filer, $studentId, $subjectType, $subjectId, $reason): array {
                    $this->requireCapability($filer);
                    if (! in_array($subjectType, ['assessment_result', 'progression_decision', 'placement_profile'], true)) {
                        throw BusinessRejection::forCode('academic.appeal_subject_unknown', sprintf('unknown appeal subject %s', $subjectType));
                    }
                    if ($reason === '') {
                        throw BusinessRejection::forCode('academic.appeal_reason', 'an appeal requires a reason');
                    }

                    $appeal = AcademicAppeal::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $studentId,
                        'subject_type' => $subjectType,
                        'subject_id' => $subjectId,
                        'reason' => $reason,
                        'lifecycle_state' => AppealLifecycle::STATE_OPEN,
                    ]);
                    $event = $this->audit->record($filer->actorId, 'academic.appeal.file', 'academic_appeal', $appeal->id, null, [
                        'student_id' => $studentId, 'subject' => $subjectType.':'.$subjectId,
                    ]);

                    return ['appeal_id' => $appeal->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $filer, 'academic.appeal.file', 'academic_appeal', $studentId);
        }
    }

    /** @return array{appeal_id: string, lifecycle_state: string, correlation_id: string} */
    public function assign(Actor $actor, AcademicAppeal $appeal, string $reviewerPersonId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.appeal.assign', $appeal->id, $reviewerPersonId, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.appeal.assign', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $appeal, $reviewerPersonId): array {
                    $this->requireCapability($actor);

                    /** @var AcademicAppeal $locked */
                    $locked = AcademicAppeal::query()->whereKey($appeal->id)->lockForUpdate()->firstOrFail();
                    AppealLifecycle::requireTransition($locked->lifecycle_state, AppealLifecycle::STATE_ASSIGNED);
                    $originalDecisionMaker = $this->originalDecisionMaker($locked);
                    if ($originalDecisionMaker !== null && $originalDecisionMaker === $reviewerPersonId) {
                        throw AuthorizationDenied::forCode('academic.appeal_not_independent', 'the original decision-maker may not review the appeal');
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => AppealLifecycle::STATE_ASSIGNED, 'assigned_reviewer_id' => $reviewerPersonId]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.appeal.assign', 'academic_appeal', $locked->id, $before, ['lifecycle_state' => AppealLifecycle::STATE_ASSIGNED, 'reviewer' => $reviewerPersonId]);

                    return ['appeal_id' => $locked->id, 'lifecycle_state' => AppealLifecycle::STATE_ASSIGNED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.appeal.assign', 'academic_appeal', $appeal->id);
        }
    }

    /** @return array{appeal_id: string, lifecycle_state: string, correlation_id: string} */
    public function investigate(Actor $reviewer, AcademicAppeal $appeal, string $idempotencyKey): array
    {
        return $this->transition($reviewer, $appeal, AppealLifecycle::STATE_INVESTIGATING, 'investigate', null, null, $idempotencyKey);
    }

    /** @return array{appeal_id: string, lifecycle_state: string, correlation_id: string} */
    public function resolve(Actor $reviewer, AcademicAppeal $appeal, string $outcome, string $outcomeEvidence, string $idempotencyKey): array
    {
        return $this->transition($reviewer, $appeal, AppealLifecycle::STATE_RESOLVED, 'resolve', $outcome, $outcomeEvidence, $idempotencyKey);
    }

    /** @return array{appeal_id: string, lifecycle_state: string, correlation_id: string} */
    public function reject(Actor $reviewer, AcademicAppeal $appeal, string $outcome, string $outcomeEvidence, string $idempotencyKey): array
    {
        return $this->transition($reviewer, $appeal, AppealLifecycle::STATE_REJECTED, 'reject', $outcome, $outcomeEvidence, $idempotencyKey);
    }

    /** @return array{appeal_id: string, lifecycle_state: string, correlation_id: string} */
    public function escalate(Actor $reviewer, AcademicAppeal $appeal, string $idempotencyKey): array
    {
        return $this->transition($reviewer, $appeal, AppealLifecycle::STATE_ESCALATED, 'escalate', null, null, $idempotencyKey);
    }

    /** @return array{appeal_id: string, lifecycle_state: string, correlation_id: string} */
    public function close(Actor $actor, AcademicAppeal $appeal, string $idempotencyKey): array
    {
        return $this->transition($actor, $appeal, AppealLifecycle::STATE_CLOSED, 'close', null, null, $idempotencyKey);
    }

    /** @return array{appeal_id: string, lifecycle_state: string, correlation_id: string} */
    private function transition(Actor $actor, AcademicAppeal $appeal, string $toState, string $verb, ?string $outcome, ?string $outcomeEvidence, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.appeal.'.$verb, $appeal->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.appeal.'.$verb, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $appeal, $toState, $verb, $outcome, $outcomeEvidence): array {
                    $this->requireCapability($actor);

                    /** @var AcademicAppeal $locked */
                    $locked = AcademicAppeal::query()->whereKey($appeal->id)->lockForUpdate()->firstOrFail();
                    AppealLifecycle::requireTransition($locked->lifecycle_state, $toState);
                    if ($toState === AppealLifecycle::STATE_INVESTIGATING && trim((string) $locked->assigned_reviewer_id) !== $actor->actorId) {
                        throw AuthorizationDenied::forCode('academic.appeal_wrong_reviewer', 'only the assigned reviewer may investigate the appeal');
                    }
                    if (in_array($toState, [AppealLifecycle::STATE_RESOLVED, AppealLifecycle::STATE_REJECTED], true)) {
                        if ($outcome === null || $outcome === '' || $outcomeEvidence === null || $outcomeEvidence === '') {
                            throw BusinessRejection::forCode('academic.appeal_outcome_required', 'a resolved or rejected appeal requires outcome and evidence');
                        }
                        if (trim((string) $locked->assigned_reviewer_id) !== $actor->actorId) {
                            throw AuthorizationDenied::forCode('academic.appeal_wrong_reviewer', 'only the assigned reviewer may decide the appeal');
                        }
                        $locked->forceFill(['outcome' => $outcome, 'outcome_evidence' => $outcomeEvidence, 'decided_by' => $actor->actorId]);
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.appeal.'.$verb, 'academic_appeal', $locked->id, $before, ['lifecycle_state' => $toState]);

                    return ['appeal_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.appeal.'.$verb, 'academic_appeal', $appeal->id);
        }
    }

    private function originalDecisionMaker(AcademicAppeal $appeal): ?string
    {
        if ($appeal->subject_type === 'assessment_result') {
            /** @var AssessmentResult|null $result */
            $result = AssessmentResult::query()->find($appeal->subject_id);

            return $result !== null ? trim((string) $result->scored_by) : null;
        }
        if ($appeal->subject_type === 'progression_decision') {
            /** @var ProgressionDecision|null $decision */
            $decision = ProgressionDecision::query()->find($appeal->subject_id);

            return $decision !== null ? trim((string) $decision->approved_by) : null;
        }
        if ($appeal->subject_type === 'placement_profile') {
            /** @var PlacementProfile|null $profile */
            $profile = PlacementProfile::query()->find($appeal->subject_id);

            return $profile !== null ? trim((string) ($profile->approved_by ?? $profile->reviewed_by ?? '')) : null;
        }

        return null;
    }

    private function requireCapability(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('academic.appeal_denied', $outcome->reason);
        }
    }
}
