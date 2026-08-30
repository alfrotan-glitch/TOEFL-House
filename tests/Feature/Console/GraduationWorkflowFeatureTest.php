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
 * PHASE_3 increment C (part two): the graduation decision chain —
 * propose (with the requirements basis) → review → approve/reject →
 * certificate from an approved eligible decision — is exercised over the
 * real HTTP surface with distinct sessions per signature. The certificate
 * serial is unique and issuance is one-shot; a not_eligible decision can
 * never produce a certificate.
 */
final class GraduationWorkflowFeatureTest extends TestCase
{
    use BuildsActors;

    private string $classId;

    private string $studentId;

    private string $versionId;

    private string $secondVersionId;

    protected function setUp(): void
    {
        parent::setUp();

        $officer = $this->academicOfficer();
        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'IELTS Preparation', 'gwf-prog');
        $version = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'boundary rules', 'gwf-ver');
        $this->versionId = $version['version_id'];
        $second = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'updated boundary rules', 'gwf-ver2');
        $this->secondVersionId = $second['version_id'];
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Fall 2026', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'gwf-period');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'gwf-period-pub');

        $class = app(MaintainClass::class)->defineClass($officer, $this->versionId, $period['period_id'], 2, 'gwf-class');
        $this->classId = $class['class_id'];
        $this->personWithAuthority('gwf-teacher-1', []);
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), 'gwf-teacher-1', new CarbonImmutable('2026-09-01'), null, 'gwf-ta');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'gwf-cls-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'gwf-cls-act');

        $this->studentId = $this->newStudent();
        $enrollment = app(MaintainEnrollment::class)->request($this->enrollmentClerk('gwf-clerk-1'), $this->studentId, $this->classId, 'gwf-enr-1');
        app(MaintainEnrollment::class)->activate($this->academicOfficer('gwf-off-2'), Enrollment::query()->findOrFail($enrollment['enrollment_id']), 'gwf-enr-2');
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('gwf-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'gwf-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    private function newStudent(): string
    {
        $personId = 'gwf-stu-1';
        $this->personWithAuthority($personId, []);

        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('gwf-clerk-2'), $personId, 'IELTS Preparation', 'gwf-reg-1');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);

        $initiated = app(DecideAdmission::class)->initiate(
            $this->admissionsClerk('gwf-clerk-3'), $applicant, true, 'meets entry policy', 'interview-notes/gwf', 'gwf-deci-1',
        );
        $decision = AdmissionDecision::query()->findOrFail($initiated['decision_id']);
        app(DecideAdmission::class)->review($this->admissionsReviewer('gwf-rev-1'), $decision, 'gwf-decr-1');
        app(DecideAdmission::class)->approve($this->admissionsApprover('gwf-adv-1'), $decision, 'gwf-deca-1');

        $converted = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('gwf-adv-2'), $applicant, 'gwf-conv-1');

        return $converted['student_id'];
    }

    public function test_graduation_chain_end_to_end_through_the_console(): void
    {
        $this->makeEmployee('gwf-dual-1', ['academic.completion', 'academic.completion_approve'], 'proposer');
        $this->makeEmployee('gwf-reviewer-1', ['academic.completion'], 'graduation-reviewer');
        $this->makeEmployee('gwf-approver-1', ['academic.completion_approve'], 'graduation-approver');
        $this->makeEmployee('gwf-cert-1', ['academic.certify'], 'certifier');

        // Propose — the proposer's own session.
        $this->signIn('proposer');
        $this->post('/academic/graduations', [
            'student_id' => $this->studentId,
            'program_version_id' => $this->versionId,
            'outcome' => 'eligible',
            'basis' => 'all requirements met per the published version',
        ])->assertRedirect('/academic');
        $decisionId = DB::table(DB::connection()->getTablePrefix().'graduation_decisions')->where('student_id', $this->studentId)->value('id');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'graduation_decisions', [
            'id' => $decisionId, 'outcome' => 'eligible', 'lifecycle_state' => 'proposed',
        ]);

        // The proposer cannot review her own proposal (capability held, independence blocks).
        $this->post('/academic/graduations/'.$decisionId.'/review', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.review_not_independent');

        // Review by a second employee; the proposer's approval attempt is
        // refused — the approver must differ from both earlier signers.
        $this->signOut();
        $this->signIn('graduation-reviewer');
        $this->post('/academic/graduations/'.$decisionId.'/review')->assertRedirect('/academic');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'graduation_decisions', ['id' => $decisionId, 'lifecycle_state' => 'reviewed']);

        $this->signOut();
        $this->signIn('proposer');
        $this->post('/academic/graduations/'.$decisionId.'/approve', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.approval_not_independent');

        // Approval by a third employee; certificate by a fourth.
        $this->signOut();
        $this->signIn('graduation-approver');
        $this->post('/academic/graduations/'.$decisionId.'/approve')->assertRedirect('/academic');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'graduation_decisions', ['id' => $decisionId, 'lifecycle_state' => 'approved']);

        $this->signOut();
        $this->signIn('certifier');
        $this->post('/academic/graduations/'.$decisionId.'/certificate')->assertRedirect('/academic');
        $serial = DB::table(DB::connection()->getTablePrefix().'certificates')->where('graduation_decision_id', $decisionId)->value('serial');
        $this->assertNotNull($serial);
        $this->assertSame(1, DB::table(DB::connection()->getTablePrefix().'certificates')->count());

        // Issuance is one-shot.
        $this->post('/academic/graduations/'.$decisionId.'/certificate', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.certificate_already_issued');
        $this->assertSame(1, DB::table(DB::connection()->getTablePrefix().'certificates')->count());
    }

    public function test_a_not_eligible_decision_can_never_produce_a_certificate(): void
    {
        $this->makeEmployee('gwf-dual-2', ['academic.completion', 'academic.completion_approve'], 'proposer-2');
        $this->makeEmployee('gwf-reviewer-2', ['academic.completion'], 'graduation-reviewer-2');
        $this->makeEmployee('gwf-approver-2', ['academic.completion_approve'], 'graduation-approver-2');
        $this->makeEmployee('gwf-cert-2', ['academic.certify'], 'certifier-2');

        $this->signIn('proposer-2');
        $this->post('/academic/graduations', [
            'student_id' => $this->studentId,
            'program_version_id' => $this->secondVersionId,
            'outcome' => 'not_eligible',
            'basis' => 'two required requirements unmet',
        ])->assertRedirect('/academic');
        $decisionId = DB::table(DB::connection()->getTablePrefix().'graduation_decisions')->where('student_id', $this->studentId)->where('program_version_id', $this->secondVersionId)->value('id');

        $this->signOut();
        $this->signIn('graduation-reviewer-2');
        $this->post('/academic/graduations/'.$decisionId.'/review')->assertRedirect('/academic');
        $this->signOut();
        $this->signIn('graduation-approver-2');
        $this->post('/academic/graduations/'.$decisionId.'/approve')->assertRedirect('/academic');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'graduation_decisions', ['id' => $decisionId, 'lifecycle_state' => 'approved', 'outcome' => 'not_eligible']);

        $this->signOut();
        $this->signIn('certifier-2');
        $this->post('/academic/graduations/'.$decisionId.'/certificate', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.certificate_requires_approval');
        $this->assertSame(0, DB::table(DB::connection()->getTablePrefix().'certificates')->count());
    }
}
