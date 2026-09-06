<?php

declare(strict_types=1);

namespace App\Modules\Privacy\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\Person;
use App\Modules\Privacy\Models\Disclosure;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Records the release of personal information: recipient, purpose,
 * authority, scope, time, and disclosed category. Disclosure of restricted
 * categories additionally requires the disclose capability; the record is
 * append-only evidence and can never be rewritten.
 */
final class RecordDisclosure
{
    public const CAPABILITY = 'privacy.disclose';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /**
     * @return array{disclosure_id: string, correlation_id: string}
     */
    public function disclose(Actor $discloser, string $subjectPersonId, string $recipient, string $purpose, string $authority, string $scopeType, string $scopeId, string $disclosedCategory, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['privacy.disclose', $subjectPersonId, $recipient, $purpose, $authority, $scopeType, $scopeId, $disclosedCategory, $discloser->actorId]));

        try {
            return $this->idempotency->execute('privacy.disclose', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($discloser, $subjectPersonId, $recipient, $purpose, $authority, $scopeType, $scopeId, $disclosedCategory): array {
                    $outcome = $this->access->decide($discloser, self::CAPABILITY, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('privacy.disclose_denied', $outcome->reason);
                    }
                    if (! Person::query()->whereKey($subjectPersonId)->exists()) {
                        throw BusinessRejection::forCode('privacy.disclose_subject_unknown', 'disclosure requires a known subject');
                    }
                    if ($recipient === '' || $purpose === '' || $disclosedCategory === '') {
                        throw BusinessRejection::forCode('privacy.disclose_minimum_fields', 'disclosure requires recipient, purpose, and disclosed category');
                    }

                    $disclosure = Disclosure::query()->create([
                        'id' => RandomIdentifier::new(),
                        'subject_person_id' => $subjectPersonId,
                        'recipient' => $recipient,
                        'purpose' => $purpose,
                        'authority' => $authority,
                        'scope_type' => $scopeType,
                        'scope_id' => $scopeId,
                        'disclosed_category' => $disclosedCategory,
                        'disclosed_by' => $discloser->actorId,
                    ]);

                    $event = $this->audit->record($discloser->actorId, 'privacy.disclose', 'disclosure', $disclosure->id, null, [
                        'subject_person_id' => $subjectPersonId,
                        'recipient' => $recipient,
                        'purpose' => $purpose,
                        'scope' => $scopeType.':'.$scopeId,
                        'disclosed_category' => $disclosedCategory,
                    ]);

                    return ['disclosure_id' => $disclosure->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $discloser, 'privacy.disclose', 'disclosure', $subjectPersonId);
        }
    }
}
