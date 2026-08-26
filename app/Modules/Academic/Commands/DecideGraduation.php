<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\ProgressionLifecycle;
use App\Modules\Academic\Models\Certificate;
use App\Modules\Academic\Models\GraduationDecision;
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
 * Graduation eligibility and certification: propose with the requirements
 * basis, independent review, Academic Management approval; a certificate
 * is issued only from an approved eligible decision and its issuance
 * record is immutable with a unique serial.
 */
final class DecideGraduation
{
    public const CAPABILITY_PROPOSE = 'academic.completion';

    public const CAPABILITY_APPROVE = 'academic.completion_approve';

    public const CAPABILITY_CERTIFY = 'academic.certify';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{decision_id: string, correlation_id: string} */
    public function propose(Actor $proposer, string $studentId, string $programVersionId, string $outcome, string $basis, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.graduation.propose', $studentId, $programVersionId, $outcome, $basis, $proposer->actorId]));

        try {
            return $this->idempotency->execute('academic.graduation.propose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($proposer, $studentId, $programVersionId, $outcome, $basis): array {
                    $this->require($proposer, self::CAPABILITY_PROPOSE, 'academic.graduation_denied');
                    if (! in_array($outcome, ['eligible', 'not_eligible'], true)) {
                        throw BusinessRejection::forCode('academic.graduation_outcome_unknown', sprintf('unknown graduation outcome %s', $outcome));
                    }
                    if ($basis === '') {
                        throw BusinessRejection::forCode('academic.graduation_basis', 'a graduation decision requires its requirements basis');
                    }
                    if (GraduationDecision::query()->where('student_id', $studentId)->where('program_version_id', $programVersionId)->whereIn('lifecycle_state', ['proposed', 'reviewed', 'approved'])->exists()) {
                        throw BusinessRejection::forCode('academic.graduation_open_decision', 'this student and program version already have an open graduation decision');
                    }

                    $decision = GraduationDecision::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $studentId,
                        'program_version_id' => $programVersionId,
                        'outcome' => $outcome,
                        'basis' => $basis,
                        'lifecycle_state' => ProgressionLifecycle::STATE_PROPOSED,
                        'proposed_by' => $proposer->actorId,
                    ]);
                    $event = $this->audit->record($proposer->actorId, 'academic.graduation.propose', 'graduation_decision', $decision->id, null, [
                        'student_id' => $studentId, 'program_version_id' => $programVersionId, 'outcome' => $outcome,
                    ]);

                    return ['decision_id' => $decision->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $proposer, 'academic.graduation.propose', 'graduation_decision', $studentId);
        }
    }

    /** @return array{decision_id: string, lifecycle_state: string, correlation_id: string} */
    public function review(Actor $reviewer, GraduationDecision $decision, string $idempotencyKey): array
    {
        return $this->transition($reviewer, $decision, ProgressionLifecycle::STATE_REVIEWED, self::CAPABILITY_PROPOSE, 'review', $idempotencyKey);
    }

    /** @return array{decision_id: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, GraduationDecision $decision, string $idempotencyKey): array
    {
        return $this->transition($approver, $decision, ProgressionLifecycle::STATE_APPROVED, self::CAPABILITY_APPROVE, 'approve', $idempotencyKey);
    }

    /** @return array{decision_id: string, lifecycle_state: string, correlation_id: string} */
    public function reject(Actor $approver, GraduationDecision $decision, string $idempotencyKey): array
    {
        return $this->transition($approver, $decision, ProgressionLifecycle::STATE_REJECTED, self::CAPABILITY_APPROVE, 'reject', $idempotencyKey);
    }

    /** @return array{certificate_id: string, serial: string, correlation_id: string} */
    public function issueCertificate(Actor $issuer, GraduationDecision $decision, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.certificate.issue', $decision->id, $issuer->actorId]));

        try {
            return $this->idempotency->execute('academic.certificate.issue', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($issuer, $decision): array {
                    $this->require($issuer, self::CAPABILITY_CERTIFY, 'academic.certify_denied');

                    /** @var GraduationDecision $locked */
                    $locked = GraduationDecision::query()->whereKey($decision->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'approved' || $locked->outcome !== 'eligible') {
                        throw BusinessRejection::forCode('academic.certificate_requires_approval', 'a certificate requires an approved eligible graduation decision');
                    }
                    if (Certificate::query()->where('graduation_decision_id', $locked->id)->exists()) {
                        throw BusinessRejection::forCode('academic.certificate_already_issued', 'this graduation decision already produced a certificate');
                    }

                    $certificate = Certificate::query()->create([
                        'id' => RandomIdentifier::new(),
                        'graduation_decision_id' => $locked->id,
                        'student_id' => $locked->student_id,
                        'serial' => 'CERT-'.strtoupper(bin2hex(random_bytes(6))),
                    ]);
                    $event = $this->audit->record($issuer->actorId, 'academic.certificate.issue', 'certificate', $certificate->id, null, [
                        'graduation_decision_id' => $locked->id, 'serial' => $certificate->serial,
                    ]);

                    return ['certificate_id' => $certificate->id, 'serial' => $certificate->serial, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $issuer, 'academic.certificate.issue', 'certificate', $decision->id);
        }
    }

    /** @return array{decision_id: string, lifecycle_state: string, correlation_id: string} */
    private function transition(Actor $actor, GraduationDecision $decision, string $toState, string $capability, string $verb, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.graduation.'.$verb, $decision->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.graduation.'.$verb, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $decision, $toState, $capability, $verb): array {
                    $this->require($actor, $capability, 'academic.graduation_denied');

                    /** @var GraduationDecision $locked */
                    $locked = GraduationDecision::query()->whereKey($decision->id)->lockForUpdate()->firstOrFail();
                    ProgressionLifecycle::requireTransition($locked->lifecycle_state, $toState);
                    if ($toState === ProgressionLifecycle::STATE_REVIEWED && trim((string) $locked->proposed_by) === $actor->actorId) {
                        throw AuthorizationDenied::forCode('academic.review_not_independent', 'the reviewer may not be the proposer');
                    }
                    if ($toState === ProgressionLifecycle::STATE_APPROVED && (trim((string) $locked->proposed_by) === $actor->actorId || trim((string) $locked->reviewed_by) === $actor->actorId)) {
                        throw AuthorizationDenied::forCode('academic.approval_not_independent', 'the approver must differ from the proposer and the reviewer');
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState]);
                    if ($toState === ProgressionLifecycle::STATE_REVIEWED) {
                        $locked->reviewed_by = $actor->actorId;
                    }
                    if (in_array($toState, [ProgressionLifecycle::STATE_APPROVED, ProgressionLifecycle::STATE_REJECTED], true)) {
                        $locked->approved_by = $actor->actorId;
                    }
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.graduation.'.$verb, 'graduation_decision', $locked->id, $before, ['lifecycle_state' => $toState]);

                    return ['decision_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.graduation.'.$verb, 'graduation_decision', $decision->id);
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
