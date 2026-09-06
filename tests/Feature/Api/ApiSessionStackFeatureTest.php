<?php

declare(strict_types=1);

namespace Tests\Feature\Api;

use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Cookie\Middleware\AddQueuedCookiesToResponse;
use Illuminate\Cookie\Middleware\EncryptCookies;
use Illuminate\Foundation\Http\Middleware\ValidateCsrfToken;
use Illuminate\Session\Middleware\StartSession;
use Illuminate\Support\Facades\Hash;
use Illuminate\View\Middleware\ShareErrorsFromSession;
use ReflectionObject;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * Regression coverage for the E2E business-journey finding: the employee API
 * is documented as "Session-authenticated (same-origin)" and the 'employee'
 * guard reads the authenticated session actor. In-process feature tests
 * share the session store across calls, so they passed even though the
 * default Laravel `api` middleware group never started a session — over real
 * HTTP every /api call returned 401 after a valid console sign-in. This test
 * pins the api group to the same stateful stack the web group runs, and
 * proves a console login then authorizes the API over the same session.
 */
final class ApiSessionStackFeatureTest extends TestCase
{
    use BuildsActors;

    public function test_the_api_middleware_group_runs_the_stateful_session_stack(): void
    {
        $kernel = $this->app->make(Kernel::class);

        $reflection = new ReflectionObject($kernel);
        $property = $reflection->getProperty('middlewareGroups');
        $property->setAccessible(true);
        /** @var array<string, list<class-string>> $groups */
        $groups = $property->getValue($kernel);

        $api = $groups['api'] ?? [];

        $this->assertContains(EncryptCookies::class, $api, 'api group must decrypt the session cookie');
        $this->assertContains(AddQueuedCookiesToResponse::class, $api, 'api group must queue the rotated session cookie');
        $this->assertContains(StartSession::class, $api, 'api group must start the session the guard reads');
        $this->assertContains(ShareErrorsFromSession::class, $api, 'api group must share session errors');
        $this->assertContains(ValidateCsrfToken::class, $api, 'state-changing api calls must enforce CSRF');
    }

    public function test_a_console_login_then_authorizes_the_api_actor_on_the_same_session(): void
    {
        $person = $this->personWithAuthority('api-session-owner', []);
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => 'api.session',
            'password_hash' => Hash::make('api-session-pw-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        // The same login the console uses (POST /login over the web stack)
        // establishes the authenticated session; the API call afterwards must
        // resolve that actor rather than 401.
        $this->post('/login', ['username' => 'api.session', 'password' => 'api-session-pw-1'])
            ->assertRedirect('/');

        $this->getJson('/api/me')
            ->assertOk()
            ->assertJsonPath('username', 'api.session')
            ->assertJsonPath('person_id', $person->id);
    }
}
