<?php

declare(strict_types=1);

namespace App\Modules\Students\Domain;

use App\Modules\Students\Models\Student;
use App\Modules\Students\Models\StudentStatus;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;

/**
 * Student-owned admission conversion port. Admissions may authorize and
 * orchestrate the conversion, but Student Lifecycle remains the only module
 * that writes the student aggregate and its initial status history.
 */
final class StudentAdmissionRegistrar
{
    /**
     * @return array{student: Student, student_code: string}
     */
    public function register(
        string $admissionDecisionId,
        string $personId,
        string $studentCode,
        string $originatingBranchId,
        ?string $placementProfileId,
        ?string $eligibilitySnapshotId,
        string $actorId,
    ): array {
        $admissionDecisionId = trim($admissionDecisionId);
        $personId = trim($personId);
        $studentCode = trim($studentCode);
        $originatingBranchId = trim($originatingBranchId);
        $placementProfileId = $placementProfileId === null ? null : trim($placementProfileId);
        $eligibilitySnapshotId = $eligibilitySnapshotId === null ? null : trim($eligibilitySnapshotId);
        $actorId = trim($actorId);
        if ($admissionDecisionId === '' || $personId === '' || $studentCode === '' || $originatingBranchId === '' || $actorId === '') {
            throw BusinessRejection::forCode('students.admission_conversion_shape', 'student conversion requires decision, person, code, branch, and actor provenance');
        }
        if (Student::query()->where('admission_decision_id', $admissionDecisionId)->exists()) {
            throw BusinessRejection::forCode('students.admission_decision_consumed', 'the admission decision already has a student aggregate');
        }
        if (Student::query()->where('person_id', $personId)->exists()) {
            throw BusinessRejection::forCode('students.person_already_student', 'the person already has a student aggregate');
        }

        $student = Student::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $personId,
            'admission_decision_id' => $admissionDecisionId,
            'student_code' => $studentCode,
            'originating_branch_id' => $originatingBranchId,
            'current_home_branch_id' => $originatingBranchId,
            'placement_profile_id' => $placementProfileId,
            'academic_eligibility_snapshot_id' => $eligibilitySnapshotId,
        ]);

        StudentStatus::query()->create([
            'id' => RandomIdentifier::new(),
            'student_id' => $student->id,
            'status' => StudentStatusRegistry::STATUS_ACTIVE,
            'effective_from' => (new CarbonImmutable)->startOfDay()->toDateString(),
            'reason' => 'admission conversion',
            'actor_id' => $actorId,
        ]);

        return ['student' => $student, 'student_code' => $studentCode];
    }
}
