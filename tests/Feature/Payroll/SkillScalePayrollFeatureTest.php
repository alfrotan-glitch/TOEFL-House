<?php

declare(strict_types=1);

namespace Tests\Feature\Payroll;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Commands\MaintainClass;
use App\Modules\Academic\Commands\MaintainEnrollment;
use App\Modules\Academic\Commands\MaintainSkill;
use App\Modules\Academic\Commands\RecordAttendance;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\AttendanceFact;
use App\Modules\Academic\Models\ClassModel;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Academic\Models\Enrollment;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\Skill;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Audit\Models\AuditEvent;
use App\Modules\Hr\Commands\MaintainContractVersion;
use App\Modules\Hr\Commands\MaintainEmployment;
use App\Modules\Hr\Commands\MaintainScale;
use App\Modules\Hr\Models\ContractVersion;
use App\Modules\Hr\Models\Employment;
use App\Modules\Payroll\Commands\ApprovePayrollResult;
use App\Modules\Payroll\Commands\CalculatePayroll;
use App\Modules\Payroll\Commands\MaintainPayrollPeriod;
use App\Modules\Payroll\Models\PayrollCalculation;
use App\Modules\Payroll\Models\PayrollPeriod;
use App\Modules\Payroll\Models\TeachingDeliveryFact;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

/**
 * Skill/Scale payroll chain: versioned contract resolution, per-skill
 * session rates with deterministic precedence, evidence-derived teaching
 * volume, fail-closed holds, double-count defense and historical
 * reproducibility across amendments, scale changes and skill retirement.
 */
final class SkillScalePayrollFeatureTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

    private string $teacherPersonId = 'p16-pay-teacher-1';

    private string $employmentId = '';

    private string $classId = '';

    private string $enrollmentId = '';

    private string $periodId = '';

    /** @var array<string, string> */
    private array $skillIds = [];

    private string $scaleS3Id = '';

    protected function setUp(): void
    {
        parent::setUp();

        $hrManager = $this->grantedActor('p16-pay-hr-1', ['hr.employ']);
        $this->personWithAuthority($this->teacherPersonId, []);
        $employment = app(MaintainEmployment::class)->employ($hrManager, $this->teacherPersonId, 'p16-pay-emp-1');
        $this->employmentId = $employment['employment_id'];

        $skillRegistrar = $this->grantedActor('p16-pay-skill-1', ['academic.skill']);
        $skills = app(MaintainSkill::class);
        foreach (['speaking_listening' => 'Speaking & Listening', 'writing_grammar' => 'Writing & Grammar', 'reading_vocabulary' => 'Reading & Vocabulary'] as $key => $name) {
            $this->skillIds[$key] = $skills->register($skillRegistrar, $key, $name, 'p16-pay-sk-'.$key)['skill_id'];
        }
        $this->scaleS3Id = app(MaintainScale::class)->register($this->grantedActor('p16-pay-scale-1', ['hr.scale']), 'S3', 'Senior', 3, 'p16-pay-scale-reg-1')['scale_id'];

        $fm = $this->financeManager();
        $commands = app(MaintainContractVersion::class);
        $prepared = $commands->prepare($fm, Employment::query()->findOrFail($this->employmentId), 'contract/2026-08.pdf', null, '2026-08-01', null, 'p16-pay-con-1');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);
        $commands->addRule($fm, $version, 'fixed_monthly', '20000.00', null, null, null, 'p16-pay-r-fix');
        $commands->addRule($fm, $version, 'session_rate', '500.00', $this->skillIds['speaking_listening'], null, null, 'p16-pay-r-sp');
        $commands->addRule($fm, $version, 'session_rate', '600.00', $this->skillIds['writing_grammar'], null, null, 'p16-pay-r-wr');
        $commands->addRule($fm, $version, 'session_rate', '450.00', $this->skillIds['reading_vocabulary'], null, null, 'p16-pay-r-rd');
        $commands->addRule($fm, $version, 'allowance', '1500.00', null, null, 'transport', 'p16-pay-r-al');
        $commands->submit($fm, $version, 'p16-pay-con-2');
        app(MaintainContractVersion::class)->approve($this->generalManager(), $version, 'p16-pay-con-3');
        app(MaintainEmployment::class)->hire($hrManager, Employment::query()->findOrFail($this->employmentId), '2026-08-01', 'p16-pay-emp-3');

        $officer = $this->academicOfficer();
        $program = app(MaintainAcademicStructure::class)->defineProgram($officer, 'TOEFL Intensive', 'p16-pay-prog-1');
        $versionPub = app(MaintainAcademicStructure::class)->publishVersion($officer, Program::query()->findOrFail($program['program_id']), 'rules', 'p16-pay-prog-2');
        $period = app(MaintainAcademicStructure::class)->definePeriod($officer, 'Fall 2026', new CarbonImmutable('2026-08-01'), new CarbonImmutable('2026-12-18'), 'p16-pay-per-1');
        app(MaintainAcademicStructure::class)->transitionPeriod($officer, AcademicPeriod::query()->findOrFail($period['period_id']), 'published', 'p16-pay-per-2');
        $class = app(MaintainClass::class)->defineClass($officer, $versionPub['version_id'], $period['period_id'], 4, 'p16-pay-class-1');
        $this->classId = $class['class_id'];
        $assignment = app(MaintainClass::class)->assignTeacher($officer, ClassModel::query()->findOrFail($this->classId), $this->teacherPersonId, new CarbonImmutable('2026-08-01'), null, 'p16-pay-class-2');
        foreach ($this->skillIds as $skillId) {
            app(MaintainClass::class)->assignSkill($officer, TeacherAssignment::query()->findOrFail($assignment['assignment_id']), $skillId, 'p16-pay-skill-'.$skillId);
        }
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'published', 'p16-pay-class-3');
        app(MaintainClass::class)->transition($officer, ClassModel::query()->findOrFail($this->classId), 'active', 'p16-pay-class-4');

        $studentId = $this->enrolledStudent('p16-pay-student-1', 'p16-pay-adm-1');
        $seat = app(MaintainEnrollment::class)->request($this->enrollmentClerk('p16-pay-clerk-1'), $studentId, $this->classId, 'p16-pay-enr-1');
        app(MaintainEnrollment::class)->activate($officer, Enrollment::query()->findOrFail($seat['enrollment_id']), 'p16-pay-enr-2');
        $this->enrollmentId = $seat['enrollment_id'];

        $payrollPeriod = app(MaintainPayrollPeriod::class)->open($this->grantedActor('p16-pay-period-1', ['payroll.period']), '2026-08', '2026-08-01', '2026-08-31', 'p16-pay-period-2');
        $this->periodId = $payrollPeriod['period_id'];
    }

    private function financeManager(): Actor
    {
        return $this->grantedActor('p16-pay-fm-1', ['hr.contract.prepare']);
    }

    private function generalManager(): Actor
    {
        return $this->grantedActor('p16-pay-gm-1', ['hr.contract.approve']);
    }

    private function payrollPreparer(): Actor
    {
        return $this->grantedActor('p16-pay-calc-1', ['payroll.calculate']);
    }

    private function enrolledStudent(string $personId, string $keyPrefix): string
    {
        $this->personWithAuthority($personId, []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('p16-pay-adm-clerk'), $personId, 'Program', $keyPrefix.'-reg');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision(
            $this->admissionsClerk('p16-pay-adm-clerk'), $this->admissionsReviewer('p16-pay-adm-rev'), $this->admissionsApprover('p16-pay-adm-appr'),
            $applicant, true, 'meets policy', 'ev/p16', $keyPrefix.'-dec',
        );

        return app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('p16-pay-adm-appr'), $applicant, $keyPrefix.'-conv')['student_id'];
    }

    private function deliveredSession(string $date, string $skillKey, string $key, string $attendanceStatus = 'present'): string
    {
        $officer = $this->academicOfficer();
        $session = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($this->classId), new CarbonImmutable($date), '09:00', '11:00', $key, $this->skillIds[$skillKey]);
        app(RecordAttendance::class)->record($officer, ClassSession::query()->findOrFail($session['session_id']), Enrollment::query()->findOrFail($this->enrollmentId), $attendanceStatus, $key.'-att');

        return $session['session_id'];
    }

    private function calculate(string $idempotencyKey): array
    {
        return app(CalculatePayroll::class)->prepare($this->payrollPreparer(), PayrollPeriod::query()->findOrFail($this->periodId), Employment::query()->findOrFail($this->employmentId), $idempotencyKey);
    }

    public function test_per_skill_session_rates_with_exact_amount_and_full_snapshot(): void
    {
        $this->deliveredSession('2026-08-05', 'speaking_listening', 'p16-t1-s1');
        $this->deliveredSession('2026-08-07', 'speaking_listening', 'p16-t1-s2');
        $this->deliveredSession('2026-08-10', 'writing_grammar', 'p16-t1-s3');
        $this->deliveredSession('2026-08-12', 'reading_vocabulary', 'p16-t1-s4');

        $calculation = $this->calculate('p16-t1-calc');

        $this->assertSame('prepared', $calculation['lifecycle_state']);
        /** @var PayrollCalculation $row */
        $row = PayrollCalculation::query()->findOrFail($calculation['calculation_id']);
        // 20000 fixed + 2*500 + 600 + 450 + 1500 allowance = 23550
        $this->assertSame('23550.00', $row->base_amount);
        $this->assertSame('skill-scale-v1', $row->snapshot['formula']);
        $this->assertNotSame('', (string) $row->snapshot['contract_version_id']);
        $this->assertCount(3, $row->snapshot['per_skill']);
        $this->assertCount(4, $row->snapshot['delivery']);
        $this->assertCount(5, $row->snapshot['rules']);
        $this->assertSame(4, TeachingDeliveryFact::query()->count());
        $this->assertSame('2.00', TeachingDeliveryFact::query()->firstOrFail()->hours);
        // Full-period version (2026-08-01.., period 2026-08-01..31): additive
        // lines pay in full — 31/31 calendar days, no proration loss.
        $this->assertSame(31, $row->snapshot['proration']['period_days']);
        $this->assertSame(31, $row->snapshot['proration']['active_days']);
        $fixedLine = collect($row->snapshot['additive'])->firstWhere('method', 'fixed_monthly');
        $this->assertSame('20000.00', $fixedLine['contract_amount']);
        $this->assertSame('20000.00', $fixedLine['amount']);
        $this->assertSame(31, $fixedLine['active_days']);
        $this->assertSame(31, $fixedLine['period_days']);
        // Delivery evidence references the qualifying attendance fact.
        $this->assertNotSame('', (string) $row->snapshot['delivery'][0]['fact_id']);
    }

    public function test_rate_resolution_ladder_is_deterministic(): void
    {
        $fm = $this->financeManager();
        $commands = app(MaintainContractVersion::class);
        $prepared = $commands->prepare($fm, Employment::query()->findOrFail($this->employmentId), 'contract/2026-08-v2.pdf', $this->scaleS3Id, '2026-08-16', null, 'p16-t2-prep');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);
        $exact = $commands->addRule($fm, $version, 'session_rate', '550.00', $this->skillIds['speaking_listening'], $this->scaleS3Id, null, 'p16-t2-r1');
        $commands->addRule($fm, $version, 'session_rate', '500.00', $this->skillIds['speaking_listening'], null, null, 'p16-t2-r2');
        $commands->addRule($fm, $version, 'session_rate', '400.00', null, $this->scaleS3Id, null, 'p16-t2-r3');
        $commands->addRule($fm, $version, 'session_rate', '600.00', $this->skillIds['writing_grammar'], null, null, 'p16-t2-r4');
        $commands->submit($fm, $version, 'p16-t2-sub');
        $commands->approve($this->generalManager(), $version, 'p16-t2-appr');

        $this->deliveredSession('2026-08-20', 'speaking_listening', 'p16-t2-s1');
        $this->deliveredSession('2026-08-21', 'writing_grammar', 'p16-t2-s2');

        $calculation = $this->calculate('p16-t2-calc');
        $this->assertSame('prepared', $calculation['lifecycle_state']);
        /** @var PayrollCalculation $row */
        $row = PayrollCalculation::query()->findOrFail($calculation['calculation_id']);
        // exact skill x scale (550) wins over skill-only (500) and scale-only (400);
        // skill-only (600) wins over scale-only (400) for writing.
        $this->assertSame('1150.00', $row->base_amount);
        $perSkill = collect($row->snapshot['per_skill'])->keyBy('skill_id');
        $this->assertSame($exact['rule_id'], $perSkill[$this->skillIds['speaking_listening']]['rule_id']);
        $this->assertSame($this->scaleS3Id, $row->snapshot['scale_id']);
    }

    public function test_missing_rule_holds_instead_of_silent_zero(): void
    {
        $fm = $this->financeManager();
        $commands = app(MaintainContractVersion::class);
        $prepared = $commands->prepare($fm, Employment::query()->findOrFail($this->employmentId), 'contract/2026-08-v2.pdf', null, '2026-08-16', null, 'p16-t3-prep');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);
        $commands->addRule($fm, $version, 'fixed_monthly', '20000.00', null, null, null, 'p16-t3-r1');
        $commands->submit($fm, $version, 'p16-t3-sub');
        $commands->approve($this->generalManager(), $version, 'p16-t3-appr');

        $this->deliveredSession('2026-08-20', 'speaking_listening', 'p16-t3-s1');

        $calculation = $this->calculate('p16-t3-calc');
        $this->assertSame('held', $calculation['lifecycle_state']);
        /** @var PayrollCalculation $row */
        $row = PayrollCalculation::query()->findOrFail($calculation['calculation_id']);
        $this->assertStringContainsString('payroll.rule_missing', (string) $row->held_reason);
        $this->assertSame(0, TeachingDeliveryFact::query()->count());
    }

    public function test_undelivered_sessions_are_not_payable_volume(): void
    {
        $officer = $this->academicOfficer();
        $scheduled = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($this->classId), new CarbonImmutable('2026-08-05'), '09:00', '11:00', 'p16-t4-s1', $this->skillIds['speaking_listening']);
        $this->assertNotNull($scheduled['session_id']);

        $calculation = $this->calculate('p16-t4-calc');
        $this->assertSame('prepared', $calculation['lifecycle_state']);
        /** @var PayrollCalculation $row */
        $row = PayrollCalculation::query()->findOrFail($calculation['calculation_id']);
        // No attendance evidence => no delivered volume; only fixed + allowance.
        $this->assertSame('21500.00', $row->base_amount);
        $this->assertSame([], $row->snapshot['delivery']);
    }

    public function test_unattributed_delivered_session_holds_the_calculation(): void
    {
        $officer = $this->academicOfficer();
        $session = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($this->classId), new CarbonImmutable('2026-08-05'), '09:00', '11:00', 'p16-t5-s1');
        app(RecordAttendance::class)->record($officer, ClassSession::query()->findOrFail($session['session_id']), Enrollment::query()->findOrFail($this->enrollmentId), 'present', 'p16-t5-att');

        $calculation = $this->calculate('p16-t5-calc');
        $this->assertSame('held', $calculation['lifecycle_state']);
        /** @var PayrollCalculation $row */
        $row = PayrollCalculation::query()->findOrFail($calculation['calculation_id']);
        $this->assertStringContainsString('payroll.skill_attribution_missing', (string) $row->held_reason);
    }

    public function test_fixed_and_allowance_prorate_by_calendar_day_overlap(): void
    {
        // New version from 2026-08-16: the prior version is superseded with
        // its window closed at 08-15, so the in-force version covers 16 of
        // the period's 31 calendar days.
        $fm = $this->financeManager();
        $commands = app(MaintainContractVersion::class);
        $prepared = $commands->prepare($fm, Employment::query()->findOrFail($this->employmentId), 'contract/2026-08-v2.pdf', null, '2026-08-16', null, 'p16-t6-prep');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);
        $commands->addRule($fm, $version, 'fixed_monthly', '3100.00', null, null, null, 'p16-t6-r1');
        $commands->addRule($fm, $version, 'allowance', '310.00', null, null, 'transport', 'p16-t6-r2');
        $commands->addRule($fm, $version, 'session_rate', '100.00', $this->skillIds['speaking_listening'], null, null, 'p16-t6-r3');
        $commands->submit($fm, $version, 'p16-t6-sub');
        $commands->approve($this->generalManager(), $version, 'p16-t6-appr');

        $this->deliveredSession('2026-08-20', 'speaking_listening', 'p16-t6-s1');

        $calculation = $this->calculate('p16-t6-calc');
        $this->assertSame('prepared', $calculation['lifecycle_state']);
        /** @var PayrollCalculation $row */
        $row = PayrollCalculation::query()->findOrFail($calculation['calculation_id']);
        // 3100 x 16/31 = 1600.00 + 310 x 16/31 = 160.00 + 1 x 100.00
        $this->assertSame('1860.00', $row->base_amount);
        $this->assertSame(16, $row->snapshot['proration']['active_days']);
        $this->assertSame(31, $row->snapshot['proration']['period_days']);
        $fixedLine = collect($row->snapshot['additive'])->firstWhere('method', 'fixed_monthly');
        $this->assertSame('3100.00', $fixedLine['contract_amount']);
        $this->assertSame(16, $fixedLine['active_days']);
        $this->assertSame(31, $fixedLine['period_days']);
        $this->assertSame('1600.00', $fixedLine['amount']);
        $allowanceLine = collect($row->snapshot['additive'])->firstWhere('method', 'allowance');
        $this->assertSame('310.00', $allowanceLine['contract_amount']);
        $this->assertSame('160.00', $allowanceLine['amount']);
        $this->assertSame('100.00', $row->snapshot['per_skill'][0]['amount']);
    }

    public function test_proration_uses_exact_cent_arithmetic_with_round_half_up(): void
    {
        $fm = $this->financeManager();
        $commands = app(MaintainContractVersion::class);

        // 1000.00 x 16/31 = 516.1290... -> 516.13
        $prepared = $commands->prepare($fm, Employment::query()->findOrFail($this->employmentId), 'contract/round-1.pdf', null, '2026-08-16', null, 'p16-t11-prep-1');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);
        $commands->addRule($fm, $version, 'fixed_monthly', '1000.00', null, null, null, 'p16-t11-r1');
        $commands->submit($fm, $version, 'p16-t11-sub-1');
        $commands->approve($this->generalManager(), $version, 'p16-t11-appr-1');
        $august = $this->calculate('p16-t11-calc-1');
        /** @var PayrollCalculation $augustRow */
        $augustRow = PayrollCalculation::query()->findOrFail($august['calculation_id']);
        $this->assertSame('516.13', $augustRow->base_amount);
        $this->assertSame(16, $augustRow->snapshot['proration']['active_days']);

        // 1000.00 x 29/30 = 966.6666... -> 966.67 (round up, non-tie)
        $prepared = $commands->prepare($fm, Employment::query()->findOrFail($this->employmentId), 'contract/round-2.pdf', null, '2026-09-02', null, 'p16-t11-prep-2');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);
        $commands->addRule($fm, $version, 'fixed_monthly', '1000.00', null, null, null, 'p16-t11-r2');
        $commands->submit($fm, $version, 'p16-t11-sub-2');
        $commands->approve($this->generalManager(), $version, 'p16-t11-appr-2');
        $september = app(MaintainPayrollPeriod::class)->open($this->grantedActor('p16-pay-period-1', ['payroll.period']), '2026-09', '2026-09-01', '2026-09-30', 'p16-t11-period');
        $septCalc = app(CalculatePayroll::class)->prepare($this->payrollPreparer(), PayrollPeriod::query()->findOrFail($september['period_id']), Employment::query()->findOrFail($this->employmentId), 'p16-t11-calc-2');
        /** @var PayrollCalculation $septRow */
        $septRow = PayrollCalculation::query()->findOrFail($septCalc['calculation_id']);
        $this->assertSame('966.67', $septRow->base_amount);
        $this->assertSame(29, $septRow->snapshot['proration']['active_days']);
        $this->assertSame(30, $septRow->snapshot['proration']['period_days']);

        // 1000.01 x 15/30 = 500.005 exactly -> round half up -> 500.01
        $prepared = $commands->prepare($fm, Employment::query()->findOrFail($this->employmentId), 'contract/round-3.pdf', null, '2026-09-16', null, 'p16-t11-prep-3');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);
        $commands->addRule($fm, $version, 'fixed_monthly', '1000.01', null, null, null, 'p16-t11-r3');
        $commands->submit($fm, $version, 'p16-t11-sub-3');
        $commands->approve($this->generalManager(), $version, 'p16-t11-appr-3');
        $septReCalc = app(CalculatePayroll::class)->prepare($this->payrollPreparer(), PayrollPeriod::query()->findOrFail($september['period_id']), Employment::query()->findOrFail($this->employmentId), 'p16-t11-calc-3');
        /** @var PayrollCalculation $tieRow */
        $tieRow = PayrollCalculation::query()->findOrFail($septReCalc['calculation_id']);
        $this->assertSame('500.01', $tieRow->base_amount);
        $this->assertSame(15, $tieRow->snapshot['proration']['active_days']);
    }

    public function test_session_qualifies_only_on_final_present_or_late_attendance(): void
    {
        $officer = $this->academicOfficer();
        // absent and excused never qualify; late and present do.
        $s1 = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($this->classId), new CarbonImmutable('2026-08-05'), '09:00', '11:00', 'p16-t12-s1', $this->skillIds['speaking_listening']);
        app(RecordAttendance::class)->record($officer, ClassSession::query()->findOrFail($s1['session_id']), Enrollment::query()->findOrFail($this->enrollmentId), 'absent', 'p16-t12-a1');
        $s2 = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($this->classId), new CarbonImmutable('2026-08-06'), '09:00', '11:00', 'p16-t12-s2', $this->skillIds['speaking_listening']);
        app(RecordAttendance::class)->record($officer, ClassSession::query()->findOrFail($s2['session_id']), Enrollment::query()->findOrFail($this->enrollmentId), 'excused', 'p16-t12-a2');
        $s3 = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($this->classId), new CarbonImmutable('2026-08-07'), '09:00', '11:00', 'p16-t12-s3', $this->skillIds['speaking_listening']);
        app(RecordAttendance::class)->record($officer, ClassSession::query()->findOrFail($s3['session_id']), Enrollment::query()->findOrFail($this->enrollmentId), 'late', 'p16-t12-a3');
        $s4 = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($this->classId), new CarbonImmutable('2026-08-08'), '09:00', '11:00', 'p16-t12-s4', $this->skillIds['speaking_listening']);
        app(RecordAttendance::class)->record($officer, ClassSession::query()->findOrFail($s4['session_id']), Enrollment::query()->findOrFail($this->enrollmentId), 'present', 'p16-t12-a4');

        $calculation = $this->calculate('p16-t12-calc');
        $this->assertSame('prepared', $calculation['lifecycle_state']);
        /** @var PayrollCalculation $row */
        $row = PayrollCalculation::query()->findOrFail($calculation['calculation_id']);
        // Only the late and present sessions bill: 20000 + 1500 + 2 x 500.
        $this->assertSame('22500.00', $row->base_amount);
        $this->assertCount(2, $row->snapshot['delivery']);
        $this->assertSame('2', $row->snapshot['per_skill'][0]['sessions']);
        $paidSessions = array_map(static fn (array $delivery): string => $delivery['session_id'], $row->snapshot['delivery']);
        $this->assertSame([$s3['session_id'], $s4['session_id']], $paidSessions);
    }

    public function test_attendance_corrections_resolve_through_the_authoritative_chain(): void
    {
        $officer = $this->academicOfficer();
        // s1: present corrected to absent -> final absent -> not payable.
        $s1 = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($this->classId), new CarbonImmutable('2026-08-05'), '09:00', '11:00', 'p16-t13-s1', $this->skillIds['speaking_listening']);
        $s1Fact = app(RecordAttendance::class)->record($officer, ClassSession::query()->findOrFail($s1['session_id']), Enrollment::query()->findOrFail($this->enrollmentId), 'present', 'p16-t13-a1');
        app(RecordAttendance::class)->correct($officer, AttendanceFact::query()->findOrFail($s1Fact['fact_id']), 'absent', 'student never arrived', 'p16-t13-c1');
        // s2: absent corrected to present -> final present -> payable.
        $s2 = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($this->classId), new CarbonImmutable('2026-08-06'), '09:00', '11:00', 'p16-t13-s2', $this->skillIds['speaking_listening']);
        $s2Fact = app(RecordAttendance::class)->record($officer, ClassSession::query()->findOrFail($s2['session_id']), Enrollment::query()->findOrFail($this->enrollmentId), 'absent', 'p16-t13-a2');
        app(RecordAttendance::class)->correct($officer, AttendanceFact::query()->findOrFail($s2Fact['fact_id']), 'present', 'late-marked by mistake', 'p16-t13-c2');
        // s3: present -> absent -> late, a two-step chain; final late -> payable.
        $s3 = app(MaintainClass::class)->scheduleSession($officer, ClassModel::query()->findOrFail($this->classId), new CarbonImmutable('2026-08-07'), '09:00', '11:00', 'p16-t13-s3', $this->skillIds['speaking_listening']);
        $s3Fact = app(RecordAttendance::class)->record($officer, ClassSession::query()->findOrFail($s3['session_id']), Enrollment::query()->findOrFail($this->enrollmentId), 'present', 'p16-t13-a3');
        $s3FirstCorrection = app(RecordAttendance::class)->correct($officer, AttendanceFact::query()->findOrFail($s3Fact['fact_id']), 'absent', 'roll called absent', 'p16-t13-c3');
        $s3FinalCorrection = app(RecordAttendance::class)->correct($officer, AttendanceFact::query()->findOrFail($s3FirstCorrection['fact_id']), 'late', 'arrived in the second half', 'p16-t13-c4');

        $calculation = $this->calculate('p16-t13-calc');
        $this->assertSame('prepared', $calculation['lifecycle_state']);
        /** @var PayrollCalculation $row */
        $row = PayrollCalculation::query()->findOrFail($calculation['calculation_id']);
        // s2 (final present) and s3 (final late) bill; s1 (final absent) does not.
        $this->assertSame('22500.00', $row->base_amount);
        $this->assertCount(2, $row->snapshot['delivery']);
        $paidSessions = array_map(static fn (array $delivery): string => $delivery['session_id'], $row->snapshot['delivery']);
        $this->assertSame([$s2['session_id'], $s3['session_id']], $paidSessions);

        // The chain is append-only history: the original present fact of s1
        // is untouched, and the final fact is the uncorrected chain tip.
        $this->assertSame('present', AttendanceFact::query()->findOrFail($s1Fact['fact_id'])->status);
        $this->assertSame('absent', AttendanceFact::query()->findOrFail($s2Fact['fact_id'])->status);
        $this->assertSame('present', AttendanceFact::query()->findOrFail($s3Fact['fact_id'])->status);
        $this->assertSame('absent', AttendanceFact::query()->findOrFail($s3FirstCorrection['fact_id'])->status);
        $this->assertSame(7, AttendanceFact::query()->count());
        // The uncorrected chain tip of s3 is the final 'late' correction.
        $s3Tip = AttendanceFact::query()->findOrFail($s3FinalCorrection['fact_id']);
        $this->assertSame('late', $s3Tip->status);
        $this->assertFalse(AttendanceFact::query()->where('corrects_id', $s3Tip->id)->exists(), 'the chain tip must be uncorrected');
        $this->assertSame(2, AttendanceFact::query()->where('session_id', $s3['session_id'])->whereNotNull('corrects_id')->count());
    }

    public function test_double_count_defense_and_replay_safe_recalculation(): void
    {
        $sessionId = $this->deliveredSession('2026-08-05', 'speaking_listening', 'p16-t7-s1');
        $first = $this->calculate('p16-t7-calc-1');
        $this->assertSame(1, TeachingDeliveryFact::query()->count());

        try {
            DB::table('teaching_delivery_facts')->insert([
                'id' => '00000000-0000-4000-8000-00000000f301',
                'payroll_calculation_id' => $first['calculation_id'],
                'session_id' => $sessionId,
                'skill_id' => $this->skillIds['speaking_listening'],
                'scheduled_on' => '2026-08-05',
                'hours' => 2,
            ]);
            $this->fail('the schema must reject paying the same session twice');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }

        $fact = TeachingDeliveryFact::query()->firstOrFail();
        try {
            DB::statement('UPDATE teaching_delivery_facts SET hours = 8 WHERE id = ?', [$fact->id]);
            $this->fail('delivery evidence is immutable');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
        try {
            DB::statement('DELETE FROM teaching_delivery_facts WHERE id = ?', [$fact->id]);
            $this->fail('delivery evidence cannot be deleted');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }

        $replay = $this->calculate('p16-t7-calc-1');
        $this->assertSame($first['calculation_id'], $replay['calculation_id']);
        $this->assertSame(1, TeachingDeliveryFact::query()->count());

        $second = $this->calculate('p16-t7-calc-2');
        $this->assertNotSame($first['calculation_id'], $second['calculation_id']);
        $this->assertDatabaseHas('payroll_calculations', ['id' => $first['calculation_id'], 'lifecycle_state' => 'superseded']);
        $this->assertSame(1, TeachingDeliveryFact::query()->count());
        $this->assertSame($second['calculation_id'], TeachingDeliveryFact::query()->firstOrFail()->payroll_calculation_id);
        /** @var PayrollCalculation $row */
        $row = PayrollCalculation::query()->findOrFail($second['calculation_id']);
        $this->assertSame('22000.00', $row->base_amount);
    }

    public function test_historical_payroll_survives_amendment_scale_change_and_skill_retirement(): void
    {
        $this->deliveredSession('2026-08-05', 'speaking_listening', 'p16-t8-s1');
        $august = $this->calculate('p16-t8-calc-1');
        app(ApprovePayrollResult::class)->approve($this->grantedActor('p16-pay-appr-1', ['payroll.approve']), PayrollCalculation::query()->findOrFail($august['calculation_id']), 'p16-t8-appr');
        /** @var PayrollCalculation $augustRow */
        $augustRow = PayrollCalculation::query()->findOrFail($august['calculation_id']);
        $augustSnapshot = $augustRow->snapshot;

        $scaleS4Id = app(MaintainScale::class)->register($this->grantedActor('p16-pay-scale-1', ['hr.scale']), 'S4', 'Expert', 4, 'p16-t8-scale')['scale_id'];
        $fm = $this->financeManager();
        $commands = app(MaintainContractVersion::class);
        $prepared = $commands->prepare($fm, Employment::query()->findOrFail($this->employmentId), 'contract/2026-09.pdf', $scaleS4Id, '2026-09-01', null, 'p16-t8-prep');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);
        $commands->addRule($fm, $version, 'fixed_monthly', '22000.00', null, null, null, 'p16-t8-r1');
        $commands->addRule($fm, $version, 'session_rate', '700.00', $this->skillIds['speaking_listening'], null, null, 'p16-t8-r2');
        $commands->submit($fm, $version, 'p16-t8-sub');
        $commands->approve($this->generalManager(), $version, 'p16-t8-v-appr');

        app(MaintainSkill::class)->retire($this->grantedActor('p16-pay-skill-1', ['academic.skill']), Skill::query()->findOrFail($this->skillIds['reading_vocabulary']), 'p16-t8-retire');

        $september = app(MaintainPayrollPeriod::class)->open($this->grantedActor('p16-pay-period-1', ['payroll.period']), '2026-09', '2026-09-01', '2026-09-30', 'p16-t8-per');
        $septSession = app(MaintainClass::class)->scheduleSession($this->academicOfficer(), ClassModel::query()->findOrFail($this->classId), new CarbonImmutable('2026-09-03'), '09:00', '11:00', 'p16-t8-s2', $this->skillIds['speaking_listening']);
        app(RecordAttendance::class)->record($this->academicOfficer(), ClassSession::query()->findOrFail($septSession['session_id']), Enrollment::query()->findOrFail($this->enrollmentId), 'present', 'p16-t8-att2');

        $septCalc = app(CalculatePayroll::class)->prepare($this->payrollPreparer(), PayrollPeriod::query()->findOrFail($september['period_id']), Employment::query()->findOrFail($this->employmentId), 'p16-t8-calc-2');
        /** @var PayrollCalculation $septRow */
        $septRow = PayrollCalculation::query()->findOrFail($septCalc['calculation_id']);
        $this->assertSame('22700.00', $septRow->base_amount);
        $this->assertSame($scaleS4Id, $septRow->snapshot['scale_id']);
        $this->assertSame(2, $septRow->snapshot['version_no']);

        /** @var PayrollCalculation $augustReloaded */
        $augustReloaded = PayrollCalculation::query()->findOrFail($august['calculation_id']);
        $this->assertSame($augustSnapshot, $augustReloaded->snapshot);
        $this->assertSame('22000.00', $augustReloaded->base_amount);

        try {
            DB::statement('UPDATE payroll_calculations SET snapshot = ? WHERE id = ?', [json_encode(['forged' => true]), $august['calculation_id']]);
            $this->fail('approved payroll history is immutable');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }

        app(ApprovePayrollResult::class)->approve($this->grantedActor('p16-pay-appr-1', ['payroll.approve']), PayrollCalculation::query()->findOrFail($septCalc['calculation_id']), 'p16-t8-appr-2');
        try {
            DB::statement('UPDATE payroll_calculations SET base_amount = 1 WHERE id = ?', [$septCalc['calculation_id']]);
            $this->fail('approved calculated amounts cannot be rewritten');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
    }

    public function test_calculation_requires_capability_and_denials_are_audited(): void
    {
        $this->deliveredSession('2026-08-05', 'speaking_listening', 'p16-t9-s1');
        $intruder = $this->actorWithoutAnyCapability('p16-pay-intruder-1');

        try {
            app(CalculatePayroll::class)->prepare($intruder, PayrollPeriod::query()->findOrFail($this->periodId), Employment::query()->findOrFail($this->employmentId), 'p16-t9-calc');
            $this->fail('payroll calculation requires the payroll.calculate capability');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('payroll.calculate_denied', $denial->errorCode());
        }
        $this->assertSame(1, AuditEvent::query()->where('operation', 'payroll.calculation.prepare.denied')->where('actor_id', 'p16-pay-intruder-1')->count());
        $this->assertSame(0, PayrollCalculation::query()->count());
    }

    public function test_two_teachers_same_skill_different_contracts_do_not_cross_bill(): void
    {
        $hrManager = $this->grantedActor('p16-pay-hr-1', ['hr.employ']);
        $this->personWithAuthority('p16-pay-teacher-2', []);
        $otherEmployment = app(MaintainEmployment::class)->employ($hrManager, 'p16-pay-teacher-2', 'p16-t10-emp');

        // A session delivered by the setUp teacher must never bill the other employment.
        $this->deliveredSession('2026-08-05', 'speaking_listening', 'p16-t10-s1');

        $calculation = app(CalculatePayroll::class)->prepare($this->payrollPreparer(), PayrollPeriod::query()->findOrFail($this->periodId), Employment::query()->findOrFail($otherEmployment['employment_id']), 'p16-t10-calc');
        $this->assertSame('held', $calculation['lifecycle_state']);
        /** @var PayrollCalculation $row */
        $row = PayrollCalculation::query()->findOrFail($calculation['calculation_id']);
        $this->assertStringContainsString('contract-silent', (string) $row->held_reason);
        $this->assertSame(0, TeachingDeliveryFact::query()->count());
    }
}
