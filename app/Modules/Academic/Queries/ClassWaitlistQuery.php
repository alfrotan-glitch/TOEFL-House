<?php

declare(strict_types=1);

namespace App\Modules\Academic\Queries;

use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassWaitlistEntry;
use App\Modules\Academic\Models\Enrollment;
use Illuminate\Support\Collection;

/**
 * Read-only class waitlist: open entries in position order, capacity state,
 * and whether the class currently has room to promote.
 */
final class ClassWaitlistQuery
{
    /** @return array{class_id: string, capacity: int, active_seats: int, waitlist: list<array<string, mixed>>} */
    public function forClass(string $classId): array
    {
        /** @var ClassModel $class */
        $class = ClassModel::query()->findOrFail($classId);
        $activeSeats = Enrollment::query()->where('class_id', $classId)->where('lifecycle_state', 'active')->count();

        /** @var Collection<int, ClassWaitlistEntry> $entries */
        $entries = ClassWaitlistEntry::query()
            ->where('class_id', $classId)
            ->whereIn('lifecycle_state', ['waiting', 'offered'])
            ->orderBy('position')
            ->get();

        return [
            'class_id' => trim($classId),
            'capacity' => (int) $class->capacity,
            'active_seats' => $activeSeats,
            'waitlist' => $entries->map(static fn (ClassWaitlistEntry $entry): array => [
                'entry_id' => trim((string) $entry->id),
                'student_id' => trim((string) $entry->student_id),
                'offering_id' => trim((string) ($entry->offering_id ?? '')),
                'position' => (int) $entry->position,
                'lifecycle_state' => $entry->lifecycle_state,
            ])->all(),
        ];
    }
}
