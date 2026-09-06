<?php

declare(strict_types=1);

namespace App\Modules\Students\Queries;

use App\Modules\Students\Models\GuardianRelationship;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Models\StudentHoldEvent;
use App\Modules\Students\Models\StudentStatus;
use Carbon\CarbonImmutable;

/**
 * Read-only student record: the effective status as of a day (history
 * never overwritten), the currently effective verified guardian
 * relationships, branch provenance/history, open-hold state, and
 * per-channel communication preferences.
 */
final class StudentRecordQuery
{
    /**
     * @return array{
     *     student_id: string,
     *     student_code: string,
     *     person_id: string,
     *     status: string|null,
     *     originating_branch_id: string,
     *     current_home_branch_id: string,
     *     branch_transfers: list<array<string, mixed>>,
     *     holds: array{open: bool, history: list<array<string, mixed>>},
     *     communication_preferences: list<array<string, mixed>>,
     *     guardians: list<array<string, mixed>>
     * }
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

        $transfers = $student->branchTransfers()
            ->get()
            ->map(static fn ($transfer): array => [
                'id' => trim((string) $transfer->id),
                'from_branch_id' => trim((string) ($transfer->from_branch_id ?? '')),
                'to_branch_id' => trim((string) $transfer->to_branch_id),
                'effective_from' => $transfer->effective_from,
                'reason' => $transfer->reason,
                'transferred_by' => trim((string) $transfer->transferred_by),
            ])
            ->all() ?? [];

        /** @var StudentHoldEvent|null $latestHold */
        $latestHold = StudentHoldEvent::query()->where('student_id', $studentId)->orderByDesc('seq')->first();
        $holdHistory = StudentHoldEvent::query()
            ->where('student_id', $studentId)
            ->orderBy('seq')
            ->get()
            ->map(static fn (StudentHoldEvent $event): array => [
                'id' => trim((string) $event->id),
                'action' => $event->action,
                'effective_from' => $event->effective_from,
                'reason' => $event->reason,
                'actor_id' => trim((string) $event->actor_id),
            ])
            ->all();

        return [
            'student_id' => trim($studentId),
            'student_code' => $student->student_code,
            'person_id' => trim((string) $student->person_id),
            'status' => $status?->status,
            'originating_branch_id' => trim((string) ($student->originating_branch_id ?? '')),
            'current_home_branch_id' => trim((string) ($student->current_home_branch_id ?? '')),
            'branch_transfers' => $transfers,
            'holds' => [
                'open' => $latestHold?->action === 'freeze',
                'history' => $holdHistory,
            ],
            'communication_preferences' => $student->communicationPreferences()
                ->get(['channel', 'enabled'])
                ->map(static fn ($preference): array => [
                    'channel' => $preference->channel,
                    'enabled' => (bool) $preference->enabled,
                ])
                ->all(),
            'guardians' => $guardians,
        ];
    }
}
