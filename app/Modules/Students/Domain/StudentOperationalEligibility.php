<?php

declare(strict_types=1);

namespace App\Modules\Students\Domain;

use App\Modules\Students\Models\Student;
use App\Modules\Students\Domain\StudentStatusRegistry;
use App\Modules\Students\Models\StudentStatus;
use App\Support\Errors\BusinessRejection;

/**
 * Read-side operational gate owned by Student status history. Other bounded
 * contexts may ask whether a student is currently operational, but they may
 * not create a competing status or balance authority.
 */
final class StudentOperationalEligibility
{
    public function isActive(string $studentId): bool
    {
        if (! Student::query()->whereKey($studentId)->exists()) {
            return false;
        }

        return StudentStatus::query()
            ->where('student_id', $studentId)
            ->latest('seq')
            ->value('status') === StudentStatusRegistry::STATUS_ACTIVE;
    }

    public function assertActive(string $studentId, string $errorCode = 'students.not_operational'): void
    {
        if (! Student::query()->whereKey($studentId)->exists()) {
            throw BusinessRejection::forCode('students.unknown_student', 'the referenced student does not exist');
        }
        if (! $this->isActive($studentId)) {
            throw BusinessRejection::forCode($errorCode, 'the student is not currently active for this operation');
        }
    }
}
