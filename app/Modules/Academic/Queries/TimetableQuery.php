<?php

declare(strict_types=1);

namespace App\Modules\Academic\Queries;

use App\Modules\Academic\Models\AcademicRoom;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSection;
use App\Modules\Academic\Models\ClassSession;
use Carbon\CarbonImmutable;

/**
 * Read-only timetable projection. The room timetable is the canonical
 * resource view; the class/section timetable is the delivery-group view. All
 * projections are derived from scheduled `ClassSession` rows and never write
 * scheduling facts.
 */
final class TimetableQuery
{
    /**
     * @return array{room: array<string, mixed>|null, sessions: list<array<string, mixed>>}
     */
    public function forRoom(string $roomId, ?CarbonImmutable $day = null): array
    {
        $day = $this->day($day);
        /** @var AcademicRoom|null $room */
        $room = AcademicRoom::query()->find($roomId);
        if ($room === null) {
            return ['room' => null, 'sessions' => []];
        }

        $sessions = ClassSession::query()
            ->where('room_id', $roomId)
            ->where('scheduled_on', $day->toDateString())
            ->with(['class', 'section'])
            ->orderBy('starts_at')
            ->get()
            ->map(fn (ClassSession $session): array => $this->sessionRow($session))
            ->all();

        return ['room' => $room->toArray(), 'sessions' => $sessions];
    }

    /**
     * @return array{class: array<string, mixed>|null, sections: list<array<string, mixed>>, sessions: list<array<string, mixed>>}
     */
    public function forClass(string $classId, ?CarbonImmutable $day = null): array
    {
        $day = $this->day($day);
        /** @var ClassModel|null $class */
        $class = ClassModel::query()->find($classId);
        if ($class === null) {
            return ['class' => null, 'sections' => [], 'sessions' => []];
        }

        $sections = ClassSection::query()
            ->where('class_id', $classId)
            ->orderBy('name')
            ->get()
            ->map(fn (ClassSection $section): array => $section->toArray())
            ->all();
        $sessions = ClassSession::query()
            ->where('class_id', $classId)
            ->where('scheduled_on', $day->toDateString())
            ->with(['section', 'room'])
            ->orderBy('starts_at')
            ->get()
            ->map(fn (ClassSession $session): array => $this->sessionRow($session))
            ->all();

        return ['class' => $class->toArray(), 'sections' => $sections, 'sessions' => $sessions];
    }

    /**
     * @return array{branch_id: string, day: string, sessions: list<array<string, mixed>>}
     */
    public function forBranch(string $branchId, ?CarbonImmutable $day = null): array
    {
        $day = $this->day($day);
        $sessions = ClassSession::query()
            ->whereHas('room', fn ($query) => $query->where('branch_id', $branchId))
            ->where('scheduled_on', $day->toDateString())
            ->with(['room', 'class', 'section'])
            ->orderBy('starts_at')
            ->get()
            ->map(fn (ClassSession $session): array => $this->sessionRow($session))
            ->all();

        return ['branch_id' => $branchId, 'day' => $day->toDateString(), 'sessions' => $sessions];
    }

    private function day(?CarbonImmutable $day): CarbonImmutable
    {
        return ($day ?? CarbonImmutable::today())->startOfDay();
    }

    /** @return array<string, mixed> */
    private function sessionRow(ClassSession $session): array
    {
        return [
            'id' => $session->id,
            'class_id' => $session->class_id,
            'section_id' => $session->section_id,
            'section' => $session->section?->name,
            'room_id' => $session->room_id,
            'room' => $session->room?->code,
            'skill_id' => $session->skill_id,
            'scheduled_on' => $session->scheduled_on,
            'starts_at' => $session->starts_at,
            'ends_at' => $session->ends_at,
        ];
    }
}
