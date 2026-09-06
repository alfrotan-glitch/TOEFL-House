<?php

declare(strict_types=1);

namespace App\Modules\Academic\Queries;

use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassWaitlistEntry;
use App\Modules\Academic\Models\Enrollment;
use Illuminate\Support\Collection;

/**
 * Read-only class waitlist: open entries in position order and the shared
 * live-seat capacity state. Waitlist rows never claim a seat.
 */
final class ClassWaitlistQuery
{
    /** @return array{class_id: string, capacity: int, claimed_seats: int, waitlist: list<array<string, mixed>>} */
    public function forClass(string $classId): array
    {
        /** @var ClassModel $class */
        $class = ClassModel::query()->findOrFail($classId);
        $claimedSeats = Enrollment::query()->where('class_id', $classId)->whereIn('lifecycle_state', ['requested', 'active', 'frozen'])->count();

        /** @var Collection<int, ClassWaitlistEntry> $entries */
        $entries = ClassWaitlistEntry::query()
            ->where('class_id', $classId)
            ->whereIn('lifecycle_state', ['waiting', 'offered'])
            ->orderBy('position')
            ->get();

        return [
            'class_id' => trim($classId),
            'capacity' => (int) $class->capacity,
            'claimed_seats' => $claimedSeats,
            'waitlist' => array_values($entries->map(static fn (ClassWaitlistEntry $entry): array => [
                'entry_id' => trim((string) $entry->id),
                'student_id' => trim((string) $entry->student_id),
                'offering_id' => trim((string) ($entry->offering_id ?? '')),
                'position' => (int) $entry->position,
                'lifecycle_state' => $entry->lifecycle_state,
            ])->all()),
        ];
    }
}
