<?php

declare(strict_types=1);

namespace App\Modules\Finance\Domain;

use App\Modules\Students\Models\Student;
use App\Support\Errors\BusinessRejection;

/**
 * Serializes Finance facts that compete for one student's uncovered balance.
 * Every command that approves or posts a coverage-affecting fact acquires the
 * same canonical student-row lock before deriving or committing coverage. The
 * caller must acquire it inside its transaction before locking command/source
 * rows so competing coverage paths share a stable first lock.
 */
final class FinancialCoverageLock
{
    public static function acquire(string $studentId): void
    {
        if (Student::query()->whereKey($studentId)->lockForUpdate()->first() === null) {
            throw BusinessRejection::forCode('finance.student_unknown', 'Finance coverage requires a known student');
        }
    }
}
