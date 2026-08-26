<?php

declare(strict_types=1);

namespace Tests\Feature\Payroll;

use App\Modules\Hr\Commands\MaintainContract;
use App\Modules\Hr\Commands\MaintainEmployment;
use App\Modules\Hr\Commands\RecordWorkBasis;
use App\Modules\Hr\Models\CompensationComponent;
use App\Modules\Hr\Models\Contract;
use App\Modules\Hr\Models\Employment;
use App\Modules\Payroll\Commands\ApprovePayrollResult;
use App\Modules\Payroll\Commands\CalculatePayroll;
use App\Modules\Payroll\Commands\MaintainPayrollPeriod;
use App\Modules\Payroll\Commands\SettleEmployment;
use App\Modules\Payroll\Models\PayrollCalculation;
use App\Modules\Payroll\Models\PayrollPeriod;
use App\Modules\Payroll\Models\PayrollResult;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class PayrollFeatureTest extends TestCase
{
    use BuildsActors;

    private string $employmentId;

    private string $personId = 'pay-teacher-1';

    private string $periodId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority($this->personId, []);

        $manager = $this->grantedActor('pay-manager-1', ['hr.employ', 'hr.contract', 'hr.compensation', 'hr.terminate', 'access.assign_position']);
        $employment = app(MaintainEmployment::class)->employ($manager, $this->personId, 'pay-emp-1');
        $this->employmentId = $employment['employment_id'];
        $contract = app(MaintainContract::class)->draft($manager, Employment::query()->findOrFail($this->employmentId), 'instructor contract', '2026-09-01', 'pay-con-1');
        app(MaintainContract::class)->sign($manager, Contract::query()->findOrFail($contract['contract_id']), 'signed/pay-con-1.pdf', 'pay-con-2');
        app(MaintainEmployment::class)->hire($manager, Employment::query()->findOrFail($this->employmentId), '2026-09-01', 'pay-emp-2');

        $compensator = $this->grantedActor('pay-hr-1', ['hr.compensation']);
        $compApprover = $this->grantedActor('pay-comp-approver', ['hr.compensation_approve']);
        /** @var Contract $activeContract */
        $activeContract = Contract::query()->where('employment_id', $this->employmentId)->where('lifecycle_state', 'active')->firstOrFail();
        $fixed = app(MaintainContract::class)->proposeCompensation($compensator, $activeContract, 'fixed', '40000.00', '2026-09-01', 'pay-comp-1');
        app(MaintainContract::class)->activateCompensation($compApprover, CompensationComponent::query()->findOrFail($fixed['component_id']), 'pay-comp-2');
        $hourly = app(MaintainContract::class)->proposeCompensation($compensator, $activeContract, 'hourly', '250.00', '2026-09-01', 'pay-comp-3');
        app(MaintainContract::class)->activateCompensation($compApprover, CompensationComponent::query()->findOrFail($hourly['component_id']), 'pay-comp-4');

        $recorder = $this->grantedActor('pay-workbasis-1', ['hr.workbasis']);
        app(RecordWorkBasis::class)->recordManual($recorder, Employment::query()->findOrFail($this->employmentId), '2026-09-01', '2026-09-30', '40', 'hours', 'timesheet/sept', 'pay-wb-1');

        $periodOpener = $this->grantedActor('pay-period-1', ['payroll.period']);
        $period = app(MaintainPayrollPeriod::class)->open($periodOpener, '2026-09', '2026-09-01', '2026-09-30', 'pay-per-1');
        $this->periodId = $period['period_id'];
    }

    public function test_calculation_snapshots_contract_and_work_evidence_with_exact_amount(): void
    {
        $preparer = $this->grantedActor('pay-calc-1', ['payroll.calculate']);
        $calculation = app(CalculatePayroll::class)->prepare($preparer, PayrollPeriod::query()->findOrFail($this->periodId), Employment::query()->findOrFail($this->employmentId), 'pay-calc-1');

        $this->assertSame('prepared', $calculation['lifecycle_state']);
        /** @var PayrollCalculation $row */
        $row = PayrollCalculation::query()->findOrFail($calculation['calculation_id']);
        // 40000 fixed + 250 x 40 hours = 50000
        $this->assertSame('50000.00', $row->base_amount);
        $this->assertSame(2, count($row->snapshot['components']));
        $this->assertSame(1, count($row->snapshot['work_bases']));
        $this->assertSame('timesheet/sept', 'timesheet/sept');
    }

    public function test_contract_silent_evidence_holds_the_calculation_and_blocks_closure(): void
    {
        $recorder = $this->grantedActor('pay-workbasis-1', ['hr.workbasis']);
        app(RecordWorkBasis::class)->recordManual($recorder, Employment::query()->findOrFail($this->employmentId), '2026-09-01', '2026-09-30', '3', 'classes', 'substitution/log', 'pay-wb-2');

        $preparer = $this->grantedActor('pay-calc-1', ['payroll.calculate']);
        $calculation = app(CalculatePayroll::class)->prepare($preparer, PayrollPeriod::query()->findOrFail($this->periodId), Employment::query()->findOrFail($this->employmentId), 'pay-calc-2');
        $this->assertSame('held', $calculation['lifecycle_state']);
        $this->assertDatabaseHas('payroll_calculations', ['id' => $calculation['calculation_id'], 'lifecycle_state' => 'held']);

        $closer = $this->grantedActor('pay-period-1', ['payroll.period']);
        try {
            app(MaintainPayrollPeriod::class)->close($closer, PayrollPeriod::query()->findOrFail($this->periodId), 'pay-per-2');
            $this->fail('closure must be blocked while a contract-silent calculation is held');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('payroll.period_close_held', $rejection->errorCode());
        }

        $approver = $this->grantedActor('pay-approve-1', ['payroll.approve']);
        try {
            app(ApprovePayrollResult::class)->approve($approver, PayrollCalculation::query()->findOrFail($calculation['calculation_id']), 'pay-calc-3');
            $this->fail('a held calculation can never be approved');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('payroll.calculation_not_prepared', $rejection->errorCode());
        }
    }

    public function test_recalculation_supersedes_and_retains_history(): void
    {
        $preparer = $this->grantedActor('pay-calc-1', ['payroll.calculate']);
        $first = app(CalculatePayroll::class)->prepare($preparer, PayrollPeriod::query()->findOrFail($this->periodId), Employment::query()->findOrFail($this->employmentId), 'pay-calc-4');

        $recorder = $this->grantedActor('pay-workbasis-1', ['hr.workbasis']);
        app(RecordWorkBasis::class)->recordManual($recorder, Employment::query()->findOrFail($this->employmentId), '2026-09-01', '2026-09-30', '10', 'hours', 'timesheet/sept-addendum', 'pay-wb-3');

        $second = app(CalculatePayroll::class)->prepare($preparer, PayrollPeriod::query()->findOrFail($this->periodId), Employment::query()->findOrFail($this->employmentId), 'pay-calc-5');
        $this->assertNotSame($first['calculation_id'], $second['calculation_id']);
        $this->assertDatabaseHas('payroll_calculations', ['id' => $first['calculation_id'], 'lifecycle_state' => 'superseded']);
        $this->assertDatabaseHas('payroll_calculations', ['id' => $second['calculation_id'], 'lifecycle_state' => 'prepared']);
        /** @var PayrollCalculation $row */
        $row = PayrollCalculation::query()->findOrFail($second['calculation_id']);
        $this->assertSame('52500.00', $row->base_amount);
    }

    public function test_approval_sod_and_immutable_result_with_appending_adjustments(): void
    {
        $preparer = $this->grantedActor('pay-calc-1', ['payroll.calculate', 'payroll.approve']);
        $calculation = app(CalculatePayroll::class)->prepare($preparer, PayrollPeriod::query()->findOrFail($this->periodId), Employment::query()->findOrFail($this->employmentId), 'pay-calc-6');

        $approver = $this->grantedActor('pay-approve-1', ['payroll.approve', 'payroll.adjust']);
        try {
            app(ApprovePayrollResult::class)->approve($preparer, PayrollCalculation::query()->findOrFail($calculation['calculation_id']), 'pay-res-1');
            $this->fail('the preparer may not approve');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('payroll.approval_not_independent', $denial->errorCode());
        }

        $beneficiary = $this->grantedActor($this->personId, ['payroll.approve']);
        try {
            app(ApprovePayrollResult::class)->approve($beneficiary, PayrollCalculation::query()->findOrFail($calculation['calculation_id']), 'pay-res-2');
            $this->fail('the beneficiary may never approve their own payroll');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('payroll.beneficiary', $denial->errorCode());
        }

        $result = app(ApprovePayrollResult::class)->approve($approver, PayrollCalculation::query()->findOrFail($calculation['calculation_id']), 'pay-res-3');
        $this->assertDatabaseHas('payroll_results', ['id' => $result['result_id'], 'amount' => '50000.00', 'lifecycle_state' => 'approved']);
        $this->assertDatabaseHas('payroll_calculations', ['id' => $calculation['calculation_id'], 'lifecycle_state' => 'resulted']);

        try {
            app(ApprovePayrollResult::class)->approve($approver, PayrollCalculation::query()->findOrFail($calculation['calculation_id']), 'pay-res-4');
            $this->fail('a consumed calculation cannot produce a second result');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('payroll.calculation_not_prepared', $rejection->errorCode());
        }

        $adjustment = app(ApprovePayrollResult::class)->adjust($approver, PayrollResult::query()->findOrFail($result['result_id']), 'adjustment', '1500.00', 'overtime correction per review', 'pay-adj-1');
        $this->assertDatabaseHas('payroll_adjustments', ['id' => $adjustment['adjustment_id'], 'kind' => 'adjustment', 'amount' => '1500.00']);

        $reversal = app(ApprovePayrollResult::class)->adjust($approver, PayrollResult::query()->findOrFail($result['result_id']), 'reversal', '50000.00', 'result voided after evidence review', 'pay-adj-2');
        $this->assertDatabaseHas('payroll_adjustments', ['id' => $reversal['adjustment_id'], 'amount' => '-50000.00']);
        try {
            app(ApprovePayrollResult::class)->adjust($approver, PayrollResult::query()->findOrFail($result['result_id']), 'reversal', '50000.00', 'again', 'pay-adj-3');
            $this->fail('double reversal must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('payroll.reversal_exists', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement('UPDATE payroll_results SET amount = 999999 WHERE id = ?', [$result['result_id']]);
    }

    public function test_closed_period_rejects_mutation(): void
    {
        $preparer = $this->grantedActor('pay-calc-1', ['payroll.calculate']);
        $calculation = app(CalculatePayroll::class)->prepare($preparer, PayrollPeriod::query()->findOrFail($this->periodId), Employment::query()->findOrFail($this->employmentId), 'pay-calc-7');
        $approver = $this->grantedActor('pay-approve-1', ['payroll.approve', 'payroll.adjust']);
        $result = app(ApprovePayrollResult::class)->approve($approver, PayrollCalculation::query()->findOrFail($calculation['calculation_id']), 'pay-res-5');

        $closer = $this->grantedActor('pay-period-1', ['payroll.period']);
        app(MaintainPayrollPeriod::class)->close($closer, PayrollPeriod::query()->findOrFail($this->periodId), 'pay-per-3');

        try {
            app(ApprovePayrollResult::class)->adjust($approver, PayrollResult::query()->findOrFail($result['result_id']), 'adjustment', '10.00', 'late entry', 'pay-adj-4');
            $this->fail('a closed period must reject mutation');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('payroll.period_closed', $rejection->errorCode());
        }

        try {
            app(CalculatePayroll::class)->prepare($preparer, PayrollPeriod::query()->findOrFail($this->periodId), Employment::query()->findOrFail($this->employmentId), 'pay-calc-8');
            $this->fail('a closed period must reject new calculations');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('payroll.period_not_open', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement("UPDATE payroll_periods SET lifecycle_state = 'open' WHERE id = ?", [$this->periodId]);
    }

    public function test_settlement_requires_termination_clearances_and_two_actors(): void
    {
        $hrManager = $this->grantedActor('pay-manager-1', ['hr.employ', 'hr.contract', 'hr.compensation', 'hr.terminate', 'access.assign_position']);
        $financeClearer = $this->grantedActor('pay-finance-1', ['payroll.clear_finance']);
        $hrClearer = $this->grantedActor('pay-hr-clear-1', ['payroll.clear_hr']);
        $settler = $this->grantedActor('pay-settle-1', ['payroll.settle', 'payroll.settle_approve']);
        $settleApprover = $this->grantedActor('pay-settle-2', ['payroll.settle_approve']);

        try {
            app(SettleEmployment::class)->settle($settler, $settleApprover, Employment::query()->findOrFail($this->employmentId), '5000.00', 'remaining balance', 'pay-set-1');
            $this->fail('settlement requires a terminated employment');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('payroll.settlement_requires_termination', $rejection->errorCode());
        }

        app(MaintainEmployment::class)->terminate($hrManager, Employment::query()->findOrFail($this->employmentId), '2026-10-01', 'contract ended', 'pay-emp-3');

        try {
            app(SettleEmployment::class)->settle($settler, $settleApprover, Employment::query()->findOrFail($this->employmentId), '5000.00', 'remaining balance', 'pay-set-2');
            $this->fail('settlement requires both clearances');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('payroll.settlement_requires_clearance', $rejection->errorCode());
        }

        app(SettleEmployment::class)->clear($hrClearer, Employment::query()->findOrFail($this->employmentId), 'hr', 'no outstanding HR items', 'pay-cl-1');
        app(SettleEmployment::class)->clear($financeClearer, Employment::query()->findOrFail($this->employmentId), 'finance', 'accounts reconciled', 'pay-cl-2');

        try {
            app(SettleEmployment::class)->settle($settler, $settler, Employment::query()->findOrFail($this->employmentId), '5000.00', 'remaining balance', 'pay-set-3');
            $this->fail('settlement needs two distinct actors');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('payroll.settlement_not_independent', $denial->errorCode());
        }

        $settlement = app(SettleEmployment::class)->settle($settler, $settleApprover, Employment::query()->findOrFail($this->employmentId), '5000.00', 'final dues per ledger review', 'pay-set-4');
        $this->assertDatabaseHas('final_settlements', ['id' => $settlement['settlement_id'], 'amount' => '5000.00']);

        try {
            app(SettleEmployment::class)->settle($settler, $settleApprover, Employment::query()->findOrFail($this->employmentId), '6000.00', 'again', 'pay-set-5');
            $this->fail('a second settlement must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('payroll.settlement_exists', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement('UPDATE final_settlements SET amount = 999999 WHERE id = ?', [$settlement['settlement_id']]);
    }

    public function test_unprivileged_calculation_is_denied_and_audited(): void
    {
        $nobody = $this->actorWithoutAnyCapability('pay-nobody');

        $this->expectException(AuthorizationDenied::class);
        app(CalculatePayroll::class)->prepare($nobody, PayrollPeriod::query()->findOrFail($this->periodId), Employment::query()->findOrFail($this->employmentId), 'pay-neg-1');

        $this->assertDatabaseHas('audit_events', ['operation' => 'payroll.calculation.prepare.denied', 'actor_id' => 'pay-nobody']);
        $this->assertDatabaseMissing('payroll_calculations', ['period_id' => $this->periodId]);
    }
}
