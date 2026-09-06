<?php

declare(strict_types=1);

namespace Tests\Feature\Api;

use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Payment;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Concerns\BuildsStudents;
use Tests\TestCase;

/**
 * The JSON employee API is session-authenticated (same-origin) and delegates
 * to the same authoritative commands the web console uses. These tests prove
 * the transport contract: auth gate, structured success, and the stable
 * domain-error mapping (never a 500 for a business rejection).
 */
final class ApiFeatureTest extends TestCase
{
    use BuildsStudents;

    private function signInAs(string $personId, string $username): void
    {
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $personId,
            'username' => $username,
            'password_hash' => Hash::make('api-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
        $this->post('/login', ['username' => $username, 'password' => 'api-password-1'])->assertRedirect('/');
    }

    public function test_api_me_requires_authentication(): void
    {
        $this->getJson('/api/me')
            ->assertUnauthorized()
            ->assertJsonPath('error', 'authentication_required');
    }

    public function test_api_me_returns_the_authenticated_actor(): void
    {
        // A full 36-char id, matching production (char(36) stores no padding).
        $personId = RandomIdentifier::new();
        $this->personWithAuthority($personId, []);
        $this->signInAs($personId, 'api.me');

        $this->getJson('/api/me')
            ->assertOk()
            ->assertJsonPath('username', 'api.me')
            ->assertJsonPath('person_id', $personId);
    }

    public function test_api_registers_an_applicant(): void
    {
        $clerk = $this->personWithAuthority('api-clerk-1', ['admissions.register']);
        $this->signInAs($clerk->id, 'api.clerk');
        $prospectId = RandomIdentifier::new();
        $prospect = Person::query()->create([
            'id' => $prospectId,
            'legal_name' => 'API Prospect',
            'date_of_birth' => '2002-02-02',
            'verification_state' => Person::VERIFICATION_VERIFIED,
            'identity_key' => 'fixture-'.$prospectId,
            'identity_evidence_ref' => 'evidence/fixture/'.$prospectId,
            'verified_by' => 'fixture-verifier',
            'verified_at' => now()->toDateTimeString(),
        ]);

        $this->postJson('/api/students/applicants', [
            'person_id' => $prospect->id,
            'program_interest' => 'TOEFL Sprint',
        ])->assertCreated();

        $this->assertDatabaseHas('applicants', ['person_id' => $prospect->id]);
    }

    public function test_api_records_a_payment(): void
    {
        $student = $this->makeStudent()['student'];
        $financier = $this->personWithAuthority('api-fin-1', ['finance.payment']);
        $this->signInAs($financier->id, 'api.fin');

        $period = FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => '2026-09',
            'date_from' => '2026-09-01',
            'date_to' => '2026-09-30',
            'lifecycle_state' => 'open',
        ]);

        $this->postJson('/api/finance/payments', [
            'period_id' => $period->id,
            'student_id' => $student->id,
            'amount' => '125.50',
            'method' => 'bank',
            'payer_ref' => 'API-PAY-1',
            'received_on' => '2026-09-05',
        ])->assertCreated();

        $this->assertDatabaseHas('payments', ['student_id' => $student->id, 'payer_ref' => 'API-PAY-1']);
    }

    public function test_api_maps_a_domain_rejection_to_structured_json_not_500(): void
    {
        // A person without finance.payment attempts to record a payment.
        $student = $this->makeStudent()['student'];
        $nobody = $this->personWithAuthority('api-nobody-1', []);
        $this->signInAs($nobody->id, 'api.nobody');

        $period = FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => '2026-10',
            'date_from' => '2026-10-01',
            'date_to' => '2026-10-31',
            'lifecycle_state' => 'open',
        ]);

        $this->postJson('/api/finance/payments', [
            'period_id' => $period->id,
            'student_id' => $student->id,
            'amount' => '10.00',
            'method' => 'cash',
            'payer_ref' => 'DENIED-1',
            'received_on' => '2026-10-01',
        ])->assertForbidden()
            ->assertJsonStructure(['error', 'category', 'message', 'correlation_id', 'retryable'])
            ->assertJsonPath('category', 'authorization');
    }

    public function test_api_replays_a_payment_idempotently_without_duplicating_rows(): void
    {
        $student = $this->makeStudent()['student'];
        $financier = $this->personWithAuthority('api-idem-1', ['finance.payment']);
        $this->signInAs($financier->id, 'api.idem');

        $period = FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => '2026-11',
            'date_from' => '2026-11-01',
            'date_to' => '2026-11-30',
            'lifecycle_state' => 'open',
        ]);

        $payload = [
            'period_id' => $period->id,
            'student_id' => $student->id,
            'amount' => '250.00',
            'method' => 'cash',
            'payer_ref' => 'API-IDEM-1',
            'received_on' => '2026-11-05',
        ];

        $key = 'api.replay.key.0001';
        $first = $this->postJson('/api/finance/payments', $payload, ['Idempotency-Key' => $key]);
        $first->assertCreated();

        // A replay carrying the SAME key and payload must not create a second payment.
        $this->postJson('/api/finance/payments', $payload, ['Idempotency-Key' => $key])->assertSuccessful();
        $this->assertSame(1, Payment::query()->where('payer_ref', 'API-IDEM-1')->count());
        $this->assertSame(1, DB::table('idempotency_keys')
            ->where('idempotency_key', $key)->where('operation', 'finance.payment.record')->count());

        // The same key reused with a DIFFERENT payload is a conflict, never a double spend.
        $this->postJson('/api/finance/payments', array_merge($payload, ['amount' => '999.00']), ['Idempotency-Key' => $key])
            ->assertStatus(409)
            ->assertJsonPath('error', 'idempotency.conflicting_payload');
        $this->assertSame(1, Payment::query()->where('payer_ref', 'API-IDEM-1')->count());
    }

    #[DataProvider('invalidMoneyAmounts')]
    public function test_api_rejects_non_money_amounts_with_422_not_500(string $invalidAmount): void
    {
        $student = $this->makeStudent()['student'];
        $financier = $this->personWithAuthority('api-money-1', ['finance.payment']);
        $this->signInAs($financier->id, 'api.money');

        $period = FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => '2026-12',
            'date_from' => '2026-12-01',
            'date_to' => '2026-12-31',
            'lifecycle_state' => 'open',
        ]);

        $this->postJson('/api/finance/payments', [
            'period_id' => $period->id,
            'student_id' => $student->id,
            'amount' => $invalidAmount,
            'method' => 'cash',
            'payer_ref' => 'BAD-'.md5($invalidAmount),
            'received_on' => '2026-12-05',
        ])->assertStatus(422); // a structured validation error — never a raw 500/SQL failure

        $this->assertSame(0, Payment::query()->where('payer_ref', 'BAD-'.md5($invalidAmount))->count());
    }

    /** @return array<string, array{0: string}> */
    public static function invalidMoneyAmounts(): array
    {
        return [
            'non-numeric' => ['abc'],
            'negative' => ['-50'],
            'third decimal' => ['0.001'],
            'third decimal large' => ['12.999'],
            'scientific notation' => ['1e2'],
            'blank' => [''],
        ];
    }
}
