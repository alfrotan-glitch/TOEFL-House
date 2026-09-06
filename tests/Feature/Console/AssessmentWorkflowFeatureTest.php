<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\ResultCorrection;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * PHASE_3 increment C (part one): the assessment evidence chain —
 * attempt → scored → moderated → approved → released — is exercised over
 * the real HTTP surface, including the staged score correction: the
 * moderator proposes a new score in her own session and a distinct
 * approver records it (the original result closes as corrected, the new
 * released result carries the corrects_id link). Each signature is one
 * session; every domain rejection surfaces with its error code.
 */
final class AssessmentWorkflowFeatureTest extends TestCase
{
    use BuildsActors;

    private string $classId;

    private string $studentId;

    private string $enrollmentId;

    protected function setUp(): void
    {
        parent::setUp();

        $officer = $this->academicOfficer();
        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'IELTS Preparation', 'awf-prog');
        $version = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'boundary rules', 'awf-ver');
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Fall 2026', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'awf-period');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'awf-period-pub');

        $class = app(MaintainClass::class)->defineClass($officer, $version['version_id'], $period['period_id'], 2, 'awf-class');
        $this->classId = $class['class_id'];
        $this->personWithAuthority('awf-teacher-1', []);
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), 'awf-teacher-1', new CarbonImmutable('2026-09-01'), null, 'awf-ta');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'awf-cls-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'awf-cls-act');

        $this->studentId = $this->newStudent();
        $this->enrollmentId = app(MaintainEnrollment::class)->request($this->enrollmentClerk('awf-clerk-1'), $this->studentId, $this->classId, 'awf-enr-1')['enrollment_id'];
        app(MaintainEnrollment::class)->activate($this->academicOfficer('awf-off-2'), Enrollment::query()->findOrFail($this->enrollmentId), 'awf-enr-2');
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('awf-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'awf-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    private function newStudent(): string
    {
        $personId = 'awf-stu-1';
        $this->personWithAuthority($personId, []);

        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('awf-clerk-2'), $personId, 'IELTS Preparation', 'awf-reg-1');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);

        $initiated = app(DecideAdmission::class)->initiate(
            $this->admissionsClerk('awf-clerk-3'), $applicant, true, 'meets entry policy', 'interview-notes/awf', 'awf-deci-1',
        );
        $decision = AdmissionDecision::query()->findOrFail($initiated['decision_id']);
        app(DecideAdmission::class)->review($this->admissionsReviewer('awf-rev-1'), $decision, 'awf-decr-1');
        app(DecideAdmission::class)->approve($this->admissionsApprover('awf-adv-1'), $decision, 'awf-deca-1');

        $converted = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('awf-adv-2'), $applicant, 'awf-conv-1');

        return $converted['student_id'];
    }

    public function test_assessment_chain_end_to_end_through_the_console(): void
    {
        $this->makeEmployee('awf-assessor-1', ['academic.assess', 'academic.moderate'], 'assessor');
        $this->makeEmployee('awf-moderator-1', ['academic.moderate'], 'moderator');
        $this->makeEmployee('awf-approver-1', ['academic.approve_result'], 'result-approver');
        $this->makeEmployee('awf-releaser-1', ['academic.release'], 'releaser');

        // 1. The assessor submits the attempt in her own session.
        $this->signIn('assessor');
        $this->post('/academic/attempts', [
            'enrollment_id' => $this->enrollmentId,
            'kind' => 'assessment',
            'evidence_ref' => 'papers/awf-stu-1/assess-1',
        ])->assertRedirect('/academic');
        $attemptId = DB::table(DB::connection()->getTablePrefix().'assessment_attempts')->where('enrollment_id', $this->enrollmentId)->value('id');
        $this->assertNotNull($attemptId);

        // 2. The assessor scores it.
        $this->post('/academic/attempts/'.$attemptId.'/score', ['score' => '72.50'])->assertRedirect('/academic');
        $resultId = DB::table(DB::connection()->getTablePrefix().'assessment_results')->where('attempt_id', $attemptId)->value('id');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'assessment_results', [
            'id' => $resultId, 'lifecycle_state' => 'scored',
        ]);

        // 3. The scorer cannot moderate her own score: the capability is
        //    held, so the independence rule — not authorization — blocks.
        $this->post('/academic/results/'.$resultId.'/moderate', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.review_not_independent');

        // 4. The moderator, the approver and the releaser sign in their own sessions.
        $this->signOut();
        $this->signIn('moderator');
        $this->post('/academic/results/'.$resultId.'/moderate')->assertRedirect('/academic');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'assessment_results', ['id' => $resultId, 'lifecycle_state' => 'moderated']);

        $this->signOut();
        $this->signIn('result-approver');
        $this->post('/academic/results/'.$resultId.'/approve')->assertRedirect('/academic');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'assessment_results', ['id' => $resultId, 'lifecycle_state' => 'approved']);

        $this->signOut();
        $this->signIn('releaser');
        $this->post('/academic/results/'.$resultId.'/release')->assertRedirect('/academic');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'assessment_results', ['id' => $resultId, 'lifecycle_state' => 'released']);

        // 5. The released result is corrected in two sessions: the moderator
        //    proposes, a distinct approver records.
        $this->signOut();
        $this->signIn('moderator');
        $this->post('/academic/results/'.$resultId.'/corrections', [
            'score' => '78.00',
            'reason' => 'section three was mis-marked; verified against the answer sheet',
        ])->assertRedirect('/academic');
        $correctionId = DB::table(DB::connection()->getTablePrefix().'result_corrections')->where('result_id', $resultId)->value('id');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'result_corrections', [
            'id' => $correctionId, 'lifecycle_state' => 'proposed',
        ]);

        // The proposer cannot approve her own correction.
        $this->post('/academic/corrections/'.$correctionId.'/approve', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.approve_result_denied');

        $this->signOut();
        $this->signIn('result-approver');
        $this->post('/academic/corrections/'.$correctionId.'/approve')->assertRedirect('/academic');

        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'assessment_results', ['id' => $resultId, 'lifecycle_state' => 'corrected']);
        $correctedId = DB::table(DB::connection()->getTablePrefix().'assessment_results')->where('corrects_id', $resultId)->value('id');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'assessment_results', [
            'id' => $correctedId, 'lifecycle_state' => 'released', 'corrects_id' => $resultId,
        ]);
        $this->assertSame(1, ResultCorrection::query()->where('lifecycle_state', 'approved')->count());
    }

    public function test_correction_proposal_rejects_a_single_actor_with_both_capabilities(): void
    {
        // A single employee holding both correction capabilities may still
        // only sign one stage: her self-approval is refused by the domain.
        $this->makeEmployee('awf-dual-2', ['academic.moderate', 'academic.approve_result'], 'lone-corrector');
        $this->makeEmployee('awf-assessor-2', ['academic.assess'], 'assessor-2');
        $this->makeEmployee('awf-approver-2', ['academic.approve_result'], 'result-approver-2');
        $this->makeEmployee('awf-releaser-2', ['academic.release'], 'releaser-2');

        $this->signIn('assessor-2');
        $this->post('/academic/attempts', [
            'enrollment_id' => $this->enrollmentId,
            'kind' => 'placement',
            'evidence_ref' => 'papers/awf-stu-1/placement-1',
        ])->assertRedirect('/academic');
        $attemptId = DB::table(DB::connection()->getTablePrefix().'assessment_attempts')->where('enrollment_id', $this->enrollmentId)->where('kind', 'placement')->value('id');
        $this->post('/academic/attempts/'.$attemptId.'/score', ['score' => '60.00'])->assertRedirect('/academic');
        $resultId = DB::table(DB::connection()->getTablePrefix().'assessment_results')->where('attempt_id', $attemptId)->value('id');

        $this->signOut();
        $this->signIn('lone-corrector');
        $this->post('/academic/results/'.$resultId.'/moderate')->assertRedirect('/academic');
        $this->signOut();
        $this->signIn('result-approver-2');
        $this->post('/academic/results/'.$resultId.'/approve')->assertRedirect('/academic');
        $this->signOut();
        $this->signIn('releaser-2');
        $this->post('/academic/results/'.$resultId.'/release')->assertRedirect('/academic');

        $this->signIn('lone-corrector');
        $this->post('/academic/results/'.$resultId.'/corrections', [
            'score' => '66.00',
            'reason' => 'arithmetic error on the marking sheet',
        ])->assertRedirect('/academic');
        $correctionId = DB::table(DB::connection()->getTablePrefix().'result_corrections')->where('result_id', $resultId)->value('id');

        $this->post('/academic/corrections/'.$correctionId.'/approve', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.correction_single_actor');

        $this->assertSame(1, ResultCorrection::query()->where('lifecycle_state', 'proposed')->count());
        $this->assertSame(0, DB::table(DB::connection()->getTablePrefix().'assessment_results')->where('corrects_id', $resultId)->count());
    }
}
