<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Academic\Models\Enrollment;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Models\Person;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Models\StudentStatus;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Students &amp; Admissions console: register applicants, run the
 * three-signature admission decision, enroll admitted applicants, and view
 * the student lifecycle. All state changes delegate to the admissions and
 * students module commands (authorization, SoD, idempotency, audit owned
 * there).
 */
final class StudentsController extends Controller
{
    public function index(): View
    {
        return view('students.index', [
            'students' => $this->studentsWithStatus()->limit(200)->get(),
            'activeCount' => $this->activeStudentCount(),
        ]);
    }

    /** Count of students whose latest status row is active. */
    private function activeStudentCount(): int
    {
        return Student::query()
            ->whereExists(function ($query): void {
                $query->selectRaw('1')
                    ->from('student_statuses as latest')
                    ->whereColumn('latest.student_id', 'students.id')
                    ->where('latest.status', 'active')
                    ->whereRaw('latest.id = (select ss.id from student_statuses ss where ss.student_id = students.id order by ss.effective_from desc, ss.id desc limit 1)');
            })
            ->count();
    }

    public function applicants(): View
    {
        return view('students.applicants', [
            'applicants' => Applicant::query()->orderByDesc('created_at')->limit(200)->get(),
            'people' => Person::query()->where('verification_state', 'verified')->orderBy('legal_name')->limit(300)->get(),
            'pendingDecisions' => AdmissionDecision::query()
                ->whereIn('lifecycle_state', ['proposed', 'reviewed'])
                ->orderByDesc('created_at')->limit(200)->get(),
        ]);
    }

    public function registerApplicant(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'person_id' => ['required', 'string'],
            'program_interest' => ['required', 'string', 'max:255'],
        ]);

        app(RegisterApplicant::class)->register(
            $this->actor(),
            $input['person_id'],
            $input['program_interest'],
            $this->idempotencyKey('admissions.register'),
        );

        return redirect()->route('students.applicants')->with('success', 'Applicant registered.');
    }

    /**
     * The signed-in session INITIATES the decision (outcome, reason, and
     * evidence are fixed up front). A different session signed in as a
     * reviewer reviews it, and a third session signed in as an approver
     * finalizes it — the transport can no longer type a colleague's person
     * id into the form.
     */
    public function initiateAdmission(Request $request, string $applicantId): RedirectResponse
    {
        $input = $request->validate([
            'decision' => ['required', 'in:admit,reject'],
            'reason' => ['required', 'string', 'max:1000'],
            'evidence_ref' => ['required', 'string', 'max:255'],
        ]);
        $applicant = Applicant::query()->findOrFail($applicantId);

        app(DecideAdmission::class)->initiate(
            $this->actor(),
            $applicant,
            $input['decision'] === 'admit',
            $input['reason'],
            $input['evidence_ref'],
            $this->idempotencyKey('admissions.initiate'),
        );

        return redirect()->route('students.applicants')->with('success', 'Admission decision initiated; it takes effect once a distinct reviewer and approver act on it.');
    }

    public function reviewAdmission(Request $request, string $decisionId): RedirectResponse
    {
        app(DecideAdmission::class)->review(
            $this->actor(),
            AdmissionDecision::query()->findOrFail($decisionId),
            $this->idempotencyKey('admissions.review'),
        );

        return redirect()->route('students.applicants')->with('success', 'Admission decision reviewed; it takes effect once a distinct approver finalizes it.');
    }

    public function approveAdmission(Request $request, string $decisionId): RedirectResponse
    {
        app(DecideAdmission::class)->approve(
            $this->actor(),
            AdmissionDecision::query()->findOrFail($decisionId),
            $this->idempotencyKey('admissions.approve'),
        );

        return redirect()->route('students.applicants')->with('success', 'Admission decision finalized and the applicant has been admitted or rejected.');
    }

    public function enroll(Request $request, string $applicantId): RedirectResponse
    {
        $applicant = Applicant::query()->findOrFail($applicantId);

        app(EnrollAdmittedApplicant::class)->convert(
            $this->actor(),
            $applicant,
            $this->idempotencyKey('admissions.enroll'),
        );

        return redirect()->route('students.applicants')->with('success', 'Admitted applicant converted to a student.');
    }

    public function show(string $studentId): View
    {
        $student = Student::query()->findOrFail($studentId);
        $statuses = StudentStatus::query()
            ->where('student_id', $student->id)
            ->orderBy('effective_from')->orderBy('id')->get();

        return view('students.show', [
            'student' => $student,
            'statuses' => $statuses,
            'enrollments' => Enrollment::query()
                ->where('student_id', $student->id)
                ->orderByDesc('created_at')->limit(50)->get(),
        ]);
    }

    /** @return Builder<Student> */
    private function studentsWithStatus(): Builder
    {
        return Student::query()
            ->select('students.*')
            ->leftJoin('student_statuses as current_status_row', function ($join): void {
                $join->on('current_status_row.student_id', '=', 'students.id')
                    ->whereRaw('current_status_row.id = (select ss.id from student_statuses ss where ss.student_id = students.id order by ss.effective_from desc, ss.id desc limit 1)');
            })
            ->selectRaw('current_status_row.status as current_status')
            ->orderBy('students.student_code');
    }
}
