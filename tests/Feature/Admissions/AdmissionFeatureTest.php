<?php

declare(strict_types=1);

namespace Tests\Feature\Admissions;

use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Models\Person;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

final class AdmissionFeatureTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

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

        // Stage 1: the clerk initiates — the decision is born 'proposed'
        // and the applicant is still in the decidable state.
        $initiated = app(DecideAdmission::class)->initiate($clerk, $applicant, true, 'meets entry policy', 'interview-notes/1', 'dec-key-1.initiate');
        $this->assertSame('proposed', $initiated['lifecycle_state']);
        $this->assertDatabaseHas('admission_decisions', ['id' => $initiated['decision_id'], 'outcome' => 'admit', 'initiator_id' => 'adm-reception-1', 'reviewer_id' => null, 'approver_id' => null, 'lifecycle_state' => 'proposed']);
        $this->assertDatabaseHas('applicants', ['id' => $applicant->id, 'lifecycle_state' => 'applicant']);

        // Stage 2: a distinct reviewer reviews — 'reviewed'.
        $reviewed = app(DecideAdmission::class)->review($reviewer, AdmissionDecision::query()->findOrFail($initiated['decision_id']), 'dec-key-1.review');
        $this->assertSame('reviewed', $reviewed['lifecycle_state']);
        $this->assertDatabaseHas('applicants', ['id' => $applicant->id, 'lifecycle_state' => 'applicant']);

        // Stage 3: a third, distinct approver finalizes — and only now does
        // the applicant become admitted.
        $decision = app(DecideAdmission::class)->approve($approver, AdmissionDecision::query()->findOrFail($initiated['decision_id']), 'dec-key-1.approve');
        $this->assertSame('admit', $decision['outcome']);
        $this->assertDatabaseHas('applicants', ['id' => $applicant->id, 'lifecycle_state' => 'admitted']);
        $this->assertDatabaseHas('admission_decisions', ['id' => $decision['decision_id'], 'outcome' => 'admit', 'initiator_id' => 'adm-reception-1', 'reviewer_id' => 'adm-review-1', 'approver_id' => 'adm-approve-1', 'lifecycle_state' => 'final']);

        $converted = app(EnrollAdmittedApplicant::class)->convert($approver, $applicant, 'conv-key-1');
        $replay = app(EnrollAdmittedApplicant::class)->convert($approver, $applicant, 'conv-key-1');
        $this->assertSame($converted, $replay);

        $this->assertDatabaseHas('students', ['id' => $converted['student_id'], 'person_id' => $this->applicantPersonId, 'admission_decision_id' => $decision['decision_id']]);
        $this->assertDatabaseHas('student_statuses', ['student_id' => $converted['student_id'], 'status' => 'active', 'reason' => 'admission conversion']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'admissions.convert', 'target_type' => 'student', 'target_id' => $converted['student_id']]);
    }

    public function test_reception_alone_cannot_review_or_approve(): void
    {
        $clerk = $this->admissionsClerk();
        $applicant = $this->registeredApplicant();

        // Reception may initiate — that is a legal stage for them.
        $initiated = app(DecideAdmission::class)->initiate($clerk, $applicant, true, 'reception-only conversion', 'ev/1', 'dec-key-2.initiate');
        $decisionId = $initiated['decision_id'];

        // ...but may never review their own proposal — reception holds no
        // review capability at all.
        try {
            app(DecideAdmission::class)->review($clerk, AdmissionDecision::query()->findOrFail($decisionId), 'dec-key-2.review');
            $this->fail('reception must never review');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('admissions.reviewer_denied', $denial->errorCode());
        }
        $this->assertDatabaseHas('admission_decisions', ['id' => $decisionId, 'lifecycle_state' => 'proposed']);
        $this->assertDatabaseHas('applicants', ['id' => $applicant->id, 'lifecycle_state' => 'applicant']);

        // A real reviewer advances it to 'reviewed'...
        app(DecideAdmission::class)->review($this->admissionsReviewer(), AdmissionDecision::query()->findOrFail($decisionId), 'dec-key-2b.review');

        // ...but the clerk must not be the one to approve it — reception
        // holds no approval capability.
        try {
            app(DecideAdmission::class)->approve($clerk, AdmissionDecision::query()->findOrFail($decisionId), 'dec-key-2b.approve');
            $this->fail('reception must not approve');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('admissions.approver_denied', $denial->errorCode());
        }
        $this->assertDatabaseHas('admission_decisions', ['id' => $decisionId, 'lifecycle_state' => 'reviewed']);
        $this->assertDatabaseHas('applicants', ['id' => $applicant->id, 'lifecycle_state' => 'applicant']);

        // Only the full three-person chain finalizes — reception alone never
        // converts anyone.
        app(DecideAdmission::class)->approve($this->admissionsApprover(), AdmissionDecision::query()->findOrFail($decisionId), 'dec-key-2c.approve');
        $this->assertDatabaseHas('applicants', ['id' => $applicant->id, 'lifecycle_state' => 'admitted']);

        $this->assertDatabaseHas('audit_events', ['operation' => 'admissions.review.denied', 'actor_id' => 'adm-reception-1']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'admissions.approve.denied', 'actor_id' => 'adm-reception-1']);
    }

    public function test_single_actor_holding_all_three_roles_is_denied(): void
    {
        $super = $this->actorWithStructureCapabilities('adm-super-1', ['admissions.initiate', 'admissions.review', 'admissions.approve']);
        $applicant = $this->registeredApplicant();

        $initiated = app(DecideAdmission::class)->initiate($super, $applicant, true, 'one person chain', 'ev/2', 'dec-key-3.initiate');

        // One person holding every capability may still carry only one stage:
        // reviewing their own proposal is where the chain breaks.
        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('the admission reviewer must differ from the initiator');
        app(DecideAdmission::class)->review($super, AdmissionDecision::query()->findOrFail($initiated['decision_id']), 'dec-key-3.review');
    }

    public function test_rejected_applicant_cannot_convert_and_unverified_person_cannot_apply(): void
    {
        $clerk = $this->admissionsClerk('adm-reception-2');
        $reviewer = $this->admissionsReviewer('adm-review-2');
        $approver = $this->admissionsApprover('adm-approve-2');
        $applicant = $this->registeredApplicant();
        $this->runAdmissionDecision($clerk, $reviewer, $approver, $applicant, false, 'entry test below threshold', 'placement/score-1', 'dec-key-4');

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
        $this->runAdmissionDecision($clerk, $reviewer, $approver, $applicant, true, 'ok', 'ev/4', 'dec-key-5');
        app(EnrollAdmittedApplicant::class)->convert($approver, $applicant, 'conv-key-3');

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('already produced a student');
        app(EnrollAdmittedApplicant::class)->convert($approver, $applicant, 'conv-key-4');
    }

    public function test_final_admission_decisions_are_immutable(): void
    {
        $applicant = $this->registeredApplicant();
        $clerk = $this->admissionsClerk('adm-reception-5');
        $decision = $this->runAdmissionDecision($clerk, $this->admissionsReviewer('adm-review-5'), $this->admissionsApprover('adm-approve-5'), $applicant, true, 'ok', 'ev/5', 'dec-key-6');
        $this->assertSame('final', $decision['lifecycle_state']);

        $this->expectException(QueryException::class);
        DB::statement("UPDATE admission_decisions SET outcome = 'reject' WHERE id = ?", [$decision['decision_id']]);
    }
}
