<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\Actor;
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

    public function decide(Request $request, string $applicantId): JsonResponse
    {
        $input = $request->validate([
            'decision' => ['required', 'in:admit,reject'],
            'reason' => ['required', 'string', 'max:1000'],
            'evidence_ref' => ['required', 'string', 'max:255'],
            'reviewer_id' => ['required', 'string'],
            'approver_id' => ['required', 'string'],
        ]);

        app(DecideAdmission::class)->decide(
            $this->actor(),
            new Actor($input['reviewer_id'], 'Admission Reviewer'),
            new Actor($input['approver_id'], 'Admission Approver'),
            Applicant::query()->findOrFail($applicantId),
            $input['decision'] === 'admit',
            $input['reason'],
            $input['evidence_ref'],
            $this->idempotencyKey('admissions.decide'),
        );

        return response()->json(['status' => 'decided']);
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
