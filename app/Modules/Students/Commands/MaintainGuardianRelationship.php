<?php

declare(strict_types=1);

namespace App\Modules\Students\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Domain\GuardianPermissionRegistry;
use App\Modules\Students\Models\GuardianRelationship;
use App\Modules\Students\Models\Student;
use App\Modules\Academic\Domain\RecordBranch;
use App\Support\Authorization\BranchScopedAccess;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Guardian relationship control: recorded unverified, verified as its own
 * explicit step, revoked without erasing history. Only a verified,
 * effective relationship carries its relationship-specific permissions.
 */
final class MaintainGuardianRelationship
{
    public const CAPABILITY = 'students.guardian';

    public function __construct(
        private readonly BranchScopedAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /**
     * @param  list<string>  $permissions
     * @return array{relationship_id: string, correlation_id: string}
     */
    public function record(Actor $recorder, Student $student, string $guardianPersonId, string $relationship, array $permissions, string $idempotencyKey): array
    {
        $guardianPersonId = trim($guardianPersonId);
        $relationship = trim($relationship);
        $permissions = GuardianPermissionRegistry::normalize($permissions);
        $payload = hash('sha256', implode('|', ['students.guardian.record', $student->id, $guardianPersonId, $relationship, implode(',', $permissions), $recorder->actorId]));

        try {
            return $this->idempotency->execute('students.guardian.record', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($recorder, $student, $guardianPersonId, $relationship, $permissions): array {
                    if ($relationship === '') {
                        throw BusinessRejection::forCode('students.guardian_relationship_missing', 'a guardian relationship requires a named relationship');
                    }

                    /** @var Student $lockedStudent */
                    $lockedStudent = Student::query()->whereKey($student->id)->lockForUpdate()->firstOrFail();
                    $this->access->require($recorder, self::CAPABILITY, RecordBranch::studentBranch($lockedStudent), 'students.guardian_denied');
                    /** @var Person|null $guardian */
                    $guardian = Person::query()->whereKey($guardianPersonId)->lockForUpdate()->first();
                    if ($guardian === null || $guardian->verification_state !== Person::VERIFICATION_VERIFIED) {
                        throw BusinessRejection::forCode('students.guardian_unverified', 'a guardian relationship requires a verified person identity');
                    }
                    if ($guardianPersonId === trim((string) $lockedStudent->person_id)) {
                        throw BusinessRejection::forCode('students.guardian_self', 'a student cannot be their own guardian');
                    }
                    if (GuardianRelationship::query()->where('student_id', $lockedStudent->id)->where('guardian_person_id', $guardianPersonId)->where('relationship', $relationship)->where('lifecycle_state', 'active')->whereNull('effective_to')->exists()) {
                        throw BusinessRejection::forCode('students.guardian_duplicate', 'this guardian relationship already has an open row');
                    }

                    $row = GuardianRelationship::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $lockedStudent->id,
                        'guardian_person_id' => $guardianPersonId,
                        'relationship' => $relationship,
                        'permissions' => array_values($permissions),
                        'verification_state' => 'unverified',
                        'lifecycle_state' => 'active',
                        'effective_from' => (new CarbonImmutable)->startOfDay()->toDateString(),
                        'effective_to' => null,
                        'recorded_by' => $recorder->actorId,
                    ]);

                    $provenance = $this->relationshipProvenance($row);
                    $event = $this->audit->record($recorder->actorId, 'students.guardian.record', 'guardian_relationship', $row->id, null, [
                        'student_id' => $lockedStudent->id, 'branch_id' => $provenance['branch_id'], 'organization_id' => $provenance['organization_id'], 'guardian_person_id' => $guardianPersonId,
                        'relationship' => $relationship, 'permissions' => array_values($permissions),
                        'verification_state' => 'unverified',
                    ]);

                    return ['relationship_id' => $row->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $recorder, 'students.guardian.record', 'guardian_relationship', $student->id);
        }
    }

    /** @return array{relationship_id: string, verification_state: string, correlation_id: string} */
    public function verify(Actor $verifier, GuardianRelationship $relationship, string $idempotencyKey, string $verificationEvidenceRef): array
    {
        $verificationEvidenceRef = trim($verificationEvidenceRef);
        if ($verificationEvidenceRef === '' || strlen($verificationEvidenceRef) > 255) {
            throw BusinessRejection::forCode('students.guardian_verification_evidence_missing', 'guardian verification requires an evidence reference of at most 255 characters');
        }
        $payload = hash('sha256', implode('|', ['students.guardian.verify', $relationship->id, $verifier->actorId, $verificationEvidenceRef]));

        try {
            return $this->idempotency->execute('students.guardian.verify', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($verifier, $relationship, $verificationEvidenceRef): array {
                    [$locked, $student] = $this->lockRelationshipAndStudent($relationship->id);
                    $this->requireRelationshipScope($verifier, $locked, $student);
                    if ($locked->lifecycle_state !== 'active') {
                        throw BusinessRejection::forCode('students.guardian_not_active', 'only an active relationship can be verified');
                    }
                    if ($locked->verification_state === 'verified') {
                        throw BusinessRejection::forCode('students.guardian_already_verified', 'this relationship is already verified');
                    }
                    $verifiedAt = CarbonImmutable::now();
                    $locked->forceFill([
                        'verification_state' => 'verified',
                        'verification_evidence_ref' => $verificationEvidenceRef,
                        'verified_by' => $verifier->actorId,
                        'verified_at' => $verifiedAt,
                    ]);
                    $locked->save();
                    $provenance = $this->relationshipProvenance($locked);

                    $event = $this->audit->record($verifier->actorId, 'students.guardian.verify', 'guardian_relationship', $locked->id, ['verification_state' => 'unverified'], [
                        'verification_state' => 'verified',
                        'verification_evidence_ref' => $verificationEvidenceRef,
                        'verified_by' => $verifier->actorId,
                        'verified_at' => $verifiedAt->toIso8601String(),
                        'branch_id' => $provenance['branch_id'],  'organization_id' => $provenance['organization_id'],
                    ]);

                    return ['relationship_id' => $locked->id, 'verification_state' => 'verified', 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $verifier, 'students.guardian.verify', 'guardian_relationship', $relationship->id);
        }
    }

    /** @return array{relationship_id: string, lifecycle_state: string, correlation_id: string} */
    public function revoke(Actor $actor, GuardianRelationship $relationship, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['students.guardian.revoke', $relationship->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('students.guardian.revoke', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $relationship): array {
                    [$locked, $student] = $this->lockRelationshipAndStudent($relationship->id);
                    $this->requireRelationshipScope($actor, $locked, $student);
                    if ($locked->lifecycle_state !== 'active') {
                        throw BusinessRejection::forCode('students.guardian_not_active', 'only an active relationship can be revoked');
                    }
                    $locked->forceFill(['lifecycle_state' => 'revoked']);
                    $locked->save();
                    $provenance = $this->relationshipProvenance($locked);

                    $event = $this->audit->record($actor->actorId, 'students.guardian.revoke', 'guardian_relationship', $locked->id, ['lifecycle_state' => 'active'], [
                        'lifecycle_state' => 'revoked',
                        'branch_id' => $provenance['branch_id'], 'organization_id' => $provenance['organization_id'],
                    ]);

                    return ['relationship_id' => $locked->id, 'lifecycle_state' => 'revoked', 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'students.guardian.revoke', 'guardian_relationship', $relationship->id);
        }
    }

    /** @return array{branch_id: string, organization_id: string} */
    private function relationshipProvenance(GuardianRelationship $relationship): array
    {
        $branchId = RecordBranch::studentBranchForId((string) $relationship->student_id);
        $branch = $branchId === null ? null : Branch::query()->whereKey($branchId)->first();
        if ($branch === null || $branch->lifecycle_state !== 'active') {
            throw BusinessRejection::forCode('students.guardian_provenance_required', 'a guardian relationship event requires active student branch provenance');
        }
        $scope = $branch->structureScope();
        if ($scope->organizationId === '') {
            throw BusinessRejection::forCode('students.guardian_provenance_required', 'a guardian relationship event requires active campus organization provenance');
        }

        return ['branch_id' => (string) $branch->id, 'organization_id' => $scope->organizationId];
    }

    /** @return array{0: GuardianRelationship, 1: Student} */
    private function lockRelationshipAndStudent(string $relationshipId): array
    {
        $studentId = GuardianRelationship::query()->whereKey($relationshipId)->value('student_id');
        if ($studentId === null) {
            throw BusinessRejection::forCode('students.guardian_unknown', 'the guardian relationship does not exist');
        }

        /** @var Student $student */
        $student = Student::query()->whereKey($studentId)->lockForUpdate()->firstOrFail();
        /** @var GuardianRelationship $relationship */
        $relationship = GuardianRelationship::query()->whereKey($relationshipId)->lockForUpdate()->firstOrFail();

        return [$relationship, $student];
    }

    private function requireRelationshipScope(Actor $actor, GuardianRelationship $relationship, Student $student): void
    {
        $this->access->require($actor, self::CAPABILITY, RecordBranch::studentBranch($student), 'students.guardian_denied');
    }
}
