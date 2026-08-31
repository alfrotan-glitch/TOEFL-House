<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Route;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * PHASE_3 certification: the frontend is reachable. Every parameter-less
 * console page (16 modules + home + audit) renders for a fully-authorized
 * operator, and unauthenticated visitors are bounced to login. The operator
 * is granted the entire machine-derived capability set (every CAPABILITY*
 * constant in app/Modules — the 90-capability set of the coverage matrix),
 * so a 403 here would mean a capability the code authorizes is missing from
 * the fixture, and a 500/404 would mean a broken console page.
 */
final class ConsoleSmokeTest extends TestCase
{
    use BuildsActors;

    /** @var string[] */
    private array $visited = [];

    public function test_every_console_page_renders_for_a_fully_authorized_operator(): void
    {
        $person = $this->personWithAuthority('smoke-operator', self::allCapabilities());
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => 'smoke-operator',
            'password_hash' => Hash::make('smoke-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
        $this->post('/login', ['username' => 'smoke-operator', 'password' => 'smoke-password-1'])
            ->assertRedirect('/');
        $this->assertAuthenticated();

        $skipped = ['api.me', 'health', 'login'];
        foreach (Route::getRoutes() as $route) {
            $name = (string) ($route->getName() ?? '');
            $uri = '/'.ltrim((string) $route->uri(), '/');
            if (! in_array('GET', (array) $route->methods(), true)) {
                continue;
            }
            if (str_starts_with($uri, '/api/') || str_contains($uri, '{')) {
                continue;
            }
            if (in_array($name, $skipped, true)) {
                continue;
            }

            $this->get($uri)->assertOk();
            $this->visited[] = $uri;
        }

        // The 16 module consoles + home + applicants + audit: the floor of the
        // certified frontend. A shrink here is a missing console page.
        $this->assertGreaterThanOrEqual(18, count($this->visited));
    }

    public function test_unauthenticated_visitors_cannot_open_the_console(): void
    {
        $this->get('/communication')->assertRedirect('/login');
        $this->get('/payroll')->assertRedirect('/login');
        $this->assertGuest();
    }

    /**
     * The machine-derived capability set: every CAPABILITY* constant value
     * across app/Modules (the authoritative set the coverage matrix counts).
     *
     * @return string[]
     */
    private static function allCapabilities(): array
    {
        static $capabilities = null;
        if ($capabilities !== null) {
            return $capabilities;
        }

        $capabilities = [];
        $files = glob(app_path('Modules/*/Commands/*.php'));
        foreach ($files as $file) {
            $source = (string) file_get_contents($file);
            if (preg_match_all("/\bCAPABILITY[A-Z_]*\s*=\s*'([a-z][a-z0-9_.]*)'/", $source, $matches)) {
                $capabilities = array_merge($capabilities, $matches[1]);
            }
        }

        $capabilities = array_values(array_unique($capabilities));
        sort($capabilities);

        return $capabilities;
    }
}
