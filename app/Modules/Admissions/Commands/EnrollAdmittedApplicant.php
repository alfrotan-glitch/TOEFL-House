<?php

declare(strict_types=1);

namespace App\Modules\Admissions\Commands;

use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Queries\AcademicEligibilitySnapshotQuery;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Domain\VisitorConversionRecorder;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Identity\Models\Person;
use App\Modules\Students\Domain\StudentAdmissionRegistrar;
use App\Modules\Students\Domain\StudentStatusRegistry;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use Illuminate\Support\Facades\DB;

/**
 * Applicant/student conversion: creates the student, its initial active
 * status row, and the audit evidence inside one transaction — the
 * conversion either fully happens or fully rolls back. Only an approved
 * admit decision can convert, and only once.
 */
final class EnrollAdmittedApplicant
{
    public const CAPABILITY = 'admissions.approve';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly VisitorConversionRecorder $visitorConversionRecorder,
        private readonly StudentAdmissionRegistrar $studentRegistrar,
        private readonly AcademicEligibilitySnapshotQuery $eligibilitySnapshots,
    ) {}

    /** @return array{student_id: string, student_code: string, correlation_id: string} */
    public function convert(Actor $converter, Applicant $applicant, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['admissions.convert', $applicant->id, $converter->actorId]));

        try {
            return $this->idempotency->execute('admissions.convert', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($converter, $applicant): array {
                    /** @var Applicant $locked */
                    $locked = Applicant::query()->whereKey($applicant->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'admitted') {
                        throw BusinessRejection::forCode('admissions.convert_requires_admission', sprintf('only an admitted applicant can convert, state is %s', $locked->lifecycle_state));
                    }
                    /** @var AdmissionDecision $decision */
                    $decision = AdmissionDecision::query()
                        ->where('applicant_id', $locked->id)
                        ->where('outcome', 'admit')
                        ->where('lifecycle_state', 'final')
                        ->orderByDesc('created_at')
                        ->orderByDesc('id')
                        ->lockForUpdate()
                        ->firstOrFail();
                    if (Student::query()->where('admission_decision_id', $decision->id)->exists()) {
                        throw BusinessRejection::forCode('admissions.already_converted', 'this admission decision has already produced a student');
                    }
                    if (Student::query()->where('person_id', $locked->person_id)->exists()) {
                        throw BusinessRejection::forCode('admissions.student_exists', 'this person is already a student');
                    }
                    if (Person::query()->whereKey($locked->person_id)->value('verification_state') !== Person::VERIFICATION_VERIFIED) {
                        throw BusinessRejection::forCode('admissions.person_no_longer_verified', 'conversion requires the person identity to remain verified');
                    }
                    $this->assertPlacementEvidence($locked);

                    $studentCode = 'STU-'.strtoupper(substr(bin2hex(random_bytes(5)), 0, 9));
                    // Student is a branch-homed anchor. Provenance must
                    // come from the applicant or its verified placement
                    // profile; conversion never guesses from the actor.
                    $originatingBranchId = trim((string) ($locked->current_home_branch_id ?? $locked->originating_branch_id ?? ''));
                    if ($originatingBranchId === '' && $locked->placement_profile_id !== null && trim((string) $locked->placement_profile_id) !== '') {
                        /** @var PlacementProfile|null $profile */
                        $profile = PlacementProfile::query()->find($locked->placement_profile_id);
                        $originatingBranchId = $profile === null ? '' : trim((string) ($profile->current_home_branch_id ?? $profile->originating_branch_id ?? ''));
                    }
                    if ($originatingBranchId === '') {
                        throw BusinessRejection::forCode('admissions.student_provenance_required', 'student conversion requires branch provenance from the applicant or placement profile');
                    }
                    $branch = \App\Modules\Organization\Models\Branch::query()->whereKey($originatingBranchId)->first();
                    if ($branch === null || $branch->lifecycle_state !== 'active' || $branch->structureScope()->organizationId === '') {
                        throw BusinessRejection::forCode('admissions.branch_inactive', 'student conversion requires an active provenance branch with organization topology');
                    }
                    $outcome = $this->access->decide($converter, self::CAPABILITY, $branch->structureScope());
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('admissions.convert_denied', $outcome->reason);
                    }
                    // Admissions authorizes and orchestrates conversion;
                    // Student Lifecycle owns creation of the Student aggregate
                    // and its initial status history.
                    $registered = $this->studentRegistrar->register(
                        $decision->id,
                        $locked->person_id,
                        $studentCode,
                        $originatingBranchId,
                        $locked->placement_profile_id,
                        $locked->academic_eligibility_snapshot_id,
                        $converter->actorId,
                    );
                    $student = $registered['student'];

                    $event = $this->audit->record($converter->actorId, 'admissions.convert', 'student', $student->id, null, [
                        'applicant_id' => $locked->id,
                        'admission_decision_id' => $decision->id,
                        'student_code' => $studentCode,
                        'initial_status' => StudentStatusRegistry::STATUS_ACTIVE,
                        'placement_profile_id' => $locked->placement_profile_id,
                        'academic_eligibility_snapshot_id' => $student->academic_eligibility_snapshot_id,
                        'branch_id' => $branch->id,
                        'organization_id' => $branch->structureScope()->organizationId,
                    ]);
                    $this->recordVisitorConversion($converter, $locked->id, $locked->person_id, $student->id, $event->id);

                    return ['student_id' => $student->id, 'student_code' => $studentCode, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $converter, 'admissions.convert', 'applicant', $applicant->id);
        }
    }

    private function recordVisitorConversion(Actor $actor, string $applicantId, string $personId, string $studentId, string $authorityAuditEventId): void
    {
        /** @var Visitor|null $visitor */
        $visitor = Visitor::query()
            ->where('person_id', $personId)
            ->whereHas('conversion', fn ($query) => $query->where('applicant_id', $applicantId))
            ->lockForUpdate()
            ->first();
        if ($visitor === null) {
            $visitor = Visitor::query()
                ->where('person_id', $personId)
                ->whereIn('status', Visitor::openStatuses())
                ->lockForUpdate()
                ->first();
        }
        if ($visitor === null) {
            return;
        }

        $this->visitorConversionRecorder->record(
            $actor,
            $visitor,
            'student',
            'student',
            $studentId,
            'admissions.convert.conversion.'.$visitor->id,
            authority: 'students',
            authorityAuditEventId: $authorityAuditEventId,
        );
    }

    private function assertPlacementEvidence(Applicant $applicant): void
    {
        if ($applicant->placement_profile_id === null) {
            if ($applicant->academic_eligibility_snapshot_id !== null) {
                throw BusinessRejection::forCode('admissions.eligibility_profile_missing', 'an eligibility snapshot cannot be attached without its placement profile');
            }

            return;
        }

        /** @var PlacementProfile|null $profile */
        $profile = PlacementProfile::query()->whereKey($applicant->placement_profile_id)->first();
        if ($profile === null || trim((string) $profile->person_id) !== trim((string) $applicant->person_id)) {
            throw BusinessRejection::forCode('admissions.placement_person_mismatch', 'the admission placement profile does not belong to the applicant person');
        }
        if ($profile->lifecycle_state !== PlacementProfile::STATE_RELEASED) {
            throw BusinessRejection::forCode('admissions.placement_not_released', 'student conversion requires a released placement profile');
        }
        if ($applicant->academic_eligibility_snapshot_id === null) {
            throw BusinessRejection::forCode('admissions.eligibility_snapshot_missing', 'student conversion requires the signed academic eligibility snapshot consumed at registration');
        }

        $snapshot = $this->eligibilitySnapshots->for($profile);
        if ($snapshot === null || ($snapshot['verification']['valid'] ?? false) !== true) {
            throw BusinessRejection::forCode('admissions.eligibility_snapshot_unverified', 'the placement eligibility snapshot could not be verified at conversion');
        }
        if ((string) ($snapshot['snapshot']['id'] ?? '') !== trim((string) $applicant->academic_eligibility_snapshot_id)) {
            throw BusinessRejection::forCode('admissions.eligibility_snapshot_mismatch', 'the applicant does not reference the current verified placement eligibility snapshot');
        }
    }
}
