<?php

declare(strict_types=1);

namespace App\Modules\Admissions\Commands;

use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Identity\Models\Person;
use App\Modules\Students\Domain\StudentStatusRegistry;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Models\StudentStatus;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
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
    ) {}

    /** @return array{student_id: string, student_code: string, correlation_id: string} */
    public function convert(Actor $converter, Applicant $applicant, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['admissions.convert', $applicant->id, $converter->actorId]));

        try {
            return $this->idempotency->execute('admissions.convert', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($converter, $applicant): array {
                    $outcome = $this->access->decide($converter, self::CAPABILITY, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('admissions.convert_denied', $outcome->reason);
                    }

                    /** @var Applicant $locked */
                    $locked = Applicant::query()->whereKey($applicant->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== 'admitted') {
                        throw BusinessRejection::forCode('admissions.convert_requires_admission', sprintf('only an admitted applicant can convert, state is %s', $locked->lifecycle_state));
                    }
                    /** @var AdmissionDecision $decision */
                    $decision = AdmissionDecision::query()->where('applicant_id', $locked->id)->where('outcome', 'admit')->orderByDesc('created_at')->firstOrFail();
                    if (Student::query()->where('admission_decision_id', $decision->id)->exists()) {
                        throw BusinessRejection::forCode('admissions.already_converted', 'this admission decision has already produced a student');
                    }
                    if (Student::query()->where('person_id', $locked->person_id)->exists()) {
                        throw BusinessRejection::forCode('admissions.student_exists', 'this person is already a student');
                    }
                    if (Person::query()->whereKey($locked->person_id)->value('verification_state') !== Person::VERIFICATION_VERIFIED) {
                        throw BusinessRejection::forCode('admissions.person_no_longer_verified', 'conversion requires the person identity to remain verified');
                    }

                    $studentCode = 'STU-'.strtoupper(substr(bin2hex(random_bytes(5)), 0, 9));
                    $student = Student::query()->create([
                        'id' => RandomIdentifier::new(),
                        'person_id' => $locked->person_id,
                        'admission_decision_id' => $decision->id,
                        'student_code' => $studentCode,
                        'placement_profile_id' => $locked->placement_profile_id,
                        'academic_eligibility_snapshot_id' => $locked->academic_eligibility_snapshot_id,
                    ]);
                    StudentStatus::query()->create([
                        'id' => RandomIdentifier::new(),
                        'student_id' => $student->id,
                        'status' => StudentStatusRegistry::STATUS_ACTIVE,
                        'effective_from' => (new CarbonImmutable)->startOfDay()->toDateString(),
                        'effective_to' => null,
                        'reason' => 'admission conversion',
                        'actor_id' => $converter->actorId,
                    ]);

                    $event = $this->audit->record($converter->actorId, 'admissions.convert', 'student', $student->id, null, [
                        'applicant_id' => $locked->id,
                        'admission_decision_id' => $decision->id,
                        'student_code' => $studentCode,
                        'initial_status' => StudentStatusRegistry::STATUS_ACTIVE,
                        'placement_profile_id' => $locked->placement_profile_id,
                        'academic_eligibility_snapshot_id' => $student->academic_eligibility_snapshot_id,
                    ]);

                    return ['student_id' => $student->id, 'student_code' => $studentCode, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $converter, 'admissions.convert', 'applicant', $applicant->id);
        }
    }
}
