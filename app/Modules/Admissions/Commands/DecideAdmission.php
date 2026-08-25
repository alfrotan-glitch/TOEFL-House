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
 * The admission decision under the authority registry: Reception/Admissions
 * initiates, Academic/Admissions reviews, the policy owner approves — three
 * distinct actors. Reception alone can never permanently convert anyone.
 * The decision is append-only and retains prior decisions.
 */
final class DecideAdmission
{
    public const CAPABILITY_INITIATE = 'admissions.initiate';

    public const CAPABILITY_REVIEW = 'admissions.review';

    public const CAPABILITY_APPROVE = 'admissions.approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /**
     * @return array{decision_id: string, outcome: string, correlation_id: string}
     */
    public function decide(Actor $initiator, Actor $reviewer, Actor $approver, Applicant $applicant, bool $admit, string $reason, string $evidenceRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['admissions.decide', $applicant->id, $admit ? 'admit' : 'reject', $reason, $initiator->actorId, $reviewer->actorId, $approver->actorId]));

        try {
            return $this->idempotency->execute('admissions.decide', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($initiator, $reviewer, $approver, $applicant, $admit, $reason, $evidenceRef): array {
                    $this->requireCapability($initiator, self::CAPABILITY_INITIATE, 'admissions.initiator_denied');
                    $this->requireCapability($reviewer, self::CAPABILITY_REVIEW, 'admissions.reviewer_denied');
                    $this->requireCapability($approver, self::CAPABILITY_APPROVE, 'admissions.approver_denied');
                    $distinct = [$initiator->actorId, $reviewer->actorId, $approver->actorId];
                    if (count(array_unique($distinct, SORT_STRING)) < 3) {
                        throw AuthorizationDenied::forCode('admissions.single_actor', 'initiator, reviewer, and approver must be distinct actors');
                    }
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
                        'reviewer_id' => $reviewer->actorId,
                        'approver_id' => $approver->actorId,
                    ]);

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState]);
                    $locked->save();

                    $event = $this->audit->record($initiator->actorId, 'admissions.decide', 'admission_decision', $decision->id, $before, [
                        'applicant_id' => $locked->id,
                        'outcome' => $decision->outcome,
                        'reason' => $reason,
                        'initiator' => $initiator->actorId,
                        'reviewer' => $reviewer->actorId,
                        'approver' => $approver->actorId,
                    ]);

                    return ['decision_id' => $decision->id, 'outcome' => $decision->outcome, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $initiator, 'admissions.decide', 'applicant', $applicant->id);
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
