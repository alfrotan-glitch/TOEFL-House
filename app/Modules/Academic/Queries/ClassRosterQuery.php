<?php

declare(strict_types=1);

namespace App\Modules\Academic\Queries;

use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\TeacherAssignment;
use Illuminate\Support\Collection;

/**
 * Read-only roster of a class: every live seat claim (requested, active,
 * frozen) with the students behind it, and the open teacher assignments. No
 * query result is an authority to mutate.
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
        $seats = Enrollment::query()->where('class_id', $classId)->whereIn('lifecycle_state', ['requested', 'active', 'frozen'])->orderBy('created_at')->get();
        $seatRows = $seats->map(static fn (Enrollment $enrollment): array => [
            'enrollment_id' => trim((string) $enrollment->id),
            'student_id' => trim((string) $enrollment->student_id),
            'lifecycle_state' => $enrollment->lifecycle_state,
            'state_reason' => $enrollment->state_reason !== null ? trim((string) $enrollment->state_reason) : null,
        ])->all();

        /** @var Collection<int, TeacherAssignment> $teachers */
        $today = now()->toDateString();
        $teachers = TeacherAssignment::query()->where('class_id', $classId)->where('branch_id', $class->branch_id)->whereNotNull('teacher_profile_id')->whereHas('teacherProfile', static fn ($profile) => $profile->whereColumn('teacher_profiles.person_id', 'teacher_assignments.teacher_person_id')->where('teacher_profiles.lifecycle_state', 'active'))->where(fn ($state) => $state->whereNull('lifecycle_state')->orWhere('lifecycle_state', '!=', 'cancelled'))->where('effective_from', '<=', $today)->where(function ($query) use ($today): void {
            $query->whereNull('effective_to')->orWhere('effective_to', '>', $today);
        })->orderBy('effective_from')->get();
        $teacherRows = $teachers->map(static fn (TeacherAssignment $assignment): array => [
            'assignment_id' => trim((string) $assignment->id),
            'teacher_person_id' => trim((string) $assignment->teacher_person_id),
            'teacher_profile_id' => $assignment->teacher_profile_id !== null ? trim((string) $assignment->teacher_profile_id) : null,
            'lifecycle_state' => $assignment->lifecycle_state,
            'branch_id' => $assignment->branch_id !== null ? trim((string) $assignment->branch_id) : null,
            'effective_from' => $assignment->effective_from,
        ])->all();

        return [
            'class_id' => trim($classId),
            'lifecycle_state' => $class->lifecycle_state,
            'capacity' => (int) $class->capacity,
            'active_seats' => Enrollment::query()->where('class_id', $classId)->where('lifecycle_state', 'active')->count(),
            'requested_seats' => Enrollment::query()->where('class_id', $classId)->where('lifecycle_state', 'requested')->count(),
            'frozen_seats' => Enrollment::query()->where('class_id', $classId)->where('lifecycle_state', 'frozen')->count(),
            'claimed_seats' => Enrollment::query()->where('class_id', $classId)->whereIn('lifecycle_state', ['requested', 'active', 'frozen'])->count(),
            'seats' => $seatRows,
            'teachers' => $teacherRows,
        ];
    }
}
