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
use App\Modules\Academic\Models\Skill;
use App\Modules\Academic\Models\TeacherAssignment;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Audit\Models\AuditEvent;
use App\Modules\Hr\Commands\MaintainContractVersion;
use App\Modules\Hr\Commands\MaintainEmployment;
use App\Modules\Hr\Commands\MaintainScale;
use App\Modules\Hr\Commands\RecordWorkBasis;
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
        $this->scaleS3Id = app(MaintainScale::class)->register($this->grantedActor('p16-pay-scale-1', ['hr.scale']), 'S3', 'Senior instructor', 3, 'p16-pay-scale-reg-1')['scale_id'];

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
        app(DecideAdmission::class)->decide(
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

    public function test_manual_volume_conflicting_with_authoritative_evidence_holds(): void
    {
        $this->deliveredSession('2026-08-05', 'speaking_listening', 'p16-t6-s1');
        app(RecordWorkBasis::class)->recordManual($this->grantedActor('p16-pay-wb-1', ['hr.workbasis']), Employment::query()->findOrFail($this->employmentId), '2026-08-01', '2026-08-31', '40', 'hours', 'timesheet/aug', 'p16-t6-wb');

        $calculation = $this->calculate('p16-t6-calc');
        $this->assertSame('held', $calculation['lifecycle_state']);
        /** @var PayrollCalculation $row */
        $row = PayrollCalculation::query()->findOrFail($calculation['calculation_id']);
        $this->assertStringContainsString('payroll.volume_conflict', (string) $row->held_reason);
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

        $scaleS4Id = app(MaintainScale::class)->register($this->grantedActor('p16-pay-scale-1', ['hr.scale']), 'S4', 'Lead instructor', 4, 'p16-t8-scale')['scale_id'];
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
