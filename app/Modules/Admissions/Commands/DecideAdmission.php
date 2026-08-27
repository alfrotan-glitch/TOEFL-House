<?php

declare(strict_types=1);

namespace App\Modules\Admissions\Commands;

use App\Modules\Admissions\Domain\ApplicantLifecycle;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
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
 * The admission decision under the authority registry, staged so that each
 * signature is captured in its own authenticated session:
 *
 *   - Reception/Admissions INITIATES (admissions.initiate): outcome,
 *     reason, and evidence are fixed up front; the decision is born
 *     'proposed';
 *   - a distinct REVIEWER (admissions.review) reviews it — 'reviewed';
 *   - a third, distinct APPROVER (admissions.approve) finalizes it —
 *     'final', and only finalization transitions the applicant.
 *
 * No single person, however many capabilities they hold, can carry more
 * than one stage. The decision is append-only and retains prior decisions.
 */
final class DecideAdmission
{
    public const CAPABILITY_INITIATE = 'admissions.initiate';

    public const CAPABILITY_REVIEW = 'admissions.review';

    public const CAPABILITY_APPROVE = 'admissions.approve';

    public const STATE_PROPOSED = 'proposed';

    public const STATE_REVIEWED = 'reviewed';

    public const STATE_FINAL = 'final';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{decision_id: string, outcome: string, lifecycle_state: string, correlation_id: string} */
    public function initiate(Actor $initiator, Applicant $applicant, bool $admit, string $reason, string $evidenceRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['admissions.initiate', $applicant->id, $admit ? 'admit' : 'reject', $reason, $evidenceRef, $initiator->actorId]));

        try {
            return $this->idempotency->execute('admissions.initiate', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($initiator, $applicant, $admit, $reason, $evidenceRef): array {
                    $this->requireCapability($initiator, self::CAPABILITY_INITIATE, 'admissions.initiator_denied');
                    if ($reason === '' || $evidenceRef === '') {
                        throw BusinessRejection::forCode('admissions.decision_evidence', 'a decision requires reason and evidence');
                    }

                    /** @var Applicant $locked */
                    $locked = Applicant::query()->whereKey($applicant->id)->lockForUpdate()->firstOrFail();
                    $toState = $admit ? ApplicantLifecycle::STATE_ADMITTED : ApplicantLifecycle::STATE_REJECTED;
                    ApplicantLifecycle::requireTransition($locked->lifecycle_state, $toState);

                    $decision = AdmissionDecision::query()->create([
                        'id' => RandomIdentifier::new(),
                        'applicant_id' => $locked->id,
                        'outcome' => $admit ? 'admit' : 'reject',
                        'reason' => $reason,
                        'evidence_ref' => $evidenceRef,
                        'initiator_id' => $initiator->actorId,
                        'lifecycle_state' => self::STATE_PROPOSED,
                    ]);

                    $event = $this->audit->record($initiator->actorId, 'admissions.initiate', 'admission_decision', $decision->id, null, [
                        'applicant_id' => $locked->id,
                        'outcome' => $decision->outcome,
                        'reason' => $reason,
                        'initiator' => $initiator->actorId,
                    ]);

                    return ['decision_id' => $decision->id, 'outcome' => $decision->outcome, 'lifecycle_state' => self::STATE_PROPOSED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $initiator, 'admissions.initiate', 'applicant', $applicant->id);
        }
    }

    /** @return array{decision_id: string, lifecycle_state: string, correlation_id: string} */
    public function review(Actor $reviewer, AdmissionDecision $decision, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['admissions.review', $decision->id, $reviewer->actorId]));

        try {
            return $this->idempotency->execute('admissions.review', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($reviewer, $decision): array {
                    $this->requireCapability($reviewer, self::CAPABILITY_REVIEW, 'admissions.reviewer_denied');

                    /** @var AdmissionDecision $locked */
                    $locked = AdmissionDecision::query()->whereKey($decision->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== self::STATE_PROPOSED) {
                        throw BusinessRejection::forCode('admissions.decision_not_proposed', sprintf('only a proposed decision can be reviewed (state: %s)', $locked->lifecycle_state));
                    }
                    // char(N) columns come back space-padded — compare trimmed.
                    if (trim((string) $locked->initiator_id) === $reviewer->actorId) {
                        throw AuthorizationDenied::forCode('admissions.single_actor', 'the admission reviewer must differ from the initiator');
                    }

                    /** @var Applicant $lockedApplicant */
                    $lockedApplicant = Applicant::query()->whereKey($locked->applicant_id)->lockForUpdate()->firstOrFail();
                    if ($lockedApplicant->lifecycle_state !== ApplicantLifecycle::STATE_APPLICANT) {
                        throw BusinessRejection::forCode('admissions.applicant_not_decidable', sprintf('the applicant is no longer in the decidable state (currently %s)', $lockedApplicant->lifecycle_state));
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => self::STATE_REVIEWED, 'reviewer_id' => $reviewer->actorId]);
                    $locked->save();
                    $event = $this->audit->record($reviewer->actorId, 'admissions.review', 'admission_decision', $locked->id, $before, [
                        'lifecycle_state' => self::STATE_REVIEWED,
                        'reviewer' => $reviewer->actorId,
                    ]);

                    return ['decision_id' => $locked->id, 'lifecycle_state' => self::STATE_REVIEWED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $reviewer, 'admissions.review', 'admission_decision', $decision->id);
        }
    }

    /** @return array{decision_id: string, outcome: string, lifecycle_state: string, correlation_id: string} */
    public function approve(Actor $approver, AdmissionDecision $decision, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['admissions.approve', $decision->id, $approver->actorId]));

        try {
            return $this->idempotency->execute('admissions.approve', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($approver, $decision): array {
                    $this->requireCapability($approver, self::CAPABILITY_APPROVE, 'admissions.approver_denied');

                    /** @var AdmissionDecision $locked */
                    $locked = AdmissionDecision::query()->whereKey($decision->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== self::STATE_REVIEWED) {
                        throw BusinessRejection::forCode('admissions.decision_not_reviewed', sprintf('only a reviewed decision can be approved (state: %s)', $locked->lifecycle_state));
                    }
                    // char(N) columns come back space-padded — compare trimmed.
                    if (trim((string) $locked->initiator_id) === $approver->actorId
                        || trim((string) $locked->reviewer_id) === $approver->actorId) {
                        throw AuthorizationDenied::forCode('admissions.single_actor', 'the admission approver must differ from the initiator and the reviewer');
                    }

                    /** @var Applicant $lockedApplicant */
                    $lockedApplicant = Applicant::query()->whereKey($locked->applicant_id)->lockForUpdate()->firstOrFail();
                    $toState = $locked->outcome === 'admit' ? ApplicantLifecycle::STATE_ADMITTED : ApplicantLifecycle::STATE_REJECTED;
                    ApplicantLifecycle::requireTransition($lockedApplicant->lifecycle_state, $toState);

                    $before = ['lifecycle_state' => $locked->lifecycle_state, 'applicant_state' => $lockedApplicant->lifecycle_state];
                    // Finalizing the decision is what transitions the
                    // applicant — the schema guard performs the same
                    // applicants update atomically; the command-side save
                    // below keeps the model and its audit trail in step.
                    $locked->forceFill(['lifecycle_state' => self::STATE_FINAL, 'approver_id' => $approver->actorId]);
                    $locked->save();
                    $lockedApplicant->refresh();
                    $event = $this->audit->record($approver->actorId, 'admissions.approve', 'admission_decision', $locked->id, $before, [
                        'lifecycle_state' => self::STATE_FINAL,
                        'outcome' => $locked->outcome,
                        'approver' => $approver->actorId,
                        'applicant_state' => $lockedApplicant->lifecycle_state,
                    ]);

                    return ['decision_id' => $locked->id, 'outcome' => $locked->outcome, 'lifecycle_state' => self::STATE_FINAL, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $approver, 'admissions.approve', 'admission_decision', $decision->id);
        }
    }

    private function requireCapability(Actor $actor, string $capability, string $errorCode): void
    {
        $outcome = $this->access->decide($actor, $capability, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode($errorCode, $outcome->reason);
        }
    }
}
