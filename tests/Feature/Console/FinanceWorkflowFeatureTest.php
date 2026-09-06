<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Payment;
use App\Modules\Finance\Models\Refund;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsStudents;
use Tests\TestCase;

/**
 * Finance console workflow over HTTP: a finance clerk records a payment for
 * a student, then proposes a refund — and a DIFFERENT session, signed in as
 * a distinct approver, records it. The two signatures are captured in two
 * authenticated sessions; the transport has no field for typing a
 * colleague's person id.
 */
final class FinanceWorkflowFeatureTest extends TestCase
{
    use BuildsStudents;

    private function signInAs(string $personId, string $username): void
    {
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $personId,
            'username' => $username,
            'password_hash' => Hash::make('fin-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
        $this->post('/login', ['username' => $username, 'password' => 'fin-password-1'])->assertRedirect('/');
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
    }

    public function test_record_payment_and_staged_refund_through_the_console(): void
    {
        $student = $this->makeStudent()['student'];

        $clerk = $this->personWithAuthority('fin-clerk-1', ['finance.payment', 'finance.refund']);
        $approverPerson = $this->personWithAuthority('fin-approver-1', ['finance.refund_approve']);
        $this->signInAs($clerk->id, 'fin.clerk');

        $period = FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => '2026-08',
            'date_from' => '2026-08-01',
            'date_to' => '2026-08-31',
            'lifecycle_state' => 'open',
        ]);

        // Record a payment.
        $this->post('/finance/payments', [
            'period_id' => $period->id,
            'student_id' => $student->id,
            'amount' => '400.00',
            'method' => 'bank',
            'payer_ref' => 'FIN-PAY-1',
            'received_on' => '2026-08-05',
        ])->assertRedirect(route('finance.index'));

        $payment = Payment::query()->where('payer_ref', 'FIN-PAY-1')->firstOrFail();
        $this->assertSame('400.00', $payment->amount);

        // The finance index surfaces the payment.
        $this->get('/finance')->assertOk()->assertSee('FIN-PAY-1');

        // Stage 1: the clerk PROPOSES the refund — no approver field exists
        // on the form, and the command does not record money yet.
        $this->post('/finance/payments/'.$payment->id.'/refund', [
            'period_id' => $period->id,
            'amount' => '150.00',
            'reason' => 'Early termination of course',
        ])->assertRedirect(route('finance.index'));

        $refund = Refund::query()->where('payment_id', $payment->id)->firstOrFail();
        $this->assertSame('150.00', $refund->amount);
        $this->assertSame('proposed', $refund->lifecycle_state);
        $this->assertNull($refund->approved_by);

        // The proposer's own session cannot approve their proposal.
        $this->post('/finance/refunds/'.$refund->id.'/approve')->assertRedirect();
        $refund->refresh();
        $this->assertSame('proposed', $refund->lifecycle_state);

        // Stage 2: a distinct approver, in their own session, records it.
        $this->signOut();
        $this->signInAs($approverPerson->id, 'fin.approver');
        $this->post('/finance/refunds/'.$refund->id.'/approve')->assertRedirect(route('finance.index'));

        $refund->refresh();
        $this->assertSame('recorded', $refund->lifecycle_state);
        $this->assertSame($approverPerson->id, trim((string) $refund->approved_by));
    }

    public function test_fabricated_approver_in_the_request_body_has_no_effect(): void
    {
        $student = $this->makeStudent()['student'];
        $clerk = $this->personWithAuthority('fin-clerk-2', ['finance.payment', 'finance.refund']);
        $someoneElse = $this->personWithAuthority('fin-other-1', ['finance.refund_approve']);
        $this->signInAs($clerk->id, 'fin.clerk2');

        $period = FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => '2026-09',
            'date_from' => '2026-09-01',
            'date_to' => '2026-09-30',
            'lifecycle_state' => 'open',
        ]);
        $payment = Payment::query()->create([
            'id' => RandomIdentifier::new(),
            'period_id' => $period->id,
            'student_id' => $student->id,
            'amount' => '200.00',
            'method' => 'cash',
            'payer_ref' => 'FIN-PAY-2',
            'received_on' => '2026-09-05',
            'recorded_by' => 'fin-clerk-2',
        ]);

        // The old attack: one session types a colleague's person id into
        // the request. The field no longer exists — the refund is only
        // PROPOSED under the session's own authority.
        $this->post('/finance/payments/'.$payment->id.'/refund', [
            'period_id' => $period->id,
            'amount' => '50.00',
            'reason' => 'attempt',
            'approver_id' => $someoneElse->id,
        ])->assertRedirect(route('finance.index'));

        $this->assertDatabaseCount('refunds', 1);
        $this->assertDatabaseHas('refunds', ['payment_id' => $payment->id, 'lifecycle_state' => 'proposed', 'approved_by' => null]);
        $this->assertDatabaseMissing('refunds', ['approved_by' => $someoneElse->id]);
    }

    public function test_refund_rejects_same_actor_as_approver(): void
    {
        $student = $this->makeStudent()['student'];
        $both = $this->personWithAuthority('fin-both-1', ['finance.payment', 'finance.refund', 'finance.refund_approve']);
        $this->signInAs($both->id, 'fin.both');

        $period = FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => '2026-10',
            'date_from' => '2026-10-01',
            'date_to' => '2026-10-31',
            'lifecycle_state' => 'open',
        ]);
        $payment = Payment::query()->create([
            'id' => RandomIdentifier::new(),
            'period_id' => $period->id,
            'student_id' => $student->id,
            'amount' => '200.00',
            'method' => 'cash',
            'payer_ref' => 'FIN-PAY-3',
            'received_on' => '2026-10-05',
            'recorded_by' => 'fin-both-1',
        ]);

        // One person holding BOTH capabilities may still carry only one
        // stage: proposing is legal, approving their own proposal is not.
        $this->post('/finance/payments/'.$payment->id.'/refund', [
            'period_id' => $period->id,
            'amount' => '50.00',
            'reason' => 'attempt',
        ])->assertRedirect(route('finance.index'));

        $refund = Refund::query()->where('payment_id', $payment->id)->firstOrFail();
        $this->assertSame('proposed', $refund->lifecycle_state);

        $this->post('/finance/refunds/'.$refund->id.'/approve')->assertRedirect();
        $refund->refresh();
        $this->assertSame('proposed', $refund->lifecycle_state);
        $this->assertNull($refund->approved_by);
    }

    public function test_finance_index_requires_authentication(): void
    {
        $this->get('/finance')->assertRedirect('/login');
        $this->post('/finance/refunds/some-refund-id/approve')->assertRedirect('/login');
    }
}
