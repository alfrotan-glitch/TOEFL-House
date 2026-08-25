<?php

declare(strict_types=1);

namespace App\Modules\Students\Queries;

use App\Modules\Students\Models\GuardianRelationship;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Models\StudentStatus;
use Carbon\CarbonImmutable;

/**
 * Read-only student record: the effective status as of a day (history
 * never overwritten) and the currently effective, verified guardian
 * relationships with their relationship-specific permissions.
 */
final class StudentRecordQuery
{
    /**
     * @return array{student_id: string, student_code: string, person_id: string, status: string|null, guardians: list<array<string, mixed>>}
     */
    public function studentRecord(string $studentId, ?CarbonImmutable $asOf = null): array
    {
        /** @var Student $student */
        $student = Student::query()->findOrFail($studentId);
        $day = ($asOf ?? CarbonImmutable::now())->startOfDay()->toDateString();

        /** @var StudentStatus|null $status */
        $status = StudentStatus::query()
            ->where('student_id', $studentId)
            ->where('effective_from', '<=', $day)
            ->orderByDesc('seq')
            ->first();

        $guardians = GuardianRelationship::query()
            ->where('student_id', $studentId)
            ->where('lifecycle_state', 'active')
            ->where('verification_state', 'verified')
            ->where('effective_from', '<=', $day)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $day))
            ->get(['id', 'guardian_person_id', 'relationship', 'permissions'])
            ->map(static fn (GuardianRelationship $relationship): array => [
                'relationship_id' => trim((string) $relationship->id),
                'guardian_person_id' => trim((string) $relationship->guardian_person_id),
                'relationship' => $relationship->relationship,
                'permissions' => $relationship->permissions ?? [],
            ])
            ->all();

        return [
            'student_id' => trim($studentId),
            'student_code' => $student->student_code,
            'person_id' => trim((string) $student->person_id),
            'status' => $status?->status,
            'guardians' => $guardians,
        ];
    }
}
