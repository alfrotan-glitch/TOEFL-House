<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Payment;
use App\Modules\Finance\Models\Refund;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsStudents;
use Tests\TestCase;

/**
 * Finance console workflow over HTTP: a finance clerk records a payment for
 * a student, then a two-signature refund (requester + distinct approver)
 * reverses part of it. Both delegate to the finance commands, which own the
 * balanced money surface, authorization, idempotency, and audit.
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

    public function test_record_payment_and_refund_through_the_console(): void
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

        // Two-signature refund (clerk requests, distinct approver approves).
        $this->post('/finance/payments/'.$payment->id.'/refund', [
            'period_id' => $period->id,
            'amount' => '150.00',
            'reason' => 'Early termination of course',
            'approver_id' => $approverPerson->id,
        ])->assertRedirect(route('finance.index'));

        $refund = Refund::query()->where('payment_id', $payment->id)->firstOrFail();
        $this->assertSame('150.00', $refund->amount);
    }

    public function test_refund_rejects_same_actor_as_approver(): void
    {
        $student = $this->makeStudent()['student'];
        $clerk = $this->personWithAuthority('fin-clerk-2', ['finance.payment', 'finance.refund']);
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

        // Requester and approver are the same person → separation-of-duties denial.
        $this->post('/finance/payments/'.$payment->id.'/refund', [
            'period_id' => $period->id,
            'amount' => '50.00',
            'reason' => 'attempt',
            'approver_id' => $clerk->id,
        ])->assertRedirect();

        $this->assertDatabaseCount('refunds', 0);
    }

    public function test_finance_index_requires_authentication(): void
    {
        $this->get('/finance')->assertRedirect('/login');
    }
}
