<?php

declare(strict_types=1);

namespace Tests\Feature\Admissions;

use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Models\Person;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class AdmissionFeatureTest extends TestCase
{
    use BuildsActors;

    private string $applicantPersonId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->applicantPersonId = 'adm-person-1';
        $this->personWithAuthority($this->applicantPersonId, []);
    }

    private function registeredApplicant(): Applicant
    {
        $result = app(RegisterApplicant::class)->register($this->admissionsClerk(), $this->applicantPersonId, 'IELTS Preparation', 'reg-key-1');

        return Applicant::query()->findOrFail($result['applicant_id']);
    }

    public function test_register_admit_convert_chain_creates_an_active_student_transactionally(): void
    {
        $clerk = $this->admissionsClerk();
        $reviewer = $this->admissionsReviewer();
        $approver = $this->admissionsApprover();
        $applicant = $this->registeredApplicant();

        $decision = app(DecideAdmission::class)->decide($clerk, $reviewer, $approver, $applicant, true, 'meets entry policy', 'interview-notes/1', 'dec-key-1');
        $this->assertSame('admit', $decision['outcome']);
        $this->assertDatabaseHas('applicants', ['id' => $applicant->id, 'lifecycle_state' => 'admitted']);
        $this->assertDatabaseHas('admission_decisions', ['id' => $decision['decision_id'], 'outcome' => 'admit', 'initiator_id' => 'adm-reception-1', 'reviewer_id' => 'adm-review-1', 'approver_id' => 'adm-approve-1']);

        $converted = app(EnrollAdmittedApplicant::class)->convert($approver, $applicant, 'conv-key-1');
        $replay = app(EnrollAdmittedApplicant::class)->convert($approver, $applicant, 'conv-key-1');
        $this->assertSame($converted, $replay);

        $this->assertDatabaseHas('students', ['id' => $converted['student_id'], 'person_id' => $this->applicantPersonId, 'admission_decision_id' => $decision['decision_id']]);
        $this->assertDatabaseHas('student_statuses', ['student_id' => $converted['student_id'], 'status' => 'active', 'reason' => 'admission conversion']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'admissions.convert', 'target_type' => 'student', 'target_id' => $converted['student_id']]);
    }

    public function test_reception_alone_cannot_decide_or_convert(): void
    {
        $clerk = $this->admissionsClerk();
        $applicant = $this->registeredApplicant();

        // Reception may initiate, but never review or approve the permanent decision.
        try {
            app(DecideAdmission::class)->decide($clerk, $clerk, $clerk, $applicant, true, 'reception-only conversion', 'ev/1', 'dec-key-2');
            $this->fail('reception alone must never pass the authority chain');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('admissions.reviewer_denied', $denial->errorCode());
        }

        try {
            app(DecideAdmission::class)->decide($clerk, $this->admissionsReviewer(), $clerk, $applicant, true, 'clerk self approval', 'ev/1b', 'dec-key-2b');
            $this->fail('reception must not approve');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('admissions.approver_denied', $denial->errorCode());
        }

        $this->assertDatabaseHas('audit_events', ['operation' => 'admissions.decide.denied', 'actor_id' => 'adm-reception-1']);
        $this->assertDatabaseMissing('admission_decisions', ['applicant_id' => $applicant->id]);
    }

    public function test_single_actor_holding_all_three_roles_is_denied(): void
    {
        $super = $this->actorWithStructureCapabilities('adm-super-1', ['admissions.initiate', 'admissions.review', 'admissions.approve']);
        $applicant = $this->registeredApplicant();

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('initiator, reviewer, and approver must be distinct actors');
        app(DecideAdmission::class)->decide($super, $super, $super, $applicant, true, 'one person chain', 'ev/2', 'dec-key-3');
    }

    public function test_rejected_applicant_cannot_convert_and_unverified_person_cannot_apply(): void
    {
        $clerk = $this->admissionsClerk('adm-reception-2');
        $reviewer = $this->admissionsReviewer('adm-review-2');
        $approver = $this->admissionsApprover('adm-approve-2');
        $applicant = $this->registeredApplicant();
        app(DecideAdmission::class)->decide($clerk, $reviewer, $approver, $applicant, false, 'entry test below threshold', 'placement/score-1', 'dec-key-4');

        try {
            app(EnrollAdmittedApplicant::class)->convert($approver, $applicant, 'conv-key-2');
            $this->fail('a rejected applicant must not convert');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('admissions.convert_requires_admission', $rejection->errorCode());
        }

        $unverified = Person::query()->create([
            'id' => RandomIdentifier::new(),
            'legal_name' => 'Unverified Applicant',
            'date_of_birth' => '2005-05-05',
            'verification_state' => 'unverified',
        ]);
        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('an applicant requires a verified person identity');
        app(RegisterApplicant::class)->register($clerk, $unverified->id, 'General English', 'reg-key-2');
    }

    public function test_duplicate_open_file_and_double_conversion_are_rejected(): void
    {
        $applicant = $this->registeredApplicant();

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('already has an open admission file');
        app(RegisterApplicant::class)->register($this->admissionsClerk('adm-reception-3'), $this->applicantPersonId, 'Another Program', 'reg-key-3');
    }

    public function test_conversion_twice_with_different_keys_is_rejected(): void
    {
        $clerk = $this->admissionsClerk('adm-reception-4');
        $reviewer = $this->admissionsReviewer('adm-review-4');
        $approver = $this->admissionsApprover('adm-approve-4');
        $applicant = $this->registeredApplicant();
        app(DecideAdmission::class)->decide($clerk, $reviewer, $approver, $applicant, true, 'ok', 'ev/4', 'dec-key-5');
        app(EnrollAdmittedApplicant::class)->convert($approver, $applicant, 'conv-key-3');

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('already produced a student');
        app(EnrollAdmittedApplicant::class)->convert($approver, $applicant, 'conv-key-4');
    }

    public function test_admission_decisions_are_append_only(): void
    {
        $applicant = $this->registeredApplicant();
        $clerk = $this->admissionsClerk('adm-reception-5');
        $decision = app(DecideAdmission::class)->decide($clerk, $this->admissionsReviewer('adm-review-5'), $this->admissionsApprover('adm-approve-5'), $applicant, true, 'ok', 'ev/5', 'dec-key-6');

        $this->expectException(QueryException::class);
        DB::statement("UPDATE admission_decisions SET outcome = 'reject' WHERE id = ?", [$decision['decision_id']]);
    }
}
