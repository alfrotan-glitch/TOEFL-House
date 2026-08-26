<?php

declare(strict_types=1);

namespace App\Modules\Academic\Queries;

use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\TeacherAssignment;
use Illuminate\Support\Collection;

/**
 * Read-only roster of an active class: active and frozen seats with the
 * students behind them, and the open teacher assignments. No query result
 * is an authority to mutate.
 */
final class ClassRosterQuery
{
    /**
     * @return array{class_id: string, lifecycle_state: string, capacity: int, active_seats: int, seats: list<array<string, mixed>>, teachers: list<array<string, mixed>>}
     */
    public function roster(string $classId): array
    {
        /** @var ClassModel $class */
        $class = ClassModel::query()->findOrFail($classId);

        /** @var Collection<int, Enrollment> $seats */
        $seats = Enrollment::query()->where('class_id', $classId)->whereIn('lifecycle_state', ['active', 'frozen'])->orderBy('created_at')->get();
        $seatRows = $seats->map(static fn (Enrollment $enrollment): array => [
            'enrollment_id' => trim((string) $enrollment->id),
            'student_id' => trim((string) $enrollment->student_id),
            'lifecycle_state' => $enrollment->lifecycle_state,
        ])->all();

        /** @var Collection<int, TeacherAssignment> $teachers */
        $teachers = TeacherAssignment::query()->where('class_id', $classId)->whereNull('effective_to')->orderBy('effective_from')->get();
        $teacherRows = $teachers->map(static fn (TeacherAssignment $assignment): array => [
            'assignment_id' => trim((string) $assignment->id),
            'teacher_person_id' => trim((string) $assignment->teacher_person_id),
            'effective_from' => $assignment->effective_from,
        ])->all();

        return [
            'class_id' => trim($classId),
            'lifecycle_state' => $class->lifecycle_state,
            'capacity' => (int) $class->capacity,
            'active_seats' => Enrollment::query()->where('class_id', $classId)->where('lifecycle_state', 'active')->count(),
            'seats' => $seatRows,
            'teachers' => $teacherRows,
        ];
    }
}
