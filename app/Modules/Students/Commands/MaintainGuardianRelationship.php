<?php

declare(strict_types=1);

namespace App\Modules\Students\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\Person;
use App\Modules\Students\Models\GuardianRelationship;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
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
        private readonly AccessDecision $access,
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
        $payload = hash('sha256', implode('|', ['students.guardian.record', $student->id, $guardianPersonId, $relationship, implode(',', $permissions), $recorder->actorId]));

        try {
            return $this->idempotency->execute('students.guardian.record', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($recorder, $student, $guardianPersonId, $relationship, $permissions): array {
                    $outcome = $this->access->decide($recorder, self::CAPABILITY, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('students.guardian_denied', $outcome->reason);
                    }
                    if ($relationship === '') {
                        throw BusinessRejection::forCode('students.guardian_relationship_missing', 'a guardian relationship requires a named relationship');
                    }
                    if ($permissions === []) {
                        throw BusinessRejection::forCode('students.guardian_permissions_missing', 'a guardian relationship requires relationship-specific permissions');
                    }
                    if (! Person::query()->whereKey($guardianPersonId)->exists()) {
                        throw BusinessRejection::forCode('students.guardian_unknown', 'a guardian relationship requires a known person');
                    }
                    if ($guardianPersonId === trim((string) $student->person_id)) {
                        throw BusinessRejection::forCode('students.guardian_self', 'a student cannot be their own guardian');
                    }
                    if (GuardianRelationship::query()->where('student_id', $student->id)->where('guardian_person_id', $guardianPersonId)->where('relationship', $relationship)->where('lifecycle_state', 'active')->whereNull('effective_to')->exists()) {
                        throw BusinessRejection::forCode('students.guardian_duplicate', 'this guardian relationship already has an open row');
                    }

                    $row = GuardianRelationship::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $student->id,
                        'guardian_person_id' => $guardianPersonId,
                        'relationship' => $relationship,
                        'permissions' => array_values($permissions),
                        'verification_state' => 'unverified',
                        'lifecycle_state' => 'active',
                        'effective_from' => (new CarbonImmutable)->startOfDay()->toDateString(),
                        'effective_to' => null,
                        'recorded_by' => $recorder->actorId,
                    ]);

                    $event = $this->audit->record($recorder->actorId, 'students.guardian.record', 'guardian_relationship', $row->id, null, [
                        'student_id' => $student->id, 'guardian_person_id' => $guardianPersonId,
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
    public function verify(Actor $verifier, GuardianRelationship $relationship, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['students.guardian.verify', $relationship->id, $verifier->actorId]));

        try {
            return $this->idempotency->execute('students.guardian.verify', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($verifier, $relationship): array {
                    $outcome = $this->access->decide($verifier, self::CAPABILITY, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('students.guardian_denied', $outcome->reason);
                    }

                    /** @var GuardianRelationship $locked */
                    $locked = GuardianRelationship::query()->whereKey($relationship->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'active') {
                        throw BusinessRejection::forCode('students.guardian_not_active', 'only an active relationship can be verified');
                    }
                    if ($locked->verification_state === 'verified') {
                        throw BusinessRejection::forCode('students.guardian_already_verified', 'this relationship is already verified');
                    }
                    $locked->forceFill(['verification_state' => 'verified']);
                    $locked->save();

                    $event = $this->audit->record($verifier->actorId, 'students.guardian.verify', 'guardian_relationship', $locked->id, ['verification_state' => 'unverified'], ['verification_state' => 'verified']);

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
                    $outcome = $this->access->decide($actor, self::CAPABILITY, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('students.guardian_denied', $outcome->reason);
                    }

                    /** @var GuardianRelationship $locked */
                    $locked = GuardianRelationship::query()->whereKey($relationship->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'active') {
                        throw BusinessRejection::forCode('students.guardian_not_active', 'only an active relationship can be revoked');
                    }
                    $locked->forceFill(['lifecycle_state' => 'revoked']);
                    $locked->save();

                    $event = $this->audit->record($actor->actorId, 'students.guardian.revoke', 'guardian_relationship', $locked->id, ['lifecycle_state' => 'active'], ['lifecycle_state' => 'revoked']);

                    return ['relationship_id' => $locked->id, 'lifecycle_state' => 'revoked', 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'students.guardian.revoke', 'guardian_relationship', $relationship->id);
        }
    }
}
