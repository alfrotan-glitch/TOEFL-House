<?php

declare(strict_types=1);

namespace App\Modules\Admissions\Commands;

use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Queries\AcademicEligibilitySnapshotQuery;
use App\Modules\Admissions\Domain\ApplicantLifecycle;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Domain\VisitorConversionRecorder;
use App\Modules\Crm\Models\Visitor;
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
        private readonly VisitorConversionRecorder $visitorConversionRecorder,
        private readonly AcademicEligibilitySnapshotQuery $eligibilitySnapshots,
    ) {}

    /** @return array{applicant_id: string, correlation_id: string} */
    public function register(Actor $registrar, string $personId, string $programInterest, string $idempotencyKey, ?string $placementProfileId = null): array
    {
        $payload = hash('sha256', implode('|', ['admissions.register', $personId, $programInterest, $placementProfileId ?? '', $registrar->actorId]));

        try {
            return $this->idempotency->execute('admissions.register', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($registrar, $personId, $programInterest, $placementProfileId): array {
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
                    $snapshotId = null;
                    if ($placementProfileId !== null && $placementProfileId !== '') {
                        $snapshotId = $this->requireReleasedEligibilitySnapshotFor($placementProfileId, $personId);
                    }

                    $applicant = Applicant::query()->create([
                        'id' => RandomIdentifier::new(),
                        'person_id' => $personId,
                        'program_interest' => $programInterest,
                        'lifecycle_state' => ApplicantLifecycle::STATE_APPLICANT,
                        'recorded_by' => $registrar->actorId,
                        'placement_profile_id' => ($placementProfileId !== null && $placementProfileId !== '') ? $placementProfileId : null,
                        'academic_eligibility_snapshot_id' => $snapshotId,
                    ]);

                    $event = $this->audit->record($registrar->actorId, 'admissions.register', 'applicant', $applicant->id, null, [
                        'person_id' => $personId, 'program_interest' => $programInterest, 'lifecycle_state' => ApplicantLifecycle::STATE_APPLICANT,
                        'placement_profile_id' => $applicant->placement_profile_id,
                        'academic_eligibility_snapshot_id' => $applicant->academic_eligibility_snapshot_id,
                    ]);
                    $this->recordVisitorConversion($registrar, $personId, 'applicant', $applicant->id);

                    return ['applicant_id' => $applicant->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $registrar, 'admissions.register', 'applicant', $personId);
        }
    }

    private function requireReleasedEligibilitySnapshotFor(string $placementProfileId, string $personId): string
    {
        /** @var PlacementProfile|null $profile */
        $profile = PlacementProfile::query()->find($placementProfileId);
        if ($profile === null || trim((string) $profile->person_id) !== $personId) {
            throw BusinessRejection::forCode('admissions.placement_person_mismatch', 'the referenced placement profile belongs to another person');
        }
        if ($profile->lifecycle_state !== PlacementProfile::STATE_RELEASED) {
            throw BusinessRejection::forCode('admissions.placement_not_released', 'admission registration may reference only a released placement profile');
        }

        $snapshot = $this->eligibilitySnapshots->for($profile);
        if ($snapshot === null) {
            throw BusinessRejection::forCode('admissions.eligibility_snapshot_missing', 'admission registration requires a signed eligibility snapshot from the released placement profile');
        }
        if (! $snapshot['verification']['valid']) {
            throw BusinessRejection::forCode('admissions.eligibility_snapshot_unverified', 'the placement eligibility snapshot could not be verified: '.$snapshot['verification']['reason']);
        }

        return (string) $snapshot['snapshot']['id'];
    }

    private function recordVisitorConversion(Actor $actor, string $personId, string $conversionType, string $downstreamId): void
    {
        /** @var Visitor|null $visitor */
        $visitor = Visitor::query()
            ->where('person_id', $personId)
            ->whereIn('status', Visitor::openStatuses())
            ->first();
        if ($visitor === null) {
            return;
        }

        $this->visitorConversionRecorder->record(
            $actor,
            $visitor,
            $conversionType,
            $conversionType,
            $downstreamId,
            'admissions.register.conversion.'.$visitor->id,
        );
    }
}
