<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Students\Models\Student;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** JSON interface for the admissions/student lifecycle (delegates to the same commands). */
final class StudentsApiController extends Controller
{
    public function index(): JsonResponse
    {
        $students = Student::query()
            ->select('students.*')
            ->leftJoin('student_statuses as csr', function ($join): void {
                $join->on('csr.student_id', '=', 'students.id')
                    ->whereRaw('csr.id = (select ss.id from student_statuses ss where ss.student_id = students.id order by ss.effective_from desc, ss.id desc limit 1)');
            })
            ->selectRaw('csr.status as current_status')
            ->orderBy('students.student_code')
            ->limit(200)
            ->get();

        $applicants = Applicant::query()->orderByDesc('created_at')->limit(200)->get();

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
}
