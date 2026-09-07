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
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Models\Student;
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
    public function register(Actor $registrar, string $personId, string $programInterest, string $idempotencyKey, ?string $placementProfileId = null, ?string $originatingBranchId = null): array
    {
        $personId = trim($personId);
        $programInterest = trim($programInterest);
        $placementProfileId = $placementProfileId === null ? null : trim($placementProfileId);
        $originatingBranchId = $originatingBranchId === null ? null : trim($originatingBranchId);
        $payload = hash('sha256', implode('|', ['admissions.register', $personId, $programInterest, $placementProfileId ?? '', $originatingBranchId ?? '', $registrar->actorId]));

        try {
            return $this->idempotency->execute('admissions.register', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($registrar, $personId, $programInterest, $placementProfileId, $originatingBranchId): array {
                    if ($originatingBranchId === null || $originatingBranchId === '') {
                        throw BusinessRejection::forCode('admissions.branch_required', 'new applicant registration requires an operational branch');
                    }
                    /** @var Branch|null $branch */
                    $branch = Branch::query()->whereKey($originatingBranchId)->first();
                    if ($branch === null || $branch->lifecycle_state !== 'active' || $branch->structureScope()->organizationId === '') {
                        throw BusinessRejection::forCode('admissions.branch_inactive', 'an applicant branch must exist, be active, and have organization provenance');
                    }
                    $outcome = $this->access->decide($registrar, self::CAPABILITY, $branch->structureScope());
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('admissions.register_denied', $outcome->reason);
                    }
                    /** @var Person|null $person */
                    $person = Person::query()->whereKey($personId)->lockForUpdate()->first();
                    if ($person === null || $person->verification_state !== Person::VERIFICATION_VERIFIED) {
                        throw BusinessRejection::forCode('admissions.person_unverified', 'an applicant requires a verified person identity');
                    }
                    if ($programInterest === '') {
                        throw BusinessRejection::forCode('admissions.program_missing', 'an applicant requires a program interest');
                    }
                    if (Student::query()->where('person_id', $personId)->exists()) {
                        throw BusinessRejection::forCode('admissions.student_exists', 'a verified person who is already a student cannot open a second admission file');
                    }
                    if (Applicant::query()->whereIn('lifecycle_state', ['prospect', 'applicant', 'admitted'])->where('person_id', $personId)->exists()) {
                        throw BusinessRejection::forCode('admissions.open_file_exists', 'this person already has an open admission file');
                    }
                    if (Applicant::query()->where('lifecycle_state', ApplicantLifecycle::STATE_REJECTED)->where('person_id', $personId)->exists()) {
                        throw BusinessRejection::forCode('admissions.reopen_required', 'a rejected admission file must be explicitly reopened for re-application');
                    }
                    $snapshotId = null;
                    if ($placementProfileId !== null && $placementProfileId !== '') {
                        $snapshotId = $this->requireReleasedEligibilitySnapshotFor($placementProfileId, $personId, $originatingBranchId);
                    }

                    $applicant = Applicant::query()->create([
                        'id' => RandomIdentifier::new(),
                        'person_id' => $personId,
                        'program_interest' => $programInterest,
                        'lifecycle_state' => ApplicantLifecycle::STATE_APPLICANT,
                        'recorded_by' => $registrar->actorId,
                        'placement_profile_id' => ($placementProfileId !== null && $placementProfileId !== '') ? $placementProfileId : null,
                        'academic_eligibility_snapshot_id' => $snapshotId,
                        'originating_branch_id' => $originatingBranchId,
                        'current_home_branch_id' => $originatingBranchId,
                    ]);

                    $event = $this->audit->record($registrar->actorId, 'admissions.register', 'applicant', $applicant->id, null, [
                        'person_id' => $personId, 'program_interest' => $programInterest, 'lifecycle_state' => ApplicantLifecycle::STATE_APPLICANT,
                        'placement_profile_id' => $applicant->placement_profile_id,
                        'academic_eligibility_snapshot_id' => $applicant->academic_eligibility_snapshot_id,
                        'originating_branch_id' => $applicant->originating_branch_id,
                        'current_home_branch_id' => $applicant->current_home_branch_id,
                        'branch_id' => $branch->id,
                        'organization_id' => $branch->structureScope()->organizationId,
                    ]);
                    $this->recordVisitorConversion($registrar, $personId, 'applicant', $applicant->id, $event->id);

                    return ['applicant_id' => $applicant->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $registrar, 'admissions.register', 'applicant', $personId);
        }
    }

    private function requireReleasedEligibilitySnapshotFor(string $placementProfileId, string $personId, string $applicantBranchId): string
    {
        /** @var PlacementProfile|null $profile */
        $profile = PlacementProfile::query()->find($placementProfileId);
        if ($profile === null || trim((string) $profile->person_id) !== $personId) {
            throw BusinessRejection::forCode('admissions.placement_person_mismatch', 'the referenced placement profile belongs to another person');
        }
        if ($profile->lifecycle_state !== PlacementProfile::STATE_RELEASED) {
            throw BusinessRejection::forCode('admissions.placement_not_released', 'admission registration may reference only a released placement profile');
        }
        if ($profile->lineage_version !== PlacementProfile::LINEAGE_VERSION) {
            throw BusinessRejection::forCode('admissions.placement_lineage_remediation_required', 'admission registration cannot consume pre-lineage placement evidence without governed remediation');
        }
        $profileBranchId = trim((string) ($profile->current_home_branch_id ?? $profile->originating_branch_id ?? ''));
        if ($profileBranchId === '' || $profileBranchId !== trim($applicantBranchId)) {
            // A cross-branch placement handoff needs an explicit authority and
            // evidence model. Linking it implicitly would disclose and reuse
            // branch-owned assessment evidence without either.
            throw BusinessRejection::forCode('admissions.placement_branch_mismatch', 'an applicant placement reference must match the applicant operational branch');
        }

        $snapshot = $this->eligibilitySnapshots->for($profile);
        if ($snapshot === null) {
            throw BusinessRejection::forCode('admissions.eligibility_snapshot_missing', 'admission registration requires a signed eligibility snapshot from the released placement profile');
        }
        if (! $snapshot['verification']['valid']) {
            throw BusinessRejection::forCode('admissions.eligibility_snapshot_unverified', 'the placement eligibility snapshot could not be verified: '.$snapshot['verification']['reason']);
        }
        if ((string) ($snapshot['snapshot']['snapshot_schema_version'] ?? '') !== \App\Modules\Academic\Placement\Domain\AcademicEligibilitySnapshotBuilder::SCHEMA_VERSION
            || (string) ($snapshot['snapshot']['placement_recommendation_id'] ?? '') !== trim((string) $profile->placement_recommendation_id)) {
            throw BusinessRejection::forCode('admissions.eligibility_snapshot_lineage_invalid', 'admission registration requires the profile-pointer-bound v2 placement eligibility snapshot');
        }
        if ((string) ($snapshot['snapshot']['person_id'] ?? '') !== $personId
            || (string) ($snapshot['snapshot']['placement_profile_id'] ?? '') !== $profile->id
            || (string) ($snapshot['snapshot']['originating_branch_id'] ?? '') !== $profileBranchId) {
            throw BusinessRejection::forCode('admissions.eligibility_snapshot_mismatch', 'the signed placement snapshot does not match the applicant evidence lineage');
        }

        return (string) $snapshot['snapshot']['id'];
    }

    private function recordVisitorConversion(Actor $actor, string $personId, string $conversionType, string $downstreamId, string $authorityAuditEventId): void
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
            authority: 'admissions',
            authorityAuditEventId: $authorityAuditEventId,
        );
    }
}
