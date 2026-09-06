<?php

declare(strict_types=1);

namespace App\Modules\Enrollment\Domain;

use App\Modules\Academic\Domain\ClassLifecycle;
use App\Modules\Academic\Domain\RecordBranch;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Academic\Queries\AcademicHistoryQuery;
use App\Modules\Students\Domain\StudentOperationalEligibility;
use App\Support\Errors\BusinessRejection;

/**
 * Enrollment-owned planning and seat constraints. Academic keeps the
 * Enrollment lifecycle writer, while this boundary owns reusable checks for
 * active students/classes, prerequisites, offerings, provenance, and seats.
 */
final class EnrollmentConstraints
{
    public function __construct(
        private readonly AcademicHistoryQuery $history,
        private readonly StudentOperationalEligibility $studentEligibility,
    ) {}

    public function assertStudentActive(string $studentId): void
    {
        $this->studentEligibility->assertActive($studentId, 'academic.student_not_active');
    }

    public function assertClassActive(string $classId): void
    {
        /** @var ClassModel|null $class */
        $class = ClassModel::query()->find($classId);
        if ($class === null || $class->lifecycle_state !== ClassLifecycle::STATE_ACTIVE) {
            throw BusinessRejection::forCode('academic.class_not_active', 'the class is not active');
        }
        if (trim((string) ($class->branch_id ?? '')) === '') {
            throw BusinessRejection::forCode('academic.class_branch_missing', 'an enrollment class requires branch provenance');
        }
    }

    public function assertPrerequisitesForClass(string $studentId, string $classId): void
    {
        /** @var ClassModel $class */
        $class = ClassModel::query()->whereKey($classId)->firstOrFail();
        if ($class->program_version_level_id === null || $class->program_version_level_id === '') {
            return;
        }
        /** @var ProgramVersionLevel $target */
        $target = ProgramVersionLevel::query()->whereKey($class->program_version_level_id)->firstOrFail();
        $violations = $this->history->prerequisiteViolations($studentId, $target);
        if ($violations !== []) {
            $keys = implode(', ', array_column($violations, 'level_key'));
            throw BusinessRejection::forCode('academic.enrollment_prerequisite_unsatisfied', 'level prerequisites are unsatisfied: '.$keys);
        }
    }

    public function assertOfferingOpenAndMatchesClass(string $offeringId, string $classId): void
    {
        /** @var Offering|null $offering */
        $offering = Offering::query()->find($offeringId);
        if ($offering === null || $offering->lifecycle_state !== Offering::STATE_OPEN) {
            throw BusinessRejection::forCode('academic.offering_not_open', 'a new enrollment may target only an open offering');
        }
        /** @var ClassModel $class */
        $class = ClassModel::query()->whereKey($classId)->firstOrFail();
        if ($offering->academic_period_id !== $class->period_id
            || $offering->program_version_level_id !== $class->program_version_level_id
            || trim((string) $offering->branch_id) !== trim((string) $class->branch_id)) {
            throw BusinessRejection::forCode('academic.enrollment_offering_mismatch', 'the enrollment offering must match the class branch, period, and level');
        }
    }

    public function offeringBranch(?string $offeringId): ?string
    {
        $offeringId = trim((string) ($offeringId ?? ''));
        if ($offeringId === '') {
            return null;
        }
        /** @var Offering|null $offering */
        $offering = Offering::query()->find($offeringId);

        return $offering === null || trim((string) $offering->branch_id) === '' ? null : trim((string) $offering->branch_id);
    }

    public function seatBranch(?string $offeringId, string $studentId): ?string
    {
        return $this->offeringBranch($offeringId) ?? RecordBranch::studentBranchForId($studentId);
    }

    public function assertOfferingCapacity(string $offeringId): void
    {
        /** @var Offering $offering */
        $offering = Offering::query()->whereKey($offeringId)->lockForUpdate()->firstOrFail();
        if ($offering->lifecycle_state !== Offering::STATE_OPEN) {
            throw BusinessRejection::forCode('academic.offering_not_open', 'a live enrollment seat requires an open offering');
        }
        $claimedSeats = Enrollment::query()->where('offering_id', $offeringId)->whereIn('lifecycle_state', ['requested', 'active', 'frozen'])->count();
        if ($claimedSeats >= $offering->capacity) {
            throw BusinessRejection::forCode('academic.offering_full', sprintf('offering capacity of %d is exhausted by live seat claims', $offering->capacity));
        }
    }

    public function assertCapacity(string $classId): void
    {
        /** @var ClassModel $class */
        $class = ClassModel::query()->whereKey($classId)->lockForUpdate()->firstOrFail();
        $claimedSeats = Enrollment::query()->where('class_id', $classId)->whereIn('lifecycle_state', ['requested', 'active', 'frozen'])->count();
        if ($claimedSeats >= $class->capacity) {
            throw BusinessRejection::forCode('academic.class_full', sprintf('class capacity of %d is exhausted by live seat claims', $class->capacity));
        }
    }
}
