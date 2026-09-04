<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\AssessmentResultLifecycle;
use App\Modules\Academic\Domain\ClassLifecycle;
use App\Modules\Academic\Domain\EnrollmentLifecycle;
use App\Modules\Academic\Domain\ProgressionLifecycle;
use App\Modules\Academic\Errors\EnrollmentFinancialGateDenied;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Academic\Placement\Models\AcademicEligibilitySnapshot;
use App\Modules\Academic\Placement\Queries\AcademicEligibilitySnapshotQuery;
use App\Modules\Academic\Queries\AcademicHistoryQuery;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Audit\RejectedOperation;
use App\Modules\Finance\Queries\FinancialGateQuery;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Models\StudentStatus;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Enrollment control: request (student must be currently active, class
 * active, seat free), activation under the enrollment-approval capability
 * with the capacity invariant and the Finance gate, a reasoned completion
 * lifecycle (freeze with reason, unfreeze with financial re-gate, withdraw
 * with reason, evidenced completion), and transfer that closes the old
 * enrollment and opens a new one in the target class under the same capacity
 * rule. There is never a duplicate active seat.
 */
final class MaintainEnrollment
{
    public const CAPABILITY_REQUEST = 'academic.enroll';

    public const CAPABILITY_APPROVE = 'academic.enroll_approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly AcademicEligibilitySnapshotQuery $eligibilitySnapshots,
        private readonly FinancialGateQuery $financialGates,
        private readonly RejectedOperation $rejectedOperation,
        private readonly AcademicHistoryQuery $history,
    ) {}

    /** @return array{enrollment_id: string, correlation_id: string} */
    public function request(Actor $requester, string $studentId, string $classId, string $idempotencyKey, ?string $offeringId = null): array
    {
        $payload = hash('sha256', implode('|', ['academic.enrollment.request', $studentId, $classId, $offeringId ?? '', $requester->actorId]));

        try {
            return $this->idempotency->execute('academic.enrollment.request', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($requester, $studentId, $classId, $offeringId): array {
                    $outcome = $this->access->decide($requester, self::CAPABILITY_REQUEST, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('academic.enrollment_denied', $outcome->reason);
                    }
                    $this->assertStudentActive($studentId);
                    $this->assertClassActive($classId);
                    $this->assertPrerequisitesForClass($studentId, $classId);
                    if ($offeringId !== null && $offeringId !== '') {
                        $this->assertOfferingOpenAndMatchesClass($offeringId, $classId);
                    }
                    if (Enrollment::query()->where('student_id', $studentId)->where('class_id', $classId)->whereIn('lifecycle_state', ['requested', 'active', 'frozen'])->exists()) {
                        throw BusinessRejection::forCode('academic.enrollment_seat_exists', 'this student already holds a seat in this class');
                    }
                    $eligibilitySnapshotId = $this->currentEligibilitySnapshotId($studentId);

                    $enrollment = Enrollment::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $studentId,
                        'class_id' => $classId,
                        'offering_id' => $offeringId !== null && $offeringId !== '' ? $offeringId : null,
                        'academic_eligibility_snapshot_id' => $eligibilitySnapshotId,
                        'lifecycle_state' => EnrollmentLifecycle::STATE_REQUESTED,
                    ]);
                    $event = $this->audit->record($requester->actorId, 'academic.enrollment.request', 'enrollment', $enrollment->id, null, [
                        'student_id' => $studentId, 'class_id' => $classId, 'offering_id' => $enrollment->offering_id,
                        'academic_eligibility_snapshot_id' => $enrollment->academic_eligibility_snapshot_id,
                    ]);

                    return ['enrollment_id' => $enrollment->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $requester, 'academic.enrollment.request', 'enrollment', $studentId);
        }
    }

    /** @return array{enrollment_id: string, lifecycle_state: string, correlation_id: string} */
    public function activate(Actor $approver, Enrollment $enrollment, string $idempotencyKey): array
    {
        return $this->transition($approver, $enrollment, EnrollmentLifecycle::STATE_ACTIVE, self::CAPABILITY_APPROVE, $idempotencyKey);
    }

    /**
     * Freeze parks an active seat under a mandatory human reason. The Finance
     * standing at freeze time is snapshotted read-only into the audit event;
     * the activation gate evidence on the row is preserved history. Finance
     * implications stay Finance-owned: no Finance fact is written here.
     *
     * @return array{enrollment_id: string, lifecycle_state: string, correlation_id: string}
     */
    public function freeze(Actor $actor, Enrollment $enrollment, string $reason, string $idempotencyKey): array
    {
        $this->assertReason($reason);
        $payload = hash('sha256', implode('|', ['academic.enrollment.freeze', $enrollment->id, $reason, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.enrollment.transition.'.EnrollmentLifecycle::STATE_FROZEN, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $enrollment, $reason): array {
                    $outcome = $this->access->decide($actor, self::CAPABILITY_APPROVE, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('academic.enrollment_denied', $outcome->reason);
                    }

                    /** @var Enrollment $locked */
                    $locked = Enrollment::query()->whereKey($enrollment->id)->lockForUpdate()->firstOrFail();
                    EnrollmentLifecycle::requireTransition($locked->lifecycle_state, EnrollmentLifecycle::STATE_FROZEN);
                    $exit = $this->exitGateSnapshot($locked);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill([
                        'lifecycle_state' => EnrollmentLifecycle::STATE_FROZEN,
                        'state_reason' => $reason,
                    ]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.enrollment.frozen', 'enrollment', $locked->id, $before, [
                        'lifecycle_state' => EnrollmentLifecycle::STATE_FROZEN,
                        'state_reason' => $reason,
                        'finance_gate_exit' => $exit,
                    ]);

                    return ['enrollment_id' => $locked->id, 'lifecycle_state' => EnrollmentLifecycle::STATE_FROZEN, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.enrollment.frozen', 'enrollment', $enrollment->id);
        }
    }

    /**
     * Unfreeze returns a frozen seat to active. A frozen seat holds no
     * capacity claim, so class/offering capacity is re-checked, and the
     * Finance gate is re-run exactly like activation: fresh signed evidence
     * is frozen on the row and an unsatisfied gate refuses the return.
     *
     * @return array{enrollment_id: string, lifecycle_state: string, correlation_id: string}
     */
    public function unfreeze(Actor $actor, Enrollment $enrollment, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.enrollment.unfreeze', $enrollment->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.enrollment.transition.'.EnrollmentLifecycle::STATE_ACTIVE, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $enrollment): array {
                    $outcome = $this->access->decide($actor, self::CAPABILITY_APPROVE, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('academic.enrollment_denied', $outcome->reason);
                    }

                    /** @var Enrollment $locked */
                    $locked = Enrollment::query()->whereKey($enrollment->id)->lockForUpdate()->firstOrFail();
                    EnrollmentLifecycle::requireTransition($locked->lifecycle_state, EnrollmentLifecycle::STATE_ACTIVE);
                    $this->assertStudentActive($locked->student_id);
                    $this->assertClassActive($locked->class_id);
                    $this->assertCapacity($locked->class_id);
                    if ($locked->offering_id !== null) {
                        $this->assertOfferingCapacity($locked->offering_id);
                    }
                    $this->freezeFinancialGate($locked, $actor);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill([
                        'lifecycle_state' => EnrollmentLifecycle::STATE_ACTIVE,
                        'state_reason' => null,
                    ]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.enrollment.active', 'enrollment', $locked->id, $before, ['lifecycle_state' => EnrollmentLifecycle::STATE_ACTIVE]);

                    return ['enrollment_id' => $locked->id, 'lifecycle_state' => EnrollmentLifecycle::STATE_ACTIVE, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.enrollment.active', 'enrollment', $enrollment->id);
        } catch (EnrollmentFinancialGateDenied $denial) {
            $this->persistDeniedGate($enrollment, $denial, $actor);
        }
    }

    /**
     * Withdraw ends a seat terminally under a mandatory human reason. Any
     * monetary settlement stays exclusively Finance-owned (refunds, credits
     * and installments are Finance commands); Academic records the Finance
     * standing at exit read-only in the audit event.
     *
     * @return array{enrollment_id: string, lifecycle_state: string, correlation_id: string}
     */
    public function withdraw(Actor $actor, Enrollment $enrollment, string $reason, string $idempotencyKey): array
    {
        $this->assertReason($reason);
        $payload = hash('sha256', implode('|', ['academic.enrollment.withdraw', $enrollment->id, $reason, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.enrollment.transition.'.EnrollmentLifecycle::STATE_WITHDRAWN, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $enrollment, $reason): array {
                    $outcome = $this->access->decide($actor, self::CAPABILITY_REQUEST, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('academic.enrollment_denied', $outcome->reason);
                    }

                    /** @var Enrollment $locked */
                    $locked = Enrollment::query()->whereKey($enrollment->id)->lockForUpdate()->firstOrFail();
                    EnrollmentLifecycle::requireTransition($locked->lifecycle_state, EnrollmentLifecycle::STATE_WITHDRAWN);
                    $exit = $this->exitGateSnapshot($locked);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill([
                        'lifecycle_state' => EnrollmentLifecycle::STATE_WITHDRAWN,
                        'state_reason' => $reason,
                    ]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.enrollment.withdrawn', 'enrollment', $locked->id, $before, [
                        'lifecycle_state' => EnrollmentLifecycle::STATE_WITHDRAWN,
                        'state_reason' => $reason,
                        'finance_gate_exit' => $exit,
                    ]);

                    return ['enrollment_id' => $locked->id, 'lifecycle_state' => EnrollmentLifecycle::STATE_WITHDRAWN, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.enrollment.withdrawn', 'enrollment', $enrollment->id);
        }
    }

    /**
     * Complete terminally marks assessed delivery with a mandatory basis and
     * verified evidence pinned on the row. A level-aware class requires
     * evidence (a released result of this seat or an approved progression
     * decision for this student and class); a legacy class keeps the
     * certified basis-only path, with optional evidence verified the same
     * way when supplied. No seat completes automatically.
     *
     * @return array{enrollment_id: string, lifecycle_state: string, correlation_id: string}
     */
    public function complete(Actor $actor, Enrollment $enrollment, string $basis, ?string $evidenceKind, ?string $evidenceId, string $idempotencyKey): array
    {
        if ($basis === '') {
            throw BusinessRejection::forCode('academic.enrollment_completion_basis_required', 'completing a seat requires its basis');
        }
        $payload = hash('sha256', implode('|', ['academic.enrollment.complete', $enrollment->id, $basis, $evidenceKind ?? '', $evidenceId ?? '', $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.enrollment.transition.'.EnrollmentLifecycle::STATE_COMPLETED, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $enrollment, $basis, $evidenceKind, $evidenceId): array {
                    $outcome = $this->access->decide($actor, self::CAPABILITY_APPROVE, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('academic.enrollment_denied', $outcome->reason);
                    }

                    /** @var Enrollment $locked */
                    $locked = Enrollment::query()->whereKey($enrollment->id)->lockForUpdate()->firstOrFail();
                    EnrollmentLifecycle::requireTransition($locked->lifecycle_state, EnrollmentLifecycle::STATE_COMPLETED);

                    /** @var ClassModel $class */
                    $class = ClassModel::query()->whereKey($locked->class_id)->firstOrFail();
                    $evidence = $this->assertCompletionEvidence($locked, $class, $evidenceKind, $evidenceId);
                    $exit = $this->exitGateSnapshot($locked);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill([
                        'lifecycle_state' => EnrollmentLifecycle::STATE_COMPLETED,
                        'state_reason' => $basis,
                        'completion_basis' => $basis,
                        'completion_evidence_kind' => $evidence['kind'] ?? null,
                        'completion_evidence_id' => $evidence['id'] ?? null,
                    ]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.enrollment.completed', 'enrollment', $locked->id, $before, [
                        'lifecycle_state' => EnrollmentLifecycle::STATE_COMPLETED,
                        'completion_basis' => $basis,
                        'completion_evidence_kind' => $evidence['kind'] ?? null,
                        'completion_evidence_id' => $evidence['id'] ?? null,
                        'finance_gate_exit' => $exit,
                    ]);

                    return ['enrollment_id' => $locked->id, 'lifecycle_state' => EnrollmentLifecycle::STATE_COMPLETED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.enrollment.completed', 'enrollment', $enrollment->id);
        }
    }

    /**
     * Transfer closes the old enrollment as transferred and opens a new
     * requested enrollment in the target class under the same invariants.
     *
     * @return array{enrollment_id: string, previous_enrollment_id: string, correlation_id: string}
     */
    public function transfer(Actor $actor, Enrollment $enrollment, string $targetClassId, string $idempotencyKey, ?string $offeringId = null): array
    {
        $payload = hash('sha256', implode('|', ['academic.enrollment.transfer', $enrollment->id, $targetClassId, $offeringId ?? '', $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.enrollment.transfer', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $enrollment, $targetClassId, $offeringId): array {
                    $outcome = $this->access->decide($actor, self::CAPABILITY_APPROVE, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('academic.enrollment_denied', $outcome->reason);
                    }

                    /** @var Enrollment $locked */
                    $locked = Enrollment::query()->whereKey($enrollment->id)->lockForUpdate()->firstOrFail();
                    EnrollmentLifecycle::requireTransition($locked->lifecycle_state, EnrollmentLifecycle::STATE_TRANSFERRED);
                    if ($targetClassId === $locked->class_id) {
                        throw BusinessRejection::forCode('academic.transfer_same_class', 'a transfer requires a different target class');
                    }
                    $this->assertClassActive($targetClassId);
                    $this->assertPrerequisitesForClass($locked->student_id, $targetClassId);
                    $this->assertStudentActive($locked->student_id);
                    $eligibilitySnapshotId = $this->currentEligibilitySnapshotId($locked->student_id);
                    $this->assertCapacity($targetClassId);
                    if ($offeringId !== null && $offeringId !== '') {
                        $this->assertOfferingOpenAndMatchesClass($offeringId, $targetClassId);
                        $this->assertOfferingCapacity($offeringId);
                    }
                    if (Enrollment::query()->where('student_id', $locked->student_id)->where('class_id', $targetClassId)->whereIn('lifecycle_state', ['requested', 'active', 'frozen'])->exists()) {
                        throw BusinessRejection::forCode('academic.enrollment_seat_exists', 'this student already holds a seat in the target class');
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => EnrollmentLifecycle::STATE_TRANSFERRED]);
                    $locked->save();

                    $next = Enrollment::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $locked->student_id,
                        'class_id' => $targetClassId,
                        'offering_id' => $offeringId !== null && $offeringId !== '' ? $offeringId : null,
                        'academic_eligibility_snapshot_id' => $eligibilitySnapshotId,
                        'lifecycle_state' => EnrollmentLifecycle::STATE_REQUESTED,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.enrollment.transfer', 'enrollment', $next->id, $before, [
                        'previous_enrollment_id' => $locked->id,
                        'student_id' => $locked->student_id,
                        'from_class' => $locked->class_id,
                        'to_class' => $targetClassId,
                        'offering_id' => $next->offering_id,
                        'academic_eligibility_snapshot_id' => $next->academic_eligibility_snapshot_id,
                        'lifecycle_state' => EnrollmentLifecycle::STATE_REQUESTED,
                    ]);

                    return ['enrollment_id' => $next->id, 'previous_enrollment_id' => $locked->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.enrollment.transfer', 'enrollment', $enrollment->id);
        }
    }

    /** @return array{enrollment_id: string, lifecycle_state: string, correlation_id: string} */
    private function transition(Actor $actor, Enrollment $enrollment, string $toState, string $capability, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.enrollment.transition', $enrollment->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.enrollment.transition.'.$toState, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $enrollment, $toState, $capability): array {
                    $outcome = $this->access->decide($actor, $capability, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('academic.enrollment_denied', $outcome->reason);
                    }

                    /** @var Enrollment $locked */
                    $locked = Enrollment::query()->whereKey($enrollment->id)->lockForUpdate()->firstOrFail();
                    EnrollmentLifecycle::requireTransition($locked->lifecycle_state, $toState);
                    if ($toState === EnrollmentLifecycle::STATE_ACTIVE) {
                        $this->assertClassActive($locked->class_id);
                        $this->assertCapacity($locked->class_id);
                        if ($locked->offering_id !== null) {
                            $this->assertOfferingCapacity($locked->offering_id);
                        }
                        $this->freezeFinancialGate($locked, $actor);
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.enrollment.'.$toState, 'enrollment', $locked->id, $before, ['lifecycle_state' => $toState]);

                    return ['enrollment_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.enrollment.'.$toState, 'enrollment', $enrollment->id);
        } catch (EnrollmentFinancialGateDenied $denial) {
            $this->persistDeniedGate($enrollment, $denial, $actor);
        }
    }

    /**
     * Finance-authoritative gate: Academic freezes the assessed, signed
     * evidence on the enrollment and refuses the transition when the result
     * is not satisfied. Academic never re-derives the balance.
     */
    private function freezeFinancialGate(Enrollment $enrollment, Actor $actor): void
    {
        $assessment = $this->financialGates->assess($enrollment);
        $this->applyGateEvidence($enrollment, $assessment);
        $enrollment->save();

        $this->audit->record($actor->actorId, 'academic.enrollment.financial_gate.satisfied', 'enrollment', $enrollment->id, null, [
            'financial_gate_satisfied' => $assessment['satisfied'],
            'financial_gate_uncovered' => $assessment['uncovered'],
            'financial_gate_remaining' => $assessment['remaining'],
            'financial_gate_evidence_sha256' => $assessment['digest'],
            'financial_gate_signature' => $assessment['signature'],
        ]);

        if (! $assessment['satisfied']) {
            throw EnrollmentFinancialGateDenied::withAssessment(
                'academic.enrollment.financial_gate',
                'the enrollment financial gate is unsatisfied',
                $assessment['evidence'],
                $assessment,
            );
        }
    }

    /**
     * A failing gate must still leave evidence. The owning transaction rolled
     * back, so the assessment is frozen in its own committed write and the
     * denial is audited before the rejection propagates.
     */
    private function persistDeniedGate(Enrollment $enrollment, EnrollmentFinancialGateDenied $denial, Actor $actor): never
    {
        DB::transaction(function () use ($enrollment, $denial): void {
            $locked = Enrollment::query()->whereKey($enrollment->id)->lockForUpdate()->first();
            if ($locked === null) {
                return;
            }
            $this->applyGateEvidence($locked, $denial->assessment());
            $locked->save();
        });

        $this->rejectedOperation->reject(
            $denial,
            $actor,
            'academic.enrollment.financial_gate',
            'enrollment',
            $enrollment->id,
            $denial->assessment(),
        );
    }

    private function assertReason(string $reason): void
    {
        if ($reason === '') {
            throw BusinessRejection::forCode('academic.enrollment_reason_required', 'this seat change requires a reason');
        }
    }

    /**
     * Finance-read exit snapshot for the freeze/withdraw/complete audit
     * payloads. Academic never writes Finance facts here; it only records
     * the Finance-authoritative standing at exit.
     *
     * @return array<string, mixed>
     */
    private function exitGateSnapshot(Enrollment $enrollment): array
    {
        $assessment = $this->financialGates->assess($enrollment);

        return [
            'satisfied' => $assessment['satisfied'],
            'remaining' => $assessment['remaining'],
            'uncovered' => $assessment['uncovered'],
            'digest' => $assessment['digest'],
            'signature' => $assessment['signature'],
            'assessed_at' => $assessment['assessed_at'],
        ];
    }

    /**
     * Verifies the assessed-delivery evidence pinned at completion. A
     * level-aware class requires evidence; a legacy class accepts a
     * basis-only completion but verifies supplied evidence the same way.
     *
     * @return array{kind: string, id: string}|null
     */
    private function assertCompletionEvidence(Enrollment $enrollment, ClassModel $class, ?string $kind, ?string $id): ?array
    {
        $kind = $kind !== null && $kind !== '' ? $kind : null;
        $id = $id !== null && $id !== '' ? $id : null;
        $levelAware = $class->program_version_level_id !== null && $class->program_version_level_id !== '';

        if ($kind === null || $id === null) {
            if ($levelAware) {
                throw BusinessRejection::forCode('academic.enrollment_completion_evidence_required', 'completing a level seat requires its assessed evidence');
            }
            if ($kind !== null || $id !== null) {
                throw BusinessRejection::forCode('academic.enrollment_completion_evidence_unknown', 'completion evidence requires both kind and id');
            }

            return null;
        }
        if (! in_array($kind, ['assessment_result', 'progression_decision'], true)) {
            throw BusinessRejection::forCode('academic.enrollment_completion_evidence_unknown', sprintf('unknown completion evidence kind %s', $kind));
        }
        if ($kind === 'assessment_result') {
            /** @var AssessmentResult|null $result */
            $result = AssessmentResult::query()->find($id);
            if ($result === null || $result->lifecycle_state !== AssessmentResultLifecycle::STATE_RELEASED) {
                throw BusinessRejection::forCode('academic.enrollment_completion_evidence_mismatch', 'completion requires a released assessment result of this seat');
            }
            $attempt = $result->attempt()->firstOrFail();
            if (trim((string) $attempt->enrollment_id) !== trim($enrollment->id)) {
                throw BusinessRejection::forCode('academic.enrollment_completion_evidence_mismatch', 'the assessment result does not belong to this seat');
            }
        } else {
            /** @var ProgressionDecision|null $decision */
            $decision = ProgressionDecision::query()->find($id);
            if ($decision === null || $decision->lifecycle_state !== ProgressionLifecycle::STATE_APPROVED) {
                throw BusinessRejection::forCode('academic.enrollment_completion_evidence_mismatch', 'completion requires an approved progression decision for this seat');
            }
            if (trim((string) $decision->student_id) !== trim($enrollment->student_id) || trim((string) $decision->class_id) !== trim($enrollment->class_id)) {
                throw BusinessRejection::forCode('academic.enrollment_completion_evidence_mismatch', 'the progression decision does not belong to this seat');
            }
        }

        return ['kind' => $kind, 'id' => $id];
    }

    /** @param array<string, mixed> $assessment */
    private function applyGateEvidence(Enrollment $enrollment, array $assessment): void
    {
        $enrollment->forceFill([
            'financial_gate_evidence' => $assessment['evidence'],
            'financial_gate_evidence_sha256' => $assessment['digest'],
            'financial_gate_signature' => $assessment['signature'],
            'financial_gate_assessed_at' => $assessment['assessed_at'],
            'financial_gate_satisfied' => $assessment['satisfied'],
        ]);
    }

    private function currentEligibilitySnapshotId(string $studentId): ?string
    {
        $snapshotId = Student::query()->whereKey($studentId)->value('academic_eligibility_snapshot_id');
        if ($snapshotId === null) {
            return null;
        }
        /** @var AcademicEligibilitySnapshot $snapshot */
        $snapshot = AcademicEligibilitySnapshot::query()->findOrFail($snapshotId);
        $verification = $this->eligibilitySnapshots->verify($snapshot);
        if (! $verification['valid']) {
            throw BusinessRejection::forCode('academic.eligibility_snapshot_unverified', 'the student eligibility snapshot could not be verified: '.$verification['reason']);
        }

        return $snapshot->id;
    }

    private function assertStudentActive(string $studentId): void
    {
        /** @var Student|null $student */
        $student = Student::query()->find($studentId);
        if ($student === null) {
            throw BusinessRejection::forCode('academic.student_unknown', 'enrollment requires a known student');
        }
        /** @var StudentStatus|null $status */
        $status = StudentStatus::query()->where('student_id', $studentId)->orderByDesc('seq')->first();
        if ($status === null || $status->status !== 'active') {
            throw BusinessRejection::forCode('academic.student_not_active', 'enrollment requires a currently active student');
        }
    }

    private function assertClassActive(string $classId): void
    {
        /** @var ClassModel|null $class */
        $class = ClassModel::query()->find($classId);
        if ($class === null || $class->lifecycle_state !== ClassLifecycle::STATE_ACTIVE) {
            throw BusinessRejection::forCode('academic.class_not_active', 'the class is not active');
        }
    }

    private function assertPrerequisitesForClass(string $studentId, string $classId): void
    {
        /** @var ClassModel $class */
        $class = ClassModel::query()->whereKey($classId)->firstOrFail();
        if ($class->program_version_level_id === null || $class->program_version_level_id === '') {
            return;
        }
        /** @var ProgramVersionLevel $target */
        $target = ProgramVersionLevel::query()->whereKey($class->program_version_level_id)->firstOrFail();
        $violations = $this->history->prerequisiteViolations($studentId, $target);
        if ($violations !== []) {
            $keys = implode(', ', array_column($violations, 'level_key'));
            throw BusinessRejection::forCode('academic.enrollment_prerequisite_unsatisfied', 'level prerequisites are unsatisfied: '.$keys);
        }
    }

    private function assertOfferingOpenAndMatchesClass(string $offeringId, string $classId): void
    {
        /** @var Offering|null $offering */
        $offering = Offering::query()->find($offeringId);
        if ($offering === null || $offering->lifecycle_state !== Offering::STATE_OPEN) {
            throw BusinessRejection::forCode('academic.offering_not_open', 'a new enrollment may target only an open offering');
        }
        /** @var ClassModel $class */
        $class = ClassModel::query()->whereKey($classId)->firstOrFail();
        if ($offering->academic_period_id !== $class->period_id || $offering->program_version_level_id !== $class->program_version_level_id) {
            throw BusinessRejection::forCode('academic.enrollment_offering_mismatch', 'the enrollment offering must match the class period and level');
        }
    }

    private function assertOfferingCapacity(string $offeringId): void
    {
        /** @var Offering $offering */
        $offering = Offering::query()->whereKey($offeringId)->lockForUpdate()->firstOrFail();
        $activeSeats = Enrollment::query()->where('offering_id', $offeringId)->where('lifecycle_state', 'active')->count();
        if ($activeSeats >= $offering->capacity) {
            throw BusinessRejection::forCode('academic.offering_full', sprintf('offering capacity of %d is exhausted', $offering->capacity));
        }
    }

    private function assertCapacity(string $classId): void
    {
        /** @var ClassModel $class */
        $class = ClassModel::query()->whereKey($classId)->lockForUpdate()->firstOrFail();
        $activeSeats = Enrollment::query()->where('class_id', $classId)->where('lifecycle_state', 'active')->count();
        if ($activeSeats >= $class->capacity) {
            throw BusinessRejection::forCode('academic.class_full', sprintf('class capacity of %d is exhausted', $class->capacity));
        }
    }
}
