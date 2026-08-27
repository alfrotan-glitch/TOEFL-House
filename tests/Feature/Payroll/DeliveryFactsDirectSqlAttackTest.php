<?php

declare(strict_types=1);

namespace Tests\Feature\Payroll;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\MaintainSkill;
use App\Modules\Academic\Commands\RecordAttendance;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Hr\Commands\MaintainContractVersion;
use App\Modules\Hr\Commands\MaintainEmployment;
use App\Modules\Hr\Models\ContractVersion;
use App\Modules\Hr\Models\Employment;
use App\Modules\Payroll\Commands\CalculatePayroll;
use App\Modules\Payroll\Commands\MaintainPayrollPeriod;
use App\Modules\Payroll\Models\PayrollPeriod;
use App\Modules\Payroll\Models\TeachingDeliveryFact;
use App\Support\Authorization\Actor;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * Direct-SQL attack surface for the teaching delivery evidence guard.
 * Delivery facts are the raw evidence payroll pays against; a forged fact
 * (inflated hours, an unattributed skill, an out-of-period session, or a
 * session with no qualifying attendance) must be rejected by the schema.
 */
final class DeliveryFactsDirectSqlAttackTest extends TestCase
{
    use BuildsActors;

    private string $teacherPersonId = 'p16atk-teacher-1';

    private string $employmentId = '';

    private string $classId = '';

    private string $enrollmentId = '';

    private string $periodId = '';

    /** @var array<string, string> */
    private array $skillIds = [];

    protected function setUp(): void
    {
        parent::setUp();

        $hrManager = $this->grantedActor('p16atk-hr-1', ['hr.employ']);
        $this->personWithAuthority($this->teacherPersonId, []);
        $employment = app(MaintainEmployment::class)->employ($hrManager, $this->teacherPersonId, 'p16atk-emp-1');
        $this->employmentId = $employment['employment_id'];

        $skillRegistrar = $this->grantedActor('p16atk-skill-1', ['academic.skill']);
        $skills = app(MaintainSkill::class);
        foreach (['speaking_listening' => 'Speaking & Listening', 'writing_grammar' => 'Writing & Grammar'] as $key => $name) {
            $this->skillIds[$key] = $skills->register($skillRegistrar, $key, $name, 'p16atk-sk-'.$key)['skill_id'];
        }

        $fm = $this->grantedActor('p16atk-fm-1', ['hr.contract.prepare']);
        $commands = app(MaintainContractVersion::class);
        $prepared = $commands->prepare($fm, Employment::query()->findOrFail($this->employmentId), 'contract/2026-08.pdf', null, '2026-08-01', null, 'p16atk-con-1');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);
        $commands->addRule($fm, $version, 'fixed_monthly', '20000.00', null, null, null, 'p16atk-r-fix');
        $commands->addRule($fm, $version, 'session_rate', '500.00', $this->skillIds['speaking_listening'], null, null, 'p16atk-r-sp');
        $commands->addRule($fm, $version, 'session_rate', '600.00', $this->skillIds['writing_grammar'], null, null, 'p16atk-r-wr');
        $commands->submit($fm, $version, 'p16atk-con-2');
        $commands->approve($this->generalManager(), $version, 'p16atk-con-3');
        app(MaintainEmployment::class)->hire($hrManager, Employment::query()->findOrFail($this->employmentId), '2026-08-01', 'p16atk-emp-3');

        $officer = $this->academicOfficer();
        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'TOEFL Intensive', 'p16atk-prog-1');
        $versionPub = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'rules', 'p16atk-prog-2');
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Fall 2026', new CarbonImmutable('2026-08-01'), new CarbonImmutable('2026-12-18'), 'p16atk-per-1');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'p16atk-per-2');
        $class = app(MaintainClass::class)->defineClass($officer, $versionPub['version_id'], $period['period_id'], 4, 'p16atk-class-1');
        $this->classId = $class['class_id'];
        $assignment = app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), $this->teacherPersonId, new CarbonImmutable('2026-08-01'), null, 'p16atk-class-2');
        foreach ($this->skillIds as $skillId) {
            app(MaintainClass::class)->assignSkill($officer, TeacherAssignment::query()->findOrFail($assignment['assignment_id']), $skillId, 'p16atk-sk-assign-'.$skillId);
        }
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'p16atk-class-3');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'p16atk-class-4');

        $studentId = $this->enrolledStudent('p16atk-student-1', 'p16atk-adm');
        $seat = app(MaintainEnrollment::class)->request($this->enrollmentClerk('p16atk-clerk-1'), $studentId, $this->classId, 'p16atk-enr-1');
        app(MaintainEnrollment::class)->activate($officer, Enrollment::query()->findOrFail($seat['enrollment_id']), 'p16atk-enr-2');
        $this->enrollmentId = $seat['enrollment_id'];

        $payrollPeriod = app(MaintainPayrollPeriod::class)->open($this->grantedActor('p16atk-period-1', ['payroll.period']), '2026-08', '2026-08-01', '2026-08-31', 'p16atk-period-2');
        $this->periodId = $payrollPeriod['period_id'];
    }

    private function generalManager(): Actor
    {
        return $this->grantedActor('p16atk-gm-1', ['hr.contract.approve']);
    }

    private function enrolledStudent(string $personId, string $keyPrefix): string
    {
        $this->personWithAuthority($personId, []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('p16atk-adm-clerk'), $personId, 'Program', $keyPrefix.'-reg');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        app(DecideAdmission::class)->decide(
            $this->admissionsClerk('p16atk-adm-clerk'), $this->admissionsReviewer('p16atk-adm-rev'), $this->admissionsApprover('p16atk-adm-appr'),
            $applicant, true, 'meets policy', 'ev/p16atk', $keyPrefix.'-dec',
        );

        return app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('p16atk-adm-appr'), $applicant, $keyPrefix.'-conv')['student_id'];
    }

    private function schedule(string $date, string $skillKey, string $key, string $attendanceStatus = 'present'): string
    {
        $officer = $this->academicOfficer();
        $session = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($this->classId), new CarbonImmutable($date), '09:00', '11:00', $key, $this->skillIds[$skillKey]);
        app(RecordAttendance::class)->record($officer, ClassSession::query()->findOrFail($session['session_id']), Enrollment::query()->findOrFail($this->enrollmentId), $attendanceStatus, $key.'-att');

        return $session['session_id'];
    }

    private function calculationId(): string
    {
        $preparer = $this->grantedActor('p16atk-calc-1', ['payroll.calculate']);
        $calculation = app(CalculatePayroll::class)->prepare($preparer, PayrollPeriod::query()->findOrFail($this->periodId), Employment::query()->findOrFail($this->employmentId), 'p16atk-calc');

        return $calculation['calculation_id'];
    }

    public function test_direct_sql_cannot_forge_inflated_delivery_hours(): void
    {
        $this->schedule('2026-08-05', 'speaking_listening', 'p16atk-s1');
        $calculationId = $this->calculationId();
        $this->assertSame('2.00', TeachingDeliveryFact::query()->firstOrFail()->hours);

        // A later session, forged with inflated hours: 2h session, 9h claim.
        $session = $this->schedule('2026-08-06', 'speaking_listening', 'p16atk-s2');

        $this->expectException(QueryException::class);
        DB::table('teaching_delivery_facts')->insert([
            'id' => 'cccccccc-dddd-4eee-8fff-000000000001',
            'payroll_calculation_id' => $calculationId,
            'session_id' => $session,
            'skill_id' => $this->skillIds['speaking_listening'],
            'scheduled_on' => '2026-08-06',
            'hours' => '9.00',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_forge_a_fact_for_an_unattributed_skill(): void
    {
        $this->schedule('2026-08-05', 'speaking_listening', 'p16atk-s3');
        $calculationId = $this->calculationId();

        // A skill the teacher was never assigned to this class.
        $foreignSkill = app(MaintainSkill::class)->register($this->grantedActor('p16atk-skill-1', ['academic.skill']), 'music_club', 'Music Club', 'p16atk-sk-fn')['skill_id'];
        $officer = $this->academicOfficer();
        $session = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($this->classId), new CarbonImmutable('2026-08-07'), '09:00', '11:00', 'p16atk-s4', $foreignSkill)['session_id'];
        app(RecordAttendance::class)->record($officer, ClassSession::query()->findOrFail($session), Enrollment::query()->findOrFail($this->enrollmentId), 'present', 'p16atk-s4-att');

        $this->expectException(QueryException::class);
        DB::table('teaching_delivery_facts')->insert([
            'id' => 'cccccccc-dddd-4eee-8fff-000000000002',
            'payroll_calculation_id' => $calculationId,
            'session_id' => $session,
            'skill_id' => $foreignSkill,
            'scheduled_on' => '2026-08-07',
            'hours' => '2.00',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_forge_a_fact_outside_the_claiming_period(): void
    {
        $this->schedule('2026-08-05', 'speaking_listening', 'p16atk-s5');
        $calculationId = $this->calculationId();

        // September is inside the academic period but outside the claiming
        // 2026-08 payroll period.
        $session = $this->schedule('2026-09-15', 'writing_grammar', 'p16atk-s6');

        $this->expectException(QueryException::class);
        DB::table('teaching_delivery_facts')->insert([
            'id' => 'cccccccc-dddd-4eee-8fff-000000000003',
            'payroll_calculation_id' => $calculationId,
            'session_id' => $session,
            'skill_id' => $this->skillIds['writing_grammar'],
            'scheduled_on' => '2026-09-15',
            'hours' => '2.00',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_forge_a_fact_without_qualifying_attendance(): void
    {
        $this->schedule('2026-08-05', 'speaking_listening', 'p16atk-s7');
        $calculationId = $this->calculationId();

        // A session where the only attendance record is absent.
        $session = $this->schedule('2026-08-08', 'writing_grammar', 'p16atk-s8', 'absent');

        $this->expectException(QueryException::class);
        DB::table('teaching_delivery_facts')->insert([
            'id' => 'cccccccc-dddd-4eee-8fff-000000000004',
            'payroll_calculation_id' => $calculationId,
            'session_id' => $session,
            'skill_id' => $this->skillIds['writing_grammar'],
            'scheduled_on' => '2026-08-08',
            'hours' => '2.00',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }
}
