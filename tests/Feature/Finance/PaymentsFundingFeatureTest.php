<?php

declare(strict_types=1);

namespace Tests\Feature\Finance;

use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Finance\Commands\AllocateFunds;
use App\Modules\Finance\Commands\AllocatePayment;
use App\Modules\Finance\Commands\MaintainDiscount;
use App\Modules\Finance\Commands\MaintainFinancialPeriod;
use App\Modules\Finance\Commands\PostObligation;
use App\Modules\Finance\Commands\RecordPayment;
use App\Modules\Finance\Commands\RefundPayment;
use App\Modules\Finance\Models\Discount;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\FundingSource;
use App\Modules\Finance\Models\Obligation;
use App\Modules\Finance\Models\ObligationLine;
use App\Modules\Finance\Models\Payment;
use App\Modules\Finance\Models\Refund;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\DecidesAdmissions;
use Tests\TestCase;

final class PaymentsFundingFeatureTest extends TestCase
{
    use BuildsActors;
    use DecidesAdmissions;

    private string $periodId;

    private string $studentId;

    private string $obligationId;

    private string $tuitionLineId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority('pay-fin-person-1', []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('pay-fin-clerk'), 'pay-fin-person-1', 'Program', 'pay-fin-reg-1');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision($this->admissionsClerk('pay-fin-clerk'), $this->admissionsReviewer('pay-fin-review'), $this->admissionsApprover('pay-fin-approve'), $applicant, true, 'meets policy', 'ev/pay', 'pay-fin-adm-1');
        $this->studentId = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('pay-fin-approve'), $applicant, 'pay-fin-conv-1')['student_id'];

        $clerk = $this->grantedActor('pay-fin-acc', ['finance.period', 'finance.obligation', 'finance.payment']);
        $period = app(MaintainFinancialPeriod::class)->open($clerk, '2026-11', '2026-11-01', '2026-11-30', 'pay-fin-per-1');
        $this->periodId = $period['period_id'];

        $obligation = app(PostObligation::class)->post($clerk, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, 'tuition', 'November tuition', [
            ['category' => 'tuition', 'amount' => '8000.00', 'source_ref' => 'price-list/v3'],
            ['category' => 'transport', 'amount' => '500.00', 'source_ref' => 'price-list/v3'],
        ], 'pay-fin-ob-1');
        $this->obligationId = $obligation['obligation_id'];
        $this->tuitionLineId = (string) ObligationLine::query()->where('obligation_id', $this->obligationId)->where('category', 'tuition')->value('id');
    }

    private function teller(): Actor
    {
        return $this->grantedActor('pay-fin-acc', ['finance.period', 'finance.obligation', 'finance.payment', 'finance.refund', 'finance.refund_approve', 'finance.discount', 'finance.discount_approve', 'finance.fund', 'finance.fund_allocate']);
    }

    public function test_payment_posts_once_and_allocations_respect_both_caps(): void
    {
        $teller = $this->teller();
        $payment = app(RecordPayment::class)->record($teller, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, '7000.00', 'bank-transfer', 'RCPT-1001', '2026-11-05', 'pay-fin-pay-1');
        $this->assertDatabaseHas('payments', ['id' => $payment['payment_id'], 'amount' => '7000.00']);

        try {
            app(RecordPayment::class)->record($teller, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, '7000.00', 'bank-transfer', 'RCPT-1001', '2026-11-05', 'pay-fin-pay-2');
            $this->fail('the same external receipt must post only once');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.payment_duplicate', $rejection->errorCode());
        }

        try {
            app(AllocatePayment::class)->allocate($teller, Payment::query()->findOrFail($payment['payment_id']), Obligation::query()->findOrFail($this->obligationId), '7000.01', 'pay-fin-all-1');
            $this->fail('an allocation cannot exceed the payment');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.allocation_exceeds_payment', $rejection->errorCode());
        }

        $allocation = app(AllocatePayment::class)->allocate($teller, Payment::query()->findOrFail($payment['payment_id']), Obligation::query()->findOrFail($this->obligationId), '6500.00', 'pay-fin-all-2');
        $this->assertDatabaseHas('payment_allocations', ['id' => $allocation['allocation_id'], 'amount' => '6500.00']);

        try {
            app(AllocatePayment::class)->allocate($teller, Payment::query()->findOrFail($payment['payment_id']), Obligation::query()->findOrFail($this->obligationId), '500.00', 'pay-fin-all-3');
            $this->fail('a payment cannot be allocated twice to the same obligation');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.allocation_pair_exists', $rejection->errorCode());
        }

        $this->assertSame('500.00', app(AllocatePayment::class)->paymentRemaining(Payment::query()->findOrFail($payment['payment_id'])));
        $this->assertSame('2000.00', app(AllocatePayment::class)->obligationRemaining(Obligation::query()->findOrFail($this->obligationId)));

        $this->expectException(QueryException::class);
        DB::statement('UPDATE payments SET amount = 999999 WHERE id = ?', [$payment['payment_id']]);
    }

    public function test_allocation_cannot_exceed_obligation_and_requires_same_payer(): void
    {
        $teller = $this->teller();
        $payment = app(RecordPayment::class)->record($teller, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, '9000.00', 'cash', 'RCPT-1002', '2026-11-06', 'pay-fin-pay-3');

        try {
            app(AllocatePayment::class)->allocate($teller, Payment::query()->findOrFail($payment['payment_id']), Obligation::query()->findOrFail($this->obligationId), '8500.01', 'pay-fin-all-4');
            $this->fail('an allocation cannot exceed the obligation');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.allocation_exceeds_obligation', $rejection->errorCode());
        }

        $this->personWithAuthority('pay-fin-person-2', []);
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk('pay-fin-clerk'), 'pay-fin-person-2', 'Program', 'pay-fin-reg-2');
        /** @var Applicant $applicant */
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->runAdmissionDecision($this->admissionsClerk('pay-fin-clerk'), $this->admissionsReviewer('pay-fin-review'), $this->admissionsApprover('pay-fin-approve'), $applicant, true, 'meets policy', 'ev/pay2', 'pay-fin-adm-2');
        $otherStudent = app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover('pay-fin-approve'), $applicant, 'pay-fin-conv-2')['student_id'];

        app(PostObligation::class)->post($teller, FinancialPeriod::query()->findOrFail($this->periodId), $otherStudent, 'tuition', 'other student tuition', [
            ['category' => 'tuition', 'amount' => '1000.00', 'source_ref' => 'price-list/v3'],
        ], 'pay-fin-ob-2');
        try {
            app(AllocatePayment::class)->allocate($teller, Payment::query()->findOrFail($payment['payment_id']),
                Obligation::query()->where('student_id', $otherStudent)->firstOrFail(), '10.00', 'pay-fin-all-5');
            $this->fail('cross-student allocation must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.allocation_payer_mismatch', $rejection->errorCode());
        }
    }

    public function test_refund_is_proposed_then_approved_by_a_distinct_session_and_cannot_exceed_the_remainder(): void
    {
        $teller = $this->teller();
        $approver = $this->grantedActor('pay-fin-ref-appr', ['finance.refund_approve']);
        $payment = app(RecordPayment::class)->record($teller, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, '6000.00', 'cash', 'RCPT-1003', '2026-11-07', 'pay-fin-pay-4');
        app(AllocatePayment::class)->allocate($teller, Payment::query()->findOrFail($payment['payment_id']), Obligation::query()->findOrFail($this->obligationId), '4000.00', 'pay-fin-all-6');

        try {
            app(RefundPayment::class)->propose($teller, Payment::query()->findOrFail($payment['payment_id']), FinancialPeriod::query()->findOrFail($this->periodId), '2000.01', 'over-refund', 'pay-fin-ref-1');
            $this->fail('the refund cannot exceed the unallocated remainder');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.refund_exceeds_source', $rejection->errorCode());
        }

        // The requester proposes; the refund is born 'proposed' — no money
        // has moved yet.
        $refund = app(RefundPayment::class)->propose($teller, Payment::query()->findOrFail($payment['payment_id']), FinancialPeriod::query()->findOrFail($this->periodId), '2000.00', 'overpayment returned per policy doc 4.2', 'pay-fin-ref-2');
        $this->assertDatabaseHas('refunds', ['id' => $refund['refund_id'], 'amount' => '2000.00', 'lifecycle_state' => 'proposed', 'approved_by' => null]);

        // The requester cannot approve their own proposal.
        try {
            app(RefundPayment::class)->approve($teller, Refund::query()->findOrFail($refund['refund_id']), 'pay-fin-ref-3');
            $this->fail('requester and approver must differ');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('finance.refund_not_independent', $denial->errorCode());
        }

        // A distinct approver, in their own session, records it.
        app(RefundPayment::class)->approve($approver, Refund::query()->findOrFail($refund['refund_id']), 'pay-fin-ref-4');
        $this->assertDatabaseHas('refunds', ['id' => $refund['refund_id'], 'lifecycle_state' => 'recorded', 'approved_by' => 'pay-fin-ref-appr']);

        // A recorded refund is terminal: it cannot be approved again, and
        // nothing is left of the payment to refund.
        try {
            app(RefundPayment::class)->approve($approver, Refund::query()->findOrFail($refund['refund_id']), 'pay-fin-ref-5');
            $this->fail('a recorded refund is terminal');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.refund_not_proposed', $rejection->errorCode());
        }

        try {
            app(RefundPayment::class)->propose($teller, Payment::query()->findOrFail($payment['payment_id']), FinancialPeriod::query()->findOrFail($this->periodId), '1.00', 'again', 'pay-fin-ref-6');
            $this->fail('nothing is left to refund');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.refund_exceeds_source', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement('UPDATE refunds SET amount = 999999 WHERE id = ?', [$refund['refund_id']]);
    }

    public function test_discount_requires_eligibility_independent_approval_and_preserves_the_charge(): void
    {
        $teller = $this->teller();
        $approver = $this->grantedActor('pay-fin-dis-appr', ['finance.discount_approve']);

        try {
            app(MaintainDiscount::class)->propose($teller, Obligation::query()->findOrFail($this->obligationId), FinancialPeriod::query()->findOrFail($this->periodId), '100.00', '', '2026-11-01', null, 'sibling', 'pay-fin-dis-1');
            $this->fail('eligibility is mandatory');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.discount_terms', $rejection->errorCode());
        }

        $discount = app(MaintainDiscount::class)->propose($teller, Obligation::query()->findOrFail($this->obligationId), FinancialPeriod::query()->findOrFail($this->periodId), '1000.00', 'policy/scholarship-rate-card v2', '2026-11-01', '2026-11-30', 'published scholarship rate', 'pay-fin-dis-2');

        try {
            app(MaintainDiscount::class)->approve($teller, Discount::query()->findOrFail($discount['discount_id']), 'pay-fin-dis-3');
            $this->fail('the proposer may not approve the discount');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('finance.discount_not_independent', $denial->errorCode());
        }

        app(MaintainDiscount::class)->approve($approver, Discount::query()->findOrFail($discount['discount_id']), 'pay-fin-dis-4');
        $this->assertDatabaseHas('discounts', ['id' => $discount['discount_id'], 'lifecycle_state' => 'approved']);
        $this->assertDatabaseHas('obligations', ['id' => $this->obligationId, 'original_amount' => '8500.00']);

        $greedy = app(MaintainDiscount::class)->propose($teller, Obligation::query()->findOrFail($this->obligationId), FinancialPeriod::query()->findOrFail($this->periodId), '7500.01', 'policy/x', '2026-11-01', null, 'over-reaching', 'pay-fin-dis-5');
        try {
            app(MaintainDiscount::class)->approve($approver, Discount::query()->findOrFail($greedy['discount_id']), 'pay-fin-dis-6');
            $this->fail('a discount cannot exceed the uncovered remainder');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.discount_exceeds_obligation', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement('UPDATE discounts SET amount = 999999 WHERE id = ?', [$discount['discount_id']]);
    }

    public function test_restricted_funds_stay_restricted_and_utilization_cannot_exceed_the_pool(): void
    {
        $teller = $this->teller();
        $fund = app(AllocateFunds::class)->establish($teller, 'Sponsor A Tuition Aid', 'agreement/SA-2026-11', '10000.00', 'tuition', 'sponsor agreement restricts use to tuition lines only', 'pay-fin-fund-1');

        try {
            app(AllocateFunds::class)->establish($teller, 'Bad Fund', 'agreement/x', '100.00', 'transport', null, 'pay-fin-fund-2');
            $this->fail('a restricted fund requires its restriction note');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.fund_restriction_note', $rejection->errorCode());
        }

        $transportLineId = (string) ObligationLine::query()->where('obligation_id', $this->obligationId)->where('category', 'transport')->value('id');
        try {
            app(AllocateFunds::class)->allocate($teller, FundingSource::query()->findOrFail($fund['fund_id']), ObligationLine::query()->findOrFail($transportLineId), '100.00', 'wrong use', 'pay-fin-fund-3');
            $this->fail('restricted use without matching category must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.fund_restriction', $rejection->errorCode());
        }

        $allocation = app(AllocateFunds::class)->allocate($teller, FundingSource::query()->findOrFail($fund['fund_id']), ObligationLine::query()->findOrFail($this->tuitionLineId), '5000.00', 'sponsor-covered tuition per agreement', 'pay-fin-fund-4');
        $this->assertDatabaseHas('fund_allocations', ['id' => $allocation['allocation_id'], 'amount' => '5000.00']);
        $this->assertSame('3500.00', app(AllocatePayment::class)->obligationRemaining(Obligation::query()->findOrFail($this->obligationId)));

        try {
            app(AllocateFunds::class)->allocate($teller, FundingSource::query()->findOrFail($fund['fund_id']), ObligationLine::query()->findOrFail($this->tuitionLineId), '5001.00', 'exceeds pool', 'pay-fin-fund-5');
            $this->fail('the allocation cannot exceed the committed pool');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.fund_exhausted', $rejection->errorCode());
        }

        try {
            app(AllocateFunds::class)->allocate($teller, FundingSource::query()->findOrFail($fund['fund_id']), ObligationLine::query()->findOrFail($this->tuitionLineId), '3000.01', 'exceeds line', 'pay-fin-fund-6');
            $this->fail('the allocation cannot exceed the uncovered line remainder');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.fund_exceeds_line', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement("UPDATE funding_sources SET restricted_category = 'transport' WHERE id = ?", [$fund['fund_id']]);
    }

    public function test_closed_period_rejects_payments_refunds_and_discounts(): void
    {
        $teller = $this->teller();
        app(MaintainFinancialPeriod::class)->close($teller, FinancialPeriod::query()->findOrFail($this->periodId), 'pay-fin-per-2');

        try {
            app(RecordPayment::class)->record($teller, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, '100.00', 'cash', 'RCPT-LATE', '2026-11-30', 'pay-fin-pay-5');
            $this->fail('a closed period must reject payments');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.period_not_open', $rejection->errorCode());
        }

        try {
            app(MaintainDiscount::class)->propose($teller, Obligation::query()->findOrFail($this->obligationId), FinancialPeriod::query()->findOrFail($this->periodId), '10.00', 'policy/x', '2026-11-01', null, 'late', 'pay-fin-dis-7');
            $this->fail('a closed period must reject discount proposals');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('finance.period_not_open', $rejection->errorCode());
        }

        $this->assertDatabaseMissing('payments', ['payer_ref' => 'RCPT-LATE']);
    }

    public function test_unprivileged_payment_is_denied_and_audited(): void
    {
        $nobody = $this->actorWithoutAnyCapability('pay-fin-nobody');

        $this->expectException(AuthorizationDenied::class);
        app(RecordPayment::class)->record($nobody, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, '50.00', 'cash', 'RCPT-DENIED', '2026-11-08', 'pay-fin-neg-1');

        $this->assertDatabaseHas('audit_events', ['operation' => 'finance.payment.record.denied', 'actor_id' => 'pay-fin-nobody']);
        $this->assertDatabaseMissing('payments', ['payer_ref' => 'RCPT-DENIED']);
    }

    // ------------------------------------------------------------------
    // Direct database attacks: bypassing the application entirely, the
    // schema itself must reject fabricated settlement (BR-FIN-001/002 at
    // the authoritative boundary).
    // ------------------------------------------------------------------

    public function test_direct_sql_cannot_over_settle_a_payment(): void
    {
        $teller = $this->teller();
        $payment = app(RecordPayment::class)->record($teller, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, '7000.00', 'bank-transfer', 'RCPT-DB-1', '2026-11-05', 'pay-fin-db-1');

        $this->expectException(QueryException::class);
        DB::table('payment_allocations')->insert([
            'id' => RandomIdentifier::new(),
            'payment_id' => $payment['payment_id'],
            'obligation_id' => $this->obligationId,
            'amount' => '7000.01',
            'allocated_by' => 'direct-sql-attacker',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_over_refund_a_payment(): void
    {
        $teller = $this->teller();
        $payment = app(RecordPayment::class)->record($teller, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, '7000.00', 'bank-transfer', 'RCPT-DB-2', '2026-11-05', 'pay-fin-db-2');

        // Even a well-formed PROPOSAL that would exceed the amount received
        // is rejected: an impossible proposal must not enter the ledger.
        $this->expectException(QueryException::class);
        DB::table('refunds')->insert([
            'id' => RandomIdentifier::new(),
            'payment_id' => $payment['payment_id'],
            'period_id' => $this->periodId,
            'amount' => '7000.01',
            'reason' => 'fabricated',
            'requested_by' => 'direct-sql-attacker',
            'lifecycle_state' => 'proposed',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_record_a_refund_skipping_its_proposal(): void
    {
        $teller = $this->teller();
        $payment = app(RecordPayment::class)->record($teller, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, '7000.00', 'bank-transfer', 'RCPT-DB-5', '2026-11-05', 'pay-fin-db-5');

        // A refund cannot be born 'recorded': recorded is reachable only by
        // approving a proposal, which is where the distinct approver and the
        // re-checked balance live.
        $this->expectException(QueryException::class);
        DB::table('refunds')->insert([
            'id' => RandomIdentifier::new(),
            'payment_id' => $payment['payment_id'],
            'period_id' => $this->periodId,
            'amount' => '100.00',
            'reason' => 'fabricated',
            'requested_by' => 'direct-sql-attacker',
            'approved_by' => 'direct-sql-attacker-two',
            'lifecycle_state' => 'recorded',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_approve_a_refund_with_a_changed_amount(): void
    {
        $teller = $this->teller();
        $payment = app(RecordPayment::class)->record($teller, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, '7000.00', 'bank-transfer', 'RCPT-DB-6', '2026-11-05', 'pay-fin-db-6');

        DB::table('refunds')->insert([
            'id' => RandomIdentifier::new(),
            'payment_id' => $payment['payment_id'],
            'period_id' => $this->periodId,
            'amount' => '500.00',
            'reason' => 'proposed within the remainder',
            'requested_by' => 'direct-sql-attacker',
            'lifecycle_state' => 'proposed',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $refundId = (string) DB::table('refunds')->where('payment_id', $payment['payment_id'])->value('id');

        // Approval may only flip lifecycle_state and set approved_by — it may
        // not rewrite the amount (and 7000.01 would also breach the cap).
        $this->expectException(QueryException::class);
        DB::statement('UPDATE refunds SET lifecycle_state = ?, approved_by = ?, amount = ? WHERE id = ?', ['recorded', 'direct-sql-attacker-two', '7000.01', $refundId]);
    }

    public function test_direct_sql_allocation_plus_refund_cannot_exceed_the_payment(): void
    {
        $teller = $this->teller();
        $payment = app(RecordPayment::class)->record($teller, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, '7000.00', 'bank-transfer', 'RCPT-DB-3', '2026-11-05', 'pay-fin-db-3');

        // Exactly covering the payment is consistent and must be accepted.
        DB::table('payment_allocations')->insert([
            'id' => RandomIdentifier::new(),
            'payment_id' => $payment['payment_id'],
            'obligation_id' => $this->obligationId,
            'amount' => '7000.00',
            'allocated_by' => 'direct-sql-attacker',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // One cent of refund on top of a fully allocated payment exceeds the
        // amount received: the schema rejects the proposal.
        $this->expectException(QueryException::class);
        DB::table('refunds')->insert([
            'id' => RandomIdentifier::new(),
            'payment_id' => $payment['payment_id'],
            'period_id' => $this->periodId,
            'amount' => '0.01',
            'reason' => 'fabricated',
            'requested_by' => 'direct-sql-attacker',
            'lifecycle_state' => 'proposed',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_over_cover_an_obligation(): void
    {
        $teller = $this->teller();
        // A payment larger than the obligation (8500.00): the payment-side
        // cap passes, so the obligation-side cap must be what rejects it.
        $payment = app(RecordPayment::class)->record($teller, FinancialPeriod::query()->findOrFail($this->periodId), $this->studentId, '9000.00', 'bank-transfer', 'RCPT-DB-4', '2026-11-05', 'pay-fin-db-4');

        $this->expectException(QueryException::class);
        DB::table('payment_allocations')->insert([
            'id' => RandomIdentifier::new(),
            'payment_id' => $payment['payment_id'],
            'obligation_id' => $this->obligationId,
            'amount' => '8500.01',
            'allocated_by' => 'direct-sql-attacker',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_post_an_unbalanced_journal(): void
    {
        $arId = RandomIdentifier::new();
        $revenueId = RandomIdentifier::new();
        DB::table('accounts')->insert([
            ['id' => $arId, 'code' => '1100', 'name' => 'Accounts Receivable', 'type' => 'asset', 'created_at' => now(), 'updated_at' => now()],
            ['id' => $revenueId, 'code' => '4100', 'name' => 'Tuition Revenue', 'type' => 'revenue', 'created_at' => now(), 'updated_at' => now()],
        ]);

        $journalId = RandomIdentifier::new();
        DB::table('journals')->insert([
            'id' => $journalId,
            'period_id' => $this->periodId,
            'source_type' => 'other',
            'source_id' => null,
            'reason' => 'direct sql attack',
            'posted_by' => 'direct-sql-attacker',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // One debit leg and no credit leg: the deferred balance guard must
        // reject the journal when the statement commits.
        $this->expectException(QueryException::class);
        DB::table('journal_lines')->insert([
            'id' => RandomIdentifier::new(),
            'journal_id' => $journalId,
            'account_id' => $arId,
            'direction' => 'debit',
            'amount' => '100.00',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_fund_beyond_the_line_remainder(): void
    {
        // A large unrestricted pool (10000) so only the line cap can fire.
        $fundId = RandomIdentifier::new();
        DB::table('funding_sources')->insert([
            'id' => $fundId,
            'name' => 'Attack Fund',
            'agreement_ref' => 'ATTACK/AG-1',
            'committed_amount' => '10000.00',
            'restricted_category' => '',
            'restriction_note' => '',
            'established_by' => 'direct-sql-attacker',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // The tuition line is 8000.00 in setUp; 8000.01 exceeds it.
        $this->expectException(QueryException::class);
        DB::table('fund_allocations')->insert([
            'id' => RandomIdentifier::new(),
            'fund_id' => $fundId,
            'obligation_line_id' => $this->tuitionLineId,
            'amount' => '8000.01',
            'reason' => 'fabricated',
            'allocated_by' => 'direct-sql-attacker',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_exhaust_a_fund_pool_beyond_commitment(): void
    {
        $fundId = RandomIdentifier::new();
        DB::table('funding_sources')->insert([
            'id' => $fundId,
            'name' => 'Small Attack Fund',
            'agreement_ref' => 'ATTACK/AG-2',
            'committed_amount' => '100.00',
            'restricted_category' => '',
            'restriction_note' => '',
            'established_by' => 'direct-sql-attacker',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // 100.01 is within the line remainder (8000) but exceeds the pool.
        $this->expectException(QueryException::class);
        DB::table('fund_allocations')->insert([
            'id' => RandomIdentifier::new(),
            'fund_id' => $fundId,
            'obligation_line_id' => $this->tuitionLineId,
            'amount' => '100.01',
            'reason' => 'fabricated',
            'allocated_by' => 'direct-sql-attacker',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_breach_a_fund_category_restriction(): void
    {
        $fundId = RandomIdentifier::new();
        DB::table('funding_sources')->insert([
            'id' => $fundId,
            'name' => 'Restricted Attack Fund',
            'agreement_ref' => 'ATTACK/AG-3',
            'committed_amount' => '1000.00',
            'restricted_category' => 'tuition',
            'restriction_note' => 'tuition only',
            'established_by' => 'direct-sql-attacker',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // The transport line (500.00, category "transport") cannot receive
        // tuition-restricted funding.
        $transportLineId = (string) ObligationLine::query()->where('obligation_id', $this->obligationId)->where('category', 'transport')->value('id');
        $this->expectException(QueryException::class);
        DB::table('fund_allocations')->insert([
            'id' => RandomIdentifier::new(),
            'fund_id' => $fundId,
            'obligation_line_id' => $transportLineId,
            'amount' => '100.00',
            'reason' => 'fabricated',
            'allocated_by' => 'direct-sql-attacker',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_add_lines_beyond_the_obligation_amount(): void
    {
        // setUp's obligation is 8500.00 (8000 + 500, complete). An extra
        // line makes the lines total 8600 <> 8500: rejected at commit.
        $this->expectException(QueryException::class);
        DB::table('obligation_lines')->insert([
            'id' => RandomIdentifier::new(),
            'obligation_id' => $this->obligationId,
            'category' => 'late',
            'amount' => '100.00',
            'source_ref' => 'fabricated',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }
}
