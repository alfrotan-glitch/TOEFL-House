<?php

declare(strict_types=1);

namespace App\Modules\Admissions\Commands;

use App\Modules\Admissions\Domain\ApplicantLifecycle;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\Person;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Registers an admission prospect and promotes it to applicant: the person
 * must be identity-verified (Identity -> Admissions boundary rejects
 * unverified identity). A person has at most one open admission file.
 */
final class RegisterApplicant
{
    public const CAPABILITY = 'admissions.register';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{applicant_id: string, correlation_id: string} */
    public function register(Actor $registrar, string $personId, string $programInterest, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['admissions.register', $personId, $programInterest, $registrar->actorId]));

        try {
            return $this->idempotency->execute('admissions.register', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($registrar, $personId, $programInterest): array {
                    $outcome = $this->access->decide($registrar, self::CAPABILITY, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('admissions.register_denied', $outcome->reason);
                    }
                    $person = Person::query()->find($personId);
                    if ($person === null || $person->verification_state !== Person::VERIFICATION_VERIFIED) {
                        throw BusinessRejection::forCode('admissions.person_unverified', 'an applicant requires a verified person identity');
                    }
                    if ($programInterest === '') {
                        throw BusinessRejection::forCode('admissions.program_missing', 'an applicant requires a program interest');
                    }
                    if (Applicant::query()->whereIn('lifecycle_state', ['prospect', 'applicant', 'admitted'])->where('person_id', $personId)->exists()) {
                        throw BusinessRejection::forCode('admissions.open_file_exists', 'this person already has an open admission file');
                    }

                    $applicant = Applicant::query()->create([
                        'id' => RandomIdentifier::new(),
                        'person_id' => $personId,
                        'program_interest' => $programInterest,
                        'lifecycle_state' => ApplicantLifecycle::STATE_APPLICANT,
                        'recorded_by' => $registrar->actorId,
                    ]);

                    $event = $this->audit->record($registrar->actorId, 'admissions.register', 'applicant', $applicant->id, null, [
                        'person_id' => $personId, 'program_interest' => $programInterest, 'lifecycle_state' => ApplicantLifecycle::STATE_APPLICANT,
                    ]);

                    return ['applicant_id' => $applicant->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $registrar, 'admissions.register', 'applicant', $personId);
        }
    }
}
