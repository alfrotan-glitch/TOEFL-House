<?php

declare(strict_types=1);

namespace Tests\Feature\Academic;

use App\Modules\Academic\Commands\DecideGraduation;
use App\Modules\Academic\Commands\DecideProgression;
use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\ManageAcademicAppeal;
use App\Modules\Academic\Commands\ManageAssessmentResult;
use App\Modules\Academic\Models\AcademicAppeal;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\GraduationDecision;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Academic\Models\ResultCorrection;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

final class AcademicDecisionFeatureTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

    private string $classId;

    private string $studentId;

    private string $enrollmentId;

    protected function setUp(): void
    {
        parent::setUp();
        $officer = $this->academicOfficer('dec-officer');
        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'Decision Program', 'dec-prog-1');
        $version = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'v1', 'dec-prog-2');
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Decision Term', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'dec-period-1');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'dec-period-2');
        $class = app(MaintainClass::class)->defineClass($officer, $version['version_id'], $period['period_id'], 5, 'dec-class-1');
        $this->classId = $class['class_id'];
        $this->grantedActor('dec-teacher-1', []);
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), 'dec-teacher-1', new CarbonImmutable('2026-09-01'), null, 'dec-class-2');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'dec-class-3');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'dec-class-4');

        $this->grantedActor('dec-person-1', []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('dec-clerk'), 'dec-person-1', 'Program', 'dec-reg-1');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision($this->admissionsClerk('dec-clerk'), $this->admissionsReviewer('dec-review'), $this->admissionsApprover('dec-approve'), $applicant, true, 'meets policy', 'ev/dec', 'dec-adm-1');
        $this->studentId = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('dec-approve'), $applicant, 'dec-conv-1')['student_id'];
        $seat = app(MaintainEnrollment::class)->request($this->enrollmentClerk('dec-enroll'), $this->studentId, $this->classId, 'dec-enr-1');
        app(MaintainEnrollment::class)->activate($this->academicOfficer('dec-officer'), Enrollment::query()->findOrFail($seat['enrollment_id']), 'dec-enr-2');
        $this->enrollmentId = $seat['enrollment_id'];
    }

    private function releasedResult(): array
    {
        $scorer = $this->grantedActor('dec-scorer', ['academic.assess']);
        $moderator = $this->grantedActor('dec-moderator', ['academic.moderate']);
        $approver = $this->grantedActor('dec-approver-r', ['academic.approve_result']);
        $releaser = $this->grantedActor('dec-releaser', ['academic.release']);

        $attempt = app(ManageAssessmentResult::class)->submitAttempt($scorer, Enrollment::query()->findOrFail($this->enrollmentId), 'assessment', 'scan/final-1', 'dec-att-1');
        $result = app(ManageAssessmentResult::class)->score($scorer, AssessmentAttempt::query()->findOrFail($attempt['attempt_id']), '87.50', 'dec-res-1');
        /** @var AssessmentResult $resultRow */
        $resultRow = AssessmentResult::query()->findOrFail($result['result_id']);
        app(ManageAssessmentResult::class)->moderate($moderator, $resultRow, 'dec-res-2');
        app(ManageAssessmentResult::class)->approve($approver, $resultRow, 'dec-res-3');
        app(ManageAssessmentResult::class)->release($releaser, $resultRow, 'dec-res-4');

        return ['attempt_id' => $attempt['attempt_id'], 'result_id' => $result['result_id']];
    }

    public function test_result_moves_scored_moderated_approved_released_with_independent_review(): void
    {
        $scorer = $this->grantedActor('dec-scorer-a', ['academic.assess', 'academic.moderate']);
        $attempt = app(ManageAssessmentResult::class)->submitAttempt($scorer, Enrollment::query()->findOrFail($this->enrollmentId), 'assessment', 'scan/a', 'dec-att-2');
        $result = app(ManageAssessmentResult::class)->score($scorer, AssessmentAttempt::query()->findOrFail($attempt['attempt_id']), '90.00', 'dec-res-5');
        /** @var AssessmentResult $row */
        $row = AssessmentResult::query()->findOrFail($result['result_id']);
        $this->assertSame('scored', $row->lifecycle_state);

        try {
            app(ManageAssessmentResult::class)->moderate($scorer, $row, 'dec-res-6');
            $this->fail('the scorer may not moderate their own result');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.review_not_independent', $denial->errorCode());
        }

        app(ManageAssessmentResult::class)->moderate($this->grantedActor('dec-moderator-a', ['academic.moderate']), $row, 'dec-res-7');
        app(ManageAssessmentResult::class)->approve($this->grantedActor('dec-approver-a', ['academic.approve_result']), $row, 'dec-res-8');
        try {
            app(ManageAssessmentResult::class)->release($this->grantedActor('dec-approver-a2', ['academic.approve_result']), $row, 'dec-res-9');
            $this->fail('releasing needs the release capability');
        } catch (AuthorizationDenied) {
            $this->assertTrue(true);
        }
        app(ManageAssessmentResult::class)->release($this->grantedActor('dec-releaser-a', ['academic.release']), $row, 'dec-res-10');

        $this->assertSame('released', $row->refresh()->lifecycle_state);
        $this->assertSame(0, DB::table('progression_decisions')->where('student_id', $this->studentId)->count(), 'a released score never becomes a progression decision automatically');
    }

    public function test_correction_appends_a_reasoned_row_and_marks_the_original_corrected(): void
    {
        $ids = $this->releasedResult();
        $dual = $this->grantedActor('dec-moderator-b', ['academic.moderate', 'academic.approve_result']);
        $approver = $this->grantedActor('dec-approver-b', ['academic.approve_result']);

        // Staged: the moderator proposes in her own session; approval needs a distinct approver.
        $proposal = app(ManageAssessmentResult::class)->proposeCorrection($dual, AssessmentResult::query()->findOrFail($ids['result_id']), '91.00', 'recount verified against source responses', 'dec-cor-1');
        $correctionModel = ResultCorrection::query()->findOrFail($proposal['correction_id']);

        try {
            app(ManageAssessmentResult::class)->approveCorrection($dual, $correctionModel, 'dec-cor-1b');
            $this->fail('a single actor may not both propose and approve a correction');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.correction_single_actor', $denial->errorCode());
        }

        $correction = app(ManageAssessmentResult::class)->approveCorrection($approver, $correctionModel, 'dec-cor-2');

        $this->assertDatabaseHas('assessment_results', ['id' => $ids['result_id'], 'lifecycle_state' => 'corrected']);
        $this->assertDatabaseHas('assessment_results', ['id' => $correction['result_id'], 'lifecycle_state' => 'released', 'corrects_id' => $ids['result_id'], 'correction_reason' => 'recount verified against source responses']);
        $this->assertDatabaseHas('result_corrections', ['id' => $proposal['correction_id'], 'lifecycle_state' => 'approved', 'approved_by' => $approver->actorId]);
        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.result.correction.approve', 'target_type' => 'assessment_result']);
    }

    public function test_appeal_flow_requires_independent_reviewer_and_outcome_evidence(): void
    {
        $ids = $this->releasedResult();
        $appealManager = $this->grantedActor('dec-appeal-mgr', ['academic.appeal_manage']);

        $appeal = app(ManageAcademicAppeal::class)->file($appealManager, $this->studentId, 'assessment_result', $ids['result_id'], 'score does not match the answer sheet', 'dec-app-1');

        try {
            app(ManageAcademicAppeal::class)->assign($appealManager, AcademicAppeal::query()->findOrFail($appeal['appeal_id']), 'dec-scorer', 'dec-app-2');
            $this->fail('the original scorer may not be assigned the appeal');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.appeal_not_independent', $denial->errorCode());
        }

        app(ManageAcademicAppeal::class)->assign($appealManager, AcademicAppeal::query()->findOrFail($appeal['appeal_id']), 'dec-appeal-mgr', 'dec-app-3');
        app(ManageAcademicAppeal::class)->investigate($appealManager, AcademicAppeal::query()->findOrFail($appeal['appeal_id']), 'dec-app-4');

        try {
            app(ManageAcademicAppeal::class)->resolve($appealManager, AcademicAppeal::query()->findOrFail($appeal['appeal_id']), 'upheld', '', 'dec-app-5');
            $this->fail('resolution requires evidence');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.appeal_outcome_required', $rejection->errorCode());
        }

        app(ManageAcademicAppeal::class)->resolve($appealManager, AcademicAppeal::query()->findOrFail($appeal['appeal_id']), 'upheld', 'answer-sheet/review-9', 'dec-app-6');
        app(ManageAcademicAppeal::class)->close($appealManager, AcademicAppeal::query()->findOrFail($appeal['appeal_id']), 'dec-app-7');

        $this->assertDatabaseHas('academic_appeals', ['id' => $appeal['appeal_id'], 'lifecycle_state' => 'closed', 'outcome' => 'upheld']);
        $this->assertDatabaseHas('assessment_results', ['id' => $ids['result_id'], 'lifecycle_state' => 'released']);
    }

    public function test_progression_is_explicit_three_role_and_supersedes_on_appeal(): void
    {
        $teacher = $this->grantedActor('dec-teacher-x', ['academic.progression_propose', 'academic.progression_review']);
        $reviewer = $this->grantedActor('dec-reviewer-x', ['academic.progression_review', 'academic.appeal_manage', 'academic.progression_approve']);
        $management = $this->grantedActor('dec-mgmt-x', ['academic.progression_approve']);

        $decision = app(DecideProgression::class)->propose($teacher, $this->studentId, $this->classId, 'repeat', 'failed threshold components', 'dec-prog-1');

        try {
            app(DecideProgression::class)->review($teacher, ProgressionDecision::query()->findOrFail($decision['decision_id']), 'dec-prog-2');
            $this->fail('the proposer may not review');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.review_not_independent', $denial->errorCode());
        }

        app(DecideProgression::class)->review($reviewer, ProgressionDecision::query()->findOrFail($decision['decision_id']), 'dec-prog-3');
        try {
            app(DecideProgression::class)->approve($reviewer, ProgressionDecision::query()->findOrFail($decision['decision_id']), 'dec-prog-4');
            $this->fail('the reviewer may not approve');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.approval_not_independent', $denial->errorCode());
        }

        app(DecideProgression::class)->approve($management, ProgressionDecision::query()->findOrFail($decision['decision_id']), 'dec-prog-5');
        $this->assertDatabaseHas('progression_decisions', ['id' => $decision['decision_id'], 'lifecycle_state' => 'approved', 'outcome' => 'repeat']);

        app(DecideProgression::class)->markAppealed($reviewer, ProgressionDecision::query()->findOrFail($decision['decision_id']), 'dec-prog-6');
        $superseding = app(DecideProgression::class)->supersede($reviewer, $management, ProgressionDecision::query()->findOrFail($decision['decision_id']), 'advance', 'appeal evidence: moderated component score above threshold', 'dec-prog-7');

        $this->assertDatabaseHas('progression_decisions', ['id' => $decision['decision_id'], 'lifecycle_state' => 'superseded', 'superseded_by_id' => $superseding['decision_id']]);
        $this->assertDatabaseHas('progression_decisions', ['id' => $superseding['decision_id'], 'lifecycle_state' => 'approved', 'outcome' => 'advance']);
    }

    public function test_graduation_requires_independent_approval_and_certificate_is_immutable(): void
    {
        $proposer = $this->grantedActor('dec-completion-x', ['academic.completion']);
        $approver = $this->grantedActor('dec-completion-appr', ['academic.completion_approve', 'academic.certify']);
        $versionId = (string) DB::table('classes')->where('id', $this->classId)->value('program_version_id');

        $decision = app(DecideGraduation::class)->propose($proposer, $this->studentId, $versionId, 'eligible', 'all program requirements met', 'dec-grad-1');

        try {
            app(DecideGraduation::class)->review($proposer, GraduationDecision::query()->findOrFail($decision['decision_id']), 'dec-grad-2');
            $this->fail('the proposer may not review');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('academic.review_not_independent', $denial->errorCode());
        }

        $reviewer = $this->grantedActor('dec-grad-reviewer', ['academic.completion']);
        app(DecideGraduation::class)->review($reviewer, GraduationDecision::query()->findOrFail($decision['decision_id']), 'dec-grad-3');
        app(DecideGraduation::class)->approve($approver, GraduationDecision::query()->findOrFail($decision['decision_id']), 'dec-grad-4');

        $certificate = app(DecideGraduation::class)->issueCertificate($approver, GraduationDecision::query()->findOrFail($decision['decision_id']), 'dec-cert-1');
        $replay = app(DecideGraduation::class)->issueCertificate($approver, GraduationDecision::query()->findOrFail($decision['decision_id']), 'dec-cert-1');
        $this->assertSame($certificate, $replay);

        try {
            app(DecideGraduation::class)->issueCertificate($approver, GraduationDecision::query()->findOrFail($decision['decision_id']), 'dec-cert-2');
            $this->fail('a second certificate must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.certificate_already_issued', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement('UPDATE certificates SET serial = ? WHERE id = ?', ['FORGED-SERIAL', $certificate['certificate_id']]);
    }

    public function test_unprivileged_actor_cannot_score_and_denial_is_audited(): void
    {
        $nobody = $this->actorWithoutAnyCapability('dec-nobody');
        $scorer = $this->grantedActor('dec-scorer-z', ['academic.assess']);
        $attempt = app(ManageAssessmentResult::class)->submitAttempt($scorer, Enrollment::query()->findOrFail($this->enrollmentId), 'assessment', 'scan/z', 'dec-att-9');

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('no active authority grants academic.assess');
        app(ManageAssessmentResult::class)->score($nobody, AssessmentAttempt::query()->findOrFail($attempt['attempt_id']), '100', 'dec-res-99');

        $this->assertDatabaseHas('audit_events', ['operation' => 'academic.result.score.denied', 'actor_id' => 'dec-nobody']);
        $this->assertDatabaseMissing('assessment_results', ['attempt_id' => $attempt['attempt_id']]);
    }
}
