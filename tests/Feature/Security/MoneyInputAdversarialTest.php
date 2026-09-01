<?php

declare(strict_types=1);

namespace Tests\Feature\Security;

use App\Modules\Finance\Commands\MaintainFinancialPeriod;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\Actor;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Illuminate\Testing\TestResponse;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\BuildsStudents;
use Tests\Concerns\OperatesStructure;
use Tests\TestCase;

/**
 * FINAL ADVERSARIAL ATTACK — money input at the HTTP boundary.
 *
 * 'numeric' alone is not a money format: it admits '0.001' (the DB rounds
 * it to 0.00 and its CHECK (amount > 0) rejects it with a raw SQLSTATE
 * 23514 — an HTTP 500), '1e2' (scientific notation), and third-decimal
 * values that would otherwise be SILENTLY rounded. The single 'money'
 * rule (AppServiceProvider) pins the format at the boundary: digits,
 * optional 1-2 decimals, at most 12 integer digits — decimal(14,2)
 * capacity. Every malformed money value must be a 422, never a 500,
 * and never a silent rounding.
 */
final class MoneyInputAdversarialTest extends TestCase
{
    use BuildsActors;
    use BuildsStudents;
    use OperatesStructure;

    private const TELLER = 'mia-teller-1';

    private const STUDENT = 'mia-student-1';

    private Student $student;

    protected function setUp(): void
    {
        parent::setUp();

        $this->student = $this->makeStudent(['applicant' => self::STUDENT])['student'];
        $this->personWithAuthority(self::TELLER, ['finance.period', 'finance.payment']);

        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => self::TELLER,
            'username' => 'mia-teller',
            'password_hash' => Hash::make('mia-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
    }

    private function openPeriod(): string
    {
        $actor = new Actor(self::TELLER, 'Teller');

        $period = app(MaintainFinancialPeriod::class)->open($actor, '2026-11', '2026-11-01', '2026-11-30', 'mia-period');

        return $period['period_id'];
    }

    private function postPayment(string $amount): TestResponse
    {
        $this->post('/login', ['username' => 'mia-teller', 'password' => 'mia-password-1'])->assertRedirect('/');

        return $this->post('/finance/payments', [
            'period_id' => $this->openPeriod(),
            'student_id' => $this->student->id,
            'amount' => $amount,
            'method' => 'cash',
            'payer_ref' => 'mia-ref-1',
            'received_on' => '2026-11-05',
        ]);
    }

    public function test_third_decimal_does_not_reach_the_database_as_a_500(): void
    {
        $this->postPayment('0.001')
            ->assertRedirect()
            ->assertSessionHasErrors('amount');

        $this->assertDatabaseCount('payments', 0);
    }

    public function test_third_decimal_is_rejected_not_silently_rounded(): void
    {
        $this->postPayment('12.345')
            ->assertRedirect()
            ->assertSessionHasErrors('amount');

        $this->assertDatabaseCount('payments', 0);
    }

    public function test_scientific_notation_is_rejected(): void
    {
        $this->postPayment('1e2')
            ->assertRedirect()
            ->assertSessionHasErrors('amount');

        $this->assertDatabaseCount('payments', 0);
    }

    public function test_twenty_digit_overflow_is_rejected_before_the_column(): void
    {
        $this->postPayment('9999999999999')
            ->assertRedirect()
            ->assertSessionHasErrors('amount');

        $this->assertDatabaseCount('payments', 0);
    }

    public function test_negative_amount_is_rejected(): void
    {
        $this->postPayment('-5')
            ->assertRedirect()
            ->assertSessionHasErrors('amount');

        $this->assertDatabaseCount('payments', 0);
    }

    public function test_a_well_formed_amount_still_records(): void
    {
        $this->postPayment('12.34')
            ->assertRedirect(route('finance.index'));

        $this->assertDatabaseHas('payments', ['student_id' => $this->student->id, 'amount' => 12.34]);
    }

    public function test_the_api_boundary_applies_the_same_rule(): void
    {
        $this->post('/login', ['username' => 'mia-teller', 'password' => 'mia-password-1'])->assertRedirect('/');

        $this->postJson('/api/finance/payments', [
            'period_id' => $this->openPeriod(),
            'student_id' => $this->student->id,
            'amount' => '0.001',
            'method' => 'cash',
            'payer_ref' => 'mia-api-ref-1',
            'received_on' => '2026-11-05',
        ])->assertStatus(422)->assertJsonValidationErrors('amount');

        $this->assertDatabaseCount('payments', 0);
    }
}
