<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Models\Program;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Hr\Commands\MaintainContractVersion;
use App\Modules\Hr\Commands\MaintainEmployment;
use App\Modules\Hr\Models\ContractVersion;
use App\Modules\Hr\Models\Employment;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Students\Models\Student;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * PHASE_3 increment B: the remaining student/HR/identity workflows —
 * student status transitions, the leave lifecycle (request/decide/cancel),
 * guardian relationships (record/verify/revoke) and account deactivation —
 * exercised end-to-end over the real HTTP surface. One signature per
 * authenticated session; every domain rejection surfaces with its code.
 */
final class IncrementBWorkflowFeatureTest extends TestCase
{
    use BuildsActors;

    private string $studentId;

    private string $employmentId;

    private string $personId = 'incb-teacher-1';

    protected function setUp(): void
    {
        parent::setUp();

        // The student, built through the authoritative staged admissions pipeline.
        $officer = $this->academicOfficer();
        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'IELTS Preparation', 'incb-prog');
        app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'rules', 'incb-ver');
        $personId = 'incb-stu-1';
        $this->personWithAuthority($personId, []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('incb-clerk-1'), $personId, 'IELTS Preparation', 'incb-reg-1');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $initiated = app(DecideAdmission::class)->initiate($this->admissionsClerk('incb-clerk-2'), $applicant, true, 'meets entry policy', 'interview-notes/incb', 'incb-deci-1');
        $decision = AdmissionDecision::query()->findOrFail($initiated['decision_id']);
        app(DecideAdmission::class)->review($this->admissionsReviewer('incb-rev-1'), $decision, 'incb-decr-1');
        app(DecideAdmission::class)->approve($this->admissionsApprover('incb-adv-1'), $decision, 'incb-deca-1');
        $converted = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('incb-adv-2'), $applicant, 'incb-conv-1');
        $this->studentId = $converted['student_id'];

        // The employment, built through the authoritative HR pipeline.
        $this->personWithAuthority($this->personId, []);
        $manager = $this->grantedActor('incb-manager-1', ['hr.employ', 'hr.terminate', 'access.assign_position']);
        $employment = app(MaintainEmployment::class)->employ($manager, $this->personId, 'incb-emp-1');
        $this->employmentId = $employment['employment_id'];
        $fm = $this->grantedActor('incb-fm-1', ['hr.contract.prepare']);
        $commands = app(MaintainContractVersion::class);
        $prepared = $commands->prepare($fm, Employment::query()->findOrFail($this->employmentId), 'contract/incb.pdf', null, '2026-09-01', '2026-12-31', 'incb-con-1');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);
        $commands->addRule($fm, $version, 'fixed_monthly', '40000.00', null, null, null, 'incb-r-fix');
        $commands->submit($fm, $version, 'incb-con-2');
        $commands->approve($this->grantedActor('incb-gm-1', ['hr.contract.approve']), $version, 'incb-con-3');
        app(MaintainEmployment::class)->hire($manager, Employment::query()->findOrFail($this->employmentId), '2026-09-01', 'incb-emp-2');
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('incb-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'incb-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    public function test_student_status_lifecycle_through_the_console(): void
    {
        $this->makeEmployee('incb-stu-mgr-1', ['students.manage'], 'student-manager');
        $this->makeEmployee('incb-stu-react-1', ['students.reactivate'], 'student-reactivator');
        $show = 'http://localhost/students/students/'.$this->studentId;

        // Suspend (students.manage), reactivate (its own capability), complete, graduate.
        $this->signIn('student-manager');
        $this->post('/students/students/'.$this->studentId.'/status/suspend', ['reason' => 'conduct review'])
            ->assertRedirect($show);
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'student_statuses', [
            'student_id' => $this->studentId, 'status' => 'suspended',
        ]);

        // The manager cannot reactivate — that capability is separate.
        $this->post('/students/students/'.$this->studentId.'/status/reactivate', ['reason' => 'review closed'], ['referer' => $show])
            ->assertRedirect($show)
            ->assertSessionHas('error_code', 'students.status_denied');

        $this->signOut();
        $this->signIn('student-reactivator');
        $this->post('/students/students/'.$this->studentId.'/status/reactivate', ['reason' => 'review closed'])
            ->assertRedirect($show);
        $this->signOut();

        $this->signIn('student-manager');
        $this->post('/students/students/'.$this->studentId.'/status/complete', ['reason' => 'course completed'])
            ->assertRedirect($show);
        $this->post('/students/students/'.$this->studentId.'/status/graduate', ['reason' => 'graduation board'])
            ->assertRedirect($show);
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'student_statuses', [
            'student_id' => $this->studentId, 'status' => 'alumni',
        ]);

        // Alumni is terminal: no further transition is allowed.
        $this->post('/students/students/'.$this->studentId.'/status/suspend', ['reason' => 'should fail'], ['referer' => $show])
            ->assertRedirect($show)
            ->assertSessionHas('error_code', 'students.transition_forbidden');
    }

    public function test_leave_lifecycle_end_to_end_through_the_console(): void
    {
        $this->makeEmployee('incb-req-1', ['hr.leave_request', 'hr.leave_approve'], 'leave-requester');
        $this->makeEmployee('incb-dec-1', ['hr.leave_approve'], 'leave-decider');

        $this->signIn('leave-requester');
        $this->post('/hr/employments/'.$this->employmentId.'/leave', [
            'category' => 'sick',
            'date_from' => '2026-09-10',
            'date_to' => '2026-09-12',
            'reason' => 'medical',
        ])->assertRedirect('/hr');
        $leaveId = DB::table(DB::connection()->getTablePrefix().'leaves')->where('employment_id', $this->employmentId)->value('id');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'leaves', [
            'employment_id' => $this->employmentId, 'lifecycle_state' => 'requested',
        ]);

        // The requester cannot decide their own request.
        $this->post('/hr/leaves/'.$leaveId.'/decide', ['decision' => 'approve'], ['referer' => 'http://localhost/hr'])
            ->assertRedirect('/hr')
            ->assertSessionHas('error_code', 'hr.leave_not_independent');

        $this->signOut();
        $this->signIn('leave-decider');
        $this->post('/hr/leaves/'.$leaveId.'/decide', ['decision' => 'approve'])->assertRedirect('/hr');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'leaves', [
            'id' => $leaveId, 'lifecycle_state' => 'approved',
        ]);

        // An overlapping second approval must be rejected by the domain.
        $this->signOut();
        $this->signIn('leave-requester');
        $this->post('/hr/employments/'.$this->employmentId.'/leave', [
            'category' => 'annual',
            'date_from' => '2026-09-11',
            'date_to' => '2026-09-14',
            'reason' => 'planned',
        ])->assertRedirect('/hr');
        $secondId = DB::table(DB::connection()->getTablePrefix().'leaves')->where('employment_id', $this->employmentId)
            ->where('id', '!=', $leaveId)->value('id');
        $this->signOut();
        $this->signIn('leave-decider');
        $this->post('/hr/leaves/'.$secondId.'/decide', ['decision' => 'approve'], ['referer' => 'http://localhost/hr'])
            ->assertRedirect('/hr')
            ->assertSessionHas('error_code', 'hr.leave_overlap');
        $this->signOut();

        // The requester cancels the pending request.
        $this->signIn('leave-requester');
        $this->post('/hr/leaves/'.$secondId.'/cancel')->assertRedirect('/hr');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'leaves', [
            'id' => $secondId, 'lifecycle_state' => 'cancelled',
        ]);
    }

    public function test_guardian_relationship_lifecycle_through_the_console(): void
    {
        $this->makeEmployee('incb-guard-1', ['students.guardian'], 'guardian-clerk');
        $guardianPerson = $this->personWithAuthority('incb-guardian-1', []);
        $show = 'http://localhost/students/students/'.$this->studentId;

        $this->signIn('guardian-clerk');
        $this->post('/students/students/'.$this->studentId.'/guardians', [
            'guardian_person_id' => $guardianPerson->id,
            'relationship' => 'parent',
            'permissions' => 'view_records, receive_reports',
        ])->assertRedirect($show);
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'guardian_relationships', [
            'student_id' => $this->studentId,
            'guardian_person_id' => $guardianPerson->id,
            'lifecycle_state' => 'active',
            'verification_state' => 'unverified',
        ]);

        // The same open (student, guardian, relationship) row cannot be duplicated.
        $this->post('/students/students/'.$this->studentId.'/guardians', [
            'guardian_person_id' => $guardianPerson->id,
            'relationship' => 'parent',
            'permissions' => 'view_records',
        ], ['referer' => $show])
            ->assertRedirect($show)
            ->assertSessionHas('error_code', 'students.guardian_duplicate');

        $relationshipId = DB::table(DB::connection()->getTablePrefix().'guardian_relationships')->where('student_id', $this->studentId)->value('id');

        $this->post('/students/guardians/'.$relationshipId.'/verify', [], ['referer' => $show])
            ->assertRedirect($show);
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'guardian_relationships', [
            'id' => $relationshipId, 'verification_state' => 'verified',
        ]);

        $this->post('/students/guardians/'.$relationshipId.'/verify', [], ['referer' => $show])
            ->assertRedirect($show)
            ->assertSessionHas('error_code', 'students.guardian_already_verified');

        $this->post('/students/guardians/'.$relationshipId.'/revoke', [], ['referer' => $show])
            ->assertRedirect($show);
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'guardian_relationships', [
            'id' => $relationshipId, 'lifecycle_state' => 'revoked',
        ]);
    }

    public function test_account_deactivation_through_the_console(): void
    {
        $this->makeEmployee('incb-admin-1', ['identity.admin'], 'identity-admin');
        [, $target] = $this->makeEmployee('incb-target-1', [], 'departed-user');

        $this->signIn('identity-admin');
        $this->post('/identity/accounts/'.$target->id.'/deactivate', ['reason' => 'employment ended'])
            ->assertRedirect('/identity');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'user_accounts', [
            'id' => $target->id, 'account_state' => UserAccount::STATE_DEACTIVATED,
        ]);

        // A deactivated account can never authenticate.
        $this->signOut();
        $this->post('/login', ['username' => 'departed-user', 'password' => 'incb-password-1'])
            ->assertSessionHasErrors('username');
        $this->assertGuest();

        // Deactivation is not reversible through the console (evidence, not erasure).
        $this->signIn('identity-admin');
        $this->post('/identity/accounts/'.$target->id.'/deactivate', ['reason' => 'again'], ['referer' => 'http://localhost/identity'])
            ->assertRedirect('/identity')
            ->assertSessionHas('error_code', 'identity.account_not_active');
    }
}
