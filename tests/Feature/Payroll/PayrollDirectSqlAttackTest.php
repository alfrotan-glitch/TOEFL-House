<?php

declare(strict_types=1);

namespace Tests\Feature\Payroll;

use App\Modules\Hr\Commands\MaintainContractVersion;
use App\Modules\Hr\Commands\MaintainEmployment;
use App\Modules\Hr\Models\ContractVersion;
use App\Modules\Hr\Models\Employment;
use App\Modules\Payroll\Commands\ApprovePayrollResult;
use App\Modules\Payroll\Commands\CalculatePayroll;
use App\Modules\Payroll\Commands\MaintainPayrollPeriod;
use App\Modules\Payroll\Commands\SettleEmployment;
use App\Modules\Payroll\Models\PayrollCalculation;
use App\Modules\Payroll\Models\PayrollPeriod;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * Direct-SQL attack surface for the payroll derivation guards. Every fixture
 * state below is built through the legitimate domain commands; the attack is
 * then a raw INSERT that bypasses the application. The schema — not the
 * application — must reject each forged payable.
 */
final class PayrollDirectSqlAttackTest extends TestCase
{
    use BuildsActors;

    private string $employmentId;

    private string $personId = 'atk-teacher-1';

    private string $periodId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority($this->personId, []);

        $manager = $this->grantedActor('atk-manager-1', ['hr.employ', 'hr.terminate', 'access.assign_position']);
        $employment = app(MaintainEmployment::class)->employ($manager, $this->personId, 'atk-emp-1');
        $this->employmentId = $employment['employment_id'];

        $fm = $this->grantedActor('atk-fm-1', ['hr.contract.prepare']);
        $commands = app(MaintainContractVersion::class);
        $prepared = $commands->prepare($fm, Employment::query()->findOrFail($this->employmentId), 'contract/2026-09.pdf', null, '2026-09-01', '2026-09-30', 'atk-con-1');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);
        $commands->addRule($fm, $version, 'fixed_monthly', '40000.00', null, null, null, 'atk-r-fix');
        $commands->addRule($fm, $version, 'allowance', '2000.00', null, null, 'housing', 'atk-r-al');
        $commands->submit($fm, $version, 'atk-con-2');
        $commands->approve($this->grantedActor('atk-gm-1', ['hr.contract.approve']), $version, 'atk-con-3');

        app(MaintainEmployment::class)->hire($manager, Employment::query()->findOrFail($this->employmentId), '2026-09-01', 'atk-emp-2');

        $periodOpener = $this->grantedActor('atk-period-1', ['payroll.period']);
        $period = app(MaintainPayrollPeriod::class)->open($periodOpener, '2026-09', '2026-09-01', '2026-09-30', 'atk-per-1');
        $this->periodId = $period['period_id'];
    }

    private function preparedCalculation(string $key): PayrollCalculation
    {
        $preparer = $this->grantedActor('atk-calc-1', ['payroll.calculate']);
        $calculation = app(CalculatePayroll::class)->prepare($preparer, PayrollPeriod::query()->findOrFail($this->periodId), Employment::query()->findOrFail($this->employmentId), $key);

        return PayrollCalculation::query()->findOrFail($calculation['calculation_id']);
    }

    /** @return array{result_id: string} */
    private function approvedResult(PayrollCalculation $calculation, string $key): array
    {
        $approver = $this->grantedActor('atk-approve-1', ['payroll.approve']);

        return app(ApprovePayrollResult::class)->approve($approver, $calculation, $key);
    }

    public function test_direct_sql_cannot_forge_a_result_amount(): void
    {
        $calculation = $this->preparedCalculation('atk-calc-f1');
        $this->assertSame('42000.00', $calculation->base_amount);

        // A raw INSERT that inflates the payable beyond the calculation base.
        $this->expectException(QueryException::class);
        DB::table('payroll_results')->insert([
            'id' => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01',
            'calculation_id' => $calculation->id,
            'period_id' => $calculation->period_id,
            'employment_id' => $calculation->employment_id,
            'amount' => '999999.00',
            'lifecycle_state' => 'approved',
            'approved_by' => 'atk-direct-sql-forger',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_result_a_superseded_calculation(): void
    {
        $first = $this->preparedCalculation('atk-calc-f2');
        $this->preparedCalculation('atk-calc-f3');
        $this->assertSame('superseded', PayrollCalculation::query()->findOrFail($first->id)->lifecycle_state);

        // Only a prepared calculation may ever carry a result.
        $this->expectException(QueryException::class);
        DB::table('payroll_results')->insert([
            'id' => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02',
            'calculation_id' => $first->id,
            'period_id' => $first->period_id,
            'employment_id' => $first->employment_id,
            'amount' => $first->base_amount,
            'lifecycle_state' => 'approved',
            'approved_by' => 'atk-direct-sql-forger',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_adjust_after_the_period_is_closed(): void
    {
        $calculation = $this->preparedCalculation('atk-calc-f4');
        $result = $this->approvedResult($calculation, 'atk-res-f4');

        $closer = $this->grantedActor('atk-period-1', ['payroll.period']);
        app(MaintainPayrollPeriod::class)->close($closer, PayrollPeriod::query()->findOrFail($this->periodId), 'atk-per-2');

        // A closed period rejects corrections — even from raw SQL.
        $this->expectException(QueryException::class);
        DB::table('payroll_adjustments')->insert([
            'id' => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee04',
            'result_id' => $result['result_id'],
            'kind' => 'adjustment',
            'amount' => '500.00',
            'reason' => 'late correction slipped in from raw sql',
            'approved_by' => 'atk-direct-sql-forger',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_reverse_a_result_twice(): void
    {
        $calculation = $this->preparedCalculation('atk-calc-f5');
        $result = $this->approvedResult($calculation, 'atk-res-f5');

        DB::table('payroll_adjustments')->insert([
            'id' => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee05',
            'result_id' => $result['result_id'],
            'kind' => 'reversal',
            'amount' => '-42000.00',
            'reason' => 'first raw-sql reversal',
            'approved_by' => 'atk-direct-sql-forger',
            'created_at' => now(), 'updated_at' => now(),
        ]);

        $this->expectException(QueryException::class);
        DB::table('payroll_adjustments')->insert([
            'id' => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee06',
            'result_id' => $result['result_id'],
            'kind' => 'reversal',
            'amount' => '-42000.00',
            'reason' => 'second raw-sql reversal must be impossible',
            'approved_by' => 'atk-direct-sql-forger',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_settle_without_both_clearances(): void
    {
        $manager = $this->grantedActor('atk-manager-1', ['hr.employ', 'hr.terminate', 'access.assign_position']);
        app(MaintainEmployment::class)->terminate($manager, Employment::query()->findOrFail($this->employmentId), '2026-10-01', 'contract ended', 'atk-emp-3');

        // Terminated but no clearances: a raw settlement INSERT must fail.
        $this->expectException(QueryException::class);
        DB::table('final_settlements')->insert([
            'id' => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee07',
            'employment_id' => $this->employmentId,
            'amount' => '5000.00',
            'basis' => 'raw sql settlement',
            'prepared_by' => 'atk-settle-prep',
            'approved_by' => 'atk-settle-appr',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_double_settle(): void
    {
        $manager = $this->grantedActor('atk-manager-1', ['hr.employ', 'hr.terminate', 'access.assign_position']);
        app(MaintainEmployment::class)->terminate($manager, Employment::query()->findOrFail($this->employmentId), '2026-10-01', 'contract ended', 'atk-emp-4');
        app(SettleEmployment::class)->clear($this->grantedActor('atk-hr-clear-1', ['payroll.clear_hr']), Employment::query()->findOrFail($this->employmentId), 'hr', 'no outstanding HR items', 'atk-cl-1');
        app(SettleEmployment::class)->clear($this->grantedActor('atk-fin-clear-1', ['payroll.clear_finance']), Employment::query()->findOrFail($this->employmentId), 'finance', 'accounts reconciled', 'atk-cl-2');

        $settler = $this->grantedActor('atk-settle-1', ['payroll.settle']);
        $settleApprover = $this->grantedActor('atk-settle-2', ['payroll.settle_approve']);
        app(SettleEmployment::class)->settle($settler, $settleApprover, Employment::query()->findOrFail($this->employmentId), '5000.00', 'final dues per ledger review', 'atk-set-1');

        // Two distinct, non-beneficiary actors: a second settlement must be impossible.
        $this->expectException(QueryException::class);
        DB::table('final_settlements')->insert([
            'id' => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee08',
            'employment_id' => $this->employmentId,
            'amount' => '1.00',
            'basis' => 'forged second settlement via raw sql',
            'prepared_by' => 'atk-settle-prep',
            'approved_by' => 'atk-settle-appr',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_settle_with_the_beneficiary_as_actor(): void
    {
        $manager = $this->grantedActor('atk-manager-1', ['hr.employ', 'hr.terminate', 'access.assign_position']);
        app(MaintainEmployment::class)->terminate($manager, Employment::query()->findOrFail($this->employmentId), '2026-10-01', 'contract ended', 'atk-emp-5');
        app(SettleEmployment::class)->clear($this->grantedActor('atk-hr-clear-1', ['payroll.clear_hr']), Employment::query()->findOrFail($this->employmentId), 'hr', 'no outstanding HR items', 'atk-cl-3');
        app(SettleEmployment::class)->clear($this->grantedActor('atk-fin-clear-1', ['payroll.clear_finance']), Employment::query()->findOrFail($this->employmentId), 'finance', 'accounts reconciled', 'atk-cl-4');

        // No settlement exists yet, so this isolates the beneficiary check:
        // the beneficiary may never approve their own settlement.
        $this->expectException(QueryException::class);
        DB::table('final_settlements')->insert([
            'id' => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee09',
            'employment_id' => $this->employmentId,
            'amount' => '5000.00',
            'basis' => 'self-approved settlement via raw sql',
            'prepared_by' => 'atk-settle-prep',
            'approved_by' => $this->personId,
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }
}
