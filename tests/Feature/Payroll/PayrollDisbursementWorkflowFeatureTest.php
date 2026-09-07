<?php

declare(strict_types=1);

namespace Tests\Feature\Payroll;

use App\Modules\Finance\Commands\MaintainChartOfAccounts;
use App\Modules\Finance\Commands\MaintainFinancialPeriod;
use App\Modules\Finance\Commands\RecognizePayrollLiability;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\PayrollLiabilityFact;
use App\Modules\Hr\Commands\MaintainEmployment;
use App\Modules\Hr\Models\Employment;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Payroll\Commands\MaintainPayrollPeriod;
use App\Modules\Payroll\Models\PayrollResult;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * Payroll → salary calculation → approval → disbursement (ledger) over the
 * real HTTP surface. These tests pin four genuine defects found on the
 * payroll E2E journey:
 *
 *  - preparing a contract version WITHOUT a scale (the normal case) 500'd
 *    because the controller read the omitted nullable key directly;
 *  - an allowance compensation rule could never be added over the console
 *    because the label the domain requires was hard-coded to null;
 *  - the JSON payroll "calculate" endpoint was mis-wired (the route has no
 *    period path segment, so the controller received no period);
 *  - a balanced journal could be sourced directly from Payroll evidence,
 *    bypassing Finance liability recognition; the Finance fact now becomes the
 *    sole payroll disbursement source and can be paid exactly once.
 */
final class PayrollDisbursementWorkflowFeatureTest extends TestCase
{
    use BuildsActors;

    private const PASSWORD = 'pdw-password-1';

    private string $employmentId;

    private string $payrollPeriodId;

    private string $financialPeriodId;

    private string $cashAccountId;

    private string $expenseAccountId;

    protected function setUp(): void
    {
        parent::setUp();

        $teacherPerson = 'pdw-teacher-1';
        $this->personWithAuthority($teacherPerson, []);

        $hrManager = $this->grantedActor('pdw-hr-1', ['hr.employ']);
        $employment = app(MaintainEmployment::class)->employ($hrManager, $teacherPerson, 'pdw-emp-1');
        $this->employmentId = $employment['employment_id'];

        $this->makeLogin('pdw-contract-prep', ['hr.contract.prepare'], 'preparer');
        $this->makeLogin('pdw-contract-appr', ['hr.contract.approve'], 'contractapprover');
        $this->makeLogin('pdw-calc', ['payroll.calculate'], 'calculator');
        $this->makeLogin('pdw-appr', ['payroll.approve'], 'approver');
        $this->makeLogin('pdw-cash', ['finance.chart', 'finance.journal', 'finance.period', 'finance.payroll_liability'], 'cashier');
        $this->makeLogin('pdw-nobody', [], 'nobody');

        $opener = $this->grantedActor('pdw-period-1', ['payroll.period']);
        $period = app(MaintainPayrollPeriod::class)->open($opener, '2026-09', '2026-09-01', '2026-09-30', 'pdw-per-1');
        $this->payrollPeriodId = $period['period_id'];

        $financeOpener = $this->grantedActor('pdw-fperiod-1', ['finance.period']);
        $fPeriod = app(MaintainFinancialPeriod::class)->open($financeOpener, 'FIN-2026-09', '2026-09-01', '2026-09-30', 'pdw-fper-1');
        $this->financialPeriodId = $fPeriod['period_id'];

        $chart = $this->grantedActor('pdw-chart-1', ['finance.chart']);
        $cash = app(MaintainChartOfAccounts::class)->define($chart, '1010', 'Cash at Bank', 'asset', 'pdw-acc-cash');
        $exp = app(MaintainChartOfAccounts::class)->define($chart, '5100', 'Teacher Salary Expense', 'expense', 'pdw-acc-exp');
        $this->cashAccountId = $cash['account_id'];
        $this->expenseAccountId = $exp['account_id'];
    }

    /** @param list<string> $capabilities */
    private function makeLogin(string $personId, array $capabilities, string $username): void
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make(self::PASSWORD),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => self::PASSWORD])->assertRedirect('/');
    }

    private function prepareInForceSalaryContract(): string
    {
        // Regression (F-P1): preparing a version WITHOUT a scale must not 500.
        $this->signIn('preparer');
        $this->post('/hr/versions/prepare', [
            'employment_id' => $this->employmentId,
            'terms_ref' => 'contract/2026-09/sal.pdf',
            'effective_from' => '2026-09-01',
            'effective_to' => '2026-12-31',
        ])->assertRedirect('/hr/contracts');
        $versionId = DB::table('contract_versions')
            ->join('contracts', 'contracts.id', '=', 'contract_versions.contract_id')
            ->where('contracts.employment_id', $this->employmentId)
            ->orderByDesc('contract_versions.id')->value('contract_versions.id');
        $versionId = (string) $versionId;

        $this->post('/hr/versions/'.$versionId.'/rule', [
            'method' => 'fixed_monthly', 'rate' => '1000.00',
        ])->assertRedirect('/hr/contracts');
        // Regression (F-P2): an allowance rule with a label must be accepted
        // (previously the label was dropped and the domain rejected the line).
        $this->post('/hr/versions/'.$versionId.'/rule', [
            'method' => 'allowance', 'rate' => '100.00', 'label' => 'housing',
        ])->assertRedirect('/hr/contracts');
        $this->post('/hr/versions/'.$versionId.'/submit')->assertRedirect('/hr/contracts');
        $this->post('/logout');

        $this->signIn('contractapprover');
        $this->post('/hr/versions/'.$versionId.'/approve')->assertRedirect('/hr/contracts');
        $this->post('/logout');

        // With an in-force contract the candidate can now be hired (active payroll scope).
        $hrManager = $this->grantedActor('pdw-hr-hire-1', ['hr.employ']);
        app(MaintainEmployment::class)->hire($hrManager, Employment::query()->findOrFail($this->employmentId), '2026-09-01', 'pdw-emp-hire');

        return $versionId;
    }

    /** @return array{result_id: string} */
    private function calculateAndApprove(): array
    {
        // Regression (F-P3): the JSON calculate endpoint reads period from the body.
        $this->signIn('calculator');
        $this->postJson('/api/v1/payroll/calculations', [
            'period_id' => $this->payrollPeriodId,
            'employment_id' => $this->employmentId,
        ])->assertCreated()->assertJsonPath('status', 'prepared');
        $this->post('/logout');

        $calculation = DB::table('payroll_calculations')
            ->where('period_id', $this->payrollPeriodId)->where('employment_id', $this->employmentId)
            ->where('lifecycle_state', 'prepared')->orderByDesc('id')->firstOrFail();

        $this->signIn('approver');
        $this->postJson('/api/v1/payroll/calculations/'.$calculation->id.'/approve')
            ->assertOk()->assertJsonPath('status', 'approved');
        $this->post('/logout');

        $result = PayrollResult::query()->where('calculation_id', $calculation->id)->firstOrFail();

        return ['result_id' => $result->id];
    }

    /** @return array<string, mixed> */
    private function disbursementJournal(string $liabilityId, string $amount): array
    {
        return [
            'period_id' => $this->financialPeriodId,
            'source_type' => 'payroll_liability',
            'source_id' => $liabilityId,
            'reason' => 'salary disbursement',
            'lines' => [
                ['account_id' => $this->expenseAccountId, 'direction' => 'debit', 'amount' => $amount],
                ['account_id' => $this->cashAccountId, 'direction' => 'credit', 'amount' => $amount],
            ],
        ];
    }

    private function recognizeLiability(string $resultId): string
    {
        $this->post('/finance/payroll-liabilities/recognize', [
            'source_type' => 'payroll_result',
            'source_id' => $resultId,
            'amount' => '1100.00',
            'evidence_ref' => 'payroll/result/'.$resultId,
        ])->assertRedirect('/finance');

        return (string) PayrollLiabilityFact::query()
            ->where('source_type', 'payroll_result')
            ->where('source_id', $resultId)
            ->value('id');
    }

    public function test_contract_version_prepare_without_scale_and_allowance_rule_over_console(): void
    {
        $versionId = $this->prepareInForceSalaryContract();

        $this->assertDatabaseHas('compensation_rules', ['contract_version_id' => $versionId, 'method' => 'fixed_monthly', 'rate' => '1000.00']);
        $this->assertDatabaseHas('compensation_rules', ['contract_version_id' => $versionId, 'method' => 'allowance', 'rate' => '100.00', 'label' => 'housing']);
    }

    public function test_api_payroll_calculate_accepts_period_in_body_and_computes_salary(): void
    {
        $this->prepareInForceSalaryContract();

        $this->signIn('calculator');
        $this->postJson('/api/v1/payroll/calculations', [
            'period_id' => $this->payrollPeriodId,
            'employment_id' => $this->employmentId,
        ])->assertCreated();

        $this->assertDatabaseHas('payroll_calculations', [
            'period_id' => $this->payrollPeriodId,
            'employment_id' => $this->employmentId,
            'base_amount' => '1100.00', // 1000 fixed + 100 allowance, full-period
            'lifecycle_state' => 'prepared',
        ]);
    }

    public function test_approved_payroll_is_recognized_by_finance_then_disbursed_exactly_once_via_a_balanced_journal(): void
    {
        $this->prepareInForceSalaryContract();
        ['result_id' => $resultId] = $this->calculateAndApprove();

        $this->signIn('cashier');
        $liabilityId = $this->recognizeLiability($resultId);
        $this->assertDatabaseHas('payroll_liability_facts', [
            'id' => $liabilityId,
            'source_type' => 'payroll_result',
            'source_id' => $resultId,
            'amount' => '1100.00',
        ]);

        // Payroll supplies calculation evidence only. The ledger disburses the
        // Finance-recognized liability, with an exact immutable source amount.
        $key = 'pdw.journal.idem.001';
        $this->post('/finance/journals', $this->disbursementJournal($liabilityId, '1100.00'), ['Idempotency-Key' => $key])
            ->assertRedirect('/finance');
        $this->assertSame(1, DB::table('journals')->where('source_type', 'payroll_liability')->where('source_id', $liabilityId)->count());

        // Same-key replay returns the original outcome without a second
        // disbursement; a changed same-key request is a conflict.
        $this->post('/finance/journals', $this->disbursementJournal($liabilityId, '1100.00'), ['Idempotency-Key' => $key])
            ->assertRedirect('/finance');
        $this->postJson('/finance/journals', $this->disbursementJournal($liabilityId, '5000.00'), ['Idempotency-Key' => $key])
            ->assertStatus(409);
        $this->assertSame(1, DB::table('journals')->where('source_type', 'payroll_liability')->where('source_id', $liabilityId)->count());

        // A fresh request cannot pay that same Finance fact twice either.
        $this->postJson('/finance/journals', $this->disbursementJournal($liabilityId, '1100.00'))
            ->assertStatus(409);
        $this->assertSame(1, DB::table('journals')->where('source_type', 'payroll_liability')->where('source_id', $liabilityId)->count());

        $debit = DB::table('journal_lines')->whereIn('journal_id', fn ($q) => $q->select('id')->from('journals')->where('source_type', 'payroll_liability')->where('source_id', $liabilityId))->where('direction', 'debit')->sum('amount');
        $credit = DB::table('journal_lines')->whereIn('journal_id', fn ($q) => $q->select('id')->from('journals')->where('source_type', 'payroll_liability')->where('source_id', $liabilityId))->where('direction', 'credit')->sum('amount');
        $this->assertSame('1100.00', (string) $debit);
        $this->assertSame('1100.00', (string) $credit);
    }

    public function test_direct_sql_cannot_bypass_finance_payroll_liability_recognition(): void
    {
        $this->prepareInForceSalaryContract();
        ['result_id' => $resultId] = $this->calculateAndApprove();

        $period = FinancialPeriod::query()->findOrFail($this->financialPeriodId);
        $cashier = $this->grantedActor('pdw-direct-cashier', ['finance.journal']);

        // Historic payroll-result journals remain readable, but a new raw SQL
        // header cannot bypass Finance's independent liability recognition.
        $this->expectException(QueryException::class);
        DB::table('journals')->insert([
            'id' => RandomIdentifier::new(),
            'period_id' => $period->id,
            'source_type' => 'payroll_result',
            'source_id' => $resultId,
            'reason' => 'forged direct Payroll-result disbursement',
            'posted_by' => $cashier->actorId,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_post_a_wrong_amount_against_a_finance_payroll_liability(): void
    {
        $this->prepareInForceSalaryContract();
        ['result_id' => $resultId] = $this->calculateAndApprove();
        $recognizer = $this->grantedActor('pdw-direct-finance-recognizer', ['finance.payroll_liability']);
        $recognized = app(RecognizePayrollLiability::class)->recognize(
            $recognizer,
            'payroll_result',
            $resultId,
            '1100.00',
            'payroll/result/'.$resultId,
            'pdw-direct-liability-recognize',
        );

        $this->expectException(QueryException::class);
        DB::transaction(function () use ($recognized): void {
            $journalId = RandomIdentifier::new();
            DB::table('journals')->insert([
                'id' => $journalId,
                'period_id' => $this->financialPeriodId,
                'source_type' => 'payroll_liability',
                'source_id' => $recognized['liability_id'],
                'reason' => 'forged short payroll disbursement',
                'posted_by' => 'pdw-direct-sql-attacker',
                'created_at' => now(),
                'updated_at' => now(),
            ]);
            DB::table('journal_lines')->insert([
                ['id' => RandomIdentifier::new(), 'journal_id' => $journalId, 'account_id' => $this->expenseAccountId, 'direction' => 'debit', 'amount' => '1099.99', 'created_at' => now(), 'updated_at' => now()],
                ['id' => RandomIdentifier::new(), 'journal_id' => $journalId, 'account_id' => $this->cashAccountId, 'direction' => 'credit', 'amount' => '1099.99', 'created_at' => now(), 'updated_at' => now()],
            ]);
            DB::statement('SET CONSTRAINTS journals_completion_and_source_amount_guard_trigger IMMEDIATE');
        });
    }

    public function test_unprivileged_user_cannot_calculate_approve_or_disburse(): void
    {
        $this->prepareInForceSalaryContract();

        $this->signIn('nobody');
        // Cannot calculate.
        $this->postJson('/api/v1/payroll/calculations', [
            'period_id' => $this->payrollPeriodId,
            'employment_id' => $this->employmentId,
        ])->assertForbidden();
        $this->assertSame(0, DB::table('payroll_calculations')->count());

        // Cannot post even an organization-wide balancing journal (default
        // deny; no ledger mutation). Payroll-liability source resolution is
        // deliberately not used here: this specifically proves authorization.
        $journalCount = DB::table('journals')->count();
        $this->post('/finance/journals', [
            'period_id' => $this->financialPeriodId,
            'source_type' => 'other',
            'reason' => 'unauthorized journal attempt',
            'lines' => [
                ['account_id' => $this->expenseAccountId, 'direction' => 'debit', 'amount' => '1100.00'],
                ['account_id' => $this->cashAccountId, 'direction' => 'credit', 'amount' => '1100.00'],
            ],
        ]);
        $this->assertSame($journalCount, DB::table('journals')->count());
        $this->assertDatabaseHas('audit_events', ['operation' => 'finance.journal.post.denied']);
    }
}
