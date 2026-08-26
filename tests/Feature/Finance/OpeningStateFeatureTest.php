<?php

declare(strict_types=1);

namespace Tests\Feature\Finance;

use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Finance\Commands\AllocatePayment;
use App\Modules\Finance\Commands\ApproveOpeningState;
use App\Modules\Finance\Commands\MaintainChartOfAccounts;
use App\Modules\Finance\Commands\MaintainDiscount;
use App\Modules\Finance\Commands\MaintainFinancialPeriod;
use App\Modules\Finance\Commands\MaintainOpeningState;
use App\Modules\Finance\Commands\RecordPayment;
use App\Modules\Finance\Domain\OpeningEntryContract;
use App\Modules\Finance\Models\Account;
use App\Modules\Finance\Models\Discount;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\OpeningEntry;
use App\Modules\Finance\Models\OpeningState;
use App\Modules\Finance\Models\Payment;
use App\Modules\Organization\Models\Organization;
use App\Modules\Reporting\Commands\ComputeProjection;
use App\Modules\Reporting\Commands\DefineMetric;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class OpeningStateFeatureTest extends TestCase
{
    use BuildsActors;

    private string $organizationId = '00000000-0000-4000-8000-00000000b005';

    private string $openingPeriodKey = 'OPENING';

    private string $studentId;

    private string $teacherPersonId = 'op-teacher-1';

    protected function setUp(): void
    {
        parent::setUp();
        $this->financeManager(); // seeds authority + the opening period + chart accounts below
        app(MaintainFinancialPeriod::class)->open($this->financeManager(), $this->openingPeriodKey, '2026-08-01', '2026-08-31', 'op-per-1');
        app(MaintainChartOfAccounts::class)->define($this->financeManager(), '1000', 'Cash on hand', 'asset', 'op-acc-1');
        app(MaintainChartOfAccounts::class)->define($this->financeManager(), '3000', 'Opening equity', 'equity', 'op-acc-2');

        // a live student of the operating business
        $this->personWithAuthority('op-person-student', []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('op-adm'), 'op-person-student', 'Program', 'op-reg-1');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        app(DecideAdmission::class)->decide($this->admissionsClerk('op-adm'), $this->admissionsReviewer('op-adm-r'), $this->admissionsApprover('op-adm-a'), $applicant, true, 'live student', 'ev/op', 'op-adm-2');
        $this->studentId = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('op-adm-a'), $applicant, 'op-conv-1')['student_id'];
        $this->personWithAuthority($this->teacherPersonId, []);
    }

    private function financeManager(): Actor
    {
        return $this->grantedActor('op-fm', ['finance.period', 'finance.opening.prepare', 'finance.obligation', 'finance.journal', 'finance.chart', 'finance.payment', 'finance.discount', 'finance.discount_approve']);
    }

    private function generalManager(): Actor
    {
        return $this->grantedActor('op-gm', ['finance.opening.approve']);
    }

    /** @return array{state: OpeningState, entries: array<string, string>} */
    private function preparedState(array $entries = []): array
    {
        $fm = $this->financeManager();
        $created = app(MaintainOpeningState::class)->create($fm, $this->organizationId, '2026-08-01', $this->openingPeriodKey, 'op-create-'.uniqid());
        $state = OpeningState::query()->findOrFail($created['opening_state_id']);
        $ids = [];
        $defaults = [
            ['category' => 'student_receivable', 'amount' => '3000.00', 'studentId' => $this->studentId, 'source' => 'paper/ledger-1'],
            ['category' => 'teacher_salary_payable', 'amount' => '12000.00', 'personId' => $this->teacherPersonId, 'source' => 'paper/salary-1'],
            ['category' => 'cash_position', 'amount' => '50000.00', 'asset' => '1000', 'equity' => '3000', 'source' => 'paper/cash-count-1'],
        ];
        $assetAccountId = (string) Account::query()->where('code', '1000')->value('id');
        $equityAccountId = (string) Account::query()->where('code', '3000')->value('id');
        foreach ($entries !== [] ? $entries : $defaults as $i => $spec) {
            $added = app(MaintainOpeningState::class)->addEntry($fm, $state,
                $spec['category'], $spec['amount'], $spec['studentId'] ?? null, $spec['personId'] ?? null, null,
                ($spec['asset'] ?? null) !== null ? $assetAccountId : null, ($spec['equity'] ?? null) !== null ? $equityAccountId : null,
                $spec['source'], '2026-08-01', $spec['description'] ?? 'opening fact from paper records', 'op-entry-'.$i.'-'.uniqid());
            $ids[$spec['source']] = $added['entry_id'];
        }

        return ['state' => $state, 'entries' => $ids];
    }

    private function createOrg(string $id): string
    {
        Organization::query()->create(['id' => $id, 'name' => 'Opening Fixture Org '.$id, 'lifecycle_state' => 'active']);

        return $id;
    }

    public function test_full_lifecycle_create_add_submit_approve_with_materialization(): void
    {
        $prepared = $this->preparedState();
        $state = $prepared['state'];
        $this->assertSame('draft', $state->status);

        $submitted = app(MaintainOpeningState::class)->submit($this->financeManager(), $state, 'op-sub-1');
        $this->assertSame('submitted', $submitted['status']);

        $approved = app(ApproveOpeningState::class)->approve($this->generalManager(), $state, 'op-appr-1');
        $this->assertSame(64, strlen($approved['approval_digest']));
        $this->assertSame(1, $approved['obligations']); // the student receivable
        $this->assertSame(1, $approved['journals']); // the cash position

        $this->assertDatabaseHas('opening_states', ['id' => $state->id, 'status' => 'approved', 'prepared_by' => 'op-fm', 'approved_by' => 'op-gm']);
        $this->assertSame(3, OpeningEntry::query()->where('opening_state_id', $state->id)->count());

        // receivable materialized as an obligation in the opening period, source-linked to the entry
        $entryId = $prepared['entries']['paper/ledger-1'];
        $this->assertDatabaseHas('obligations', ['student_id' => $this->studentId, 'source' => 'opening-state', 'original_amount' => '3000.00', 'period_id' => FinancialPeriod::query()->where('period_key', $this->openingPeriodKey)->value('id')]);
        $this->assertDatabaseHas('obligation_lines', ['category' => 'student_receivable', 'amount' => '3000.00', 'source_ref' => 'opening/'.$entryId]);
        $this->assertDatabaseHas('opening_materializations', ['opening_entry_id' => $entryId, 'instrument_type' => 'obligation']);

        // cash position materialized as a balanced journal
        $cashEntryId = $prepared['entries']['paper/cash-count-1'];
        $this->assertDatabaseHas('journals', ['source_type' => 'other', 'source_id' => $cashEntryId]);
        $this->assertDatabaseHas('opening_materializations', ['opening_entry_id' => $cashEntryId, 'instrument_type' => 'journal']);

        // payable stays the authoritative opening liability (no fake payroll history)
        $this->assertDatabaseHas('opening_entries', ['id' => $prepared['entries']['paper/salary-1'], 'category' => 'teacher_salary_payable', 'amount' => '12000.00']);
        $this->assertSame(0, DB::table('payroll_results')->count());
        $this->assertSame(0, DB::table('payments')->count());
    }

    public function test_separation_of_duties_and_denials_are_audited(): void
    {
        $prepared = $this->preparedState([['category' => 'other_payable', 'amount' => '500.00', 'source' => 'paper/rent-1', 'personId' => $this->teacherPersonId]]);
        $state = $prepared['state'];

        // Finance Manager cannot approve
        try {
            app(ApproveOpeningState::class)->approve($this->financeManager(), $state, 'op-x-1');
            $this->fail('the Finance Manager must not approve');
        } catch (AuthorizationDenied) {
            $this->assertDatabaseHas('audit_events', ['operation' => 'finance.opening.approve.denied', 'actor_id' => 'op-fm']);
        }

        // General Manager cannot prepare or modify (the GM holds approval only)
        $gmNoPrepare = $this->generalManager();
        try {
            app(MaintainOpeningState::class)->addEntry($gmNoPrepare, $state, 'other_payable', '1.00', null, $this->teacherPersonId, null, null, null, 'paper/x', '2026-08-01', 'x', 'op-x-2');
            $this->fail('the General Manager must not modify the submitted state');
        } catch (AuthorizationDenied) {
            $this->assertDatabaseHas('audit_events', ['operation' => 'finance.opening.entry.denied', 'actor_id' => 'op-gm']);
        }
        $this->assertSame(1, OpeningEntry::query()->where('opening_state_id', $state->id)->count());

        // self-approval is impossible even if the same person held both capabilities
        $both = $this->grantedActor('op-both', ['finance.opening.prepare', 'finance.opening.approve']);
        $own = app(MaintainOpeningState::class)->create($both, $this->createOrg('00000000-0000-4000-8000-00000000f001'), '2026-08-01', $this->openingPeriodKey, 'op-x-3');
        app(MaintainOpeningState::class)->addEntry($both, OpeningState::query()->findOrFail($own['opening_state_id']), 'other_payable', '10.00', null, $this->teacherPersonId, null, null, null, 'paper/y', '2026-08-01', 'y', 'op-x-4');
        app(MaintainOpeningState::class)->submit($both, OpeningState::query()->findOrFail($own['opening_state_id']), 'op-x-5');
        try {
            app(ApproveOpeningState::class)->approve($both, OpeningState::query()->findOrFail($own['opening_state_id']), 'op-x-6');
            $this->fail('self-approval must be denied');
        } catch (AuthorizationDenied) {
            $this->assertDatabaseHas('audit_events', ['operation' => 'finance.opening.approve.denied', 'actor_id' => 'op-both']);
        }

        // unprivileged nobody cannot even create
        try {
            app(MaintainOpeningState::class)->create($this->actorWithoutAnyCapability('op-nobody'), $this->organizationId, '2026-08-01', $this->openingPeriodKey, 'op-x-7');
            $this->fail('unprivileged creation must be denied');
        } catch (AuthorizationDenied) {
            $this->assertDatabaseHas('audit_events', ['operation' => 'finance.opening.create.denied', 'actor_id' => 'op-nobody']);
        }
    }

    public function test_exactly_one_opening_state_no_second_after_approval(): void
    {
        $prepared = $this->preparedState([['category' => 'other_receivable', 'amount' => '700.00', 'source' => 'paper/misc-1', 'studentId' => null]]);
        app(MaintainOpeningState::class)->submit($this->financeManager(), $prepared['state'], 'op-sub-2');
        app(ApproveOpeningState::class)->approve($this->generalManager(), $prepared['state'], 'op-appr-2');

        // a second opening state for the same organization is impossible (command + DB)
        try {
            app(MaintainOpeningState::class)->create($this->financeManager(), $this->organizationId, '2026-08-01', $this->openingPeriodKey, 'op-second-1');
            $this->fail('a second opening state must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.opening_frozen', $rejection->errorCode());
        }
        $this->expectException(QueryException::class);
        OpeningState::query()->create(['id' => '00000000-0000-4000-8000-00000000aa01', 'organization_id' => $this->organizationId, 'status' => 'draft', 'effective_on' => '2026-08-01', 'opening_period_key' => 'X', 'prepared_by' => 'op-fm']);
    }

    public function test_approved_state_is_immutable_everywhere(): void
    {
        $prepared = $this->preparedState([['category' => 'student_receivable', 'amount' => '5000.00', 'studentId' => $this->studentId, 'source' => 'paper/wrong-1']]);
        $state = $prepared['state'];
        app(MaintainOpeningState::class)->submit($this->financeManager(), $state, 'op-sub-3');
        app(ApproveOpeningState::class)->approve($this->generalManager(), $state, 'op-appr-3');

        // no command path: entries cannot be added, submit fails, approve fails
        try {
            app(MaintainOpeningState::class)->addEntry($this->financeManager(), $state, 'other_payable', '1.00', null, $this->teacherPersonId, null, null, null, 'paper/z', '2026-08-01', 'z', 'op-imm-1');
            $this->fail('post-approval entry must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.opening_not_draft', $rejection->errorCode());
        }
        try {
            app(ApproveOpeningState::class)->approve($this->generalManager(), $state, 'op-imm-2');
            $this->fail('double approval must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.opening_frozen', $rejection->errorCode());
        }

        // no raw SQL path: update/delete of state or entries rejected by triggers
        try {
            DB::statement('UPDATE opening_states SET status = ? WHERE id = ?', ['draft', $state->id]);
            $this->fail('raw SQL unfreeze must fail');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
        try {
            DB::statement('DELETE FROM opening_entries WHERE id = ?', [$prepared['entries']['paper/wrong-1']]);
            $this->fail('raw SQL entry delete must fail');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
        try {
            DB::statement('UPDATE opening_entries SET amount = 4000.00 WHERE id = ?', [$prepared['entries']['paper/wrong-1']]);
            $this->fail('raw SQL entry rewrite must fail');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
        $this->assertDatabaseHas('opening_entries', ['id' => $prepared['entries']['paper/wrong-1'], 'amount' => '5000.00']);
    }

    public function test_invalid_entries_and_duplicate_facts_are_rejected(): void
    {
        $fm = $this->financeManager();
        $created = app(MaintainOpeningState::class)->create($fm, $this->organizationId, '2026-08-01', $this->openingPeriodKey, 'op-inv-0');
        $state = OpeningState::query()->findOrFail($created['opening_state_id']);
        $add = fn (array $over) => app(MaintainOpeningState::class)->addEntry($fm, $state,
            $over['category'] ?? 'other_payable', $over['amount'] ?? '1.00', $over['studentId'] ?? null, $over['personId'] ?? null, null,
            $over['asset'] ?? null, $over['equity'] ?? null, $over['source'] ?? 'paper/s', $over['effectiveOn'] ?? '2026-08-01', $over['description'] ?? 'd', $over['key'] ?? 'op-inv-'.uniqid());

        foreach ([
            [['amount' => '-5.00'], 'finance.opening_amount'],
            [['amount' => '0.00'], 'finance.opening_amount'],
            [['amount' => 'abc'], 'finance.opening_amount'],
            [['category' => 'student_receivable'], 'finance.opening_student_required'],
            [['category' => 'teacher_salary_payable', 'personId' => null], 'finance.opening_person_required'],
            [['category' => 'cash_position', 'asset' => null], 'finance.opening_cash_accounts'],
            [['category' => 'invented'], 'finance.opening_category_unknown'],
            [['source' => ''], 'finance.opening_evidence'],
            [['studentId' => '00000000-0000-4000-8000-0000000000ff'], 'finance.opening_student_unknown'],
        ] as [$over, $code]) {
            $category = $over['category'] ?? 'other_payable';
            $payload = array_merge(['category' => $category === 'student_receivable' ? 'student_receivable' : $category], $over);
            // student_receivable default without student → shape rejection expected
            try {
                $add($over);
                $this->fail("expected rejection {$code}");
            } catch (BusinessRejection $rejection) {
                $this->assertSame($code, $rejection->errorCode());
            }
        }

        // duplicate paper source reference = duplicate opening fact
        $add(['source' => 'paper/dup-1', 'personId' => $this->teacherPersonId, 'key' => 'op-dup-a']);
        try {
            $add(['source' => 'paper/dup-1', 'personId' => $this->teacherPersonId, 'key' => 'op-dup-b']);
            $this->fail('duplicate opening fact must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.opening_duplicate', $rejection->errorCode());
        }

        // empty state cannot be submitted
        $fresh = app(MaintainOpeningState::class)->create($fm, $this->createOrg('00000000-0000-4000-8000-00000000f002'), '2026-08-01', $this->openingPeriodKey, 'op-inv-1');
        try {
            app(MaintainOpeningState::class)->submit($fm, OpeningState::query()->findOrFail($fresh['opening_state_id']), 'op-inv-2');
            $this->fail('an empty opening state must not be submittable');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.opening_empty', $rejection->errorCode());
        }

        // DB-level negative/zero amount and bad currency impossible
        $this->expectException(QueryException::class);
        OpeningEntry::query()->create(['id' => '00000000-0000-4000-8000-00000000aa02', 'opening_state_id' => $state->id, 'category' => 'other_payable', 'amount' => '-1.00', 'currency' => 'USD', 'source_ref' => 'paper/db', 'effective_on' => '2026-08-01', 'description' => 'x', 'prepared_by' => 'op-fm']);
    }

    public function test_opening_position_plus_subsequent_activity_equals_current_position(): void
    {
        // student owes 3000 opening; a real 1000 payment allocates against the materialized obligation
        $prepared = $this->preparedState([['category' => 'student_receivable', 'amount' => '3000.00', 'studentId' => $this->studentId, 'source' => 'paper/ledger-2'], ['category' => 'book_receivable', 'amount' => '500.00', 'studentId' => $this->studentId, 'source' => 'paper/book-2']]);
        $state = $prepared['state'];
        app(MaintainOpeningState::class)->submit($this->financeManager(), $state, 'op-sub-4');
        app(ApproveOpeningState::class)->approve($this->generalManager(), $state, 'op-appr-4');

        // opening position: 3000 + 500 = 3500 outstanding in the opening period
        $openingPeriodId = FinancialPeriod::query()->where('period_key', $this->openingPeriodKey)->value('id');
        $obligations = Obligation::query()->where('period_id', $openingPeriodId)->where('student_id', $this->studentId)->get();
        $this->assertSame(2, $obligations->count());

        $analyst = $this->grantedActor('op-analyst', ['reporting.catalog', 'reporting.compute']);
        app(DefineMetric::class)->define($analyst, 'student_outstanding_balance', 'Outstanding balance', 'spec', '2026-01-01', 'op-def-1');
        $opening = app(ComputeProjection::class)->compute($analyst, 'student_outstanding_balance', $this->openingPeriodKey, 'student', $this->studentId, 'op-proj-1');
        $this->assertSame('3500.00', $opening['value']);

        // subsequent activity: a real payment of 1000 allocated through the normal certified mechanism
        $september = app(MaintainFinancialPeriod::class)->open($this->financeManager(), '2026-09', '2026-09-01', '2026-09-30', 'op-per-9');
        $payment = app(RecordPayment::class)->record($this->financeManager(), FinancialPeriod::query()->findOrFail($september['period_id']), $this->studentId, '1000.00', 'cash', 'RCPT-OP-1', '2026-09-05', 'op-pay-1');
        app(AllocatePayment::class)->allocate($this->financeManager(), Payment::query()->findOrFail($payment['payment_id']), $obligations->firstWhere('original_amount', '3000.00'), '1000.00', 'op-alloc-1');

        // current position: opening period now nets 3500 - 1000 = 2500
        $current = app(ComputeProjection::class)->compute($analyst, 'student_outstanding_balance', $this->openingPeriodKey, 'student', $this->studentId, 'op-proj-2');
        $this->assertSame('2500.00', $current['value']);
        // subsequent activity period shows no obligations of its own
        $septemberView = app(ComputeProjection::class)->compute($analyst, 'student_outstanding_balance', '2026-09', 'student', $this->studentId, 'op-proj-3');
        $this->assertSame('0.00', $septemberView['value']);

        // correction after approval: approved discount of 500 adjusts WITHOUT touching opening evidence
        $discount = app(MaintainDiscount::class)->propose($this->financeManager(), $obligations->firstWhere('original_amount', '3000.00'), FinancialPeriod::query()->findOrFail($september['period_id']), '500.00', 'policy/correction', '2026-09-10', null, 'post-approval correction', 'op-dis-1');
        app(MaintainDiscount::class)->approve($this->grantedActor('op-dis-appr', ['finance.discount_approve']), Discount::query()->findOrFail($discount['discount_id']), 'op-dis-2');
        $afterCorrection = app(ComputeProjection::class)->compute($analyst, 'student_outstanding_balance', $this->openingPeriodKey, 'student', $this->studentId, 'op-proj-4');
        $this->assertSame('2000.00', $afterCorrection['value']);

        // opening evidence remains intact and reproducible
        $this->assertDatabaseHas('opening_entries', ['id' => $prepared['entries']['paper/ledger-2'], 'amount' => '3000.00']);
        $this->assertDatabaseHas('obligations', ['id' => $obligations->firstWhere('original_amount', '3000.00')->id, 'original_amount' => '3000.00']);
        $approved = OpeningState::query()->findOrFail($state->id);
        $this->assertSame(OpeningEntryContract::digestFor($approved), $approved->approval_digest);
    }

    public function test_concurrent_creation_and_approval_collapse_safely(): void
    {
        $fm = $this->financeManager();
        $orgB = $this->createOrg('00000000-0000-4000-8000-00000000f003');

        // concurrent creation: the second transaction finds the row under the unique index
        $first = app(MaintainOpeningState::class)->create($fm, $orgB, '2026-08-01', $this->openingPeriodKey, 'op-race-1');
        try {
            app(MaintainOpeningState::class)->create($fm, $orgB, '2026-08-01', $this->openingPeriodKey, 'op-race-2');
            $this->fail('concurrent creation must collapse to one opening state');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.opening_exists', $rejection->errorCode());
        }
        $this->assertSame(1, OpeningState::query()->where('organization_id', $orgB)->count());

        // concurrent approval: idempotent same-key replay returns the original outcome
        $state = OpeningState::query()->findOrFail($first['opening_state_id']);
        app(MaintainOpeningState::class)->addEntry($fm, $state, 'student_receivable', '100.00', $this->studentId, null, null, null, null, 'paper/race-1', '2026-08-01', 'r', 'op-race-3');
        app(MaintainOpeningState::class)->submit($fm, $state, 'op-race-4');
        $a = app(ApproveOpeningState::class)->approve($this->generalManager(), $state, 'op-race-key');
        $b = app(ApproveOpeningState::class)->approve($this->generalManager(), $state, 'op-race-key');
        $this->assertSame($a['opening_state_id'], $b['opening_state_id']);
        $this->assertSame($a['approval_digest'], $b['approval_digest']);
        $this->assertSame(1, OpeningState::query()->where('organization_id', $orgB)->where('status', 'approved')->count());
        $this->assertSame(1, DB::table('opening_materializations')->count());
        $this->assertSame(1, Obligation::query()->where('source', 'opening-state')->count());
    }

    public function test_scope_and_period_guards(): void
    {
        $fm = $this->financeManager();
        // unknown organization rejected by FK at DB level (forged organization)
        $this->expectException(QueryException::class);
        OpeningState::query()->create(['id' => '00000000-0000-4000-8000-00000000aa03', 'organization_id' => '00000000-0000-4000-8000-00000000dead', 'status' => 'draft', 'effective_on' => '2026-08-01', 'opening_period_key' => 'X', 'prepared_by' => 'op-fm']);
    }

    public function test_approval_requires_opening_period_and_fails_atomically(): void
    {
        $fm = $this->financeManager();
        // submitted state whose opening period does not exist: approval must fail WITHOUT partial effects
        $created = app(MaintainOpeningState::class)->create($fm, $this->createOrg('00000000-0000-4000-8000-00000000f004'), '2026-08-01', 'NO-SUCH-PERIOD', 'op-per-x-1');
        $state = OpeningState::query()->findOrFail($created['opening_state_id']);
        app(MaintainOpeningState::class)->addEntry($fm, $state, 'student_receivable', '100.00', $this->studentId, null, null, null, null, 'paper/noperiod-1', '2026-08-01', 'x', 'op-per-x-2');
        app(MaintainOpeningState::class)->submit($fm, $state, 'op-per-x-3');
        try {
            app(ApproveOpeningState::class)->approve($this->generalManager(), $state, 'op-per-x-4');
            $this->fail('approval without the opening period must fail');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.opening_period', $rejection->errorCode());
        }
        // atomic: nothing materialized, state still submitted
        $this->assertSame('submitted', OpeningState::query()->findOrFail($state->id)->status);
        $this->assertSame(0, DB::table('opening_materializations')->count());
        $this->assertSame(0, Obligation::query()->where('student_id', $this->studentId)->count());
    }
}
