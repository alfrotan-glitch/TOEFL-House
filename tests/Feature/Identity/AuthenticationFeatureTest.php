<?php

declare(strict_types=1);

namespace Tests\Feature\Identity;

use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

/**
 * Employee authentication over the real HTTP surface: sign-in, sign-out,
 * the unauthenticated guard, and the health endpoint. Authority is NOT
 * carried by the session — these tests prove identity establishment only;
 * per-operation authorization is proven by the command feature tests.
 */
final class AuthenticationFeatureTest extends TestCase
{
    private function makeEmployee(string $username = 'login.employee', string $password = 'correct-horse-99', string $state = UserAccount::STATE_ACTIVE): UserAccount
    {
        $person = Person::query()->create([
            'id' => RandomIdentifier::new(),
            'legal_name' => 'Login Employee',
            'date_of_birth' => '1990-01-01',
            'verification_state' => Person::VERIFICATION_VERIFIED,
        ]);

        return UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make($password),
            'account_state' => $state,
        ]);
    }

    public function test_login_page_renders_with_official_name(): void
    {
        $this->get('/login')
            ->assertOk()
            ->assertSee('The TOEFL House');
    }

    public function test_unauthenticated_employee_is_redirected_to_login(): void
    {
        $this->get('/')->assertRedirect('/login');
        $this->get('/finance')->assertRedirect('/login');
    }

    public function test_valid_credentials_establish_session_and_reach_home(): void
    {
        $this->makeEmployee();

        $this->post('/login', ['username' => 'login.employee', 'password' => 'correct-horse-99'])
            ->assertRedirect('/');

        $this->followingRedirects()
            ->get('/')
            ->assertOk()
            ->assertSee('The TOEFL House');

        $this->assertAuthenticated();
    }

    public function test_wrong_password_is_rejected_and_not_authenticated(): void
    {
        $this->makeEmployee();

        $this->post('/login', ['username' => 'login.employee', 'password' => 'wrong-password-00'])
            ->assertSessionHasErrors('username');

        $this->assertGuest();
    }

    public function test_deactivated_account_cannot_sign_in(): void
    {
        $this->makeEmployee(state: UserAccount::STATE_DEACTIVATED);

        $this->post('/login', ['username' => 'login.employee', 'password' => 'correct-horse-99'])
            ->assertSessionHasErrors('username');

        $this->assertGuest();
    }

    public function test_unknown_user_is_rejected_without_distinct_error(): void
    {
        $this->makeEmployee();

        $this->post('/login', ['username' => 'ghost.employee', 'password' => 'correct-horse-99'])
            ->assertSessionHasErrors('username');

        $this->assertGuest();
    }

    public function test_logout_terminates_the_session(): void
    {
        $this->makeEmployee();
        $this->post('/login', ['username' => 'login.employee', 'password' => 'correct-horse-99']);
        $this->assertAuthenticated();

        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    public function test_health_endpoint_is_public_and_available(): void
    {
        $this->get('/up')->assertOk();
    }

    public function test_api_me_requires_authentication_and_returns_the_actor(): void
    {
        $this->getJson('/api/me')->assertUnauthorized();

        $this->makeEmployee();
        $this->post('/login', ['username' => 'login.employee', 'password' => 'correct-horse-99']);

        $this->getJson('/api/me')
            ->assertOk()
            ->assertJsonPath('username', 'login.employee');
    }
}
