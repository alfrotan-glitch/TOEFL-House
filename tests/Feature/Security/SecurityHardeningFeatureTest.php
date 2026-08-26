<?php

declare(strict_types=1);

namespace Tests\Feature\Security;

use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

/**
 * Production security hardening (The TOEFL House): baseline security headers,
 * brute-force protection on sign-in, and the production health/readiness
 * probe. These verify the transport-layer controls that protect the
 * deployment; per-operation authorization is proven by the module command
 * tests.
 */
final class SecurityHardeningFeatureTest extends TestCase
{
    private function makeEmployee(string $username = 'security.employee', string $password = 'correct-horse-99'): UserAccount
    {
        $person = Person::query()->create([
            'id' => RandomIdentifier::new(),
            'legal_name' => 'Security Employee',
            'date_of_birth' => '1990-01-01',
            'verification_state' => Person::VERIFICATION_VERIFIED,
        ]);

        return UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make($password),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
    }

    public function test_responses_carry_baseline_security_headers(): void
    {
        $this->get('/login')
            ->assertOk()
            ->assertHeader('X-Content-Type-Options', 'nosniff')
            ->assertHeader('X-Frame-Options', 'DENY')
            ->assertHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
            ->assertHeader('Strict-Transport-Security');
    }

    public function test_api_responses_carry_security_headers_too(): void
    {
        $this->getJson('/api/me')
            ->assertUnauthorized()
            ->assertHeader('X-Content-Type-Options', 'nosniff');
    }

    public function test_login_is_rate_limited_after_the_per_minute_allowance(): void
    {
        $this->makeEmployee();

        // The allowance is 5 attempts per minute per (IP, username).
        for ($i = 1; $i <= 5; $i++) {
            $this->post('/login', ['username' => 'security.employee', 'password' => 'correct-horse-99'])
                ->assertStatus(302);
        }

        // The 6th attempt from the same IP for the same username is rejected
        // before it reaches the credential check.
        $this->post('/login', ['username' => 'security.employee', 'password' => 'correct-horse-99'])
            ->assertStatus(429)
            ->assertHeader('Retry-After');
    }

    public function test_health_endpoint_reports_healthy_with_database_check(): void
    {
        $response = $this->getJson('/health');

        $response->assertOk()
            ->assertJsonPath('status', 'ok')
            ->assertJsonPath('service', 'The TOEFL House')
            ->assertJsonPath('checks.database', 'ok')
            ->assertJsonPath('checks.application_key', 'ok');
    }

    public function test_health_endpoint_is_public_and_does_not_leak_secrets(): void
    {
        $body = $this->getJson('/health')->assertOk()->json();

        $serialized = json_encode($body);
        $this->assertStringNotContainsString('DB_PASSWORD', $serialized);
        $this->assertStringNotContainsString('postgres', $serialized);
        $this->assertArrayNotHasKey('version', $body['checks']);
    }
}
