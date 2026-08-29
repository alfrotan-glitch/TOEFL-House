<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Academic\Commands\DecideProgression;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\RecordAttendance;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Academic\Models\Skill;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Students\Models\Student;
use Carbon\CarbonImmutable;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Academic console: the structure (programs, periods, classes, skills,
 * teacher assignments), the session calendar, and attendance recording with
 * corrections. Session scheduling and attendance delegate to the academic
 * module commands, which own authorization and the delivery evidence.
 */
final class AcademicController extends Controller
{
    public function index(): View
    {
        return view('academic.index', [
            'programs' => Program::query()->orderBy('name')->limit(100)->get(),
            'periods' => AcademicPeriod::query()->orderBy('starts_on')->limit(100)->get(),
            'skills' => Skill::query()->orderBy('rank_order')->limit(100)->get(),
            'classes' => ClassModel::query()->orderBy('id')->limit(100)->get(),
            'assignments' => TeacherAssignment::query()->orderBy('id')->limit(100)->get(),
            'students' => Student::query()->orderBy('student_code')->limit(300)->get(),
            'requestedEnrollments' => Enrollment::query()->where('lifecycle_state', 'requested')->orderBy('id')->limit(200)->get(),
            'progressions' => ProgressionDecision::query()->whereIn('lifecycle_state', ['proposed', 'reviewed'])->orderBy('id')->limit(200)->get(),
        ]);
    }

    public function sessions(): View
    {
        return view('academic.sessions', [
            'sessions' => ClassSession::query()->orderByDesc('scheduled_on')->limit(200)->get(),
            'classes' => ClassModel::query()->where('lifecycle_state', 'active')->orderBy('id')->get(),
            'skills' => Skill::query()->where('lifecycle_state', 'active')->orderBy('rank_order')->get(),
            'enrollments' => Enrollment::query()->where('lifecycle_state', 'active')->orderBy('class_id')->limit(1000)->get(),
        ]);
    }

    public function scheduleSession(Request $request): RedirectResponse
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
            $this->idempotencyKey('academic.schedule'),
            $input['skill_id'] !== null && $input['skill_id'] !== '' ? $input['skill_id'] : null,
        );

        return redirect()->route('academic.sessions')->with('success', 'Session scheduled.');
    }

    public function recordAttendance(Request $request, string $sessionId): RedirectResponse
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

        return redirect()->route('academic.sessions')->with('success', 'Attendance fact recorded.');
    }

    public function requestEnrollment(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'student_id' => ['required', 'string'],
            'class_id' => ['required', 'string'],
        ]);

        app(MaintainEnrollment::class)->request(
            $this->actor(),
            $input['student_id'],
            $input['class_id'],
            $this->idempotencyKey('academic.enrollment.request'),
        );

        return redirect()->route('academic.index')->with('success', 'Seat requested; it takes effect once an approver activates it.');
    }

    public function activateEnrollment(Request $request, string $enrollmentId): RedirectResponse
    {
        app(MaintainEnrollment::class)->activate(
            $this->actor(),
            Enrollment::query()->findOrFail($enrollmentId),
            $this->idempotencyKey('academic.enrollment.activate'),
        );

        return redirect()->route('academic.index')->with('success', 'Seat activated.');
    }

    public function proposeProgression(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'student_id' => ['required', 'string'],
            'class_id' => ['required', 'string'],
            'outcome' => ['required', 'in:advance,repeat'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(DecideProgression::class)->propose(
            $this->actor(),
            $input['student_id'],
            $input['class_id'],
            $input['outcome'],
            $input['reason'],
            $this->idempotencyKey('academic.progression.propose'),
        );

        return redirect()->route('academic.index')->with('success', 'Progression proposed; it takes effect once reviewed and approved by distinct signers.');
    }

    public function reviewProgression(Request $request, string $decisionId): RedirectResponse
    {
        app(DecideProgression::class)->review(
            $this->actor(),
            ProgressionDecision::query()->findOrFail($decisionId),
            $this->idempotencyKey('academic.progression.review'),
        );

        return redirect()->route('academic.index')->with('success', 'Progression reviewed.');
    }

    public function approveProgression(Request $request, string $decisionId): RedirectResponse
    {
        app(DecideProgression::class)->approve(
            $this->actor(),
            ProgressionDecision::query()->findOrFail($decisionId),
            $this->idempotencyKey('academic.progression.approve'),
        );

        return redirect()->route('academic.index')->with('success', 'Progression approved.');
    }
}
