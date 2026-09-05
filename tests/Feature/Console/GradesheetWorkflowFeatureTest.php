<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Domain\TranscriptComposer;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AssessmentResult;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Program;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Students\Models\Student;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * Gradesheets: the per-class compilation (roster × attempts × live result
 * × correction lineage) is exercised over the real HTTP surface. An
 * assigned teacher with zero capabilities opens her class by identity; a
 * stranger is denied with the governed error (and the denial is audited);
 * the chain and staged corrections surface per seat; official lines stay
 * identical to the transcript's released truth.
 */
final class GradesheetWorkflowFeatureTest extends TestCase
{
    use BuildsActors;

    private string $classId;

    private string $programVersionId;

    private string $studentId;

    private string $enrollmentId;

    protected function setUp(): void
    {
        parent::setUp();

        $officer = $this->academicOfficer();
        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'IELTS Preparation', 'gs-prog');
        $version = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'boundary rules', 'gs-ver');
        $this->programVersionId = $version['version_id'];
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Fall 2026', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'gs-period');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'gs-period-pub');

        $class = app(MaintainClass::class)->defineClass($officer, $this->programVersionId, $period['period_id'], 2, 'gs-class');
        $this->classId = $class['class_id'];
        $this->personWithAuthority('gs-teacher-1', []);
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), 'gs-teacher-1', new CarbonImmutable('2026-09-01'), null, 'gs-ta');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'gs-cls-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'gs-cls-act');

        $this->studentId = $this->newStudent();
        $this->enrollmentId = app(MaintainEnrollment::class)->request($this->enrollmentClerk('gs-clerk-1'), $this->studentId, $this->classId, 'gs-enr-1')['enrollment_id'];
        app(MaintainEnrollment::class)->activate($this->academicOfficer('gs-off-2'), Enrollment::query()->findOrFail($this->enrollmentId), 'gs-enr-2');
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('gs-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'gs-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    private function newStudent(): string
    {
        $personId = 'gs-stu-1';
        $this->personWithAuthority($personId, []);

        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('gs-clerk-2'), $personId, 'IELTS Preparation', 'gs-reg-1');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);

        $initiated = app(DecideAdmission::class)->initiate(
            $this->admissionsClerk('gs-clerk-3'), $applicant, true, 'meets entry policy', 'interview-notes/gs', 'gs-deci-1',
        );
        $decision = AdmissionDecision::query()->findOrFail($initiated['decision_id']);
        app(DecideAdmission::class)->review($this->admissionsReviewer('gs-rev-1'), $decision, 'gs-decr-1');
        app(DecideAdmission::class)->approve($this->admissionsApprover('gs-adv-1'), $decision, 'gs-deca-1');

        $converted = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('gs-adv-2'), $applicant, 'gs-conv-1');

        return $converted['student_id'];
    }

    private function prefix(): string
    {
        return DB::connection()->getTablePrefix();
    }

    public function test_teacher_opens_own_class_by_identity_and_stranger_is_denied(): void
    {
        // The teacher holds NO capabilities: identity on the open
        // assignment is the whole credential for reading.
        $this->makeEmployee('gs-teacher-1', [], 'class-teacher');
        $this->makeEmployee('gs-stranger-1', [], 'stranger');

        $studentCode = Student::query()->findOrFail($this->studentId)->student_code;

        $this->signIn('class-teacher');
        $this->get('/academic')->assertOk()->assertSee('Open gradesheet');
        $this->get('/academic/gradesheets/'.$this->classId)
            ->assertOk()
            ->assertSee('Class gradesheet')
            ->assertSee($studentCode);
        $this->signOut();

        // A stranger sees no openable classes and is refused the page with
        // the governed error; the denial is audited.
        $this->signIn('stranger');
        $this->get('/academic')->assertOk()->assertSee('No classes are open to you');
        $this->get('/academic/gradesheets/'.$this->classId)
            ->assertRedirect('/')
            ->assertSessionHas('error_code', 'academic.gradesheet_denied');
        $this->assertDatabaseHas($this->prefix().'audit_events', [
            'actor_id' => 'gs-stranger-1',
            'operation' => 'academic.gradesheet.view.denied',
            'target_type' => 'class',
            'target_id' => $this->classId,
        ]);
        $this->signOut();
    }

    public function test_viewer_rule_does_not_grant_mutation_authority(): void
    {
        $this->makeEmployee('gs-teacher-1', [], 'class-teacher');

        $this->signIn('class-teacher');
        $this->post('/academic/attempts', [
            'enrollment_id' => $this->enrollmentId,
            'kind' => 'assessment',
            'evidence_ref' => 'papers/gs-stu-1/assess-1',
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.assess_denied');
        $this->assertSame(0, DB::table($this->prefix().'assessment_attempts')->where('enrollment_id', $this->enrollmentId)->count());
        $this->signOut();
    }

    public function test_gradesheet_tracks_chain_correction_lineage_and_matches_transcript_truth(): void
    {
        $this->makeEmployee('gs-assessor-1', ['academic.assess'], 'assessor');
        $this->makeEmployee('gs-moderator-1', ['academic.moderate'], 'moderator');
        $this->makeEmployee('gs-approver-1', ['academic.approve_result'], 'result-approver');
        $this->makeEmployee('gs-releaser-1', ['academic.release'], 'releaser');
        $this->makeEmployee('gs-teacher-1', [], 'class-teacher');

        $this->signIn('assessor');
        $this->post('/academic/attempts', [
            'enrollment_id' => $this->enrollmentId,
            'kind' => 'assessment',
            'evidence_ref' => 'papers/gs-stu-1/assess-1',
        ])->assertRedirect('/academic');
        $attemptId = DB::table($this->prefix().'assessment_attempts')->where('enrollment_id', $this->enrollmentId)->value('id');
        $this->post('/academic/attempts/'.$attemptId.'/score', ['score' => '72.50'])->assertRedirect('/academic');
        $resultId = DB::table($this->prefix().'assessment_results')->where('attempt_id', $attemptId)->value('id');

        $this->signOut();
        $this->signIn('moderator');
        $this->post('/academic/results/'.$resultId.'/moderate')->assertRedirect('/academic');
        $this->signOut();
        $this->signIn('result-approver');
        $this->post('/academic/results/'.$resultId.'/approve')->assertRedirect('/academic');
        $this->signOut();
        $this->signIn('releaser');
        $this->post('/academic/results/'.$resultId.'/release')->assertRedirect('/academic');

        // The teacher's page shows the in-flight truth: scored value and
        // the official line once released.
        $this->signOut();
        $this->signIn('class-teacher');
        $this->get('/academic/gradesheets/'.$this->classId)
            ->assertOk()
            ->assertSee('72.50')
            ->assertSee('official line');

        // Staged correction in two sessions, then the lineage is visible:
        // the original score stands corrected beside the new official one.
        $this->signOut();
        $this->signIn('moderator');
        $this->post('/academic/results/'.$resultId.'/corrections', [
            'score' => '78.00',
            'reason' => 'section three was mis-marked; verified against the answer sheet',
        ])->assertRedirect('/academic');
        $correctionId = DB::table($this->prefix().'result_corrections')->where('result_id', $resultId)->value('id');
        $this->signOut();
        $this->signIn('result-approver');
        $this->post('/academic/corrections/'.$correctionId.'/approve')->assertRedirect('/academic');

        $this->signOut();
        $this->signIn('class-teacher');
        $this->get('/academic/gradesheets/'.$this->classId)
            ->assertOk()
            ->assertSee('72.50')
            ->assertSee('corrected')
            ->assertSee('78.00')
            ->assertSee('official line');

        // Official lines on the gradesheet equal the transcript's released
        // truth for the same student: one source of truth, two surfaces.
        /** @var AssessmentResult $official */
        $official = AssessmentResult::query()->where('attempt_id', $attemptId)->where('lifecycle_state', 'released')->firstOrFail();
        $this->assertSame('78.00', (string) $official->score);

        $transcript = app(TranscriptComposer::class)->compose($this->studentId, $this->programVersionId);
        $transcriptRows = array_values(array_filter(
            $transcript['results'],
            fn (array $row): bool => $row['enrollment_id'] === $this->enrollmentId
        ));
        $this->assertCount(1, $transcriptRows);
        $this->assertSame((string) $official->id, $transcriptRows[0]['result_id']);
        $this->assertSame('78.00', $transcriptRows[0]['score']);
    }

    public function test_oversight_opens_any_class_without_teaching_it(): void
    {
        $this->makeEmployee('gs-officer-9', ['academic.structure'], 'officer');

        $this->signIn('officer');
        $this->get('/academic')->assertOk()->assertSee('Open gradesheet');
        $this->get('/academic/gradesheets/'.$this->classId)->assertOk()->assertSee('Class gradesheet');
        $this->signOut();
    }
}
