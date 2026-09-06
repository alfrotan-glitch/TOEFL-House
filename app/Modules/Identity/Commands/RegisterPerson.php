<?php

declare(strict_types=1);

namespace App\Modules\Identity\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Errors\DomainError;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Person intake: opens the unverified person record every other boundary
 * starts from. Until a person row exists there is nothing for Identity to
 * verify, for HR to employ, or for Admissions to register as an applicant —
 * the E2E business journey cannot leave the gate on a fresh system. The
 * intake records the natural identity facts (legal name and date of birth)
 * plus a selected home-branch designation; it never asserts a verified
 * identity key. The person is created UNVERIFIED and must pass the governed VerifyPerson workflow
 * before Admissions/HR accept it, preserving the Identity boundary rule that
 * a verification is a separate, evidenced, authority-gated decision.
 */
final class RegisterPerson
{
    public const CAPABILITY = 'identity.admin';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{person_id: string, correlation_id: string} */
    public function register(Actor $administrator, string $legalName, string $dateOfBirth, string $homeBranchId, string $idempotencyKey): array
    {
        $legalName = trim($legalName);
        $dateOfBirth = trim($dateOfBirth);
        $homeBranchId = trim($homeBranchId);
        $payload = hash('sha256', implode('|', ['identity.person.register', $legalName, $dateOfBirth, $homeBranchId, $administrator->actorId]));

        try {
            return $this->idempotency->execute('identity.person.register', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($administrator, $legalName, $dateOfBirth, $homeBranchId): array {
                    $scope = $this->branchScope($homeBranchId);
                    $outcome = $this->access->decide($administrator, self::CAPABILITY, $scope);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('identity.person_register_denied', $outcome->reason);
                    }
                    if ($legalName === '') {
                        throw BusinessRejection::forCode('identity.person_name_required', 'a person record requires a legal name');
                    }
                    if (! preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateOfBirth) || strtotime($dateOfBirth) === false) {
                        throw BusinessRejection::forCode('identity.person_birthdate_invalid', 'a person record requires a valid YYYY-MM-DD date of birth');
                    }
                    $born = CarbonImmutable::parse($dateOfBirth)->startOfDay();
                    if ($born->isAfter(CarbonImmutable::now()->startOfDay())) {
                        throw BusinessRejection::forCode('identity.person_birthdate_future', 'date of birth cannot be in the future');
                    }

                    $correlationId = DomainError::newCorrelationId();
                    $personId = RandomIdentifier::new();
                    $person = Person::query()->create([
                        'id' => $personId,
                        'legal_name' => $legalName,
                        'date_of_birth' => $born->toDateString(),
                        'verification_state' => Person::VERIFICATION_UNVERIFIED,
                        'identity_key' => null,
                        'identity_evidence_ref' => null,
                        'verified_at' => null,
                        'verified_by' => null,
                        'home_branch_id' => $homeBranchId,
                    ]);

                    $this->audit->record(
                        $administrator->actorId,
                        'identity.person.register',
                        'person',
                        $person->id,
                        null,
                        ['legal_name' => $legalName, 'date_of_birth' => $born->toDateString(), 'verification_state' => Person::VERIFICATION_UNVERIFIED, 'branch_id' => $scope->branchId, 'organization_id' => $scope->organizationId],
                        $correlationId,
                    );

                    return ['person_id' => $person->id, 'correlation_id' => $correlationId];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            // No person row exists on an authorization denial, so there is no
            // target id to attribute the attempt to; the correlation id is
            // itself the bounded audit target and remains uniquely traceable.
            $this->attemptedOperation->deniedByActor($denial, $administrator, 'identity.person.register', 'person_intake', $denial->correlationId());
        }
    }

    private function branchScope(string $branchId): StructureScope
    {
        $branch = Branch::query()->whereKey($branchId)->first();
        if ($branch === null || $branch->lifecycle_state !== 'active') {
            throw BusinessRejection::forCode('identity.person_branch_required', 'person intake requires an active home branch');
        }
        $scope = $branch->structureScope();
        if ($scope->organizationId === '' || $scope->branchId === null) {
            throw BusinessRejection::forCode('identity.person_branch_required', 'person intake requires active organization provenance');
        }

        return $scope;
    }
}
