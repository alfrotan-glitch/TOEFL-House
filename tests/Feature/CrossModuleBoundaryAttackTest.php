<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Program;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Finance\Commands\MaintainFinancialPeriod;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Hr\Commands\MaintainContractVersion;
use App\Modules\Hr\Commands\MaintainEmployment;
use App\Modules\Hr\Models\ContractVersion;
use App\Modules\Hr\Models\Employment;
use App\Modules\Payroll\Commands\CalculatePayroll;
use App\Modules\Payroll\Commands\MaintainPayrollPeriod;
use App\Modules\Payroll\Models\PayrollPeriod;
use App\Modules\Students\Commands\TransitionStudentStatus;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\Actor;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

/**
 * Cross-module boundary attack surface (PHASE_2). The application commands
 * keep the Academic, Finance and Payroll modules honest with each other
 * (active student/class and capacity before a seat becomes real, payroll
 * overlap before a financial period closes, one open teacher assignment
 * per class and teacher). These attacks prove the same invariants hold at
 * the database boundary when a direct SQL statement bypasses the commands.
 */
final class CrossModuleBoundaryAttackTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

    private string $teacherPersonId = 'bd-teacher-1';

    private string $versionId;

    private string $periodId;

    private string $classIdA;

    private string $classIdB;

    private int $keyCounter = 0;

    protected function setUp(): void
    {
        parent::setUp();

        $officer = $this->academicOfficer();
        $this->personWithAuthority($this->teacherPersonId, []);

        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'IELTS Preparation', $this->k('prog'));
        $version = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'boundary rules', $this->k('ver'));
        $this->versionId = $version['version_id'];
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Fall 2026', new CarbonImmutable('2026-09-01'), new CarbonImmutable('2026-12-18'), $this->k('period'));
        $this->periodId = $period['period_id'];
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($this->periodId), 'published', $this->k('period-pub'));

        // Class A holds two seats; class B holds one.
        $classA = app(MaintainClass::class)->defineClass($officer, $this->versionId, $this->periodId, 2, $this->k('class-a'));
        $this->classIdA = $classA['class_id'];
        $classB = app(MaintainClass::class)->defineClass($officer, $this->versionId, $this->periodId, 1, $this->k('class-b'));
        $this->classIdB = $classB['class_id'];
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classIdA), $this->teacherPersonId, new CarbonImmutable('2026-09-01'), null, $this->k('ta-a'));
        app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classIdB), $this->teacherPersonId, new CarbonImmutable('2026-09-01'), null, $this->k('ta-b'));
    }

    private function k(string $what): string
    {
        return 'bd-'.hash('sha256', get_class($this).$what.$this->keyCounter++);
    }

    private function officer(): Actor
    {
        return $this->academicOfficer();
    }

    private function clerk(): Actor
    {
        return $this->enrollmentClerk();
    }

    private function activeClass(string $classId): string
    {
        app(MaintainClass::class)->transition($this->officer(), ClassModel::query()->findOrFail($classId), 'published', $this->k('cls-pub'));
        app(MaintainClass::class)->transition($this->officer(), ClassModel::query()->findOrFail($classId), 'active', $this->k('cls-act'));

        return $classId;
    }

    private function newStudent(string $personId): string
    {
        $this->personWithAuthority($personId, []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('bd-clerk-'.$personId), $personId, 'IELTS Preparation', $this->k('reg'));
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision(
            $this->admissionsClerk('bd-clerk-'.$personId), $this->admissionsReviewer('bd-review-'.$personId), $this->admissionsApprover('bd-approve-'.$personId),
            $applicant, true, 'meets entry policy', 'interview-notes/'.$personId, $this->k('dec'),
        );

        return app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('bd-approve-'.$personId), $applicant, $this->k('conv'))['student_id'];
    }

    /** @return array{enrollment_id: string, student_id: string} */
    private function activeSeat(string $personId, string $classId): array
    {
        $studentId = $this->newStudent($personId);
        $seat = app(MaintainEnrollment::class)->request($this->clerk(), $studentId, $classId, $this->k('req'));
        app(MaintainEnrollment::class)->activate($this->officer(), Enrollment::query()->findOrFail($seat['enrollment_id']), $this->k('act'));

        return ['enrollment_id' => $seat['enrollment_id'], 'student_id' => $studentId];
    }

    public function test_direct_sql_cannot_enroll_a_student_whose_latest_status_is_not_active(): void
    {
        $classId = $this->activeClass($this->classIdA);
        $studentId = $this->newStudent('bd-person-susp');
        app(TransitionStudentStatus::class)->suspend($this->studentManager('bd-stu-susp'), Student::query()->findOrFail($studentId), 'attendance', $this->k('susp'));

        $this->expectException(QueryException::class);
        DB::table('enrollments')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-0000000000b1',
            'student_id' => $studentId,
            'class_id' => $classId,
            'lifecycle_state' => 'requested',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_enroll_into_a_class_that_is_not_active(): void
    {
        // Class A is still planned; only active classes take new seats.
        $studentId = $this->newStudent('bd-person-inactive');

        $this->expectException(QueryException::class);
        DB::table('enrollments')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-0000000000b2',
            'student_id' => $studentId,
            'class_id' => $this->classIdA,
            'lifecycle_state' => 'requested',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_insert_a_seat_that_is_not_requested(): void
    {
        $classId = $this->activeClass($this->classIdA);
        $studentId = $this->newStudent('bd-person-forged-state');

        // A seat is always born requested; a forged straight-to-active seat
        // would skip the request audit and the activation checks.
        $this->expectException(QueryException::class);
        DB::table('enrollments')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-0000000000b3',
            'student_id' => $studentId,
            'class_id' => $classId,
            'lifecycle_state' => 'active',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_hold_two_open_seats_for_the_same_student_and_class(): void
    {
        $classId = $this->activeClass($this->classIdA);
        $studentId = $this->newStudent('bd-person-dup-seat');
        app(MaintainEnrollment::class)->request($this->clerk(), $studentId, $classId, $this->k('dup-req'));

        $this->expectException(QueryException::class);
        DB::table('enrollments')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-0000000000b4',
            'student_id' => $studentId,
            'class_id' => $classId,
            'lifecycle_state' => 'requested',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_move_a_seat_between_classes(): void
    {
        $classIdA = $this->activeClass($this->classIdA);
        $this->activeClass($this->classIdB);
        $studentId = $this->newStudent('bd-person-mover');
        $seat = app(MaintainEnrollment::class)->request($this->clerk(), $studentId, $classIdA, $this->k('move-req'));

        $this->expectException(QueryException::class);
        DB::table('enrollments')->where('id', $seat['enrollment_id'])->update(['class_id' => $this->classIdB]);
    }

    public function test_direct_sql_cannot_break_the_enrollment_state_machine(): void
    {
        $classId = $this->activeClass($this->classIdA);
        $seat = $this->activeSeat('bd-person-sm', $classId);

        // active -> requested is not a registered transition.
        $this->expectException(QueryException::class);
        DB::table('enrollments')->where('id', $seat['enrollment_id'])->update(['lifecycle_state' => 'requested']);
    }

    public function test_direct_sql_cannot_revive_a_terminal_enrollment(): void
    {
        $classId = $this->activeClass($this->classIdA);
        $seat = app(MaintainEnrollment::class)->request($this->clerk(), $this->newStudent('bd-person-term'), $classId, $this->k('term-req'));
        app(MaintainEnrollment::class)->withdraw($this->clerk(), Enrollment::query()->findOrFail($seat['enrollment_id']), 'withdrawn seat under test', $this->k('term-wd'));

        $this->expectException(QueryException::class);
        DB::table('enrollments')->where('id', $seat['enrollment_id'])->update(['lifecycle_state' => 'active']);
    }

    public function test_direct_sql_cannot_activate_a_seat_beyond_class_capacity(): void
    {
        $classId = $this->activeClass($this->classIdA);
        $this->activeSeat('bd-person-cap-1', $classId);
        $this->activeSeat('bd-person-cap-2', $classId);
        $thirdStudent = $this->newStudent('bd-person-cap-3');
        $seat = app(MaintainEnrollment::class)->request($this->clerk(), $thirdStudent, $classId, $this->k('cap-req'));

        $this->expectException(QueryException::class);
        DB::table('enrollments')->where('id', $seat['enrollment_id'])->update(['lifecycle_state' => 'active']);
    }

    public function test_direct_sql_cannot_activate_a_seat_in_a_class_that_is_no_longer_active(): void
    {
        $classId = $this->activeClass($this->classIdA);
        $studentId = $this->newStudent('bd-person-completed');
        $seat = app(MaintainEnrollment::class)->request($this->clerk(), $studentId, $classId, $this->k('comp-req'));
        app(MaintainClass::class)->transition($this->officer(), ClassModel::query()->findOrFail($classId), 'completed', $this->k('comp-cls'));

        $this->expectException(QueryException::class);
        DB::table('enrollments')->where('id', $seat['enrollment_id'])->update(['lifecycle_state' => 'active']);
    }

    public function test_direct_sql_cannot_close_a_period_with_an_open_overlapping_payroll_period(): void
    {
        $accountant = $this->grantedActor('bd-acc-fp', ['finance.chart', 'finance.period']);
        $payroll = $this->grantedActor('bd-pay-fp', ['payroll.period']);
        $period = app(MaintainFinancialPeriod::class)->open($accountant, '2026-09', '2026-09-01', '2026-09-30', $this->k('fp'));
        app(MaintainPayrollPeriod::class)->open($payroll, '2026-09', '2026-09-01', '2026-09-30', $this->k('pp'));

        $this->expectException(QueryException::class);
        DB::table('financial_periods')->where('id', $period['period_id'])->update(['lifecycle_state' => 'closed']);
    }

    public function test_direct_sql_cannot_rewrite_a_period_date_scope(): void
    {
        $accountant = $this->grantedActor('bd-acc-ds', ['finance.chart', 'finance.period']);
        $period = app(MaintainFinancialPeriod::class)->open($accountant, '2026-09', '2026-09-01', '2026-09-30', $this->k('fp-ds'));

        // The date scope is fixed at open; rewriting it would move the
        // period off its payroll overlap and reporting boundary.
        $this->expectException(QueryException::class);
        DB::table('financial_periods')->where('id', $period['period_id'])->update(['date_to' => '2026-12-31']);
    }

    public function test_direct_sql_cannot_reopen_a_closed_period(): void
    {
        $accountant = $this->grantedActor('bd-acc-re', ['finance.chart', 'finance.period']);
        $period = app(MaintainFinancialPeriod::class)->open($accountant, '2026-11', '2026-11-01', '2026-11-30', $this->k('fp-re'));
        app(MaintainFinancialPeriod::class)->close($accountant, FinancialPeriod::query()->findOrFail($period['period_id']), $this->k('fp-re-close'));

        $this->expectException(QueryException::class);
        DB::table('financial_periods')->where('id', $period['period_id'])->update(['lifecycle_state' => 'open']);
    }

    public function test_direct_sql_can_close_a_period_once_the_overlapping_payroll_period_is_closed(): void
    {
        $accountant = $this->grantedActor('bd-acc-ok', ['finance.chart', 'finance.period']);
        $payroll = $this->grantedActor('bd-pay-ok', ['payroll.period']);
        $period = app(MaintainFinancialPeriod::class)->open($accountant, '2026-09', '2026-09-01', '2026-09-30', $this->k('fp-ok'));
        $payrollPeriod = app(MaintainPayrollPeriod::class)->open($payroll, '2026-09', '2026-09-01', '2026-09-30', $this->k('pp-ok'));
        app(MaintainPayrollPeriod::class)->close($payroll, PayrollPeriod::query()->findOrFail($payrollPeriod['period_id']), $this->k('pp-ok-close'));

        DB::table('financial_periods')->where('id', $period['period_id'])->update(['lifecycle_state' => 'closed']);
        $this->assertDatabaseHas('financial_periods', ['id' => $period['period_id'], 'lifecycle_state' => 'closed']);
    }

    public function test_direct_sql_can_close_a_period_when_only_a_disjoint_payroll_period_is_open(): void
    {
        $accountant = $this->grantedActor('bd-acc-dj', ['finance.chart', 'finance.period']);
        $payroll = $this->grantedActor('bd-pay-dj', ['payroll.period']);
        $period = app(MaintainFinancialPeriod::class)->open($accountant, '2026-09', '2026-09-01', '2026-09-30', $this->k('fp-dj'));
        app(MaintainPayrollPeriod::class)->open($payroll, '2026-10', '2026-10-01', '2026-10-31', $this->k('pp-dj'));

        DB::table('financial_periods')->where('id', $period['period_id'])->update(['lifecycle_state' => 'closed']);
        $this->assertDatabaseHas('financial_periods', ['id' => $period['period_id'], 'lifecycle_state' => 'closed']);
    }

    public function test_direct_sql_cannot_hold_two_open_teacher_assignments_for_a_class_and_teacher(): void
    {
        $this->activeClass($this->classIdA);

        $this->expectException(QueryException::class);
        DB::table('teacher_assignments')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-0000000000b5',
            'class_id' => $this->classIdA,
            'teacher_person_id' => $this->teacherPersonId,
            'effective_from' => '2026-09-15',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_can_end_an_open_teacher_assignment(): void
    {
        $this->activeClass($this->classIdA);
        /** @var string|null $open */
        $open = DB::table('teacher_assignments')
            ->where('class_id', $this->classIdA)
            ->where('teacher_person_id', $this->teacherPersonId)
            ->whereNull('effective_to')
            ->value('id');
        $this->assertNotNull($open);

        DB::table('teacher_assignments')->where('id', $open)->update(['effective_to' => '2026-09-30']);
        $this->assertDatabaseHas('teacher_assignments', ['id' => $open, 'effective_to' => '2026-09-30']);
    }

    private function closedFinancialPeriod(string $actorId, string $month, string $from, string $to): string
    {
        $accountant = $this->grantedActor($actorId, ['finance.chart', 'finance.period']);
        $period = app(MaintainFinancialPeriod::class)->open($accountant, $month, $from, $to, $this->k('fp'));
        app(MaintainFinancialPeriod::class)->close($accountant, FinancialPeriod::query()->findOrFail($period['period_id']), $this->k('fp-close'));

        return $period['period_id'];
    }

    private string $payrollPeriodId = '';

    /** Employment with an in-force contract, hired into the open 2026-09 payroll period. */
    private function payrollWorld(): string
    {
        $personId = 'bd-payroll-person';
        $this->personWithAuthority($personId, []);
        $manager = $this->grantedActor('bd-hr-mgr', ['hr.employ', 'hr.terminate', 'access.assign_position']);
        $employment = app(MaintainEmployment::class)->employ($manager, $personId, $this->k('emp'));
        $employmentId = $employment['employment_id'];

        $fm = $this->grantedActor('bd-fm', ['hr.contract.prepare']);
        $commands = app(MaintainContractVersion::class);
        $prepared = $commands->prepare($fm, Employment::query()->findOrFail($employmentId), 'contract/2026-09.pdf', null, '2026-09-01', '2026-09-30', $this->k('con'));
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);
        $commands->addRule($fm, $version, 'fixed_monthly', '40000.00', null, null, null, $this->k('rule-fix'));
        $commands->submit($fm, $version, $this->k('con-sub'));
        $commands->approve($this->grantedActor('bd-gm', ['hr.contract.approve']), $version, $this->k('con-apr'));

        app(MaintainEmployment::class)->hire($manager, Employment::query()->findOrFail($employmentId), '2026-09-01', $this->k('hire'));
        $period = app(MaintainPayrollPeriod::class)->open($this->grantedActor('bd-pay-open', ['payroll.period']), '2026-09', '2026-09-01', '2026-09-30', $this->k('pay-per'));
        $this->payrollPeriodId = $period['period_id'];

        return $employmentId;
    }

    public function test_direct_sql_cannot_post_an_obligation_into_a_closed_period(): void
    {
        $periodId = $this->closedFinancialPeriod('bd-acc-obl', '2026-09', '2026-09-01', '2026-09-30');
        $studentId = $this->newStudent('bd-person-obl');

        $this->expectException(QueryException::class);
        $this->expectExceptionMessage('requires an open financial period');
        DB::table('obligations')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-0000000000c1',
            'period_id' => $periodId,
            'student_id' => $studentId,
            'source' => 'tuition',
            'original_amount' => '1000.00',
            'reason' => 'forged obligation into a closed period',
            'posted_by' => 'bd-forger-1',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_post_a_journal_into_a_closed_period(): void
    {
        $periodId = $this->closedFinancialPeriod('bd-acc-jnl', '2026-09', '2026-09-01', '2026-09-30');

        $this->expectException(QueryException::class);
        $this->expectExceptionMessage('requires an open financial period');
        DB::table('journals')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-0000000000c2',
            'period_id' => $periodId,
            'source_type' => 'other',
            'reason' => 'forged journal into a closed period',
            'posted_by' => 'bd-forger-1',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_record_a_payment_into_a_closed_period(): void
    {
        $periodId = $this->closedFinancialPeriod('bd-acc-pay', '2026-09', '2026-09-01', '2026-09-30');
        $studentId = $this->newStudent('bd-person-pay');

        $this->expectException(QueryException::class);
        $this->expectExceptionMessage('requires an open financial period');
        DB::table('payments')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-0000000000c3',
            'period_id' => $periodId,
            'student_id' => $studentId,
            'amount' => '250.00',
            'method' => 'cash',
            'payer_ref' => 'bd-ref-closed',
            'received_on' => '2026-09-05',
            'recorded_by' => 'bd-forger-1',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_record_a_refund_into_a_closed_period(): void
    {
        $accountant = $this->grantedActor('bd-acc-rfd', ['finance.chart', 'finance.period']);
        $period = app(MaintainFinancialPeriod::class)->open($accountant, '2026-09', '2026-09-01', '2026-09-30', $this->k('fp-rfd'));
        $studentId = $this->newStudent('bd-person-rfd');
        DB::table('payments')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-0000000000c4',
            'period_id' => $period['period_id'],
            'student_id' => $studentId,
            'amount' => '250.00',
            'method' => 'cash',
            'payer_ref' => 'bd-ref-rfd',
            'received_on' => '2026-09-05',
            'recorded_by' => 'bd-forger-1',
            'created_at' => now(), 'updated_at' => now(),
        ]);
        app(MaintainFinancialPeriod::class)->close($accountant, FinancialPeriod::query()->findOrFail($period['period_id']), $this->k('fp-rfd-close'));

        $this->expectException(QueryException::class);
        $this->expectExceptionMessage('requires an open financial period');
        DB::table('refunds')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-0000000000c5',
            'payment_id' => 'eeeeeeee-ffff-4000-8000-0000000000c4',
            'period_id' => $period['period_id'],
            'amount' => '100.00',
            'reason' => 'forged refund into a closed period',
            'requested_by' => 'bd-forger-1',
            'lifecycle_state' => 'proposed',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_attach_a_discount_into_a_closed_period(): void
    {
        $accountant = $this->grantedActor('bd-acc-dsc', ['finance.chart', 'finance.period']);
        $period = app(MaintainFinancialPeriod::class)->open($accountant, '2026-09', '2026-09-01', '2026-09-30', $this->k('fp-dsc'));
        $studentId = $this->newStudent('bd-person-dsc');
        DB::table('obligations')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-0000000000c6',
            'period_id' => $period['period_id'],
            'student_id' => $studentId,
            'source' => 'tuition',
            'original_amount' => '1000.00',
            'reason' => 'tuition for the forged discount target',
            'posted_by' => 'bd-forger-1',
            'created_at' => now(), 'updated_at' => now(),
        ]);
        app(MaintainFinancialPeriod::class)->close($accountant, FinancialPeriod::query()->findOrFail($period['period_id']), $this->k('fp-dsc-close'));

        $this->expectException(QueryException::class);
        $this->expectExceptionMessage('requires an open financial period');
        DB::table('discounts')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-0000000000c7',
            'obligation_id' => 'eeeeeeee-ffff-4000-8000-0000000000c6',
            'period_id' => $period['period_id'],
            'amount' => '500.00',
            'eligibility' => 'sibling',
            'effective_from' => '2026-09-01',
            'reason' => 'forged discount into a closed period',
            'lifecycle_state' => 'proposed',
            'proposed_by' => 'bd-forger-1',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_prepare_a_payroll_calculation_into_a_closed_period(): void
    {
        $this->payrollWorld();
        app(MaintainPayrollPeriod::class)->close($this->grantedActor('bd-pay-close-c', ['payroll.period']), PayrollPeriod::query()->findOrFail($this->payrollPeriodId), $this->k('pay-close-c'));

        $this->expectException(QueryException::class);
        $this->expectExceptionMessage('open or calculating payroll period');
        DB::table('payroll_calculations')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-0000000000c8',
            'period_id' => $this->payrollPeriodId,
            'employment_id' => 'eeeeeeee-ffff-4000-8000-0000000000c9',
            'base_amount' => '40000.00',
            'snapshot' => json_encode(['forged' => true]),
            'lifecycle_state' => 'prepared',
            'prepared_by' => 'bd-forger-1',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_rewrite_a_payroll_calculation_snapshot(): void
    {
        $employmentId = $this->payrollWorld();
        $preparer = $this->grantedActor('bd-calc-snap', ['payroll.calculate']);
        $calc = app(CalculatePayroll::class)->prepare($preparer, PayrollPeriod::query()->findOrFail($this->payrollPeriodId), Employment::query()->findOrFail($employmentId), $this->k('calc-snap'));

        // The 000103 derivation guard accepts any result whose amount
        // equals the calculation's base amount; a forged base amount is a
        // forged payable. Only the lifecycle state may ever change.
        $this->expectException(QueryException::class);
        $this->expectExceptionMessage('write-once');
        DB::table('payroll_calculations')->where('id', $calc['calculation_id'])->update(['base_amount' => '999999.99']);
    }

    public function test_direct_sql_can_record_a_payment_into_an_open_period(): void
    {
        $accountant = $this->grantedActor('bd-acc-pos', ['finance.chart', 'finance.period']);
        $period = app(MaintainFinancialPeriod::class)->open($accountant, '2026-09', '2026-09-01', '2026-09-30', $this->k('fp-pos'));
        $studentId = $this->newStudent('bd-person-pos');

        DB::table('payments')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-0000000000ca',
            'period_id' => $period['period_id'],
            'student_id' => $studentId,
            'amount' => '250.00',
            'method' => 'cash',
            'payer_ref' => 'bd-ref-open',
            'received_on' => '2026-09-05',
            'recorded_by' => 'bd-acc-pos',
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $this->assertDatabaseHas('payments', ['id' => 'eeeeeeee-ffff-4000-8000-0000000000ca', 'period_id' => $period['period_id']]);
    }
}
