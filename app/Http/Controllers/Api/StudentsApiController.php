<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Academic\Domain\RecordBranch;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Commands\ReopenApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Commands\MaintainStudentCommunicationPreference;
use App\Modules\Students\Commands\MaintainGuardianRelationship;
use App\Modules\Students\Commands\ManageStudentHold;
use App\Modules\Students\Commands\TransferStudentHomeBranch;
use App\Modules\Students\Commands\TransitionStudentStatus;
use App\Modules\Students\Domain\GuardianPermissionRegistry;
use App\Modules\Students\Models\GuardianRelationship;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Queries\StudentLifecycleQuery;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/** JSON interface for the admissions/student lifecycle (delegates to the same commands). */
final class StudentsApiController extends Controller
{
    public function index(): JsonResponse
    {
        // Branch visibility is fail-closed. Unknown-provenance operational
        // rows are historical remediation candidates, not a wildcard.
        $studentVisible = $this->authorizedBranches('students.manage');
        $admissionReviewBranches = $this->authorizedBranches('admissions.review');
        $admissionInitiateBranches = $this->authorizedBranches('admissions.initiate');
        $admissionApproveBranches = $this->authorizedBranches('admissions.approve');
        $admissionVisible = array_values(array_unique([...$admissionReviewBranches, ...$admissionInitiateBranches, ...$admissionApproveBranches]));
        $students = [];
        $applicants = [];
        if ($studentVisible !== []) {
            $students = Student::query()
                ->with(['person:id,legal_name,verification_state', 'currentHomeBranch:id,name'])
                ->select(['students.id', 'students.student_code', 'students.person_id', 'students.originating_branch_id', 'students.current_home_branch_id'])
                ->leftJoin('student_statuses as csr', function ($join): void {
                    $join->on('csr.student_id', '=', 'students.id')
                        ->whereRaw('csr.id = (select ss.id from student_statuses ss where ss.student_id = students.id order by ss.seq desc limit 1)');
                })
                ->selectRaw('csr.status as current_status')
                ->where(function ($query) use ($studentVisible): void {
                    $query->whereIn('students.current_home_branch_id', $studentVisible)
                        ->orWhere(function ($query) use ($studentVisible): void {
                            $query->whereNull('students.current_home_branch_id')
                                ->whereIn('students.originating_branch_id', $studentVisible);
                        });
                })
                ->orderBy('students.student_code')
                ->limit(200)
                ->get()
                ->map(static fn (Student $student): array => [
                    'id' => trim((string) $student->id),
                    'student_code' => $student->student_code,
                    'person' => $student->person === null ? null : [
                        'legal_name' => $student->person->legal_name,
                        'verification_state' => $student->person->verification_state,
                    ],
                    'current_status' => $student->current_status,
                    'originating_branch_id' => $student->originating_branch_id,
                    'current_home_branch_id' => $student->current_home_branch_id,
                    'current_home_branch' => $student->currentHomeBranch === null ? null : [
                        'id' => trim((string) $student->currentHomeBranch->id),
                        'name' => $student->currentHomeBranch->name,
                    ],
                ])->all();
        }

        if ($admissionVisible !== []) {
            $applicants = Applicant::query()
                ->with(['person:id,legal_name,verification_state'])
                ->select(['applicants.id', 'applicants.person_id', 'applicants.program_interest', 'applicants.lifecycle_state', 'applicants.originating_branch_id', 'applicants.current_home_branch_id', 'applicants.created_at'])
                ->leftJoin('placement_profiles as profile', 'profile.id', '=', 'applicants.placement_profile_id')
                ->where(function ($query) use ($admissionVisible): void {
                    $query->whereIn('applicants.current_home_branch_id', $admissionVisible)
                        ->orWhere(function ($query) use ($admissionVisible): void {
                            $query->whereNull('applicants.current_home_branch_id')
                                ->whereIn('applicants.originating_branch_id', $admissionVisible);
                        })
                        ->orWhere(function ($query) use ($admissionVisible): void {
                            $query->whereNull('applicants.current_home_branch_id')
                                ->whereNull('applicants.originating_branch_id')
                                ->whereIn('profile.current_home_branch_id', $admissionVisible);
                        })
                        ->orWhere(function ($query) use ($admissionVisible): void {
                            $query->whereNull('applicants.current_home_branch_id')
                                ->whereNull('applicants.originating_branch_id')
                                ->whereNull('profile.current_home_branch_id')
                                ->whereIn('profile.originating_branch_id', $admissionVisible);
                        });
                })
                ->orderByDesc('applicants.created_at')
                ->limit(200)
                ->get()
                ->map(static fn (Applicant $applicant): array => [
                    'id' => trim((string) $applicant->id),
                    'person' => $applicant->person === null ? null : [
                        'legal_name' => $applicant->person->legal_name,
                        'verification_state' => $applicant->person->verification_state,
                    ],
                    'program_interest' => $applicant->program_interest,
                    'lifecycle_state' => $applicant->lifecycle_state,
                    'originating_branch_id' => $applicant->originating_branch_id,
                    'current_home_branch_id' => $applicant->current_home_branch_id,
                ])->all();
        }

        $applicantIds = collect($applicants)->pluck('id')->filter()->values()->all();
        $decisions = $applicantIds === []
            ? []
            : AdmissionDecision::query()
                ->whereIn('applicant_id', $applicantIds)
                ->whereRaw('admission_decisions.id = (select latest.id from admission_decisions latest where latest.applicant_id = admission_decisions.applicant_id order by latest.created_at desc, latest.id desc limit 1)')
                ->orderByDesc('created_at')
                ->get(['id', 'applicant_id', 'outcome', 'reason', 'evidence_ref', 'initiator_id', 'reviewer_id', 'approver_id', 'lifecycle_state', 'created_at']);
        $registrationBranches = $this->authorizedBranches('admissions.register');
        $transferBranches = $this->authorizedBranches('students.transfer');
        $guardianBranches = $this->authorizedBranches('students.guardian');
        $registrationPeople = $registrationBranches === []
            ? []
            : Person::query()
                ->where('verification_state', Person::VERIFICATION_VERIFIED)
                ->whereIn('home_branch_id', $registrationBranches)
                ->orderBy('legal_name')
                ->limit(300)
                ->get(['id', 'legal_name', 'home_branch_id']);
        $guardianPeople = $guardianBranches === []
            ? []
            : Person::query()
                ->where('verification_state', Person::VERIFICATION_VERIFIED)
                ->whereIn('home_branch_id', $guardianBranches)
                ->orderBy('legal_name')
                ->limit(300)
                ->get(['id', 'legal_name', 'home_branch_id']);
        $branchIds = array_values(array_unique([...$registrationBranches, ...$transferBranches, ...$admissionVisible]));
        $availableBranches = $branchIds === []
            ? collect()
            : Branch::query()
                ->whereIn('id', $branchIds)
                ->where('lifecycle_state', 'active')
                ->orderBy('name')
                ->get(['id', 'name', 'lifecycle_state']);
        $branches = $transferBranches === []
            ? collect()
            : $availableBranches->whereIn('id', $transferBranches)->values();
        $registrationBranchRows = $registrationBranches === []
            ? collect()
            : $availableBranches->whereIn('id', $registrationBranches)->values();

        return response()->json([
            'students' => $students,
            'applicants' => $applicants,
            'decisions' => $decisions,
            'registration_people' => $registrationPeople,
            'guardian_people' => $guardianPeople,
            'registration_branches' => $registrationBranchRows,
            'branch_options' => $branches,
            'branch_catalog' => $availableBranches,
            'guardian_permission_options' => GuardianPermissionRegistry::permissions(),
            'capabilities' => [
                'directory' => $studentVisible !== [],
                'admission_register' => $registrationBranches !== [],
                'admission_initiate' => $admissionInitiateBranches !== [],
                'admission_review' => $admissionReviewBranches !== [],
                'admission_approve' => $admissionApproveBranches !== [],
                'student_transfer' => $transferBranches !== [],
                'student_guardian' => $guardianBranches !== [],
            ],
        ]);
    }

    public function registerApplicant(Request $request): JsonResponse
    {
        $input = $request->validate([
            'person_id' => ['required', 'string'],
            'program_interest' => ['required', 'string', 'max:255'],
            'branch_id' => ['required', 'string'],
        ]);

        app(RegisterApplicant::class)->register(
            $this->actor(),
            $input['person_id'],
            $input['program_interest'],
            $this->idempotencyKey('admissions.register'),
            null,
            $input['branch_id'],
        );

        return response()->json(['status' => 'registered'], 201);
    }

    public function reopenApplicant(Request $request, string $applicantId): JsonResponse
    {
        $input = $request->validate([
            'program_interest' => ['required', 'string', 'max:255'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        $result = app(ReopenApplicant::class)->reopen(
            $this->actor(),
            Applicant::query()->findOrFail($applicantId),
            $input['program_interest'],
            $input['reason'],
            $this->idempotencyKey('admissions.reopen'),
        );

        return response()->json(['status' => 'reopened', ...$result]);
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
        $branchId = RecordBranch::studentBranchForId($student->id);
        $this->requireBranchCapability(
            'students.manage',
            $branchId,
            'api.students.show',
            'student',
            $student->id,
        );

        $financeObligationBranches = $this->authorizedBranches('finance.obligation');
        $financePaymentBranches = $this->authorizedBranches('finance.payment');
        $includeFinance = $financeObligationBranches !== [] && $financePaymentBranches !== [];
        $includeGuardianReview = $this->branchCapabilityAllowed('students.guardian', $branchId);

        $lifecycle = (new StudentLifecycleQuery)->for($student, null, $includeFinance, $includeGuardianReview, $financeObligationBranches, $financePaymentBranches);
        $lifecycle['capabilities'] = [
            'status_manage' => $this->branchCapabilityAllowed('students.manage', $branchId),
            'status_reactivate' => $this->branchCapabilityAllowed('students.reactivate', $branchId),
            'transfer' => $this->branchCapabilityAllowed('students.transfer', $branchId),
            'hold' => $this->branchCapabilityAllowed('students.hold', $branchId),
            'communication' => $this->branchCapabilityAllowed('students.communication', $branchId),
            'guardian' => $includeGuardianReview,
            'finance_obligation' => $financeObligationBranches !== [],
            'finance_payment' => $financePaymentBranches !== [],
            'finance' => $includeFinance,
        ];

        return response()->json($lifecycle);
    }

    public function status(Request $request, string $studentId, string $action): JsonResponse
    {
        if (! in_array($action, ['suspend', 'withdraw', 'reactivate', 'complete', 'graduate'], true)) {
            abort(404);
        }
        $input = $request->validate([
            'reason' => ['required', 'string', 'max:1000'],
        ]);
        $student = Student::query()->findOrFail($studentId);
        $command = app(TransitionStudentStatus::class);
        $actor = $this->actor();
        $reason = $input['reason'];
        $idempotencyKey = $this->idempotencyKey('students.status.'.$action);
        $result = match ($action) {
            'suspend' => $command->suspend($actor, $student, $reason, $idempotencyKey),
            'withdraw' => $command->withdraw($actor, $student, $reason, $idempotencyKey),
            'reactivate' => $command->reactivate($actor, $student, $reason, $idempotencyKey),
            'complete' => $command->complete($actor, $student, $reason, $idempotencyKey),
            'graduate' => $command->graduate($actor, $student, $reason, $idempotencyKey),
        };

        return response()->json(['status' => $action, ...$result]);
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

    public function guardian(Request $request, string $studentId): JsonResponse
    {
        $input = $request->validate([
            'guardian_person_id' => ['required', 'string'],
            'relationship' => ['required', 'string', 'max:120'],
            'permissions' => ['required', 'array', 'min:1'],
            'permissions.*' => ['string', 'max:120', Rule::in(GuardianPermissionRegistry::permissions())],
        ]);

        /** @var list<string> $permissions */
        $permissions = array_values($input['permissions']);
        $result = app(MaintainGuardianRelationship::class)->record(
            $this->actor(),
            Student::query()->findOrFail($studentId),
            $input['guardian_person_id'],
            $input['relationship'],
            $permissions,
            $this->idempotencyKey('students.guardian.record'),
        );

        return response()->json(['status' => 'recorded', ...$result], 201);
    }

    public function guardianVerification(Request $request, string $relationshipId, string $action): JsonResponse
    {
        if (! in_array($action, ['verify', 'revoke'], true)) {
            abort(404);
        }
        $relationship = GuardianRelationship::query()->findOrFail($relationshipId);
        $input = $action === 'verify'
            ? $request->validate(['evidence_ref' => ['required', 'string', 'max:255']])
            : [];
        $command = app(MaintainGuardianRelationship::class);
        $result = $action === 'verify'
            ? $command->verify($this->actor(), $relationship, $this->idempotencyKey('students.guardian.verify'), $input['evidence_ref'])
            : $command->revoke($this->actor(), $relationship, $this->idempotencyKey('students.guardian.revoke'));

        return response()->json(['status' => $action, ...$result]);
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
