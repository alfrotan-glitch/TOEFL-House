<?php

declare(strict_types=1);

namespace Tests\Feature\Api;

use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
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
}
