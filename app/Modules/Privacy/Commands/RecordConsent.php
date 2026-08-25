<?php

declare(strict_types=1);

namespace App\Modules\Privacy\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\Person;
use App\Modules\Privacy\Models\Consent;
use App\Modules\Privacy\Models\ConsentPurpose;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Records a subject's consent for a defined purpose as a draft with
 * evidence. The subject must be a verified person; staff recording on the
 * subject's behalf need the consent capability.
 */
final class RecordConsent
{
    public const CAPABILITY = 'privacy.consent';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /**
     * @return array{consent_id: string, correlation_id: string}
     */
    public function record(Actor $recorder, string $subjectPersonId, string $purposeId, string $evidenceRef, CarbonImmutable $effectiveFrom, ?CarbonImmutable $effectiveTo, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['privacy.consent.record', $subjectPersonId, $purposeId, $evidenceRef, $effectiveFrom->toDateString(), $effectiveTo?->toDateString() ?? '', $recorder->actorId]));

        try {
            return $this->idempotency->execute('privacy.consent.record', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($recorder, $subjectPersonId, $purposeId, $evidenceRef, $effectiveFrom, $effectiveTo): array {
                    if ($recorder->actorId !== $subjectPersonId) {
                        $outcome = $this->access->decide($recorder, self::CAPABILITY, null);
                        if (! $outcome->allowed) {
                            throw AuthorizationDenied::forCode('privacy.consent_denied', $outcome->reason);
                        }
                    }

                    $subject = Person::query()->find($subjectPersonId);
                    if ($subject === null || $subject->verification_state !== Person::VERIFICATION_VERIFIED) {
                        throw BusinessRejection::forCode('privacy.consent_subject_unverified', 'consent requires a verified subject identity');
                    }
                    if (! ConsentPurpose::query()->whereKey($purposeId)->exists()) {
                        throw BusinessRejection::forCode('privacy.consent_purpose_unknown', 'consent requires a defined purpose');
                    }
                    if ($evidenceRef === '') {
                        throw BusinessRejection::forCode('privacy.consent_evidence_missing', 'consent requires evidence');
                    }
                    if ($effectiveTo !== null && $effectiveTo->startOfDay()->lessThanOrEqualTo($effectiveFrom->startOfDay())) {
                        throw BusinessRejection::forCode('privacy.consent_period', 'consent period must end after it starts');
                    }

                    $consent = Consent::query()->create([
                        'id' => RandomIdentifier::new(),
                        'subject_person_id' => $subjectPersonId,
                        'purpose_id' => $purposeId,
                        'lifecycle_state' => 'draft',
                        'effective_from' => $effectiveFrom->startOfDay()->toDateString(),
                        'effective_to' => $effectiveTo?->startOfDay()->toDateString(),
                        'evidence_ref' => $evidenceRef,
                        'recorded_by' => $recorder->actorId,
                    ]);

                    $event = $this->audit->record($recorder->actorId, 'privacy.consent.record', 'consent', $consent->id, null, [
                        'subject_person_id' => $subjectPersonId,
                        'purpose_id' => $purposeId,
                        'lifecycle_state' => 'draft',
                        'effective_from' => $consent->effective_from,
                    ]);

                    return ['consent_id' => $consent->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $recorder, 'privacy.consent.record', 'consent', $subjectPersonId);
        }
    }
}
