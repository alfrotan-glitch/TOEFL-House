<?php

declare(strict_types=1);

namespace App\Modules\Identity\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\Person;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\AuthorizationGate;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Errors\DomainError;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * Identity verification writes the canonical identity key exactly once; a
 * second verified identity for the same human is a business rejection and
 * the partial unique index keeps the invariant under concurrency.
 */
final class VerifyPerson
{
    public const CAPABILITY = 'identity.verify';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{person_id: string, identity_key: string, correlation_id: string} */
    public function verify(Actor $administrator, Person $person, string $identityKey, string $evidenceRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['identity.verify', $person->id, $identityKey, $evidenceRef, $administrator->actorId]));

        try {
            return $this->idempotency->execute('identity.verify', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($administrator, $person, $identityKey, $evidenceRef): array {
                    AuthorizationGate::require($this->access, $administrator, self::CAPABILITY, null, 'identity.verify_denied');

                    /** @var Person $locked */
                    $locked = Person::query()->whereKey($person->id)->lockForUpdate()->firstOrFail();
                    if ($locked->isVerified()) {
                        throw BusinessRejection::forCode('identity.already_verified', 'person identity is already verified');
                    }

                    $duplicate = Person::query()
                        ->where('verification_state', Person::VERIFICATION_VERIFIED)
                        ->where('identity_key', $identityKey)
                        ->exists();
                    if ($duplicate) {
                        throw BusinessRejection::forCode('identity.duplicate_verified_person', 'identity key already belongs to a verified person');
                    }

                    $correlationId = DomainError::newCorrelationId();
                    $locked->identity_key = $identityKey;
                    $locked->identity_evidence_ref = $evidenceRef;
                    $locked->verification_state = Person::VERIFICATION_VERIFIED;
                    $locked->verified_at = now()->toDateTimeString();
                    $locked->verified_by = $administrator->actorId;
                    try {
                        $locked->save();
                    } catch (UniqueConstraintViolationException) {
                        throw BusinessRejection::forCode('identity.duplicate_verified_person', 'identity key already belongs to a verified person');
                    }

                    $this->audit->record(
                        $administrator->actorId,
                        'identity.verify',
                        'person',
                        $locked->id,
                        ['verification_state' => Person::VERIFICATION_UNVERIFIED],
                        ['verification_state' => Person::VERIFICATION_VERIFIED, 'identity_key' => $identityKey, 'identity_evidence_ref' => $evidenceRef],
                        $correlationId,
                    );

                    return ['person_id' => $locked->id, 'identity_key' => $identityKey, 'correlation_id' => $correlationId];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $administrator, 'identity.verify', 'person', $person->id);
        }
    }
}
