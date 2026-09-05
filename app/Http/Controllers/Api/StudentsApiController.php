<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Academic\Domain\RecordBranch;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Students\Commands\MaintainStudentCommunicationPreference;
use App\Modules\Students\Commands\ManageStudentHold;
use App\Modules\Students\Commands\TransferStudentHomeBranch;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Queries\StudentLifecycleQuery;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** JSON interface for the admissions/student lifecycle (delegates to the same commands). */
final class StudentsApiController extends Controller
{
    public function index(): JsonResponse
    {
        // Branch-visibility (WP-ACAD-SCOPE): only students/applicants of the
        // actor's branches. Null-provenance rows stay visible to authorized
        // actors while provenance is being populated.
        $visible = $this->visibleBranches();
        $students = [];
        $applicants = [];
        if ($this->hasReadAuthority()) {
            $students = Student::query()
                ->select('students.*')
                ->leftJoin('student_statuses as csr', function ($join): void {
                    $join->on('csr.student_id', '=', 'students.id')
                        ->whereRaw('csr.id = (select ss.id from student_statuses ss where ss.student_id = students.id order by ss.effective_from desc, ss.id desc limit 1)');
                })
                ->selectRaw('csr.status as current_status')
                ->where(function ($query) use ($visible): void {
                    $query->whereIn('students.current_home_branch_id', $visible)
                        ->orWhere(function ($query) use ($visible): void {
                            $query->whereNull('students.current_home_branch_id')
                                ->whereIn('students.originating_branch_id', $visible);
                        })
                        ->orWhere(function ($query): void {
                            $query->whereNull('students.current_home_branch_id')
                                ->whereNull('students.originating_branch_id');
                        });
                })
                ->orderBy('students.student_code')
                ->limit(200)
                ->get();

            $applicants = Applicant::query()
                ->select('applicants.*')
                ->leftJoin('placement_profiles as profile', 'profile.id', '=', 'applicants.placement_profile_id')
                ->where(function ($query) use ($visible): void {
                    $query->whereNull('applicants.placement_profile_id')
                        ->orWhereIn('profile.current_home_branch_id', $visible)
                        ->orWhere(function ($query) use ($visible): void {
                            $query->whereNull('profile.current_home_branch_id')
                                ->whereIn('profile.originating_branch_id', $visible);
                        })
                        ->orWhere(function ($query): void {
                            $query->whereNull('profile.current_home_branch_id')
                                ->whereNull('profile.originating_branch_id');
                        });
                })
                ->orderByDesc('applicants.created_at')
                ->limit(200)
                ->get();
        }

        return response()->json(['students' => $students, 'applicants' => $applicants]);
    }

    public function registerApplicant(Request $request): JsonResponse
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

        return response()->json(['status' => 'registered'], 201);
    }

    /**
     * The signed-in session INITIATES the decision. A different session
     * signed in as a reviewer reviews it, and a third session signed in as
     * an approver finalizes it — no person-id may be supplied in the body.
     */
    public function initiate(Request $request, string $applicantId): JsonResponse
    {
        $input = $request->validate([
            'decision' => ['required', 'in:admit,reject'],
            'reason' => ['required', 'string', 'max:1000'],
            'evidence_ref' => ['required', 'string', 'max:255'],
        ]);

        $result = app(DecideAdmission::class)->initiate(
            $this->actor(),
            Applicant::query()->findOrFail($applicantId),
            $input['decision'] === 'admit',
            $input['reason'],
            $input['evidence_ref'],
            $this->idempotencyKey('admissions.initiate'),
        );

        return response()->json(['status' => 'initiated', 'decision_id' => $result['decision_id']], 201);
    }

    public function review(Request $request, string $decisionId): JsonResponse
    {
        $result = app(DecideAdmission::class)->review(
            $this->actor(),
            AdmissionDecision::query()->findOrFail($decisionId),
            $this->idempotencyKey('admissions.review'),
        );

        return response()->json(['status' => 'reviewed', 'decision_id' => $result['decision_id']]);
    }

    public function approve(Request $request, string $decisionId): JsonResponse
    {
        $result = app(DecideAdmission::class)->approve(
            $this->actor(),
            AdmissionDecision::query()->findOrFail($decisionId),
            $this->idempotencyKey('admissions.approve'),
        );

        return response()->json(['status' => 'final', 'decision_id' => $result['decision_id'], 'outcome' => $result['outcome']]);
    }

    public function enroll(Request $request, string $applicantId): JsonResponse
    {
        app(EnrollAdmittedApplicant::class)->convert(
            $this->actor(),
            Applicant::query()->findOrFail($applicantId),
            $this->idempotencyKey('admissions.enroll'),
        );

        return response()->json(['status' => 'enrolled']);
    }

    public function show(string $studentId): JsonResponse
    {
        $student = Student::query()->findOrFail($studentId);
        $this->requireBranchVisible(
            RecordBranch::studentBranchForId($student->id),
            'api.students.show',
            'student',
            $student->id,
        );

        return response()->json((new StudentLifecycleQuery)->for($student));
    }

    public function transfer(Request $request, string $studentId): JsonResponse
    {
        $input = $request->validate([
            'branch_id' => ['required', 'string'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        $result = app(TransferStudentHomeBranch::class)->transfer(
            $this->actor(),
            Student::query()->findOrFail($studentId),
            $input['branch_id'],
            $input['reason'],
            $this->idempotencyKey('students.transfer'),
        );

        return response()->json(['status' => 'transferred', ...$result]);
    }

    public function hold(Request $request, string $studentId): JsonResponse
    {
        $input = $request->validate([
            'action' => ['required', 'string', 'in:freeze,resume'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        $student = Student::query()->findOrFail($studentId);
        $command = app(ManageStudentHold::class);
        $result = $input['action'] === 'freeze'
            ? $command->freeze($this->actor(), $student, $input['reason'], $this->idempotencyKey('students.hold.freeze'))
            : $command->resume($this->actor(), $student, $input['reason'], $this->idempotencyKey('students.hold.resume'));

        return response()->json(['status' => $input['action'], ...$result]);
    }

    public function communicationPreference(Request $request, string $studentId): JsonResponse
    {
        $input = $request->validate([
            'channel' => ['required', 'string', 'in:email,sms,whatsapp,push'],
            'enabled' => ['required', 'boolean'],
        ]);

        $result = app(MaintainStudentCommunicationPreference::class)->setPreference(
            $this->actor(),
            Student::query()->findOrFail($studentId),
            $input['channel'],
            (bool) $input['enabled'],
            $this->idempotencyKey('students.communication'),
        );

        return response()->json(['status' => 'saved', ...$result]);
    }
}
