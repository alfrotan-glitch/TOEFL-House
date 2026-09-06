<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Program;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Finance\Commands\MaintainFinancialPeriod;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * PHASE_3 transport completion: the remaining critical-path employee
 * workflows (seat request/activation, obligation posting, staged
 * progression) are exercised over the real HTTP surface. Every signature
 * is captured in its own authenticated session — the transport has no
 * field for typing a colleague's person id — and every domain rejection
 * surfaces as a redirect with the error code, never as a second truth.
 */
final class TransportWorkflowFeatureTest extends TestCase
{
    use BuildsActors;

    private string $classId;

    protected function setUp(): void
    {
        parent::setUp();

        $officer = $this->academicOfficer();
        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'IELTS Preparation', 'twt-prog');
        $version = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'boundary rules', 'twt-ver');
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Fall 2026', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), 'twt-period');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'twt-period-pub');

        $class = app(MaintainClass::class)->defineClass($officer, $version['version_id'], $period['period_id'], 2, 'twt-class');
        $this->classId = $class['class_id'];
        $this->personWithAuthority('twt-teacher-1', []);
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), 'twt-teacher-1', new CarbonImmutable('2026-09-01'), null, 'twt-ta');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'twt-cls-pub');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'twt-cls-act');
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('twt-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'twt-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    /**
     * One admitted student, built through the authoritative staged
     * admissions pipeline (initiate/review/approve/convert).
     */
    private function newStudent(string $suffix): string
    {
        $personId = 'twt-stu-'.$suffix;
        $this->personWithAuthority($personId, []);

        $registered = app(RegisterApplicant::class)->register(
            $this->admissionsClerk('twt-clerk-'.$suffix), $personId, 'IELTS Preparation', 'twt-reg-'.$suffix,
        );
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);

        $initiated = app(DecideAdmission::class)->initiate(
            $this->admissionsClerk('twt-clerk2-'.$suffix), $applicant, true, 'meets entry policy', 'interview-notes/'.$suffix, 'twt-deci-'.$suffix,
        );
        $decision = AdmissionDecision::query()->findOrFail($initiated['decision_id']);
        app(DecideAdmission::class)->review($this->admissionsReviewer('twt-rev-'.$suffix), $decision, 'twt-decr-'.$suffix);
        app(DecideAdmission::class)->approve($this->admissionsApprover('twt-adv-'.$suffix), $decision, 'twt-deca-'.$suffix);

        $converted = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('twt-adv2-'.$suffix), $applicant, 'twt-conv-'.$suffix);

        return $converted['student_id'];
    }

    public function test_enrollment_seat_lifecycle_through_the_console(): void
    {
        $this->makeEmployee('twt-clerk-s1', ['academic.enroll'], 'seat-clerk');
        $this->makeEmployee('twt-officer-s1', ['academic.enroll_approve'], 'seat-approver');
        $studentId = $this->newStudent('s1');

        // Clerk signs the request in her own session.
        $this->signIn('seat-clerk');
        $this->post('/academic/enrollments', [
            'student_id' => $studentId,
            'class_id' => $this->classId,
        ])->assertRedirect('/academic');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'enrollments', [
            'student_id' => $studentId, 'class_id' => $this->classId, 'lifecycle_state' => 'requested',
        ]);

        // A second request for the same seat is rejected by the domain,
        // surfaced as a redirect with the error code.
        $this->post('/academic/enrollments', [
            'student_id' => $studentId,
            'class_id' => $this->classId,
        ], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.enrollment_seat_exists');
        $this->assertSame(1, DB::table(DB::connection()->getTablePrefix().'enrollments')->count());

        $seatId = DB::table(DB::connection()->getTablePrefix().'enrollments')->where('student_id', $studentId)->value('id');

        // A different session signed in as the approver activates it.
        $this->signOut();
        $this->signIn('seat-approver');
        $this->post('/academic/enrollments/'.$seatId.'/activate')->assertRedirect('/academic');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'enrollments', [
            'student_id' => $studentId, 'class_id' => $this->classId, 'lifecycle_state' => 'active',
        ]);
    }

    public function test_enrollment_activation_requires_the_approve_capability(): void
    {
        $this->makeEmployee('twt-clerk-s2', ['academic.enroll'], 'seat-clerk-2');
        $studentId = $this->newStudent('s2');

        $this->signIn('seat-clerk-2');
        $this->post('/academic/enrollments', [
            'student_id' => $studentId,
            'class_id' => $this->classId,
        ])->assertRedirect('/academic');
        $seatId = DB::table(DB::connection()->getTablePrefix().'enrollments')->where('student_id', $studentId)->value('id');

        $this->post('/academic/enrollments/'.$seatId.'/activate', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.enrollment_denied');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'enrollments', [
            'id' => $seatId, 'lifecycle_state' => 'requested',
        ]);
    }

    public function test_obligation_posts_only_to_an_open_period(): void
    {
        $this->makeEmployee('twt-fin-1', ['finance.obligation', 'finance.period'], 'finance-clerk');
        $studentId = $this->newStudent('f1');

        $officer = $this->grantedActor('twt-fin-off-1', ['finance.period']);
        $period = app(MaintainFinancialPeriod::class)->open(
            $officer, 'SY2026-1', '2026-08-01', '2027-07-31', 'twt-fp',
        );
        $periodId = $period['period_id'];

        $this->signIn('finance-clerk');
        $this->post('/finance/obligations', [
            'period_id' => $periodId,
            'student_id' => $studentId,
            'source' => 'tuition',
            'reason' => 'first tuition instalment',
            'category' => 'tuition',
            'amount' => '1250',
            'source_ref' => 'INV-2026-001',
        ])->assertRedirect('/finance');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'obligations', [
            'student_id' => $studentId, 'period_id' => $periodId, 'original_amount' => 1250,
        ]);

        app(MaintainFinancialPeriod::class)->close($officer, FinancialPeriod::query()->findOrFail($periodId), 'twt-fp-close');

        $this->post('/finance/obligations', [
            'period_id' => $periodId,
            'student_id' => $studentId,
            'source' => 'tuition',
            'reason' => 'second instalment',
            'category' => 'tuition',
            'amount' => '1250',
            'source_ref' => 'INV-2026-002',
        ], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.period_not_open');
        $this->assertSame(1, DB::table(DB::connection()->getTablePrefix().'obligations')->count());
    }

    public function test_progression_staged_lifecycle_through_the_console(): void
    {
        $this->makeEmployee('twt-prop-1', ['academic.progression_propose'], 'proposer');
        $this->makeEmployee('twt-rev-p1', ['academic.progression_review'], 'progression-reviewer');
        $this->makeEmployee('twt-app-p1', ['academic.progression_approve'], 'progression-approver');
        $studentId = $this->newStudent('p1');

        // Proposal — the proposer's own session only.
        $this->signIn('proposer');
        $this->post('/academic/progressions', [
            'student_id' => $studentId,
            'class_id' => $this->classId,
            'outcome' => 'advance',
            'reason' => 'meets the exit criteria',
        ])->assertRedirect('/academic');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'progression_decisions', [
            'student_id' => $studentId, 'class_id' => $this->classId, 'outcome' => 'advance', 'lifecycle_state' => 'proposed',
        ]);

        // The proposer has no signature over review or approval.
        $decisionId = DB::table(DB::connection()->getTablePrefix().'progression_decisions')->where('student_id', $studentId)->value('id');
        $this->post('/academic/progressions/'.$decisionId.'/approve', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.progression_denied');

        // Review by a second employee, approval by a third.
        $this->signOut();
        $this->signIn('progression-reviewer');
        $this->post('/academic/progressions/'.$decisionId.'/review')->assertRedirect('/academic');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'progression_decisions', [
            'id' => $decisionId, 'lifecycle_state' => 'reviewed',
        ]);

        $this->signOut();
        $this->signIn('progression-approver');
        $this->post('/academic/progressions/'.$decisionId.'/approve')->assertRedirect('/academic');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'progression_decisions', [
            'id' => $decisionId, 'lifecycle_state' => 'approved',
        ]);
    }

    public function test_progression_review_and_approval_require_independent_signatures(): void
    {
        // One employee holding all three progression capabilities must
        // still be unable to sign the same decision twice.
        $this->makeEmployee('twt-all-p1', ['academic.progression_propose', 'academic.progression_review', 'academic.progression_approve'], 'lone-signer');
        $studentId = $this->newStudent('p2');

        $this->signIn('lone-signer');
        $this->post('/academic/progressions', [
            'student_id' => $studentId,
            'class_id' => $this->classId,
            'outcome' => 'repeat',
            'reason' => 'did not meet the exit criteria',
        ])->assertRedirect('/academic');
        $decisionId = DB::table(DB::connection()->getTablePrefix().'progression_decisions')->where('student_id', $studentId)->value('id');

        $this->post('/academic/progressions/'.$decisionId.'/review', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.review_not_independent');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'progression_decisions', [
            'id' => $decisionId, 'lifecycle_state' => 'proposed',
        ]);

        // A second employee reviews; the proposer's later approval is
        // still refused — the approver must differ from both signers.
        $this->signOut();
        $this->makeEmployee('twt-rev-p2', ['academic.progression_review'], 'progression-reviewer-2');
        $this->signIn('progression-reviewer-2');
        $this->post('/academic/progressions/'.$decisionId.'/review')->assertRedirect('/academic');
        $this->signOut();

        $this->signIn('lone-signer');
        $this->post('/academic/progressions/'.$decisionId.'/approve', [], ['referer' => 'http://localhost/academic'])
            ->assertRedirect('/academic')
            ->assertSessionHas('error_code', 'academic.approval_not_independent');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'progression_decisions', [
            'id' => $decisionId, 'lifecycle_state' => 'reviewed',
        ]);
    }

    public function test_financial_period_lifecycle_through_the_console(): void
    {
        $this->makeEmployee('twt-fp-1', ['finance.period'], 'period-keeper');

        $this->signIn('period-keeper');
        $this->post('/finance/periods', [
            'period_key' => 'SY2026-C1',
            'date_from' => '2026-08-01',
            'date_to' => '2027-07-31',
        ])->assertRedirect('/finance');
        $periodId = DB::table(DB::connection()->getTablePrefix().'financial_periods')->where('period_key', 'SY2026-C1')->value('id');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'financial_periods', [
            'period_key' => 'SY2026-C1', 'lifecycle_state' => 'open',
        ]);

        // The same key cannot be opened twice.
        $this->post('/finance/periods', [
            'period_key' => 'SY2026-C1',
            'date_from' => '2026-08-01',
            'date_to' => '2027-07-31',
        ], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.period_key_exists');

        // Closure is a session-signed, terminal transition.
        $this->post('/finance/periods/'.$periodId.'/close')->assertRedirect('/finance');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'financial_periods', [
            'id' => $periodId, 'lifecycle_state' => 'closed',
        ]);

        $this->post('/finance/periods/'.$periodId.'/close', [], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.period_transition_forbidden');
    }
}
