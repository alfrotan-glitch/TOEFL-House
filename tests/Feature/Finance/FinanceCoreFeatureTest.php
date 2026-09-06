<?php

declare(strict_types=1);

namespace Tests\Feature\Finance;

use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Finance\Commands\MaintainChartOfAccounts;
use App\Modules\Finance\Commands\MaintainFinancialPeriod;
use App\Modules\Finance\Commands\PostJournal;
use App\Modules\Finance\Commands\PostObligation;
use App\Modules\Finance\Commands\RecordReconciliation;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Journal;
use App\Modules\Finance\Models\Reconciliation;
use App\Modules\Payroll\Commands\MaintainPayrollPeriod;
use App\Modules\Payroll\Models\PayrollPeriod;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

final class FinanceCoreFeatureTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

    private string $periodId;

    private string $arAccountId;

    private string $revenueAccountId;

    private string $studentId;

    protected function setUp(): void
    {
        parent::setUp();
        $accountant = $this->grantedActor('fin-acc-1', ['finance.chart', 'finance.period', 'finance.obligation', 'finance.journal']);
        $ar = app(MaintainChartOfAccounts::class)->define($accountant, '1100', 'Accounts Receivable', 'asset', 'fin-acc-1');
        $revenue = app(MaintainChartOfAccounts::class)->define($accountant, '4100', 'Tuition Revenue', 'revenue', 'fin-acc-2');
        $this->arAccountId = $ar['account_id'];
        $this->revenueAccountId = $revenue['account_id'];

        $period = app(MaintainFinancialPeriod::class)->open($accountant, '2026-09', '2026-09-01', '2026-09-30', 'fin-per-1');
        $this->periodId = $period['period_id'];

        $this->personWithAuthority('fin-person-1', []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('fin-clerk'), 'fin-person-1', 'Program', 'fin-reg-1');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision($this->admissionsClerk('fin-clerk'), $this->admissionsReviewer('fin-review'), $this->admissionsApprover('fin-approve'), $applicant, true, 'meets policy', 'ev/fin', 'fin-adm-1');
        $this->studentId = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('fin-approve'), $applicant, 'fin-conv-1')['student_id'];
    }

    private function accountant(): Actor
    {
        return $this->grantedActor('fin-acc-1', ['finance.chart', 'finance.period', 'finance.obligation', 'finance.journal', 'finance.reconcile', 'finance.reconcile_approve']);
    }

    public function test_obligation_lines_must_sum_exactly_and_are_immutable(): void
    {
        $accountant = $this->accountant();
        $obligation = app(PostObligation::class)->post($accountant, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, 'tuition', 'September tuition', [
            ['category' => 'tuition', 'amount' => '8000.00', 'source_ref' => 'price-list/v3'],
            ['category' => 'registration', 'amount' => '500.00', 'source_ref' => 'price-list/v3'],
        ], 'fin-ob-1');
        $this->assertDatabaseHas('obligations', ['id' => $obligation['obligation_id'], 'original_amount' => '8500.00']);
        $this->assertSame(2, DB::table('obligation_lines')->where('obligation_id', $obligation['obligation_id'])->count());

        try {
            app(PostObligation::class)->post($accountant, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, 'tuition', 'bad', [
                ['category' => 'tuition', 'amount' => '0.00', 'source_ref' => 'x'],
            ], 'fin-ob-2');
            $this->fail('zero lines must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.obligation_line_amount', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement('UPDATE obligations SET original_amount = 1 WHERE id = ?', [$obligation['obligation_id']]);
    }

    public function test_journals_must_balance_and_reversals_append_negations(): void
    {
        $accountant = $this->accountant();
        $obligation = app(PostObligation::class)->post($accountant, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, 'tuition', 'September tuition', [
            ['category' => 'tuition', 'amount' => '8500.00', 'source_ref' => 'price-list/v3'],
        ], 'fin-ob-3');

        try {
            app(PostJournal::class)->post($accountant, FinancialPeriod::query()->findOrFail($this->periodId), 'obligation', $obligation['obligation_id'], 'charge posting', [
                ['account_id' => $this->arAccountId, 'direction' => 'debit', 'amount' => '8500.00'],
                ['account_id' => $this->revenueAccountId, 'direction' => 'credit', 'amount' => '8000.00'],
            ], 'fin-j-1');
            $this->fail('an unbalanced journal must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.journal_unbalanced', $rejection->errorCode());
        }

        $journal = app(PostJournal::class)->post($accountant, FinancialPeriod::query()->findOrFail($this->periodId), 'obligation', $obligation['obligation_id'], 'charge posting', [
            ['account_id' => $this->arAccountId, 'direction' => 'debit', 'amount' => '8500.00'],
            ['account_id' => $this->revenueAccountId, 'direction' => 'credit', 'amount' => '8500.00'],
        ], 'fin-j-2');
        $this->assertDatabaseHas('journals', ['id' => $journal['journal_id'], 'source_type' => 'obligation', 'source_id' => $obligation['obligation_id']]);

        $reversal = app(PostJournal::class)->reverse($accountant, Journal::query()->findOrFail($journal['journal_id']), 'charge voided after review', 'fin-j-3');
        $this->assertDatabaseHas('journals', ['id' => $reversal['journal_id'], 'source_type' => 'journal', 'source_id' => $journal['journal_id']]);
        $debits = DB::table('journal_lines')->where('journal_id', $reversal['journal_id'])->where('direction', 'debit')->sum('amount');
        $credits = DB::table('journal_lines')->where('journal_id', $reversal['journal_id'])->where('direction', 'credit')->sum('amount');
        $this->assertEquals('8500.00', $debits);
        $this->assertEquals('8500.00', $credits);
        $this->assertSame('debit', (string) DB::table('journal_lines')->where('journal_id', $reversal['journal_id'])->where('account_id', $this->revenueAccountId)->value('direction'), 'the reversal negates the original legs');

        $this->expectException(QueryException::class);
        DB::statement('UPDATE journal_lines SET amount = 1 WHERE journal_id = ?', [$journal['journal_id']]);
    }

    public function test_closed_period_rejects_posting_and_never_reopens(): void
    {
        $accountant = $this->accountant();
        app(MaintainFinancialPeriod::class)->close($accountant, FinancialPeriod::query()->findOrFail($this->periodId), 'fin-per-2');

        try {
            app(PostObligation::class)->post($accountant, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, 'tuition', 'late', [
                ['category' => 'tuition', 'amount' => '100.00', 'source_ref' => 'x'],
            ], 'fin-ob-4');
            $this->fail('a closed period must reject obligations');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.period_not_open', $rejection->errorCode());
        }

        try {
            app(PostJournal::class)->post($accountant, FinancialPeriod::query()->findOrFail($this->periodId), 'other', null, 'late', [
                ['account_id' => $this->arAccountId, 'direction' => 'debit', 'amount' => '1.00'],
                ['account_id' => $this->revenueAccountId, 'direction' => 'credit', 'amount' => '1.00'],
            ], 'fin-j-4');
            $this->fail('a closed period must reject journals');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.period_not_open', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement("UPDATE financial_periods SET lifecycle_state = 'open' WHERE id = ?", [$this->periodId]);
    }

    public function test_finance_close_coordinates_with_payroll_periods(): void
    {
        $accountant = $this->accountant();
        $payrollOpener = $this->grantedActor('fin-payroll-1', ['payroll.period']);
        app(MaintainPayrollPeriod::class)->open($payrollOpener, '2026-10', '2026-10-01', '2026-10-31', 'fin-pay-1');
        $october = app(MaintainFinancialPeriod::class)->open($accountant, '2026-10', '2026-10-01', '2026-10-31', 'fin-per-3');

        try {
            app(MaintainFinancialPeriod::class)->close($accountant, FinancialPeriod::query()->findOrFail($october['period_id']), 'fin-per-4');
            $this->fail('closing must be blocked while an overlapping payroll period is open');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.period_payroll_open', $rejection->errorCode());
        }

        app(MaintainPayrollPeriod::class)->close($payrollOpener, PayrollPeriod::query()->where('period_key', '2026-10')->firstOrFail(), 'fin-pay-2');
        app(MaintainFinancialPeriod::class)->close($accountant, FinancialPeriod::query()->findOrFail($october['period_id']), 'fin-per-5');
        $this->assertDatabaseHas('financial_periods', ['id' => $october['period_id'], 'lifecycle_state' => 'closed']);
    }

    public function test_reconciliation_records_variance_and_locks_on_independent_approval(): void
    {
        $accountant = $this->accountant();
        $observer = $this->grantedActor('fin-recon-1', ['finance.reconcile', 'finance.reconcile_approve']);
        $approver = $this->grantedActor('fin-recon-2', ['finance.reconcile_approve']);

        try {
            app(RecordReconciliation::class)->observe($observer, FinancialPeriod::query()->findOrFail($this->periodId), 'ar-subledger', '8500.00', '8400.00', null, 'fin-rec-1');
            $this->fail('a variance without explanation must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.reconciliation_explanation', $rejection->errorCode());
        }

        $reconciliation = app(RecordReconciliation::class)->observe($observer, FinancialPeriod::query()->findOrFail($this->periodId), 'ar-subledger', '8500.00', '8400.00', 'cash payment not yet journalled', 'fin-rec-2');
        $this->assertDatabaseHas('reconciliations', ['id' => $reconciliation['reconciliation_id'], 'variance' => '-100.00', 'lifecycle_state' => 'draft']);

        try {
            app(RecordReconciliation::class)->observe($observer, FinancialPeriod::query()->findOrFail($this->periodId), 'ar-subledger', '8500.00', '8400.00', 'again', 'fin-rec-3');
            $this->fail('one observation per period and subject');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.reconciliation_exists', $rejection->errorCode());
        }

        try {
            app(RecordReconciliation::class)->approve($observer, Reconciliation::query()->findOrFail($reconciliation['reconciliation_id']), 'fin-rec-4');
            $this->fail('the observer may not approve their own reconciliation');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('finance.reconciliation_not_independent', $denial->errorCode());
        }

        app(RecordReconciliation::class)->approve($approver, Reconciliation::query()->findOrFail($reconciliation['reconciliation_id']), 'fin-rec-5');
        $this->assertDatabaseHas('reconciliations', ['id' => $reconciliation['reconciliation_id'], 'lifecycle_state' => 'approved']);

        $this->expectException(QueryException::class);
        DB::statement('UPDATE reconciliations SET variance = 0 WHERE id = ?', [$reconciliation['reconciliation_id']]);
    }

    public function test_account_codes_are_unique_and_immutable(): void
    {
        $accountant = $this->accountant();
        try {
            app(MaintainChartOfAccounts::class)->define($accountant, '1100', 'Duplicate', 'asset', 'fin-acc-3');
            $this->fail('duplicate account codes must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.account_code_exists', $rejection->errorCode());
        }

        try {
            app(MaintainChartOfAccounts::class)->define($accountant, '1200', 'Bad Type', 'profit', 'fin-acc-4');
            $this->fail('unknown account types must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.account_type_unknown', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement('UPDATE accounts SET name = ? WHERE code = ?', ['Forged Name', '1100']);
    }

    public function test_unprivileged_posting_is_denied_and_audited(): void
    {
        $nobody = $this->actorWithoutAnyCapability('fin-nobody');

        $this->expectException(AuthorizationDenied::class);
        app(PostObligation::class)->post($nobody, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, 'tuition', 'probe', [
            ['category' => 'tuition', 'amount' => '10.00', 'source_ref' => 'x'],
        ], 'fin-neg-1');

        $this->assertDatabaseHas('audit_events', ['operation' => 'finance.obligation.post.denied', 'actor_id' => 'fin-nobody']);
        $this->assertDatabaseMissing('obligations', ['student_id' => $this->studentId]);
    }
}
