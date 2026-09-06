<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\AcademicAccess;
use App\Modules\Academic\Domain\AppealLifecycle;
use App\Modules\Academic\Domain\AssessmentResultLifecycle;
use App\Modules\Academic\Domain\ProgressionLifecycle;
use App\Modules\Academic\Domain\RecordBranch;
use App\Modules\Academic\Models\AcademicAppeal;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Students\Models\Student;
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
 *
 * Resolution semantics (WP-ACAD-APPEAL-RESOLVE): resolved means the grievance
 * was upheld AND redress is recorded on the contested subject — resolve() is
 * refused on an untouched subject. Rejected means no merit; the subject
 * stands. Remediation itself always flows through the subject's owning verbs
 * (result mark-appealed/correction, progression mark-appealed/supersede,
 * placement supersede/retire); resolve() verifies, never performs.
 *
 * Scope (WP-ACAD-SCOPE): every verb is checked in the contested subject's
 * branch scope, derived from the verified/locked subject row.
 */
final class ManageAcademicAppeal
{
    public const CAPABILITY = 'academic.appeal_manage';

    public function __construct(
        private readonly AcademicAccess $access,
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
                    // Capability presence first (no existence probing by
                    // unauthorized actors), then subject-branch scope.
                    $this->requireCapability($filer, null);
                    if (! in_array($subjectType, ['assessment_result', 'progression_decision', 'placement_profile'], true)) {
                        throw BusinessRejection::forCode('academic.appeal_subject_unknown', sprintf('unknown appeal subject %s', $subjectType));
                    }
                    if ($reason === '') {
                        throw BusinessRejection::forCode('academic.appeal_reason', 'an appeal requires a reason');
                    }

                    $subject = $this->verifiedSubject($subjectType, $subjectId, trim($studentId));
                    $this->requireCapability($filer, $subject['branch']);

                    $appeal = AcademicAppeal::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $subject['student_id'],
                        'subject_type' => $subjectType,
                        'subject_id' => trim($subjectId),
                        'reason' => $reason,
                        'lifecycle_state' => AppealLifecycle::STATE_OPEN,
                    ]);
                    $event = $this->audit->record($filer->actorId, 'academic.appeal.file', 'academic_appeal', $appeal->id, null, [
                        'student_id' => $studentId, 'subject' => $subjectType.':'.trim($subjectId),
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
                    $this->requireCapability($actor, null);

                    /** @var AcademicAppeal $locked */
                    $locked = AcademicAppeal::query()->whereKey($appeal->id)->lockForUpdate()->firstOrFail();
                    AppealLifecycle::requireTransition($locked->lifecycle_state, AppealLifecycle::STATE_ASSIGNED);
                    $subjectBranch = RecordBranch::appealBranch($locked);
                    $this->requireCapability($actor, $subjectBranch);
                    $originalDecisionMaker = $this->originalDecisionMaker($locked);
                    if ($originalDecisionMaker !== null && $originalDecisionMaker === $reviewerPersonId) {
                        throw AuthorizationDenied::forCode('academic.appeal_not_independent', 'the original decision-maker may not review the appeal');
                    }
                    // Fail fast: the reviewer must be able to act in the
                    // subject's branch, or the appeal parks in assigned
                    // forever with nobody able to investigate it. A
                    // nonexistent person holds no grants, so existence is
                    // implied — no separate person lookup.
                    $this->access->require(
                        new Actor($reviewerPersonId, $reviewerPersonId),
                        self::CAPABILITY,
                        $subjectBranch,
                        'academic.appeal_reviewer_denied',
                    );

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
                    $this->requireCapability($actor, null);

                    /** @var AcademicAppeal $locked */
                    $locked = AcademicAppeal::query()->whereKey($appeal->id)->lockForUpdate()->firstOrFail();
                    AppealLifecycle::requireTransition($locked->lifecycle_state, $toState);
                    $this->requireCapability($actor, RecordBranch::appealBranch($locked));
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
                        if ($toState === AppealLifecycle::STATE_RESOLVED) {
                            $this->assertRedressRecorded($locked);
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

    /**
     * Resolved means upheld AND redressed: the contested subject must
     * already carry its remediation marking from its owning workflow
     * (WP-ACAD-APPEAL-RESOLVE). Resolving an untouched subject is refused.
     */
    private function assertRedressRecorded(AcademicAppeal $appeal): void
    {
        $subjectType = (string) $appeal->subject_type;
        $subjectId = trim((string) $appeal->subject_id);
        if ($subjectType === 'assessment_result') {
            /** @var AssessmentResult|null $result */
            $result = AssessmentResult::query()->find($subjectId);
            $state = $result === null ? null : $result->lifecycle_state;
            if (! in_array($state, [AssessmentResultLifecycle::STATE_APPEALED, AssessmentResultLifecycle::STATE_CORRECTED], true)) {
                throw BusinessRejection::forCode('academic.appeal_subject_untouched', 'an appeal against a result resolves only after remediation is recorded on the result (mark appealed, then correct)');
            }

            return;
        }
        if ($subjectType === 'progression_decision') {
            /** @var ProgressionDecision|null $decision */
            $decision = ProgressionDecision::query()->find($subjectId);
            $state = $decision === null ? null : $decision->lifecycle_state;
            if (! in_array($state, [ProgressionLifecycle::STATE_APPEALED, ProgressionLifecycle::STATE_SUPERSEDED], true)) {
                throw BusinessRejection::forCode('academic.appeal_subject_untouched', 'an appeal against a progression resolves only after remediation is recorded on the decision (mark appealed, then supersede)');
            }

            return;
        }
        if ($subjectType === 'placement_profile') {
            /** @var PlacementProfile|null $profile */
            $profile = PlacementProfile::query()->find($subjectId);
            $state = $profile === null ? null : $profile->lifecycle_state;
            if (! in_array($state, [PlacementProfile::STATE_SUPERSEDED, PlacementProfile::STATE_RETIRED], true)) {
                throw BusinessRejection::forCode('academic.appeal_subject_untouched', 'an appeal against a placement resolves only after the profile is superseded or retired (retake path included)');
            }

            return;
        }
        throw BusinessRejection::forCode('academic.appeal_subject_unknown', sprintf('unknown appeal subject %s', $subjectType));
    }

    /**
     * Filing-time subject verification (WP-ACAD-APPEAL-RESOLVE): the subject
     * must exist, be in an appealable state, and belong to the appeal's
     * student.
     *
     * @return array{student_id: string|null, branch: string|null}
     */
    private function verifiedSubject(string $subjectType, string $subjectId, string $suppliedStudentId): array
    {
        $subjectId = trim($subjectId);
        if ($subjectId === '') {
            throw BusinessRejection::forCode('academic.appeal_subject_unknown', 'an appeal requires a subject');
        }
        if ($subjectType === 'assessment_result') {
            /** @var AssessmentResult|null $result */
            $result = AssessmentResult::query()->find($subjectId);
            if ($result === null) {
                throw BusinessRejection::forCode('academic.appeal_subject_unknown', 'the assessment result subject does not exist');
            }
            if ($result->lifecycle_state !== AssessmentResultLifecycle::STATE_RELEASED) {
                throw BusinessRejection::forCode('academic.appeal_subject_not_appealable', 'only a released assessment result can be appealed');
            }
            $ownerStudentId = RecordBranch::subjectStudentId($subjectType, $subjectId) ?? '';
            $this->requireSubjectStudent($suppliedStudentId, $ownerStudentId);

            return ['student_id' => $ownerStudentId, 'branch' => RecordBranch::resultBranch($result)];
        }
        if ($subjectType === 'progression_decision') {
            /** @var ProgressionDecision|null $decision */
            $decision = ProgressionDecision::query()->find($subjectId);
            if ($decision === null) {
                throw BusinessRejection::forCode('academic.appeal_subject_unknown', 'the progression decision subject does not exist');
            }
            if (! in_array($decision->lifecycle_state, [ProgressionLifecycle::STATE_APPROVED, ProgressionLifecycle::STATE_REJECTED], true)) {
                throw BusinessRejection::forCode('academic.appeal_subject_not_appealable', 'only a decided progression can be appealed');
            }
            $ownerStudentId = trim((string) $decision->student_id);
            $this->requireSubjectStudent($suppliedStudentId, $ownerStudentId);

            return ['student_id' => $ownerStudentId, 'branch' => RecordBranch::progressionBranch($decision)];
        }
        /** @var PlacementProfile|null $profile */
        $profile = PlacementProfile::query()->find($subjectId);
        if ($profile === null) {
            throw BusinessRejection::forCode('academic.appeal_placement_unknown', 'the placement profile subject does not exist');
        }
        if ($profile->lifecycle_state !== PlacementProfile::STATE_RELEASED) {
            throw BusinessRejection::forCode('academic.appeal_subject_not_appealable', 'only a released placement profile can be appealed');
        }
        // Pre-Student profiles have no student row: the appeal carries the
        // profile's derived student when one exists, else stays unbound.
        $resolvedStudentId = RecordBranch::subjectStudentId($subjectType, $subjectId) ?? '';

        return ['student_id' => $resolvedStudentId !== '' ? $resolvedStudentId : null, 'branch' => RecordBranch::placementProfileBranch($profile)];
    }

    private function requireSubjectStudent(string $suppliedStudentId, string $ownerStudentId): void
    {
        if ($suppliedStudentId === '') {
            throw BusinessRejection::forCode('academic.appeal_student_required', 'an appeal against a result or progression requires a student');
        }
        if (Student::query()->whereKey($suppliedStudentId)->doesntExist()) {
            throw BusinessRejection::forCode('academic.appeal_student_unknown', 'the student subject does not exist');
        }
        if ($ownerStudentId === '' || trim($suppliedStudentId) !== $ownerStudentId) {
            throw BusinessRejection::forCode('academic.appeal_subject_student_mismatch', 'the appeal student must own the contested subject');
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

    private function requireCapability(Actor $actor, ?string $branchId): void
    {
        $this->access->require($actor, self::CAPABILITY, $branchId, 'academic.appeal_denied');
    }
}
