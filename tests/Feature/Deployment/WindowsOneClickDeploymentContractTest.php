<?php

declare(strict_types=1);

namespace Tests\Feature\Deployment;

use App\Modules\Identity\Models\UserAccount;
use Database\Seeders\FirstRunBootstrapSeeder;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\File;
use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;
use SplFileInfo;
use Tests\TestCase;

/**
 * Windows one-click deployment contract (final delivery unit).
 *
 * The .bat files themselves cannot execute in the development environment
 * (Linux), so this suite pins the contract that makes them safe and correct:
 * the files exist, the launcher uses Tailscale SERVE (never Funnel) and
 * verifies /health, no secret material ever ships in the deployment
 * artifacts, the backup/restore batch protocol matches the drilled
 * production tooling, the owner bootstrap covers EVERY capability defined
 * in the source (a new capability can never silently miss the bootstrap),
 * and the first-run bootstrap seeder itself is exercised end to end:
 * fresh database -> owner account -> real login -> re-run is a no-op.
 */
final class WindowsOneClickDeploymentContractTest extends TestCase
{
    private const FILES = [
        'START-TOEFL-HOUSE.bat',
        'STOP-TOEFL-HOUSE.bat',
        'BACKUP-TOEFL-HOUSE.bat',
        'RESTORE-TOEFL-HOUSE.bat',
        'SETUP.md',
    ];

    protected function tearDown(): void
    {
        putenv('BOOTSTRAP_OWNER_NAME');
        putenv('BOOTSTRAP_OWNER_BIRTHDATE');
        putenv('BOOTSTRAP_OWNER_USERNAME');
        putenv('BOOTSTRAP_OWNER_PASSWORD');

        parent::tearDown();
    }

    private function read(string $path): string
    {
        $full = base_path($path);
        $this->assertFileExists($full, 'deployment artifact missing: '.$path);

        return File::get($full);
    }

    public function test_all_one_click_deployment_files_exist(): void
    {
        foreach (self::FILES as $file) {
            $this->assertFileExists(base_path($file), 'deployment artifact missing: '.$file);
        }
        $this->assertFileExists(base_path('database/seeders/FirstRunBootstrapSeeder.php'));
        $this->assertFileExists(base_path('.env.example'));
    }

    public function test_the_launcher_exposes_serve_not_funnel_and_verifies_health(): void
    {
        $start = $this->read('START-TOEFL-HOUSE.bat');

        $this->assertStringContainsString('tailscale serve', mb_strtolower($start));
        // The documentation may state that Funnel is not used, but the
        // command itself must never be invoked: no line that starts a
        // tailscale invocation may carry a funnel subcommand.
        foreach (preg_split('/\\R/', $start) as $line) {
            $trimmed = ltrim($line);
            if (preg_match('/^(tailscale(\.exe)?|where\s+tailscale)/i', $trimmed) && stripos($trimmed, 'funnel') !== false) {
                $this->fail('the launcher must never invoke Tailscale Funnel: '.$line);
            }
        }
        $this->assertStringContainsString('/health', $start);
        $this->assertStringContainsString('key:generate', $start);
        $this->assertStringContainsString('migrate --force', $start);
        $this->assertStringContainsString('initdb', $start);
        $this->assertStringContainsString('createdb', $start);
        $this->assertStringContainsString('--no-dev', $start);
        $this->assertStringContainsString('127.0.0.1:8080', $start);
        // Fails loudly, never silently.
        $this->assertStringContainsString('exit /b 1', $start);
        $this->assertStringContainsString('pause', $start);
        // An interrupted first run leaves an incomplete cluster (debris, no
        // PG_VERSION); initdb then refuses with "directory not empty" - the
        // failure message must tell the owner the recovery path (AUDIT: this
        // was a real dead end found in the fresh-run recovery test).
        $failAt = mb_strpos($start, 'initialization failed');
        $recoverAt = mb_strpos($start, 'delete the whole folder .runtime\\pgdata');
        $this->assertNotFalse($failAt, 'the initdb failure message is missing');
        $this->assertNotFalse($recoverAt, 'the initdb failure message lacks the pgdata recovery path');
        $this->assertLessThan($recoverAt, $failAt, 'the recovery path must be inside the failure message');
        // An interrupted migrate can leave a deadlocked schema (the migration
        // record is logged after the DDL commits). The launcher must auto-heal
        // only the provably safe case (no user_accounts table, or zero
        // accounts) and point data-bearing deployments at the restore tool.
        $this->assertStringContainsString("to_regclass('public.user_accounts')", $start);
        $this->assertStringContainsString('dropdb', $start);
        $this->assertStringContainsString('RESTORE-TOEFL-HOUSE.bat', $start);
        // Tailscale Serve must be configured in the background, with a
        // one-time interactive fallback for tailnets whose HTTPS certificates
        // are not enabled yet (the interactive consent flow cannot run in
        // --bg mode).
        $this->assertStringContainsString('serve --bg', $start);
        $this->assertStringContainsString('start "Tailscale Setup" cmd /k', $start);
        $this->assertStringContainsString('HTTPS certificates', $start);
    }

    public function test_no_secret_material_ships_in_the_deployment_artifacts(): void
    {
        $files = array_merge(self::FILES, ['database/seeders/FirstRunBootstrapSeeder.php']);
        foreach ($files as $file) {
            $contents = $this->read($file);
            $lower = mb_strtolower($contents);

            // A committed, populated APP_KEY (32+ base64 chars) would be a
            // secret leak; templates must carry an empty value.
            if (preg_match('#APP_KEY=base64:[A-Za-z0-9+/=]{32,}#', $contents) === 1) {
                $this->fail('a populated APP_KEY must never be committed: '.$file);
            }
            if (preg_match('/DB_PASSWORD=\S/', $contents) === 1) {
                $this->fail('a database password must never be committed: '.$file);
            }
            foreach (['ghp_', 'gho_', 'github_pat_', 'xoxb-', 'xoxp-', 'BEGIN RSA PRIVATE KEY', 'BEGIN OPENSSH PRIVATE KEY', 'sk_live_', 'sk_test_'] as $needle) {
                $this->assertStringNotContainsString($needle, $lower, 'credential material in '.$file);
            }
        }
    }

    public function test_the_environment_template_carries_no_secrets(): void
    {
        $template = $this->read('.env.example');

        $this->assertMatchesRegularExpression('/^APP_KEY=$/m', $template);
        $this->assertMatchesRegularExpression('/^DB_PASSWORD=$/m', $template);
        $this->assertStringContainsString('APP_ENV=production', $template);
        $this->assertStringContainsString('APP_DEBUG=false', $template);
    }

    public function test_the_backup_and_restore_bats_mirror_the_production_protocol(): void
    {
        $backup = $this->read('BACKUP-TOEFL-HOUSE.bat');
        $restore = $this->read('RESTORE-TOEFL-HOUSE.bat');

        // deploy/backup.sh protocol: custom format, no owner/privileges,
        // integrity verification, 14-dump retention.
        $this->assertStringContainsString('--format=custom', $backup);
        $this->assertStringContainsString('--no-owner', $backup);
        $this->assertStringContainsString('--no-privileges', $backup);
        $this->assertStringContainsString('pg_restore', $backup);
        $this->assertStringContainsString('--list', $backup);
        $this->assertStringContainsString('14', $backup);

        // deploy/restore.sh protocol: verify before destroying, explicit
        // typed confirmation, clean create restore, post-restore checks.
        $this->assertStringContainsString('pg_restore', $restore);
        $this->assertStringContainsString('--clean', $restore);
        $this->assertStringContainsString('--create', $restore);
        $this->assertStringContainsString('RESTORE', $restore);
        $this->assertStringContainsString('set /p "CONFIRM=', $restore);

        // The integrity check must come BEFORE the destructive restore in
        // the file (protocol order, not just presence).
        $verifyAt = mb_strpos($restore, '--list');
        $destroyAt = mb_strpos($restore, '--clean');
        $this->assertNotFalse($verifyAt);
        $this->assertNotFalse($destroyAt);
        $this->assertLessThan($destroyAt, $verifyAt, 'the dump must be verified before the destructive restore runs');
    }

    public function test_the_owner_bootstrap_covers_every_capability_in_the_source(): void
    {
        $defined = [];
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(base_path('app/Modules')));
        foreach ($it as $file) {
            /** @var SplFileInfo $file */
            if ($file->getExtension() !== 'php') {
                continue;
            }
            if (preg_match_all("/CAPABILITY[A-Z_]*\s*=\s*'([^']+)'/", File::get($file->getPathname()), $matches) > 0) {
                foreach ($matches[1] as $capability) {
                    $defined[$capability] = true;
                }
            }
        }
        ksort($defined);

        $owner = FirstRunBootstrapSeeder::OWNER_CAPABILITIES;
        sort($owner);
        $owner = array_values(array_unique($owner));

        $missing = array_diff(array_keys($defined), $owner);
        $extra = array_diff($owner, array_keys($defined));
        $this->assertSame([], $missing, 'capabilities defined in the source but missing from the owner bootstrap: '.implode(', ', $missing));
        $this->assertSame([], $extra, 'owner bootstrap capabilities that do not exist in the source: '.implode(', ', $extra));
        $this->assertGreaterThan(50, count($owner), 'the canonical capability set unexpectedly shrank');
    }

    public function test_first_run_bootstrap_creates_a_working_owner_account(): void
    {
        $this->seedFirstRun('owner.one', 'Owner One');

        $this->assertDatabaseCount('organizations', 1);
        $this->assertDatabaseHas('organizations', ['name' => 'The TOEFL House']);
        $this->assertDatabaseCount('user_accounts', 1);
        $this->assertDatabaseHas('user_accounts', ['username' => 'owner.one', 'account_state' => UserAccount::STATE_ACTIVE]);

        // The created account must actually sign in.
        $this->post('/login', ['username' => 'owner.one', 'password' => 'owner-password-12345'])
            ->assertRedirect('/');
        $this->assertAuthenticated();
    }

    public function test_first_run_bootstrap_is_a_no_op_on_a_live_system(): void
    {
        $this->seedFirstRun('owner.one', 'Owner One');

        // Second run on an initialized system: the guard must refuse to touch
        // anything, whatever credentials it is handed.
        putenv('BOOTSTRAP_OWNER_USERNAME=intruder.two');
        putenv('BOOTSTRAP_OWNER_NAME=Intruder');
        putenv('BOOTSTRAP_OWNER_BIRTHDATE=1990-01-01');
        putenv('BOOTSTRAP_OWNER_PASSWORD=should-not-be-created-1');
        Artisan::call('db:seed', ['--class' => 'FirstRunBootstrapSeeder', '--force' => true]);

        $this->assertDatabaseCount('user_accounts', 1);
        $this->assertDatabaseCount('organizations', 1);
        $this->assertDatabaseMissing('user_accounts', ['username' => 'intruder.two']);
    }

    public function test_first_run_bootstrap_refuses_without_credentials(): void
    {
        Artisan::call('db:seed', ['--class' => 'FirstRunBootstrapSeeder', '--force' => true]);

        $this->assertDatabaseCount('user_accounts', 0);
        $this->assertDatabaseCount('organizations', 0);
    }

    private function seedFirstRun(string $username, string $name): void
    {
        putenv('BOOTSTRAP_OWNER_USERNAME='.$username);
        putenv('BOOTSTRAP_OWNER_NAME='.$name);
        putenv('BOOTSTRAP_OWNER_BIRTHDATE=1985-04-12');
        putenv('BOOTSTRAP_OWNER_PASSWORD=owner-password-12345');
        $exit = Artisan::call('db:seed', ['--class' => 'FirstRunBootstrapSeeder', '--force' => true]);
        $this->assertSame(0, $exit, 'first-run bootstrap failed: '.Artisan::output());
    }
}
