<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Academic\Commands\DecideProgression;
use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\ManageAcademicAppeal;
use App\Modules\Academic\Commands\ManageAssessmentResult;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\ProgressionDecision;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * PHASE_3 increment C (part three): the academic appeal chain —
 * file → assign → investigate → resolve / reject / escalate → close —
 * is exercised over the real HTTP surface with distinct sessions per
 * signature. The original decision-maker of the appealed subject (the
 * scorer of a released result, the approver of a progression decision)
 * can never be assigned the review; only the assigned reviewer can
 * investigate and decide; and a decided appeal is closed only after its
 * outcome and evidence are on record. Filing is idempotent per key.
 */
final class AcademicAppealWorkflowFeatureTest extends TestCase
{
    use BuildsActors;

    private string $classId;

    private string $studentId;

    private string $enrollmentId;

    private string $resultId;

    private string $progressionId;

    protected function setUp(): void
    {
        parent::setUp();

        $officer = $this->academicOfficer();
        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'IELTS Preparation', 'afw-prog');
        $version = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'boundary rules', 'afw-ver');
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Fall 2026', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'afw-period');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'afw-period-pub');

        $class = app(MaintainClass::class)->defineClass($officer, $version['version_id'], $period['period_id'], 2, 'afw-class');
        $this->classId = $class['class_id'];
        $this->personWithAuthority('afw-teacher-1', []);
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), 'afw-teacher-1', new CarbonImmutable('2026-09-01'), null, 'afw-ta');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'afw-cls-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'afw-cls-act');

        $this->studentId = $this->newStudent();
        $this->enrollmentId = app(MaintainEnrollment::class)->request($this->enrollmentClerk('afw-clerk-1'), $this->studentId, $this->classId, 'afw-enr-1')['enrollment_id'];
        app(MaintainEnrollment::class)->activate($this->academicOfficer('afw-off-2'), Enrollment::query()->findOrFail($this->enrollmentId), 'afw-enr-2');

        // A released result — its scorer is the original decision-maker the
        // appeal independence rule protects against.
        $scorer = $this->grantedActor('afw-scorer-1', ['academic.assess']);
        $moderator = $this->grantedActor('afw-moderator-1', ['academic.moderate']);
        $approver = $this->grantedActor('afw-approver-1', ['academic.approve_result']);
        $releaser = $this->grantedActor('afw-releaser-1', ['academic.release']);
        $assessment = app(ManageAssessmentResult::class);
        $attempt = $assessment->submitAttempt($scorer, Enrollment::query()->findOrFail($this->enrollmentId), 'assessment', 'papers/afw-stu-1/assess-1', 'afw-attempt-1');
        $result = $assessment->score($scorer, AssessmentAttempt::query()->findOrFail($attempt['attempt_id']), '72.50', 'afw-score-1');
        $assessment->moderate($moderator, AssessmentResult::query()->findOrFail($result['result_id']), 'afw-moderate-1');
        $assessment->approve($approver, AssessmentResult::query()->findOrFail($result['result_id']), 'afw-approve-1');
        $assessment->release($releaser, AssessmentResult::query()->findOrFail($result['result_id']), 'afw-release-1');
        $this->resultId = $result['result_id'];

        // An approved progression decision — its approver is the original
        // decision-maker for appeals against progression decisions.
        $proposer = $this->grantedActor('afw-prog-1', ['academic.progression_propose']);
        $progressionReviewer = $this->grantedActor('afw-prog-2', ['academic.progression_review']);
        $progressionApprover = $this->grantedActor('afw-prog-3', ['academic.progression_approve']);
        $progression = app(DecideProgression::class);
        $decision = $progression->propose($proposer, $this->studentId, $this->classId, 'advance', 'meets the boundary rules', 'afw-prog-prop-1');
        $progression->review($progressionReviewer, ProgressionDecision::query()->findOrFail($decision['decision_id']), 'afw-prog-rev-1');
        $progression->approve($progressionApprover, ProgressionDecision::query()->findOrFail($decision['decision_id']), 'afw-prog-app-1');
        $this->progressionId = $decision['decision_id'];
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('afw-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'afw-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    private function newStudent(): string
    {
        $personId = 'afw-stu-1';
        $this->personWithAuthority($personId, []);

        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('afw-clerk-2'), $personId, 'IELTS Preparation', 'afw-reg-1');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);

        $initiated = app(DecideAdmission::class)->initiate(
            $this->admissionsClerk('afw-clerk-3'), $applicant, true, 'meets entry policy', 'interview-notes/afw', 'afw-deci-1',
        );
        $decision = AdmissionDecision::query()->findOrFail($initiated['decision_id']);
        app(DecideAdmission::class)->review($this->admissionsReviewer('afw-rev-1'), $decision, 'afw-decr-1');
        app(DecideAdmission::class)->approve($this->admissionsApprover('afw-adv-1'), $decision, 'afw-deca-1');

        $converted = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('afw-adv-2'), $applicant, 'afw-conv-1');

        return $converted['student_id'];
    }

    public function test_result_appeal_chain_with_independence_over_the_console(): void
    {
        $this->makeEmployee('afw-filer-1', ['academic.appeal_manage'], 'filer');
        $this->makeEmployee('afw-reviewer-1', ['academic.appeal_manage'], 'appeal-reviewer');
        $this->makeEmployee('afw-moderator-1', ['academic.moderate'], 'moderator');
        $this->makeEmployee('afw-stranger-1', ['academic.appeal_manage'], 'stranger');
        $this->makeEmployee('afw-closer-1', ['academic.appeal_manage'], 'closer');
        $this->makeEmployee('afw-plain-1', [], 'plain');

        $appeals = DB::connection()->getTablePrefix().'academic_appeals';

        // An employee without the capability cannot file.
        $this->signIn('plain');
        $this->post('/academic/appeals', [
            'student_id' => $this->studentId,
            'subject_type' => 'assessment_result',
            'subject_id' => $this->resultId,
            'reason' => 'section two was mis-marked',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.appeal_denied');
        $this->assertSame(0, DB::table($appeals)->count());

        // The filer opens the appeal in her own session; the same idempotency
        // key and payload replay to the same row instead of a duplicate.
        $this->signOut();
        $this->signIn('filer');
        $file = [
            'student_id' => $this->studentId,
            'subject_type' => 'assessment_result',
            'subject_id' => $this->resultId,
            'reason' => 'section two was mis-marked',
            'idempotency_key' => 'afw-file-key-1',
        ];
        $this->post('/academic/appeals', $file)->assertRedirect('/academic');
        $this->assertSame(1, DB::table($appeals)->count());
        $appealId = DB::table($appeals)->value('id');
        $this->assertDatabaseHas($appeals, ['id' => $appealId, 'lifecycle_state' => 'open', 'subject_type' => 'assessment_result']);

        $this->post('/academic/appeals', $file)->assertRedirect('/academic');
        $this->assertSame(1, DB::table($appeals)->count());
        $this->assertSame($appealId, DB::table($appeals)->value('id'));

        // The original scorer of the appealed result cannot be assigned the
        // review: the capability is held, the independence rule blocks.
        $this->post('/academic/appeals/'.$appealId.'/assign', [
            'reviewer_person_id' => 'afw-scorer-1',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.appeal_not_independent');
        $this->assertDatabaseHas($appeals, ['id' => $appealId, 'lifecycle_state' => 'open']);

        // Assignment of an independent reviewer, then investigation by exactly
        // that reviewer — nobody else can act on the appeal.
        $this->post('/academic/appeals/'.$appealId.'/assign', ['reviewer_person_id' => 'afw-reviewer-1'])->assertRedirect('/academic');
        $this->assertDatabaseHas($appeals, ['id' => $appealId, 'lifecycle_state' => 'assigned', 'assigned_reviewer_id' => 'afw-reviewer-1']);

        $this->signOut();
        $this->signIn('stranger');
        $this->post('/academic/appeals/'.$appealId.'/investigate', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.appeal_wrong_reviewer');

        $this->signOut();
        $this->signIn('appeal-reviewer');
        $this->post('/academic/appeals/'.$appealId.'/investigate')->assertRedirect('/academic');
        $this->assertDatabaseHas($appeals, ['id' => $appealId, 'lifecycle_state' => 'investigating']);

        // No silent closure: an investigating appeal cannot jump to closed.
        $this->post('/academic/appeals/'.$appealId.'/close', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.appeal_transition_forbidden');

        // And a stranger cannot decide the appeal even with the capability.
        $this->signOut();
        $this->signIn('stranger');
        $this->post('/academic/appeals/'.$appealId.'/resolve', [
            'outcome' => 'appeal upheld',
            'outcome_evidence' => 'answer-sheet/afw-stu-1',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.appeal_wrong_reviewer');

        // Resolving before remediation is recorded is refused: resolved
        // means upheld AND redressed, never a bare verdict.
        $this->signOut();
        $this->signIn('appeal-reviewer');
        $this->post('/academic/appeals/'.$appealId.'/resolve', [
            'outcome' => 'appeal upheld',
            'outcome_evidence' => 'answer-sheet/afw-stu-1',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.appeal_subject_untouched');

        // Remediation is ordered through the owning result workflow, by its
        // own authority — then the reviewer resolves and a distinct employee
        // closes the record.
        $this->signOut();
        $this->signIn('moderator');
        $this->post('/academic/results/'.$this->resultId.'/mark-appealed')->assertRedirect('/academic');
        $this->assertDatabaseHas('assessment_results', ['id' => $this->resultId, 'lifecycle_state' => 'appealed']);

        $this->signOut();
        $this->signIn('appeal-reviewer');
        $this->post('/academic/appeals/'.$appealId.'/resolve', [
            'outcome' => 'appeal upheld',
            'outcome_evidence' => 'answer-sheet/afw-stu-1',
        ])->assertRedirect('/academic');
        $this->assertDatabaseHas($appeals, ['id' => $appealId, 'lifecycle_state' => 'resolved', 'decided_by' => 'afw-reviewer-1']);

        $this->signOut();
        $this->signIn('closer');
        $this->post('/academic/appeals/'.$appealId.'/close')->assertRedirect('/academic');
        $this->assertDatabaseHas($appeals, ['id' => $appealId, 'lifecycle_state' => 'closed', 'outcome' => 'appeal upheld']);
    }

    public function test_progression_appeal_escalates_and_reassigns_before_rejection(): void
    {
        $this->makeEmployee('afw2-filer-1', ['academic.appeal_manage'], 'filer-2');
        $this->makeEmployee('afw2-reviewer-1', ['academic.appeal_manage'], 'appeal-reviewer-2');
        $this->makeEmployee('afw2-reviewer-2', ['academic.appeal_manage'], 'appeal-reviewer-3');
        $this->makeEmployee('afw2-closer-1', ['academic.appeal_manage'], 'closer-2');

        $appeals = DB::connection()->getTablePrefix().'academic_appeals';

        $this->signIn('filer-2');
        $this->post('/academic/appeals', [
            'student_id' => $this->studentId,
            'subject_type' => 'progression_decision',
            'subject_id' => $this->progressionId,
            'reason' => 'boundary evidence was incomplete at approval time',
        ])->assertRedirect('/academic');
        $appealId = DB::table($appeals)->value('id');
        $this->assertDatabaseHas($appeals, ['id' => $appealId, 'lifecycle_state' => 'open', 'subject_type' => 'progression_decision']);

        // The approver of the appealed progression decision is its original
        // decision-maker and cannot be assigned the review.
        $this->post('/academic/appeals/'.$appealId.'/assign', [
            'reviewer_person_id' => 'afw-prog-3',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.appeal_not_independent');

        $this->post('/academic/appeals/'.$appealId.'/assign', ['reviewer_person_id' => 'afw2-reviewer-1'])->assertRedirect('/academic');

        $this->signOut();
        $this->signIn('appeal-reviewer-2');
        $this->post('/academic/appeals/'.$appealId.'/investigate')->assertRedirect('/academic');
        $this->post('/academic/appeals/'.$appealId.'/escalate')->assertRedirect('/academic');
        $this->assertDatabaseHas($appeals, ['id' => $appealId, 'lifecycle_state' => 'escalated']);

        // Escalation returns the appeal to re-assignment with a fresh reviewer.
        $this->post('/academic/appeals/'.$appealId.'/assign', ['reviewer_person_id' => 'afw2-reviewer-2'])->assertRedirect('/academic');
        $this->assertDatabaseHas($appeals, ['id' => $appealId, 'lifecycle_state' => 'assigned', 'assigned_reviewer_id' => 'afw2-reviewer-2']);

        // The displaced reviewer can no longer act on the appeal.
        $this->post('/academic/appeals/'.$appealId.'/investigate', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.appeal_wrong_reviewer');

        $this->signOut();
        $this->signIn('appeal-reviewer-3');
        $this->post('/academic/appeals/'.$appealId.'/investigate')->assertRedirect('/academic');
        $this->post('/academic/appeals/'.$appealId.'/reject', [
            'outcome' => 'appeal not upheld',
            'outcome_evidence' => 'boundary-rules/afw',
        ])->assertRedirect('/academic');
        $this->assertDatabaseHas($appeals, ['id' => $appealId, 'lifecycle_state' => 'rejected', 'decided_by' => 'afw2-reviewer-2']);

        $this->signOut();
        $this->signIn('closer-2');
        $this->post('/academic/appeals/'.$appealId.'/close')->assertRedirect('/academic');
        $this->assertDatabaseHas($appeals, ['id' => $appealId, 'lifecycle_state' => 'closed', 'outcome' => 'appeal not upheld']);
    }

    public function test_the_file_rejection_rules_of_the_appeal_command(): void
    {
        $manager = $this->grantedActor('afw-mgr-3', ['academic.appeal_manage']);
        $domain = app(ManageAcademicAppeal::class);

        try {
            $domain->file($manager, $this->studentId, 'guardian_relationship', $this->resultId, 'contested', 'afw-dom-1');
            $this->fail('expected the unknown subject type to be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.appeal_subject_unknown', $rejection->errorCode());
        }

        try {
            $domain->file($manager, $this->studentId, 'assessment_result', $this->resultId, '', 'afw-dom-2');
            $this->fail('expected the empty reason to be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.appeal_reason', $rejection->errorCode());
        }

        $this->assertSame(0, DB::table(DB::connection()->getTablePrefix().'academic_appeals')->count());
    }
}
