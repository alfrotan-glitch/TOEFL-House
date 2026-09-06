<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Finance\Commands\MaintainChartOfAccounts;
use App\Modules\Finance\Commands\MaintainDiscount;
use App\Modules\Finance\Commands\MaintainFinancialPeriod;
use App\Modules\Finance\Commands\PostJournal;
use App\Modules\Finance\Commands\PostObligation;
use App\Modules\Finance\Commands\RecordReconciliation;
use App\Modules\Finance\Models\Account;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\ObligationLine;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * PHASE_3 increment D: the finance back office — chart of accounts,
 * balanced journals (with reversals), the discount lifecycle with SoD,
 * reconciliation observations with SoD, and funding pools with restricted
 * allocations — is exercised over the real HTTP surface with distinct
 * sessions per signature. The domain-owned rules (balance, independence,
 * restriction, pool/line remainders, no-silent-closure equivalents) are
 * asserted with their exact error codes. (The payment/refund console
 * workflow lives in FinanceWorkflowFeatureTest.)
 */
final class FinanceBackOfficeWorkflowFeatureTest extends TestCase
{
    use BuildsActors;

    private string $studentId;

    private string $periodId;

    protected function setUp(): void
    {
        parent::setUp();

        $this->studentId = $this->newStudent();
        $keeper = $this->grantedActor('fdw-keeper-1', ['finance.period']);
        $period = app(MaintainFinancialPeriod::class)->open(
            $keeper, 'SY2026-1', '2026-09-01', '2026-12-18', 'fdw-period-1',
        );
        $this->periodId = $period['period_id'];
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('fdw-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'fdw-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    private function newStudent(): string
    {
        $personId = 'fdw-stu-1';
        $this->personWithAuthority($personId, []);

        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('fdw-clerk-1'), $personId, 'IELTS Preparation', 'fdw-reg-1');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);

        $initiated = app(DecideAdmission::class)->initiate(
            $this->admissionsClerk('fdw-clerk-2'), $applicant, true, 'meets entry policy', 'interview-notes/fdw', 'fdw-deci-1',
        );
        $decision = AdmissionDecision::query()->findOrFail($initiated['decision_id']);
        app(DecideAdmission::class)->review($this->admissionsReviewer('fdw-rev-1'), $decision, 'fdw-decr-1');
        app(DecideAdmission::class)->approve($this->admissionsApprover('fdw-adv-1'), $decision, 'fdw-deca-1');

        $converted = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('fdw-adv-2'), $applicant, 'fdw-conv-1');

        return $converted['student_id'];
    }

    /** @return array{obligation_id: string, line_id: string, category: string} */
    private function postObligation(string $category, string $amount, string $key): array
    {
        $poster = $this->grantedActor('fdw-obl-'.substr($key, -4), ['finance.obligation']);
        $obligation = app(PostObligation::class)->post(
            $poster,
            FinancialPeriod::query()->findOrFail($this->periodId),
            $this->studentId,
            'tuition',
            'course charges',
            [['category' => $category, 'amount' => $amount, 'source_ref' => 'invoice/fdw-'.$category]],
            $key,
        );

        return [
            'obligation_id' => $obligation['obligation_id'],
            'line_id' => ObligationLine::query()->where('obligation_id', $obligation['obligation_id'])->value('id'),
            'category' => $category,
        ];
    }

    public function test_chart_of_accounts_and_journal_chain_over_the_console(): void
    {
        $this->makeEmployee('fdw-accountant-1', ['finance.chart', 'finance.journal', 'finance.period'], 'accountant');
        $this->makeEmployee('fdw-plain-1', [], 'plain');

        $accounts = DB::connection()->getTablePrefix().'accounts';
        $journals = DB::connection()->getTablePrefix().'journals';

        // An employee without the capability cannot define accounts.
        $this->signIn('plain');
        $this->post('/finance/accounts', [
            'code' => '1000', 'name' => 'Cash', 'type' => 'asset',
        ], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.chart_denied');
        $this->assertSame(0, DB::table($accounts)->count());

        // The accountant defines the chart; a duplicate code is refused.
        $this->signOut();
        $this->signIn('accountant');
        $this->post('/finance/accounts', ['code' => '1000', 'name' => 'Cash', 'type' => 'asset'])->assertRedirect('/finance');
        $cashId = DB::table($accounts)->where('code', '1000')->value('id');
        $this->assertNotNull($cashId);

        $this->post('/finance/accounts', ['code' => '1000', 'name' => 'Cash box', 'type' => 'asset'], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.account_code_exists');

        $this->post('/finance/accounts', ['code' => '4000', 'name' => 'Tuition revenue', 'type' => 'revenue'])->assertRedirect('/finance');
        $revenueId = DB::table($accounts)->where('code', '4000')->value('id');

        // A balanced journal posts; a replay with the same key adds nothing.
        $journal = [
            'period_id' => $this->periodId,
            'source_type' => 'other',
            'reason' => 'opening cash receipt for tuition',
            'idempotency_key' => 'fdw-journal-1',
            'lines' => [
                ['account_id' => $cashId, 'direction' => 'debit', 'amount' => '500.00'],
                ['account_id' => $revenueId, 'direction' => 'credit', 'amount' => '500.00'],
            ],
        ];
        $this->post('/finance/journals', $journal)->assertRedirect('/finance');
        $this->assertSame(1, DB::table($journals)->count());
        $journalId = DB::table($journals)->value('id');
        $this->assertSame(2, DB::table(DB::connection()->getTablePrefix().'journal_lines')->where('journal_id', $journalId)->count());

        $this->post('/finance/journals', $journal)->assertRedirect('/finance');
        $this->assertSame(1, DB::table($journals)->count());

        // An unbalanced journal is refused.
        $this->post('/finance/journals', [
            'period_id' => $this->periodId,
            'source_type' => 'other',
            'reason' => 'unbalanced attempt',
            'lines' => [
                ['account_id' => $cashId, 'direction' => 'debit', 'amount' => '100.00'],
                ['account_id' => $revenueId, 'direction' => 'credit', 'amount' => '99.99'],
            ],
        ], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.journal_unbalanced');
        $this->assertSame(1, DB::table($journals)->count());

        // A line referencing an unknown account is refused.
        $this->post('/finance/journals', [
            'period_id' => $this->periodId,
            'source_type' => 'other',
            'reason' => 'ghost account attempt',
            'lines' => [
                ['account_id' => RandomIdentifier::new(), 'direction' => 'debit', 'amount' => '10.00'],
                ['account_id' => $revenueId, 'direction' => 'credit', 'amount' => '10.00'],
            ],
        ], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.journal_account_unknown');

        // A reversal posts as a new journal linked to its original.
        $this->post('/finance/journals/'.$journalId.'/reverse', ['reason' => 'recorded against the wrong source'])->assertRedirect('/finance');
        $this->assertSame(2, DB::table($journals)->count());
        $this->assertDatabaseHas($journals, [
            'source_type' => 'journal', 'source_id' => $journalId, 'reason' => 'recorded against the wrong source',
        ]);

        // After the period closes, no more journals can post to it. A fresh
        // idempotency key is required: replaying the earlier one would return
        // its stored result instead of reaching the period check.
        $this->post('/finance/periods/'.$this->periodId.'/close')->assertRedirect('/finance');
        $closedPost = $journal;
        $closedPost['idempotency_key'] = 'fdw-journal-closed';
        $this->post('/finance/journals', $closedPost, ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.period_not_open');
        $this->assertSame(2, DB::table($journals)->count());
    }

    public function test_discount_lifecycle_with_independence(): void
    {
        // The proposer holds both discount capabilities so that the
        // independence rule — not authorization — blocks her self-approval.
        $this->makeEmployee('fdw-dprop-1', ['finance.discount', 'finance.discount_approve'], 'discount-proposer');
        $this->makeEmployee('fdw-dappr-1', ['finance.discount_approve'], 'discount-approver');

        $discounts = DB::connection()->getTablePrefix().'discounts';
        $obligation = $this->postObligation('tuition', '1000.00', 'fdw-ob1');

        $this->signIn('discount-proposer');
        $this->post('/finance/discounts', [
            'obligation_id' => $obligation['obligation_id'],
            'period_id' => $this->periodId,
            'amount' => '100.00',
            'eligibility' => 'early-payment discount per the published schedule',
            'effective_from' => '2026-09-01',
            'effective_to' => '2026-09-30',
            'reason' => 'paid two weeks early',
        ])->assertRedirect('/finance');
        $discountId = DB::table($discounts)->value('id');
        $this->assertDatabaseHas($discounts, ['id' => $discountId, 'lifecycle_state' => 'proposed', 'proposed_by' => 'fdw-dprop-1']);

        // The proposer cannot approve her own discount.
        $this->post('/finance/discounts/'.$discountId.'/approve', [], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.discount_not_independent');
        $this->assertDatabaseHas($discounts, ['id' => $discountId, 'lifecycle_state' => 'proposed']);

        // A distinct approver approves it.
        $this->signOut();
        $this->signIn('discount-approver');
        $this->post('/finance/discounts/'.$discountId.'/approve')->assertRedirect('/finance');
        $this->assertDatabaseHas($discounts, ['id' => $discountId, 'lifecycle_state' => 'approved', 'approved_by' => 'fdw-dappr-1']);

        // A discount larger than the now-reduced remainder is refused at
        // approval — the original charge is never rewritten.
        $this->signOut();
        $this->signIn('discount-proposer');
        $this->post('/finance/discounts', [
            'obligation_id' => $obligation['obligation_id'],
            'period_id' => $this->periodId,
            'amount' => '10000.00',
            'eligibility' => 'full remission',
            'effective_from' => '2026-09-01',
            'reason' => 'appeal outcome',
        ])->assertRedirect('/finance');
        $overId = DB::table($discounts)->where('amount', '10000.00')->value('id');
        $this->assertNotNull($overId);

        $this->signOut();
        $this->signIn('discount-approver');
        $this->post('/finance/discounts/'.$overId.'/approve', [], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.discount_exceeds_obligation');
        $this->assertDatabaseHas($discounts, ['id' => $overId, 'lifecycle_state' => 'proposed']);
    }

    public function test_reconciliation_observation_and_approval(): void
    {
        // The observer holds both reconciliation capabilities so that the
        // independence rule — not authorization — blocks her self-approval.
        $this->makeEmployee('fdw-obs-1', ['finance.reconcile', 'finance.reconcile_approve'], 'observer');
        $this->makeEmployee('fdw-rappr-1', ['finance.reconcile_approve'], 'recon-approver');

        $reconciliations = DB::connection()->getTablePrefix().'reconciliations';

        $this->signIn('observer');

        // A variance without an explanation is refused.
        $this->post('/finance/reconciliations', [
            'period_id' => $this->periodId,
            'subject' => 'bank-cash',
            'expected' => '1000.00',
            'observed' => '998.50',
        ], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.reconciliation_explanation');
        $this->assertSame(0, DB::table($reconciliations)->count());

        // With its explanation the observation is recorded as a draft; a
        // second observation for the same period and subject is refused.
        $this->post('/finance/reconciliations', [
            'period_id' => $this->periodId,
            'subject' => 'bank-cash',
            'expected' => '1000.00',
            'observed' => '998.50',
            'explanation' => 'two pending bank charges at cut-off',
        ])->assertRedirect('/finance');
        $reconId = DB::table($reconciliations)->value('id');
        $this->assertDatabaseHas($reconciliations, ['id' => $reconId, 'lifecycle_state' => 'draft', 'variance' => '-1.50']);

        $this->post('/finance/reconciliations', [
            'period_id' => $this->periodId,
            'subject' => 'bank-cash',
            'expected' => '1000.00',
            'observed' => '1000.00',
        ], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.reconciliation_exists');

        // The observer cannot approve her own observation.
        $this->post('/finance/reconciliations/'.$reconId.'/approve', [], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.reconciliation_not_independent');

        // A distinct approver locks it.
        $this->signOut();
        $this->signIn('recon-approver');
        $this->post('/finance/reconciliations/'.$reconId.'/approve')->assertRedirect('/finance');
        $this->assertDatabaseHas($reconciliations, ['id' => $reconId, 'lifecycle_state' => 'approved', 'approved_by' => 'fdw-rappr-1']);
    }

    public function test_funding_establish_and_allocation_rules(): void
    {
        $this->makeEmployee('fdw-fund-1', ['finance.fund'], 'fund-manager');
        $this->makeEmployee('fdw-fall-1', ['finance.fund_allocate'], 'fund-allocator');

        $funds = DB::connection()->getTablePrefix().'funding_sources';
        $allocations = DB::connection()->getTablePrefix().'fund_allocations';

        $tuition = $this->postObligation('tuition', '1000.00', 'fdw-ob2');
        $exam = $this->postObligation('exam', '500.00', 'fdw-ob3');

        $this->signIn('fund-manager');

        // A restricted fund without its restriction note is refused.
        $this->post('/finance/funds', [
            'name' => 'Grant A', 'agreement_ref' => 'grant/A',
            'committed_amount' => '1000.00', 'restricted_category' => 'tuition',
        ], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.fund_restriction_note');
        $this->assertSame(0, DB::table($funds)->count());

        // Restricted to tuition, and an unrestricted pool.
        $this->post('/finance/funds', [
            'name' => 'Grant A', 'agreement_ref' => 'grant/A',
            'committed_amount' => '1000.00', 'restricted_category' => 'tuition',
            'restriction_note' => 'grant agreement A: tuition only',
        ])->assertRedirect('/finance');
        $restrictedId = DB::table($funds)->where('name', 'Grant A')->value('id');

        $this->post('/finance/funds', [
            'name' => 'General pool', 'agreement_ref' => 'gen/1',
            'committed_amount' => '1000.00',
        ])->assertRedirect('/finance');
        $generalId = DB::table($funds)->where('name', 'General pool')->value('id');

        // Allocation across to a line of the permitted use.
        $this->signOut();
        $this->signIn('fund-allocator');
        $this->post('/finance/funds/'.$restrictedId.'/allocations', [
            'obligation_line_id' => $tuition['line_id'], 'amount' => '500.00', 'reason' => 'grant coverage of tuition',
        ])->assertRedirect('/finance');
        $this->assertSame(1, DB::table($allocations)->count());

        // The restriction blocks another use on the same fund.
        $this->post('/finance/funds/'.$restrictedId.'/allocations', [
            'obligation_line_id' => $exam['line_id'], 'amount' => '100.00', 'reason' => 'exam fee',
        ], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.fund_restriction');

        // The pool remainder is enforced.
        $this->post('/finance/funds/'.$restrictedId.'/allocations', [
            'obligation_line_id' => $tuition['line_id'], 'amount' => '500.01', 'reason' => 'last of the pool',
        ], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.fund_exhausted');

        // The line remainder is enforced from an unrestricted pool.
        $this->post('/finance/funds/'.$generalId.'/allocations', [
            'obligation_line_id' => $tuition['line_id'], 'amount' => '900.00', 'reason' => 'general coverage',
        ], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.fund_exceeds_line');

        // Within both remainders, the allocation commits.
        $this->post('/finance/funds/'.$generalId.'/allocations', [
            'obligation_line_id' => $tuition['line_id'], 'amount' => '500.00', 'reason' => 'general coverage of the remainder',
        ])->assertRedirect('/finance');
        $this->assertSame(2, DB::table($allocations)->count());
    }

    public function test_the_validation_gates_of_the_finance_commands(): void
    {
        $actor = $this->grantedActor('fdw-keeper-2', [
            'finance.chart', 'finance.journal', 'finance.discount', 'finance.reconcile',
        ]);
        $period = FinancialPeriod::query()->findOrFail($this->periodId);

        // Chart: a type outside the five canonical types.
        try {
            app(MaintainChartOfAccounts::class)->define($actor, '9000', 'Cost centre', 'cost', 'fdw-dom-1');
            $this->fail('expected the unknown account type to be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.account_type_unknown', $rejection->errorCode());
        }

        // Journal: unknown source, empty reason, bad direction, non-positive amount.
        $cash = Account::query()->firstWhere('code', '1000');
        if ($cash === null) {
            $cash = Account::query()->create([
                'id' => RandomIdentifier::new(), 'code' => '1000', 'name' => 'Cash', 'type' => 'asset',
            ]);
        }
        $lines = static fn (string $direction, string $amount): array => [
            ['account_id' => $cash->id, 'direction' => $direction, 'amount' => $amount],
            ['account_id' => $cash->id, 'direction' => $direction === 'debit' ? 'credit' : 'debit', 'amount' => $amount],
        ];

        foreach ([
            ['finance.journal_source_unknown', 'invoice', 'a reason', $lines('debit', '10.00')],
            ['finance.journal_reason', 'other', '', $lines('debit', '10.00')],
            ['finance.journal_direction', 'other', 'a reason', [
                ['account_id' => $cash->id, 'direction' => 'dr', 'amount' => '10.00'],
                ['account_id' => $cash->id, 'direction' => 'cr', 'amount' => '10.00'],
            ]],
        ] as [$code, $source, $reason, $journalLines]) {
            try {
                app(PostJournal::class)->post($actor, $period, $source, null, $reason, $journalLines, 'fdw-dom-'.$code);
                $this->fail("expected {$code} to be rejected");
            } catch (BusinessRejection $rejection) {
                $this->assertSame($code, $rejection->errorCode());
            }
        }

        try {
            app(PostJournal::class)->post($actor, $period, 'other', null, 'a reason', [
                ['account_id' => $cash->id, 'direction' => 'debit', 'amount' => '0.00'],
                ['account_id' => $cash->id, 'direction' => 'credit', 'amount' => '0.00'],
            ], 'fdw-dom-amount');
            $this->fail('expected the non-positive amount to be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.journal_amount', $rejection->errorCode());
        }

        // Discount: missing terms, non-positive amount, inverted window.
        $obligationPoster = $this->grantedActor('fdw-obl-9', ['finance.obligation']);
        $obligation = app(PostObligation::class)->post(
            $obligationPoster, $period, $this->studentId, 'tuition', 'course charges',
            [['category' => 'tuition', 'amount' => '500.00', 'source_ref' => 'invoice/fdw-dom']],
            'fdw-dom-obligation',
        );
        $obligationModel = Obligation::query()->findOrFail($obligation['obligation_id']);

        try {
            app(MaintainDiscount::class)->propose(
                $actor, $obligationModel, $period, '10.00', '', '2026-09-01', null, 'a reason', 'fdw-dom-disc-1',
            );
            $this->fail('expected the missing eligibility to be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.discount_terms', $rejection->errorCode());
        }

        try {
            app(MaintainDiscount::class)->propose(
                $actor, $obligationModel, $period, '0.00', 'early payment', '2026-09-01', null, 'a reason', 'fdw-dom-disc-2',
            );
            $this->fail('expected the non-positive amount to be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.discount_amount', $rejection->errorCode());
        }

        try {
            app(MaintainDiscount::class)->propose(
                $actor, $obligationModel, $period, '10.00', 'early payment', '2026-09-30', '2026-09-01', 'a reason', 'fdw-dom-disc-3',
            );
            $this->fail('expected the inverted window to be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.discount_window', $rejection->errorCode());
        }

        // Reconciliation: non-numeric values.
        try {
            app(RecordReconciliation::class)->observe(
                $actor, $period, 'bank-cash', 'one thousand', '1000.00', null, 'fdw-dom-recon-1',
            );
            $this->fail('expected the non-numeric expected value to be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.reconciliation_amounts', $rejection->errorCode());
        }
    }
}
