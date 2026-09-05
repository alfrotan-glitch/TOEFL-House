<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\RecordAttendance;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\Enrollment;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** JSON interface for the academic calendar and attendance (delegates to the same commands). */
final class AcademicApiController extends Controller
{
    public function sessions(): JsonResponse
    {
        // Room-less sessions are scheduling metadata; roomed sessions disclose
        // branch resources and are confined to visible branches.
        $sessions = [];
        if ($this->hasReadAuthority()) {
            $visible = $this->visibleBranches();
            $sessions = ClassSession::query()
                ->select('class_sessions.*')
                ->leftJoin('academic_rooms as room', 'room.id', '=', 'class_sessions.room_id')
                ->where(function ($query) use ($visible): void {
                    $query->whereNull('class_sessions.room_id')
                        ->orWhereIn('room.branch_id', $visible);
                })
                ->orderByDesc('class_sessions.scheduled_on')
                ->limit(200)
                ->get();
        }

        return response()->json(['sessions' => $sessions]);
    }

    public function schedule(Request $request): JsonResponse
    {
        $input = $request->validate([
            'class_id' => ['required', 'string'],
            'scheduled_on' => ['required', 'date'],
            'starts_at' => ['required', 'string', 'regex:/^\d{2}:\d{2}$/'],
            'ends_at' => ['required', 'string', 'regex:/^\d{2}:\d{2}$/'],
            'skill_id' => ['nullable', 'string'],
        ]);

        app(MaintainClass::class)->scheduleSession(
            $this->actor(),
            ClassModel::query()->findOrFail($input['class_id']),
            CarbonImmutable::parse($input['scheduled_on']),
            $input['starts_at'],
            $input['ends_at'],
            $input['skill_id'] !== null && $input['skill_id'] !== '' ? $input['skill_id'] : null,
            $this->idempotencyKey('academic.schedule'),
        );

        return response()->json(['status' => 'scheduled'], 201);
    }

    public function attendance(Request $request, string $sessionId): JsonResponse
    {
        $input = $request->validate([
            'enrollment_id' => ['required', 'string'],
            'status' => ['required', 'in:present,late,absent,excused'],
        ]);

        app(RecordAttendance::class)->record(
            $this->actor(),
            ClassSession::query()->findOrFail($sessionId),
            Enrollment::query()->findOrFail($input['enrollment_id']),
            $input['status'],
            $this->idempotencyKey('academic.attendance'),
        );

        return response()->json(['status' => 'recorded']);
    }
}
