<?php

declare(strict_types=1);

namespace App\Modules\Admissions\Commands;

use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Admissions\Domain\ApplicantLifecycle;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;

/**
 * Reopens a rejected application for a new decision cycle. The original
 * rejected decision remains immutable history; this command only returns the
 * applicant file to the decidable state and records why the re-application is
 * allowed. It never creates a Student or bypasses the staged decision chain.
 */
final class ReopenApplicant
{
    public const CAPABILITY = 'admissions.register';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{applicant_id: string, lifecycle_state: string, correlation_id: string} */
    public function reopen(Actor $registrar, Applicant $applicant, string $programInterest, string $reason, string $idempotencyKey): array
    {
        $programInterest = trim($programInterest);
        $reason = trim($reason);
        $payload = hash('sha256', implode('|', ['admissions.reopen', $applicant->id, $programInterest, $reason, $registrar->actorId]));

        try {
            return $this->idempotency->execute('admissions.reopen', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($registrar, $applicant, $programInterest, $reason): array {
                    /** @var Applicant $locked */
                    $locked = Applicant::query()->whereKey($applicant->id)->lockForUpdate()->firstOrFail();
                    ApplicantLifecycle::requireTransition($locked->lifecycle_state, ApplicantLifecycle::STATE_APPLICANT);
                    if ($locked->lifecycle_state !== ApplicantLifecycle::STATE_REJECTED) {
                        throw BusinessRejection::forCode('admissions.reopen_requires_rejection', 'only a rejected application can be reopened');
                    }
                    if ($programInterest === '' || $reason === '') {
                        throw BusinessRejection::forCode('admissions.reopen_evidence', 'reopening an application requires a program interest and reason');
                    }
                    $rejection = AdmissionDecision::query()
                        ->where('applicant_id', $locked->id)
                        ->where('outcome', 'reject')
                        ->where('lifecycle_state', 'final')
                        ->orderByDesc('created_at')
                        ->orderByDesc('id')
                        ->lockForUpdate()
                        ->first();
                    if ($rejection === null) {
                        throw BusinessRejection::forCode('admissions.reopen_requires_rejection', 'reopening requires a durable final rejection decision');
                    }
                    if (Student::query()->where('person_id', $locked->person_id)->exists()) {
                        throw BusinessRejection::forCode('admissions.student_exists', 'a person who is already a student cannot reopen an admission file');
                    }
                    if (Person::query()->whereKey($locked->person_id)->value('verification_state') !== Person::VERIFICATION_VERIFIED) {
                        throw BusinessRejection::forCode('admissions.person_unverified', 'reopening an application requires a verified person identity');
                    }

                    $branch = $this->branchForApplicant($locked);
                    $outcome = $this->access->decide($registrar, self::CAPABILITY, $branch->structureScope());
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('admissions.reopen_denied', $outcome->reason);
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state, 'program_interest' => $locked->program_interest];
                    $locked->forceFill([
                        'lifecycle_state' => ApplicantLifecycle::STATE_APPLICANT,
                        'program_interest' => $programInterest,
                    ])->save();
                    $event = $this->audit->record($registrar->actorId, 'admissions.reopen', 'applicant', $locked->id, $before, [
                        'lifecycle_state' => ApplicantLifecycle::STATE_APPLICANT,
                        'program_interest' => $programInterest,
                        'reason' => $reason,
                        'rejection_decision_id' => $rejection->id,
                        'branch_id' => $branch->id,
                        'organization_id' => $branch->structureScope()->organizationId,
                    ]);

                    return ['applicant_id' => $locked->id, 'lifecycle_state' => ApplicantLifecycle::STATE_APPLICANT, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $registrar, 'admissions.reopen', 'applicant', $applicant->id);
        }
    }

    private function branchForApplicant(Applicant $applicant): Branch
    {
        $branchId = trim((string) ($applicant->current_home_branch_id ?? ''));
        if ($branchId === '') {
            $branchId = trim((string) ($applicant->originating_branch_id ?? ''));
        }
        if ($branchId === '' && $applicant->placement_profile_id !== null) {
            /** @var PlacementProfile|null $profile */
            $profile = PlacementProfile::query()->whereKey($applicant->placement_profile_id)->first();
            if ($profile !== null && trim((string) $profile->person_id) === trim((string) $applicant->person_id)) {
                $branchId = trim((string) ($profile->current_home_branch_id ?? $profile->originating_branch_id ?? ''));
            }
        }
        $branch = $branchId === '' ? null : Branch::query()->whereKey($branchId)->first();
        if ($branch === null || $branch->lifecycle_state !== 'active' || $branch->structureScope()->organizationId === '') {
            throw AuthorizationDenied::forCode('admissions.provenance_unknown', 'applicant branch provenance is unknown, inactive, or organizationless');
        }

        return $branch;
    }
}
